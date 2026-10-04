import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import PDFDocument from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";
import { createLocalDocumentOcrProvider, LOCAL_OCR_LIMITS, localOcrRuntimeEnvironment } from "../src/services/localDocumentOcr.js";
import { extractPdfEvidence } from "../src/services/documentIntelligence.js";
import { removeLongHorizontalRules } from "../src/services/ocrImagePreparation.js";

function fakeWorker() {
  const worker = new EventEmitter();
  worker.terminated = false;
  worker.send = () => {};
  worker.kill = () => { worker.terminated = true; worker.exitCode = 1; worker.emit("exit", 1); };
  return worker;
}

async function pdfBytes(draw) {
  const pdf = new PDFDocument({ size: "LETTER", margin: 40 });
  const chunks = [];
  pdf.on("data", chunk => chunks.push(chunk));
  const finished = new Promise(resolve => pdf.on("end", () => resolve(Buffer.concat(chunks))));
  draw(pdf);
  pdf.end();
  return finished;
}

test("OCR child environment omits application secrets and injected Node options", () => {
  assert.deepEqual(localOcrRuntimeEnvironment({ SystemRoot: "system", TEMP: "temp", TZ: "UTC",
    DATABASE_URL: "private-db", R2_SECRET_ACCESS_KEY: "private-key", NODE_OPTIONS: "--require=untrusted",
    AZURE_DOCUMENT_INTELLIGENCE_KEY: "cloud-secret", PATH: "arbitrary-executables",
  }), { SystemRoot: "system", TEMP: "temp", TZ: "UTC" });
});

test("local OCR rejects invalid or oversized inputs and selections before creating a worker", async () => {
  let workers = 0;
  const provider = createLocalDocumentOcrProvider({}, { workerFactory: () => { workers += 1; return fakeWorker(); } });
  await assert.rejects(provider.analyzePdf(Buffer.from("not a PDF")), /document_not_pdf/);
  const oversized = Buffer.alloc(LOCAL_OCR_LIMITS.maximumBytes + 1);
  oversized.write("%PDF-");
  await assert.rejects(provider.analyzePdf(oversized), /document_too_large/);
  for (const pageNumbers of [[], [0], [1.5], [251], [1, 1], "1"]) {
    await assert.rejects(provider.analyzePdf(Buffer.from("%PDF-test"), { pageNumbers }), /document_ocr_page_selection_invalid/);
  }
  await assert.rejects(provider.analyzePdf(Buffer.from("%PDF-test"), {
    pageNumbers: Array.from({ length: 65 }, (_, index) => index + 1),
  }), /document_ocr_page_limit_exceeded/);
  assert.equal(workers, 0);
});

test("local OCR allows one scan across provider instances and frees capacity only after termination", async () => {
  const worker = fakeWorker();
  const first = createLocalDocumentOcrProvider({}, { workerFactory: () => worker });
  const second = createLocalDocumentOcrProvider({}, { workerFactory: () => fakeWorker() });
  const pending = first.analyzePdf(Buffer.from("%PDF-test"));
  await assert.rejects(second.analyzePdf(Buffer.from("%PDF-test")), /document_ocr_busy/);
  worker.emit("message", { result: { pages: ["Synthetic evidence"] } });
  assert.deepEqual((await pending).pages, ["Synthetic evidence"]);
  assert.equal(worker.terminated, true);
});

test("local OCR hard deadline terminates a stalled worker and sanitizes worker errors", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = fakeWorker();
  const provider = createLocalDocumentOcrProvider({ DOCUMENT_OCR_LOCAL_TIMEOUT_MS: "1000" }, {
    workerFactory: () => worker,
  });
  const timedOut = provider.analyzePdf(Buffer.from("%PDF-test"));
  const rejection = assert.rejects(timedOut, { message: "document_ocr_timeout" });
  context.mock.timers.tick(1000);
  await rejection;
  assert.equal(worker.terminated, true);
  const failure = provider.analyzePdf(Buffer.from("%PDF-test"));
  const sanitized = assert.rejects(failure, { message: "document_ocr_failed" });
  worker.emit("error", new Error("private source text and host path"));
  await sanitized;
});

test("mixed PDFs request only sparse pages, preserve native evidence, and retain page citations", async () => {
  const buffer = await pdfBytes(pdf => {
    pdf.text("PURCHASE CONTRACT\nContract Price: $410,000\nNative contract terms retained for review.");
    pdf.addPage();
  });
  let requested;
  const extraction = await extractPdfEvidence(buffer, { requestedType: "purchase_contract", ocrProvider: {
    configured: true,
    async analyzePdf(_content, options) {
      requested = options;
      return { extraction_method: "synthetic_ocr", pages: ["Do not overwrite native text",
        "Contract Date: 08/20/2026\nAdditional scanned terms for appraiser review."] };
    },
  } });
  assert.deepEqual(requested, { pageNumbers: [2], pageCount: 2 });
  assert.match(extraction.pages[0], /Contract Price: \$410,000/);
  const price = extraction.candidates.find(candidate => candidate.field_key === "contract_price");
  const date = extraction.candidates.find(candidate => candidate.field_key === "contract_date");
  assert.equal(price.page_number, 1);
  assert.equal(price.extraction_method, "labeled_text");
  assert.equal(date.page_number, 2);
  assert.equal(date.extraction_method, "labeled_text");
  assert.deepEqual(extraction.ocr_metadata.text_recovered_page_numbers, [2]);
  assert.equal(extraction.extraction_status, "review_required");
});

async function mixedNativePdf(blankPages = 1) {
  return pdfBytes(pdf => {
    pdf.text("PURCHASE CONTRACT\nContract Price: $410,000\nNative contract terms retained for review.");
    for (let index = 0; index < blankPages; index += 1) pdf.addPage();
  });
}

test("mixed searchable PDFs stay reviewable with a blank page and no configured scanner", async () => {
  const buffer = await mixedNativePdf();
  for (const ocrProvider of [null, { configured: false, analyzePdf() { assert.fail("Disabled OCR was called"); } }]) {
    const result = await extractPdfEvidence(buffer, { requestedType: "purchase_contract", ocrProvider });
    assert.equal(result.extraction_status, "review_required");
    assert.equal(result.extraction_method, "pdf_text");
    assert.equal(result.ocr_metadata, null);
    assert.equal(result.candidates.find(candidate => candidate.field_key === "contract_price")?.normalized_value, "410000.00");
    assert.equal(result.candidates.find(candidate => candidate.field_key === "contract_price")?.page_number, 1);
    assert.equal(result.pages[1], "");
    assert.match(result.review_reason, /Pages 2.*visual review/);
  }
});

for (const [message, expectedCode] of [
  ["document_ocr_failed", "document_ocr_failed"],
  ["document_ocr_timeout", "document_ocr_timeout"],
  ["document_ocr_page_limit_exceeded", "document_ocr_page_limit_exceeded"],
  ["document_ocr_pixel_limit_exceeded", "document_ocr_pixel_limit_exceeded"],
  ["document_ocr_poll_timeout", "document_ocr_poll_timeout"],
  ["private-url=https://private.example/secret-token", "document_ocr_failed"],
]) {
  test(`mixed native evidence survives sparse-page OCR failure (${expectedCode}, ${message === expectedCode ? "known" : "sanitized"})`, async () => {
    const buffer = await mixedNativePdf();
    const baseline = await extractPdfEvidence(buffer, { requestedType: "purchase_contract" });
    const result = await extractPdfEvidence(buffer, { requestedType: "purchase_contract", ocrProvider: {
      configured: true, provider: "synthetic_ocr",
      async analyzePdf() { throw new Error(message); },
    } });
    assert.equal(result.extraction_status, "review_required");
    assert.equal(result.extraction_method, "pdf_text");
    assert.equal(result.text_length, baseline.text_length);
    assert.deepEqual(result.pages, baseline.pages);
    assert.deepEqual(result.candidates, baseline.candidates);
    assert.equal(result.ocr_metadata.error, expectedCode);
    assert.deepEqual(result.ocr_metadata.attempted_page_numbers, [2]);
    assert.deepEqual(result.ocr_metadata.scanned_page_numbers, []);
    assert.deepEqual(result.ocr_metadata.text_recovered_page_numbers, []);
    assert.deepEqual(result.ocr_metadata.unresolved_page_numbers, [2]);
    assert.match(result.review_reason, /could not finish for pages 2/);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
  });
}

test("mixed evidence survives the real local scanner's page bound without spawning a child", async () => {
  const provider = createLocalDocumentOcrProvider({}, { workerFactory() { assert.fail("Page limit must precede spawning"); } });
  const result = await extractPdfEvidence(await mixedNativePdf(65), { requestedType: "purchase_contract", ocrProvider: provider });
  assert.equal(result.extraction_status, "review_required");
  assert.equal(result.page_count, 66);
  assert.equal(result.ocr_metadata.error, "document_ocr_page_limit_exceeded");
  assert.equal(result.ocr_metadata.unresolved_page_numbers.length, 65);
  assert.equal(result.candidates.find(candidate => candidate.field_key === "contract_price")?.normalized_value, "410000.00");
});

test("mixed OCR failure diagnostics tolerate a hostile message getter", async () => {
  const failure = Object.defineProperty(new Error(), "message", { get() { throw new Error("private getter detail"); } });
  const result = await extractPdfEvidence(await mixedNativePdf(), { ocrProvider: {
    configured: true, async analyzePdf() { throw failure; },
  } });
  assert.equal(result.extraction_status, "review_required");
  assert.equal(result.ocr_metadata.error, "document_ocr_failed");
  assert.equal(JSON.stringify(result).includes("private getter"), false);
});

test("busy OCR propagates for both mixed and image-only PDFs so the durable queue can retry", async () => {
  for (const buffer of [await mixedNativePdf(), await pdfBytes(() => {})]) {
    await assert.rejects(extractPdfEvidence(buffer, { ocrProvider: {
      configured: true, async analyzePdf() { throw new Error("document_ocr_busy"); },
    } }), { message: "document_ocr_busy" });
  }
});

test("image-only OCR failure, timeout and limit errors retain explicit failure semantics", async () => {
  const buffer = await pdfBytes(() => {});
  for (const message of ["document_ocr_failed", "document_ocr_timeout", "document_ocr_page_limit_exceeded"]) {
    await assert.rejects(extractPdfEvidence(buffer, { requestedType: "purchase_contract", ocrProvider: {
      configured: true, async analyzePdf() { throw new Error(message); },
    } }), { message });
  }
});

test("image-only OCR returning no text remains OCR-required without fabricated candidates", async () => {
  const result = await extractPdfEvidence(await pdfBytes(() => {}), { requestedType: "purchase_contract", ocrProvider: {
    configured: true, async analyzePdf() { return { pages: [""] }; },
  } });
  assert.equal(result.extraction_status, "ocr_required");
  assert.equal(result.extraction_method, "ocr_no_reliable_text");
  assert.deepEqual(result.candidates, []);
});

test("empty purchase contracts cannot invent default negative candidates without OCR", async () => {
  const extraction = await extractPdfEvidence(await pdfBytes(() => {}), { requestedType: "purchase_contract" });
  assert.equal(extraction.extraction_status, "ocr_required");
  assert.deepEqual(extraction.candidates, []);
});

test("ruled-form preparation removes long dark runs but preserves short glyphs and color", () => {
  const pixels = new Uint8ClampedArray(100 * 4 * 4).fill(255);
  const dark = (x, y) => { const start = (y * 100 + x) * 4; pixels.fill(0, start, start + 3); };
  for (let x = 10; x < 90; x += 1) dark(x, 1);
  for (let x = 10; x < 20; x += 1) dark(x, 2);
  assert.equal(removeLongHorizontalRules(pixels, 100, 4), 80);
  assert.equal(pixels[(100 + 10) * 4], 255);
  assert.equal(pixels[(200 + 10) * 4], 0);
  assert.equal(pixels[(100 + 10) * 4 + 3], 255);
  assert.throws(() => removeLongHorizontalRules(pixels, 10000, 10000), /pixel_limit/);
});

test("partial OCR explicitly identifies unrecovered original pages", async () => {
  const buffer = await pdfBytes(pdf => { pdf.addPage(); });
  const extraction = await extractPdfEvidence(buffer, { ocrProvider: { configured: true,
    async analyzePdf() { return { pages: ["Recovered searchable evidence for appraiser confirmation.", ""] }; },
  } });
  assert.deepEqual(extraction.ocr_metadata.unresolved_page_numbers, [2]);
  assert.match(extraction.review_reason, /could not recover reliable text on pages 2/);
});

test("packaged local engine reads an image-only PDF without a hosted OCR service", { timeout: 60_000 }, async () => {
  const canvas = createCanvas(1200, 700);
  const drawing = canvas.getContext("2d");
  drawing.fillStyle = "white";
  drawing.fillRect(0, 0, 1200, 700);
  drawing.fillStyle = "black";
  drawing.font = "40px sans-serif";
  drawing.fillText("PURCHASE CONTRACT", 60, 100);
  drawing.fillText("Contract Price: $425,000", 60, 180);
  drawing.fillText("Contract Date: 08/19/2026", 60, 260);
  const image = await canvas.encode("png");
  const bytes = await pdfBytes(pdf => { pdf.image(image, 40, 40, { width: 520 }); });
  const provider = createLocalDocumentOcrProvider({ DOCUMENT_OCR_LOCAL_TIMEOUT_MS: "50000" });
  const extraction = await extractPdfEvidence(bytes, { requestedType: "purchase_contract", ocrProvider: provider });
  assert.equal(extraction.extraction_status, "review_required");
  assert.equal(extraction.ocr_metadata.provider, "local_tesseract");
  assert.equal(extraction.candidates.find(candidate => candidate.field_key === "contract_price")?.normalized_value, "425000.00");
  assert.equal(extraction.candidates.find(candidate => candidate.field_key === "contract_date")?.normalized_value, "2026-08-19");
  assert.equal(extraction.candidates.find(candidate => candidate.field_key === "contract_price")?.extraction_method, "labeled_text");
  assert.deepEqual(extraction.ocr_metadata.text_recovered_page_numbers, [1]);
});
