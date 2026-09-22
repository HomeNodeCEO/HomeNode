import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import AssignmentDocumentCenter from '@/components/AssignmentDocumentCenter';
import {
  getAssignmentFiles,
  getCustomAppraisalWorkfile,
  type AppraisalAssignmentFile,
  type AssignmentDocumentApplication,
} from '@/lib/api';
import {
  createAssignmentWorkfileLink,
  deleteAssignmentWorkfileItem,
  downloadAssignmentWorkfileItem,
  getAssignmentWorkfileItems,
  uploadAssignmentWorkfileItem,
  type AssignmentWorkfileItem,
  type AssignmentWorkfileItemScope,
} from '@/lib/assignmentWorkfileItems';
import {
  getUadEditor,
  listUadAssets,
  listUadSketches,
  type UadAsset,
  type UadDocumentApplicationResult,
  type UadEditorResponse,
  type UadSketch,
} from '@/features/uad/api';

type Tab = 'overview' | 'documents' | 'files' | 'data';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  fileNumber: string;
  subjectAddress?: string;
  assignmentFileId?: number | null;
  uadWorkfileId?: string | null;
  getEditorKey?: () => string;
  onCustomAssignmentApplied?: (application: AssignmentDocumentApplication) => void;
  onUadApplied?: (result: UadDocumentApplicationResult) => void;
}

const ACCEPTED_FILES = '.pdf,.xls,.xlsx,.csv,.doc,.docx,.rtf,.txt,.jpg,.jpeg,.png,.webp,.svg';
const EMPTY_EDITOR_KEY = () => '';

function readableSize(bytes: number | null) {
  if (bytes === null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function title(value: string) {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AppraisalWorkfileModal({
  open,
  onClose,
  accountId,
  fileNumber,
  subjectAddress = '',
  assignmentFileId = null,
  uadWorkfileId = null,
  getEditorKey = EMPTY_EDITOR_KEY,
  onCustomAssignmentApplied,
  onUadApplied,
}: Props) {
  const isUad = Boolean(uadWorkfileId);
  const scope = useMemo<AssignmentWorkfileItemScope | null>(() => {
    if (uadWorkfileId) return { workflow: 'uad_3_6', uadWorkfileId };
    if (assignmentFileId && accountId) {
      return { workflow: 'custom_appraisal', accountId, assignmentFileId };
    }
    return null;
  }, [accountId, assignmentFileId, uadWorkfileId]);
  const [tab, setTab] = useState<Tab>('overview');
  const [items, setItems] = useState<AssignmentWorkfileItem[]>([]);
  const [customFile, setCustomFile] = useState<AppraisalAssignmentFile | null>(null);
  const [customWorkfile, setCustomWorkfile] = useState<Awaited<ReturnType<typeof getCustomAppraisalWorkfile>>['workfile'] | null>(null);
  const [uadEditor, setUadEditor] = useState<UadEditorResponse | null>(null);
  const [uadAssets, setUadAssets] = useState<UadAsset[]>([]);
  const [uadSketches, setUadSketches] = useState<UadSketch[]>([]);
  const [scopeMutable, setScopeMutable] = useState<boolean | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileTitle, setFileTitle] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const dialogPanel = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const loadGeneration = useRef(0);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const initiatingElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    opener.current = initiatingElement;
    return () => {
      const elementToRestore = opener.current;
      opener.current = null;
      if (elementToRestore?.isConnected) window.setTimeout(() => elementToRestore.focus(), 0);
    };
  }, [open]);

  useEffect(() => {
    loadGeneration.current += 1;
    setItems([]);
    setCustomFile(null);
    setCustomWorkfile(null);
    setUadEditor(null);
    setUadAssets([]);
    setUadSketches([]);
    setScopeMutable(null);
    setSelectedFile(null);
    setFileTitle('');
    setLinkTitle('');
    setLinkUrl('');
    setBusy(false);
    setMessage('');
  }, [scope]);

  const load = useCallback(async () => {
    if (!scope) return;
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setBusy(true);
    setMessage('');
    try {
      if (scope.workflow === 'custom_appraisal') {
        const [itemState, files, workfile] = await Promise.all([
          getAssignmentWorkfileItems(scope),
          getAssignmentFiles(accountId, scope.assignmentFileId),
          getCustomAppraisalWorkfile(accountId, scope.assignmentFileId),
        ]);
        if (loadGeneration.current !== generation) return;
        setItems(itemState.items);
        setScopeMutable(itemState.mutable);
        setCustomFile(files.files.find((file) => file.id === scope.assignmentFileId) || null);
        setCustomWorkfile(workfile.workfile);
        setUadEditor(null);
        setUadAssets([]);
        setUadSketches([]);
      } else {
        const [itemState, editor, assets, sketches] = await Promise.all([
          getAssignmentWorkfileItems(scope),
          getUadEditor(scope.uadWorkfileId),
          listUadAssets(scope.uadWorkfileId),
          listUadSketches(scope.uadWorkfileId),
        ]);
        if (loadGeneration.current !== generation) return;
        setItems(itemState.items);
        setScopeMutable(itemState.mutable);
        setUadEditor(editor);
        setUadAssets(assets);
        setUadSketches(sketches);
        setCustomFile(null);
        setCustomWorkfile(null);
      }
    } catch (error) {
      if (loadGeneration.current !== generation) return;
      setScopeMutable(null);
      setMessage(error instanceof Error ? error.message : 'The workfile could not be loaded.');
    } finally {
      if (loadGeneration.current === generation) setBusy(false);
    }
  }, [accountId, scope]);

  useEffect(() => {
    if (!open) return;
    setTab('overview');
    void load();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => closeButton.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogPanel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialogPanel.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogPanel.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      loadGeneration.current += 1;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [load, open]);

  const upload = async () => {
    if (!scope || !selectedFile) return;
    setBusy(true);
    setMessage('');
    try {
      const item = await uploadAssignmentWorkfileItem(scope, selectedFile, fileTitle);
      setItems((current) => [item, ...current]);
      setSelectedFile(null);
      setFileTitle('');
      setMessage('File added to the appraisal workfile.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The file could not be uploaded.');
    } finally {
      setBusy(false);
    }
  };

  const addLink = async () => {
    if (!scope || !linkTitle.trim() || !linkUrl.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const item = await createAssignmentWorkfileLink(scope, {
        title: linkTitle.trim(),
        external_url: linkUrl.trim(),
      });
      setItems((current) => [item, ...current]);
      setLinkTitle('');
      setLinkUrl('');
      setMessage('Link added to the appraisal workfile.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The link could not be added.');
    } finally {
      setBusy(false);
    }
  };

  const downloadItem = async (item: AssignmentWorkfileItem) => {
    if (!scope || item.item_type !== 'file') return;
    setBusy(true);
    try {
      downloadBlob(await downloadAssignmentWorkfileItem(scope, item), item.original_file_name || item.title);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The file could not be downloaded.');
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (item: AssignmentWorkfileItem) => {
    if (!scope || !window.confirm(`Remove “${item.title}” from this workfile?`)) return;
    setBusy(true);
    try {
      await deleteAssignmentWorkfileItem(scope, item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setMessage('Workfile item removed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The workfile item could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const exportData = () => {
    const data = isUad
      ? { editor: uadEditor, assets: uadAssets, sketches: uadSketches, workfile_items: items }
      : { workfile: customWorkfile, assignment_file: customFile, workfile_items: items };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${fileNumber || 'appraisal'}-workfile-data.json`);
  };

  if (!open || !scope) return null;
  const customSketch = customFile?.mobile_inspection_sketch;
  const customPhotos = customFile?.mobile_inspection_photos || [];
  const photoCount = customFile?.mobile_inspection_photos?.length || 0;
  const sectionCount = isUad ? uadEditor?.sections.length || 0 : Object.keys(customWorkfile?.sections || {}).length;
  const sketchCount = isUad ? uadSketches.length : customSketch ? 1 : 0;
  const definitelyLocked = scopeMutable === false;
  const canMutate = scopeMutable === true;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm sm:p-5" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCloseRef.current();
    }}>
      <section ref={dialogPanel} className="hn-workspace-surface flex max-h-[96vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="appraisal-workfile-title">
        <header className="hn-app-header flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4 text-white">
          <div>
            <span className="hn-eyebrow text-[10px]">Assignment workfile</span>
            <h2 id="appraisal-workfile-title" className="mt-1 text-xl font-semibold">{fileNumber || 'Active appraisal file'}</h2>
            <p className="mt-1 text-xs text-violet-100">{isUad ? 'UAD 3.6' : 'Custom Appraisal'} · {subjectAddress || accountId}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="hn-action-gold rounded-lg px-3 py-2 text-xs font-semibold" type="button" onClick={() => void load()} disabled={busy}>Refresh</button>
            <button ref={closeButton} className="hn-action-secondary rounded-lg px-3 py-2 text-xs font-semibold" type="button" onClick={onClose}>Close Workfile</button>
          </div>
        </header>

        <nav className="flex flex-wrap gap-2 border-b border-slate-200 bg-white px-4 py-3" aria-label="Workfile sections">
          {([
            ['overview', 'Overview'],
            ['documents', 'Evidence Documents'],
            ['files', 'Files & Links'],
            ['data', 'Data & Sketches'],
          ] as Array<[Tab, string]>).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setTab(value)} className={tab === value ? 'hn-action-primary rounded-lg px-3 py-2 text-xs font-semibold' : 'hn-action-secondary rounded-lg px-3 py-2 text-xs font-semibold'}>{label}</button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6">
          {message ? <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-950" role="status">{message}</div> : null}
          {tab === 'overview' ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Report sections', sectionCount],
                  ['Additional files & links', items.length],
                  ['Sketches', sketchCount],
                  [isUad ? 'Verified UAD assets' : 'Inspection photos', isUad ? uadAssets.filter((asset) => asset.status === 'verified').length : photoCount],
                ].map(([label, value]) => <div className="hn-subtle-panel rounded-xl border p-4" key={String(label)}><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div></div>)}
              </div>
              <section className="hn-subtle-panel rounded-xl border p-5">
                <h3 className="font-semibold text-slate-950">One workfile for the complete assignment</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Evidence Center PDFs, general exhibits, links, photos, sketches, and saved report data remain attached to this exact appraisal file. Open a section above to review or add material.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className="hn-action-primary rounded-lg px-4 py-2 text-sm font-semibold" type="button" onClick={() => setTab('documents')}>Review Evidence Documents</button>
                  <button className="hn-action-gold rounded-lg px-4 py-2 text-sm font-semibold" type="button" onClick={() => setTab('files')}>Add Files or Links</button>
                  <button className="hn-action-secondary rounded-lg px-4 py-2 text-sm font-semibold" type="button" onClick={() => setTab('data')}>Review Data & Sketches</button>
                </div>
              </section>
            </div>
          ) : null}

          {tab === 'documents' ? (
            <AssignmentDocumentCenter
              accountId={accountId}
              assignmentFileId={assignmentFileId}
              defaultOpen
              embedded
              getEditorKey={getEditorKey}
              onCustomAssignmentApplied={onCustomAssignmentApplied}
              onUadApplied={onUadApplied}
              readOnly={scopeMutable !== true}
              subjectAddress={subjectAddress}
              uadWorkfileId={uadWorkfileId}
            />
          ) : null}

          {tab === 'files' ? (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
              <section className="hn-subtle-panel rounded-xl border p-4">
                <h3 className="font-semibold text-slate-950">Additional workfile material</h3>
                <p className="mt-1 text-xs leading-5 text-slate-600">Upload spreadsheets, documents, images, sketch exhibits, and supporting PDFs that do not need Evidence Center extraction.</p>
                {definitelyLocked ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">This appraisal is locked. Its saved workfile remains available for review and download, but new material cannot be added.</p> : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Optional title</span><input className="input input-bordered input-sm mt-1 w-full bg-white" value={fileTitle} onChange={(event) => setFileTitle(event.target.value)} placeholder="Defaults to the file name" disabled={!canMutate} /></label>
                  <label className="block"><span className="text-xs font-semibold uppercase tracking-wide text-slate-600">File</span><input className="file-input file-input-bordered file-input-sm mt-1 w-full bg-white" type="file" accept={ACCEPTED_FILES} disabled={!canMutate} onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} /></label>
                </div>
                <button className="hn-action-primary mt-3 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" type="button" onClick={() => void upload()} disabled={busy || !canMutate || !selectedFile}>{busy ? 'Working…' : 'Add File to Workfile'}</button>
                <div className="my-5 border-t border-slate-200" />
                <h4 className="text-sm font-semibold text-slate-900">Add a research or source link</h4>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Link title</span><input className="input input-bordered input-sm mt-1 w-full bg-white" value={linkTitle} onChange={(event) => setLinkTitle(event.target.value)} placeholder="City zoning map" disabled={!canMutate} /></label>
                  <label className="block"><span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Web address</span><input className="input input-bordered input-sm mt-1 w-full bg-white" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://…" inputMode="url" disabled={!canMutate} /></label>
                </div>
                <button className="hn-action-gold mt-3 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" type="button" onClick={() => void addLink()} disabled={busy || !canMutate || !linkTitle.trim() || !linkUrl.trim()}>Add Link to Workfile</button>
              </section>
              <section className="hn-subtle-panel rounded-xl border p-4">
                <div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-slate-950">Saved files & links</h3><span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-900">{items.length}</span></div>
                <div className="mt-3 space-y-2">
                  {items.length ? items.map((item) => <article className="rounded-lg border border-slate-200 bg-white p-3" key={item.id}>
                    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-950">{item.title}</div><div className="mt-1 text-xs text-slate-500">{item.item_type === 'file' ? `${item.original_file_name} · ${readableSize(item.file_size_bytes)}` : item.external_url}</div></div>{canMutate ? <button className="text-xs font-semibold text-rose-700" type="button" onClick={() => void removeItem(item)}>Remove</button> : null}</div>
                    <div className="mt-2">{item.item_type === 'file' ? <button className="hn-action-secondary rounded-lg px-3 py-1.5 text-xs font-semibold" type="button" onClick={() => void downloadItem(item)}>Download</button> : <a className="hn-action-secondary inline-flex rounded-lg px-3 py-1.5 text-xs font-semibold" href={item.external_url || '#'} target="_blank" rel="noreferrer">Open Link</a>}</div>
                  </article>) : <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">No additional files or links have been added. Evidence Center PDFs are available on their own tab.</p>}
                </div>
              </section>
            </div>
          ) : null}

          {tab === 'data' ? (
            <div className="space-y-5">
              <section className="hn-subtle-panel rounded-xl border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-950">Saved report data</h3><p className="mt-1 text-xs text-slate-600">Review what is stored with this assignment without placing internal record identifiers in the client report.</p></div><button className="hn-action-gold rounded-lg px-3 py-2 text-xs font-semibold" type="button" onClick={exportData}>Download Data Copy</button></div>
                <div className="mt-4 grid gap-2 md:grid-cols-2">
                  {isUad ? uadEditor?.sections.map((section) => {
                    const completion = uadEditor.completion[section.key];
                    return <div className="rounded-lg border border-slate-200 bg-white p-3" key={section.key}><div className="text-sm font-semibold text-slate-900">Section {section.officialSectionNumber}: {section.title}</div><div className="mt-1 text-xs text-slate-500">{completion?.completed || 0} of {completion?.required || 0} required · {completion?.percent || 0}%</div></div>;
                  }) : Object.entries(customWorkfile?.sections || {}).map(([key, section]) => <details className="rounded-lg border border-slate-200 bg-white p-3" key={key}><summary className="cursor-pointer text-sm font-semibold text-slate-900">{title(key)} · revision {section.revision}</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-600">{JSON.stringify(section.value, null, 2)}</pre></details>)}
                </div>
              </section>
              <section className="hn-subtle-panel rounded-xl border p-4">
                <h3 className="font-semibold text-slate-950">Photos and media</h3>
                <p className="mt-1 text-xs text-slate-600">Inspection photographs and verified report assets already attached to this assignment.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {isUad ? uadAssets.map((asset) => <article className="rounded-lg border border-slate-200 bg-white p-3" key={asset.id}><div className="truncate text-sm font-semibold text-slate-950">{asset.caption || asset.original_file_name || title(asset.asset_kind)}</div><div className="mt-1 text-xs text-slate-500">{title(asset.asset_kind)} · {asset.status}{asset.byte_size === null ? '' : ` · ${readableSize(asset.byte_size)}`}</div></article>) : customPhotos.map((photo) => <article className="rounded-lg border border-slate-200 bg-white p-3" key={photo.id}><div className="truncate text-sm font-semibold text-slate-950">{photo.caption || photo.room_label || title(photo.category)}</div><div className="mt-1 text-xs text-slate-500">{title(photo.category)} · {title(photo.origin_channel)} · verified</div>{photo.view_url ? <a className="mt-2 inline-block text-xs font-semibold text-violet-700 underline" href={photo.view_url} target="_blank" rel="noreferrer">Open photo</a> : null}</article>)}
                  {(isUad ? uadAssets.length : customPhotos.length) === 0 ? <p className="text-sm text-slate-600">No photos or media assets have been saved yet.</p> : null}
                </div>
              </section>
              <section className="hn-subtle-panel rounded-xl border p-4">
                <h3 className="font-semibold text-slate-950">Sketches and calculated area</h3>
                {isUad ? (uadSketches.length ? <div className="mt-3 grid gap-3 md:grid-cols-2">{uadSketches.map((sketch) => <article className="rounded-lg border border-slate-200 bg-white p-3" key={sketch.id}><div className="text-sm font-semibold">Revision {sketch.revision} · {title(sketch.source)}</div><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-slate-600">{JSON.stringify(sketch.calculated_areas, null, 2)}</pre></article>)}</div> : <p className="mt-2 text-sm text-slate-600">No UAD sketch has been saved yet.</p>) : customSketch ? <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
                  ['Revision', customSketch.revision],
                  ['Net GLA', `${(customSketch.summary.net_gla_sqft ?? customSketch.summary.above_grade_finished_sqft).toLocaleString()} sq. ft.`],
                  ['Areas', customSketch.summary.area_count],
                  ['Rooms', customSketch.summary.room_count],
                ].map(([label, value]) => <div className="rounded-lg border border-slate-200 bg-white p-3" key={String(label)}><dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-950">{value}</dd></div>)}</dl> : <p className="mt-2 text-sm text-slate-600">No measured sketch has been saved yet.</p>}
              </section>
            </div>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
