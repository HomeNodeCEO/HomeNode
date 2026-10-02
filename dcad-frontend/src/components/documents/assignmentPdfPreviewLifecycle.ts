import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export const PDF_PREVIEW_MAX_DIMENSION = 4096;
export const PDF_PREVIEW_MAX_PIXELS = 4_194_304;

/** Bound both canvas axes and its pixel area, including on high-DPI displays. */
export function pdfPreviewGeometry(width: number, height: number, availableWidth: number, zoom: number, pixelRatio: number) {
  if (![width, height, availableWidth, zoom].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('pdf_preview_invalid_geometry');
  }
  const displayScale = Math.min(
    availableWidth / width * Math.min(3, Math.max(0.5, zoom)),
    PDF_PREVIEW_MAX_DIMENSION / width,
    PDF_PREVIEW_MAX_DIMENSION / height,
  );
  const ratio = Number.isFinite(pixelRatio) ? Math.min(2, Math.max(1, pixelRatio)) : 1;
  const renderScale = Math.min(
    displayScale * ratio,
    PDF_PREVIEW_MAX_DIMENSION / width,
    PDF_PREVIEW_MAX_DIMENSION / height,
    Math.sqrt(PDF_PREVIEW_MAX_PIXELS / width / height),
  );
  if (!Number.isFinite(renderScale) || renderScale <= 0) throw new Error('pdf_preview_invalid_geometry');
  return {
    renderScale,
    canvasWidth: Math.max(1, Math.floor(width * renderScale)),
    canvasHeight: Math.max(1, Math.floor(height * renderScale)),
    displayWidth: width * displayScale,
    displayHeight: height * displayScale,
  };
}

/** A replaced Blob must never finish loading into the next document's view. */
export function loadPdfPreview(
  blob: Blob,
  createDocument: (bytes: Uint8Array) => PDFDocumentLoadingTask,
  onReady: (document: PDFDocumentProxy) => void,
  onError: () => void,
) {
  let active = true;
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let destroyed = false;
  const destroy = () => {
    if (!loadingTask || destroyed) return;
    destroyed = true;
    try { void loadingTask.destroy().catch(() => {}); } catch { /* Already terminated. */ }
  };
  void (async () => {
    try {
      const bytes = await blob.arrayBuffer();
      if (!active) return;
      loadingTask = createDocument(new Uint8Array(bytes));
      const document = await loadingTask.promise;
      if (!active) return;
      if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
        throw new Error('pdf_preview_invalid_pages');
      }
      onReady(document);
    } catch {
      destroy();
      if (active) onError();
    }
  })();
  return () => { active = false; destroy(); };
}

/** Callers give each render a fresh canvas so cancelled renders cannot share it. */
export function renderPdfPreviewPage(
  document: PDFDocumentProxy,
  canvas: HTMLCanvasElement,
  options: { page: number; availableWidth: number; zoom: number; pixelRatio: number },
  onReady: () => void,
  onError: () => void,
) {
  let active = true;
  let renderTask: RenderTask | undefined;
  void (async () => {
    try {
      const page = await document.getPage(options.page);
      if (!active) return;
      const original = page.getViewport({ scale: 1 });
      const geometry = pdfPreviewGeometry(original.width, original.height, options.availableWidth, options.zoom, options.pixelRatio);
      canvas.width = geometry.canvasWidth;
      canvas.height = geometry.canvasHeight;
      canvas.style.width = `${geometry.displayWidth}px`;
      canvas.style.height = `${geometry.displayHeight}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('pdf_preview_canvas_unavailable');
      renderTask = page.render({ canvas, viewport: page.getViewport({ scale: geometry.renderScale }) });
      await renderTask.promise;
      if (active) onReady();
    } catch {
      if (active) onError();
    }
  })();
  return () => {
    active = false;
    try { renderTask?.cancel(); } catch { /* Already terminated. */ }
  };
}
