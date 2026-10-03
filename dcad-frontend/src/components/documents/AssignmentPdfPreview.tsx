import { useEffect, useMemo, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { loadPdfPreview, renderPdfPreviewPage } from './assignmentPdfPreviewLifecycle';

GlobalWorkerOptions.workerSrc = workerUrl;

type Props = { blob: Blob; title: string };
type Source = { blob: Blob };
type LoadedDocument = { source: Source; document: PDFDocumentProxy };
type RenderedPage = { document: PDFDocumentProxy; page: number; zoom: number; width: number; title: string; failed: boolean };

/** Lazy-loaded by the document center; preview bytes never cross an iframe. */
export default function AssignmentPdfPreview({ blob, title }: Props) {
  // A -> B -> A still creates a fresh load; the first A's proxy was destroyed.
  const source = useMemo(() => ({ blob }), [blob]);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [loadError, setLoadError] = useState<Source | null>(null);
  const [download, setDownload] = useState<{ source: Source; url: string } | null>(null);
  const [selection, setSelection] = useState({ source, page: 1, zoom: 1 });
  const [width, setWidth] = useState(640);
  const [rendered, setRendered] = useState<RenderedPage | null>(null);
  const document = loaded?.source === source ? loaded.document : null;
  const page = selection.source === source ? selection.page : 1;
  const zoom = selection.source === source ? selection.zoom : 1;
  const downloadUrl = download?.source === source ? download.url : null;
  const matchingRender = rendered?.document === document && rendered?.page === page
    && rendered?.zoom === zoom && rendered?.width === width && rendered?.title === title;
  const failed = loadError === source || (matchingRender && rendered?.failed === true);
  const busy = !failed && (!document || !matchingRender);
  const safeTitle = [...title.replace(/[\\/:*?"<>|]/g, '_')].filter((character) => character.charCodeAt(0) >= 32).join('').trim().slice(0, 180) || 'document';
  const filename = /\.pdf$/i.test(safeTitle) ? safeTitle : `${safeTitle}.pdf`;

  useEffect(() => {
    const url = URL.createObjectURL(source.blob);
    setDownload({ source, url });
    return () => URL.revokeObjectURL(url);
  }, [source]);

  useEffect(() => loadPdfPreview(
    source.blob,
    (data) => getDocument({ data, enableXfa: false }),
    (next) => { setLoaded({ source, document: next }); setLoadError(null); },
    () => setLoadError(source),
  ), [source]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setWidth(Math.max(1, Math.floor(container.clientWidth - 24)));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!document || !host) return;
    const canvas = window.document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${title}, page ${page} of ${document.numPages}`);
    canvas.className = 'block bg-white shadow-sm';
    host.replaceChildren(canvas);
    const finish = (renderFailed: boolean) => setRendered({ document, page, zoom, width, title, failed: renderFailed });
    const stop = renderPdfPreviewPage(document, canvas, {
      page, zoom, availableWidth: width, pixelRatio: window.devicePixelRatio,
    }, () => finish(false), () => finish(true));
    return () => { stop(); canvas.remove(); };
  }, [document, page, zoom, width, title]);

  const changePage = (next: number) => setSelection({ source, page: Math.max(1, Math.min(document?.numPages ?? 1, next)), zoom });
  const changeZoom = (next: number) => setSelection({ source, page, zoom: Math.max(0.5, Math.min(3, next)) });

  return (
    <section aria-label={`${title} PDF preview`} className="overflow-hidden rounded-lg border border-slate-300 bg-slate-100">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-300 bg-white p-3 text-sm">
        <button type="button" className="btn btn-sm" disabled={!document || page <= 1} onClick={() => changePage(page - 1)}>Previous page</button>
        <span aria-live="polite">Page {document ? page : '—'} of {document?.numPages ?? '—'}</span>
        <button type="button" className="btn btn-sm" disabled={!document || page >= document.numPages} onClick={() => changePage(page + 1)}>Next page</button>
        <label className="ml-auto flex items-center gap-2">
          Zoom
          <select className="select select-bordered select-sm" aria-label="PDF zoom" value={zoom} onChange={(event) => changeZoom(Number(event.target.value))}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((value) => <option key={value} value={value}>{value === 1 ? 'Fit width' : `${value * 100}%`}</option>)}
          </select>
        </label>
        {downloadUrl ? <>
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm">Open PDF</a>
          <a href={downloadUrl} download={filename} className="btn btn-sm">Download PDF</a>
        </> : null}
      </div>
      <div ref={containerRef} className="relative max-h-[80vh] min-h-64 overflow-auto p-3" style={{ scrollbarGutter: 'stable' }} aria-busy={busy}>
        {busy ? <p role="status" className="absolute inset-x-3 top-3 z-10 bg-slate-100 py-8 text-center text-sm text-slate-700">Loading PDF page…</p> : null}
        {failed ? <p role="alert" className="absolute inset-x-3 top-3 z-10 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">This PDF could not be previewed. Use Open PDF or Download PDF to review the original document.</p> : null}
        {/* Keep page geometry during painting: collapsing it can toggle the
            scrollbar, resize the viewport and repeatedly cancel the render. */}
        <div ref={canvasHostRef} style={{ visibility: busy || failed ? 'hidden' : 'visible' }} />
      </div>
      <p className="border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">Source document preview. Open or download the original PDF for selectable text and accessible reading.</p>
    </section>
  );
}
