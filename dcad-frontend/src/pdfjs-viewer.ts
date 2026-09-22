import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import "./pdfjs-viewer.css";

GlobalWorkerOptions.workerSrc = workerUrl;

const params = new URLSearchParams(window.location.search);
const file = params.get("file") || "";
const container = document.getElementById("viewerContainer");

function isTrustedParentMessage(event: MessageEvent) {
  return event.source === window.parent && event.origin === window.location.origin;
}

function postToTrustedParent(message: object) {
  window.parent.postMessage(message, window.location.origin);
}

function showLoadError() {
  const error = document.createElement("div");
  error.className = "pdf-viewer-error";
  error.textContent = "Failed to load PDF.";
  document.body.appendChild(error);
}

async function init() {
  if (!(container instanceof HTMLDivElement) || !file) {
    showLoadError();
    return;
  }

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const viewer = new PDFViewer({
    container,
    eventBus,
    linkService,
    textLayerMode: 2,
    annotationMode: AnnotationMode.ENABLE_FORMS,
  });
  linkService.setViewer(viewer);

  let pdfDocument: PDFDocumentProxy | null = null;
  try {
    const task = getDocument({ url: file });
    pdfDocument = await task.promise;
    viewer.setDocument(pdfDocument);
    linkService.setDocument(pdfDocument, null);
  } catch {
    showLoadError();
    console.error("PDF load failed");
  }

  window.addEventListener("message", async (event) => {
    const data = event.data || {};
    if (!isTrustedParentMessage(event) || data.type !== "SAVE_PDF") return;
    try {
      if (!pdfDocument) throw new Error("pdf_not_loaded");
      const bytes = await pdfDocument.saveDocument();
      const blob = new Blob([bytes], { type: "application/pdf" });
      const reader = new FileReader();
      reader.onload = () => {
        postToTrustedParent({ type: "PDF_DATA", dataURL: reader.result });
      };
      reader.readAsDataURL(blob);
    } catch {
      postToTrustedParent({ type: "PDF_DATA_ERROR", error: "pdf_export_failed" });
    }
  });
}

void init();
