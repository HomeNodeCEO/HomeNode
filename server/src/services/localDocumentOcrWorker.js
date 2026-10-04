import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { createWorker } from "tesseract.js";
import {
  createIsomorphicCanvasFactory, definePDFJSModule, getDocumentProxy, renderPageAsImage,
} from "unpdf";
import { LOCAL_OCR_LIMITS as limits } from "./localDocumentOcr.js";
import { removeLongHorizontalRules } from "./ocrImagePreparation.js";

const require = createRequire(import.meta.url);

async function scan(workerData) {
  const canvasImport = () => import("@napi-rs/canvas");
  const BaseCanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
  const assertPixels = (width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
      || width > limits.maximumDimension || height > limits.maximumDimension
      || width * height > limits.maximumImagePixels) {
      throw new Error("document_ocr_pixel_limit_exceeded");
    }
  };
  class BoundedCanvasFactory extends BaseCanvasFactory {
    create(width, height) { assertPixels(width, height); return super.create(width, height); }
    reset(canvas, width, height) { assertPixels(width, height); return super.reset(canvas, width, height); }
  }
  await definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
  const pdf = await getDocumentProxy(workerData.content, {
    CanvasFactory: BoundedCanvasFactory,
    isEvalSupported: false,
    enableScripting: false,
    useSystemFonts: false,
    maxImageSize: limits.maximumImagePixels,
    canvasMaxAreaInBytes: limits.maximumImagePixels * 4,
    // All assets resolve to installed packages; PDF actions and remote URLs are
    // not followed. No network service receives document content.
    wasmUrl: join(dirname(require.resolve("pdfjs-dist/package.json")), "wasm") + "/",
  });
  let ocr;
  try {
    if (pdf.numPages > limits.maximumDocumentPages) throw new Error("document_ocr_page_limit_exceeded");
    const pageNumbers = workerData.pageNumbers || Array.from({ length: pdf.numPages }, (_, index) => index + 1);
    if (pageNumbers.length > limits.maximumOcrPages) throw new Error("document_ocr_page_limit_exceeded");
    if (pageNumbers.some(page => page > pdf.numPages)) throw new Error("document_ocr_page_selection_invalid");
    const languageRoot = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
    const langPath = join(languageRoot, "4.0.0_best_int");
    await access(join(langPath, "eng.traineddata.gz"));
    ocr = await createWorker("eng", 1, {
      langPath,
      corePath: dirname(require.resolve("tesseract.js-core/package.json")),
      workerPath: join(dirname(require.resolve("tesseract.js/package.json")), "src/worker-script/node/index.js"),
      cacheMethod: "none",
      gzip: true,
      // Initialization failures must not leave createWorker pending until the
      // whole scan deadline; the parent converts this exit to a safe error.
      errorHandler: () => process.exit(1),
    });
    await ocr.setParameters({ preserve_interword_spaces: "1" });
    const pages = Array(pdf.numPages).fill("");
    const confidenceByPage = {};
    const preprocessingByPage = {};
    let textLength = 0;
    for (const pageNumber of pageNumbers) {
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
          throw new Error("document_ocr_pixel_limit_exceeded");
        }
        const scale = Math.min(2.5, Math.sqrt(limits.maximumPagePixels / (viewport.width * viewport.height)),
          limits.maximumDimension / viewport.width, limits.maximumDimension / viewport.height);
        const rendered = await renderPageAsImage(pdf, pageNumber, { canvasImport, scale });
        let result = await ocr.recognize(Buffer.from(rendered), {}, { text: true });
        // One bounded fallback for sparse, uncertain form pages. Long box rules
        // can otherwise swallow typed dates even when the glyphs are legible.
        if (result.data.confidence < 90 && String(result.data.text || "").length < 2500) {
          const { createCanvas, loadImage } = await canvasImport();
          const source = await loadImage(Buffer.from(rendered));
          const canvas = createCanvas(source.width, source.height);
          try {
            const context = canvas.getContext("2d");
            context.drawImage(source, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            if (removeLongHorizontalRules(pixels.data, canvas.width, canvas.height)) {
              context.putImageData(pixels, 0, 0);
              const prepared = await canvas.encode("png");
              const alternate = await ocr.recognize(prepared, {}, { text: true });
              if (alternate.data.confidence >= result.data.confidence) {
                result = alternate;
                preprocessingByPage[pageNumber] = "horizontal_rule_removal";
              }
            }
          } finally { canvas.width = 1; canvas.height = 1; }
        }
        const text = String(result?.data?.text || "").replace(/\u0000/g, "").trim();
        textLength += text.length;
        if (textLength > limits.maximumTextLength) throw new Error("document_ocr_text_limit_exceeded");
        pages[pageNumber - 1] = text;
        confidenceByPage[pageNumber] = Number(result?.data?.confidence || 0);
      } finally { page.cleanup(); }
    }
    return {
      provider: "local_tesseract",
      extraction_method: "local_tesseract_read",
      model_id: "tesseract-eng-lstm",
      api_version: "7.0.0",
      page_count: pdf.numPages,
      scanned_page_numbers: pageNumbers,
      confidence_by_page: confidenceByPage,
      preprocessing_by_page: preprocessingByPage,
      pages,
    };
  } finally {
    await ocr?.terminate();
    await pdf.loadingTask.destroy();
  }
}

process.once("message", workerData => {
  scan(workerData).then(result => process.send({ result })).catch(error => {
    const code = String(error?.message || "");
    process.send({ error: /^document_ocr_[a-z_]+$/.test(code) ? code : "document_ocr_failed" });
  });
});
