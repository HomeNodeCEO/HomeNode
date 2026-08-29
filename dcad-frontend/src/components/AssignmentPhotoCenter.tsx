import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createAssignmentPhotoUpload,
  getAssignmentPhotos,
  removeAssignmentPhoto,
  verifyAssignmentPhotoUpload,
  type AssignmentPhoto,
  type AssignmentPhotoUploadRequest,
} from '@/lib/api';

const CATEGORIES = [
  'Front', 'Rear', 'Street', 'Kitchen', 'Living area', 'Bedroom', 'Bathroom',
  'Garage', 'Attic', 'Mechanical systems', 'Site/view', 'Defect', 'Repair item',
  'Additional improvement', 'Other',
];
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 50 * 1024 * 1024;

async function displayDerivative(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2048 / Math.max(1, bitmap.width));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('desktop_photo_canvas_unavailable');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error('desktop_photo_derivative_failed')),
      'image/jpeg',
      0.86,
    ));
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}

async function prepareUpload(file: File, category: string, caption: string) {
  if (!ALLOWED_TYPES.has(file.type)) throw new Error('Desktop upload accepts JPEG, PNG, or WebP images.');
  if (!file.size || file.size > MAX_BYTES) throw new Error('Each photo must be between 1 byte and 50 MB.');
  const display = await displayDerivative(file);
  const clientPhotoId = crypto.randomUUID();
  const originalObjectId = crypto.randomUUID();
  const displayObjectId = crypto.randomUUID();
  const stem = file.name.replace(/\.[^.]+$/, '') || 'appraisal-photo';
  const request: AssignmentPhotoUploadRequest = {
    client_photo_id: clientPhotoId,
    category,
    caption: caption.trim() || category,
    captured_at: file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString(),
    objects: [
      {
        client_object_id: originalObjectId,
        variant: 'original',
        file_name: file.name,
        content_type: file.type,
        byte_size: file.size,
      },
      {
        client_object_id: displayObjectId,
        variant: 'display',
        file_name: `${stem}-display.jpg`,
        content_type: 'image/jpeg',
        byte_size: display.blob.size,
        width: display.width,
        height: display.height,
      },
    ],
  };
  return { request, files: { original: file, display: display.blob } };
}

export default function AssignmentPhotoCenter({
  accountId,
  assignmentFileId,
  getEditorKey,
  readOnly = false,
  className = '',
}: {
  accountId: string;
  assignmentFileId?: number | null;
  getEditorKey: () => string;
  readOnly?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<AssignmentPhoto[]>([]);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!accountId || !assignmentFileId) return;
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setBusy(true);
    try {
      const result = await getAssignmentPhotos(accountId, assignmentFileId, editorKey);
      setPhotos(result.photos);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Photo evidence could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [accountId, assignmentFileId, getEditorKey]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const upload = async (files: FileList | null) => {
    if (!files?.length || !assignmentFileId) return;
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setBusy(true);
    setMessage('');
    try {
      for (const file of Array.from(files)) {
        const prepared = await prepareUpload(file, category, caption);
        const registered = await createAssignmentPhotoUpload(
          accountId,
          assignmentFileId,
          prepared.request,
          editorKey,
        );
        for (const uploadRequest of registered.uploads) {
          const body = prepared.files[uploadRequest.variant];
          const response = await fetch(uploadRequest.url, {
            method: uploadRequest.method,
            headers: uploadRequest.headers,
            body,
          });
          if (!response.ok) throw new Error(`Photo upload failed (${response.status}).`);
        }
        await verifyAssignmentPhotoUpload(accountId, assignmentFileId, registered.photo.id, editorKey);
      }
      setCaption('');
      if (inputRef.current) inputRef.current.value = '';
      await load();
      setMessage('Photo evidence was verified and saved to this appraisal file.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Photo upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (photo: AssignmentPhoto) => {
    if (!assignmentFileId || photo.origin_channel !== 'desktop') return;
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setBusy(true);
    try {
      await removeAssignmentPhoto(accountId, assignmentFileId, photo.id, editorKey);
      await load();
      setMessage(photo.status === 'verified'
        ? 'The photo was removed from the report but retained as excluded appraisal evidence.'
        : 'The unfinished photo upload was removed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Photo removal failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`hn-custom-section ${open ? 'hn-custom-section-active' : ''} rounded-2xl border ${className}`}
      data-section-expanded={open ? 'true' : 'false'}
    >
      <button type="button" className={`hn-custom-section-header ${open ? 'hn-custom-section-header-active' : ''} flex w-full items-center justify-between gap-4 px-5 py-4 text-left`} onClick={() => setOpen((value) => !value)}>
        <span>
          <span className="hn-custom-section-title block text-sm font-semibold uppercase tracking-[0.16em]">Appraisal Photo Evidence</span>
          <span className="mt-1 block text-xs text-slate-500">Shared mobile and desktop photos saved to this appraisal file</span>
        </span>
        <span className={open ? 'hn-action-gold rounded-lg px-3 py-2 text-xs font-semibold' : 'hn-action-secondary rounded-lg px-3 py-2 text-xs font-semibold'}>{open ? 'Collapse' : 'Manage Photos'}</span>
      </button>
      {open ? (
        <div className="border-t border-slate-200 p-5">
          {!assignmentFileId ? (
            <p className="text-sm text-amber-700">Create or open an appraisal file before adding photos.</p>
          ) : (
            <>
              {!readOnly ? (
                <div className="grid gap-3 rounded-xl bg-slate-50 p-3 md:grid-cols-[180px_1fr_auto] md:items-end">
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Category
                    <select className="select select-bordered mt-1 w-full bg-white" value={category} onChange={(event) => setCategory(event.target.value)}>
                      {CATEGORIES.map((value) => <option key={value}>{value}</option>)}
                    </select>
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Caption
                    <input className="input input-bordered mt-1 w-full bg-white" maxLength={200} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Optional; category used by default" />
                  </label>
                  <label className={`hn-action-primary btn btn-primary btn-sm normal-case rounded-lg ${busy ? 'btn-disabled' : ''}`}>
                    {busy ? 'Saving...' : 'Add Photos'}
                    <input ref={inputRef} className="hidden" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={(event) => void upload(event.target.files)} />
                  </label>
                </div>
              ) : (
                <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">Signed files are read-only. Their verified photos remain retained and viewable.</p>
              )}
              {message ? <p className="mt-3 text-sm text-slate-700">{message}</p> : null}
              {photos.length ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {photos.map((photo) => (
                    <article key={photo.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                      {photo.view_url ? <img src={photo.view_url} alt={photo.caption || photo.category} className="h-36 w-full object-cover" /> : <div className="grid h-36 place-items-center bg-slate-100 text-xs text-slate-500">Upload pending verification</div>}
                      <div className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div><p className="text-sm font-semibold text-slate-900">{photo.caption || photo.category}</p><p className="text-xs text-slate-500">{photo.category}</p></div>
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase text-slate-600">{photo.origin_channel}</span>
                        </div>
                        {photo.retention_until ? <p className="mt-2 text-[11px] text-slate-500">Retained through {new Date(photo.retention_until).toLocaleDateString()}</p> : null}
                        {!readOnly && photo.origin_channel === 'desktop' ? <button type="button" className="mt-2 text-xs font-semibold text-rose-700" disabled={busy} onClick={() => void remove(photo)}>Remove from report</button> : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : !busy ? <p className="mt-4 text-sm text-slate-500">No verified mobile or desktop photos are attached to this file yet.</p> : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
