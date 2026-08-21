import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createUadPdfViewModel,
  renderUadNativePdf,
  UAD_NATIVE_PDF_PAGE_SIZE,
} from "../src/modules/uad/uadPdf.js";
import {
  uadNativePdfEditorFixture,
  uadNativePdfSignerFixture,
} from "./fixtures/uadNativePdfFixture.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
test("builds a report view solely from the canonical UAD editor revision", () => {
  const view = createUadPdfViewModel(uadNativePdfEditorFixture(), { signers: [uadNativePdfSignerFixture()] });
  assert.equal(view.fileName, "UAD-STAGING-SFR-0001.pdf");
  assert.equal(view.address, "1909 Snowmass Ln, Garland, TX 75044");
  assert.equal(view.opinionOfValue, "$491,000");
  assert.equal(view.quality, "Q4");
  assert.equal(view.condition, "C4");
  assert.equal(view.signers.length, 1);
  assert.deepEqual(view.sections.map((section) => section.number), [2, 3, 15, 17, 20, 26, 29]);
});

test("renders a deterministic legal-size native UAD report", async () => {
  const editor = uadNativePdfEditorFixture();
  const first = await renderUadNativePdf(editor, { signers: [uadNativePdfSignerFixture()] });
  const second = await renderUadNativePdf(editor, { signers: [uadNativePdfSignerFixture()] });

  assert.equal(first.content.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(first.content.length > 6_000);
  assert.equal(first.checksum_sha256, second.checksum_sha256);
  assert.equal(first.content.equals(second.content), true);
  assert.ok(first.page_count >= 3);
  assert.equal(first.signer_count, 1);
  assert.deepEqual(UAD_NATIVE_PDF_PAGE_SIZE, [612, 1008]);
  assert.match(first.content.toString("latin1"), /\/MediaBox \[0 0 612 1008\]/);
});

test("wires PDF artifact routes without changing the legacy report renderer", () => {
  const router = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/modules/uad/router.js"), "utf8");
  const legacy = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/services/customAppraisalReportPdf.js"), "utf8");
  assert.match(router, /artifacts\/pdf/);
  assert.match(router, /generateUadPdfArtifact/);
  assert.match(legacy, /HomeNode Custom Appraisal Report Engine/);
  assert.doesNotMatch(legacy, /UAD 3\.6 Native Report Engine/);
});
