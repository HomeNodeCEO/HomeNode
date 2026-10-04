import { fork } from "node:child_process";

export const LOCAL_OCR_LIMITS = Object.freeze({
  maximumBytes: 25 * 1024 * 1024,
  maximumDocumentPages: 250,
  maximumOcrPages: 64,
  maximumPagePixels: 6_000_000,
  maximumImagePixels: 16_000_000,
  maximumDimension: 8_192,
  maximumTextLength: 4_000_000,
});

// The durable assignment_documents queue owns waiting/retries. Do not accumulate
// PDFs or create an unbounded in-memory queue when multiple uploads arrive.
let activeScan = false;

export function localOcrRuntimeEnvironment(environment = process.env) {
  const result = {};
  // Native DLL/temp/locale support only. In particular, do not expose database,
  // object-storage, cloud-OCR credentials or injected NODE_OPTIONS to the parser.
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TZ", "LANG", "LC_ALL"]) {
    if (typeof environment[name] === "string") result[name] = environment[name];
  }
  return result;
}

export function createLocalDocumentOcrProvider(env = process.env, {
  workerFactory = (url, options) => fork(url, [], options),
} = {}) {
  const requestedTimeout = Number(env.DOCUMENT_OCR_LOCAL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(1_000, Math.min(300_000, Math.trunc(requestedTimeout))) : 180_000;
  return {
    provider: "local",
    configured: true,
    model_id: "tesseract-eng-lstm",
    api_version: "7.0.0",
    async analyzePdf(content, { pageNumbers } = {}) {
      if (!Buffer.isBuffer(content) || content.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("document_not_pdf");
      }
      if (content.length > LOCAL_OCR_LIMITS.maximumBytes) throw new Error("document_too_large");
      if (pageNumbers !== undefined && (!Array.isArray(pageNumbers)
        || !pageNumbers.length || pageNumbers.some(page => !Number.isInteger(page) || page < 1
          || page > LOCAL_OCR_LIMITS.maximumDocumentPages)
        || new Set(pageNumbers).size !== pageNumbers.length)) {
        throw new Error("document_ocr_page_selection_invalid");
      }
      if (pageNumbers?.length > LOCAL_OCR_LIMITS.maximumOcrPages) {
        throw new Error("document_ocr_page_limit_exceeded");
      }
      if (activeScan) throw new Error("document_ocr_busy");
      activeScan = true;
      let worker;
      let timer;
      try {
        // Isolate parsing, rendering, and OCR from the HTTP event loop. No private
        // source files or plaintext are written to disk by this worker.
        worker = workerFactory(new URL("./localDocumentOcrWorker.js", import.meta.url), {
          execArgv: ["--max-old-space-size=512"],
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          serialization: "advanced",
          windowsHide: true,
          env: localOcrRuntimeEnvironment(),
        });
        // Third-party diagnostics can contain source-derived text. Discard them;
        // only the sanitized error code below crosses into application logging.
        worker.stdout?.resume();
        worker.stderr?.resume();
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("document_ocr_timeout")), timeoutMs);
          worker.once("message", message => {
            if (message?.error) {
              const allowed = new Set([
                "document_ocr_page_limit_exceeded", "document_ocr_pixel_limit_exceeded",
                "document_ocr_text_limit_exceeded", "document_ocr_page_selection_invalid",
              ]);
              reject(new Error(allowed.has(message.error) ? message.error : "document_ocr_failed"));
            } else if (message?.result && Array.isArray(message.result.pages)) {
              resolve(message.result);
            } else reject(new Error("document_ocr_failed"));
          });
          worker.once("error", () => reject(new Error("document_ocr_failed")));
          worker.once("exit", () => reject(new Error("document_ocr_failed")));
          worker.send({ content: new Uint8Array(content), pageNumbers }, error => {
            if (error) reject(new Error("document_ocr_failed"));
          });
        });
      } catch (error) {
        if (/^document_[a-z_]+$/.test(String(error?.message || ""))) throw error;
        throw new Error("document_ocr_failed");
      } finally {
        clearTimeout(timer);
        try {
          if (worker && worker.exitCode == null && worker.signalCode == null) {
            await new Promise(resolve => {
              worker.once("exit", resolve);
              worker.once("error", resolve);
              if (!worker.kill("SIGKILL")) resolve();
            });
          }
        } finally { activeScan = false; }
      }
    },
  };
}
