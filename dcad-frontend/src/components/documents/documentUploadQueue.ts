import type { AssignmentDocumentType } from '@/lib/api';

export const DOCUMENT_UPLOAD_LIMITS = Object.freeze({
  files: 20,
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
});

export const DOCUMENT_UPLOAD_TYPES: ReadonlyArray<readonly [AssignmentDocumentType, string]> = [
  ['zoning_map', 'Zoning Map'],
  ['zoning_ordinance', 'Zoning Ordinance / Code'],
  ['purchase_contract', 'Purchase Contract'],
  ['engagement_letter', 'Engagement Letter'],
  ['mls_sheet', 'MLS Sheet'],
  ['map', 'Other Map'],
  ['other', 'Other Appraisal Document'],
];

export interface DocumentUploadMetadata {
  documentType: AssignmentDocumentType;
  title: string;
}

export interface DocumentUploadItem extends DocumentUploadMetadata {
  id: string;
  file: File;
  status: 'queued' | 'uploading' | 'uploaded' | 'failed';
  error: string;
}

function sameFile(left: File, right: File) {
  return left.name === right.name && left.size === right.size && left.lastModified === right.lastModified;
}

/** Retain original File objects and metadata; reselecting a failed file cannot silently retry it. */
export function addDocumentUploadFiles(
  current: readonly DocumentUploadItem[],
  files: readonly File[],
  documentType: AssignmentDocumentType,
  makeId: () => string = () => crypto.randomUUID(),
): { items: DocumentUploadItem[]; messages: string[] } {
  const items = [...current];
  const messages: string[] = [];
  let rejected = 0;
  let bytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const reject = (message: string) => {
    rejected += 1;
    if (messages.length < 8) messages.push(message);
  };
  for (const file of files) {
    const isPdf = file.type.toLowerCase() === 'application/pdf'
      || (!file.type && /\.pdf$/i.test(file.name));
    if (!isPdf) {
      reject(`${file.name}: choose a PDF file.`);
    } else if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > DOCUMENT_UPLOAD_LIMITS.fileBytes) {
      reject(`${file.name}: each PDF must be nonempty and no larger than 25 MiB.`);
    } else if (items.some(item => sameFile(item.file, file))) {
      reject(`${file.name}: already in this queue; its existing status was kept.`);
    } else if (items.length >= DOCUMENT_UPLOAD_LIMITS.files) {
      reject(`${file.name}: the queue holds up to 20 files. Remove finished files before adding more.`);
    } else if (bytes + file.size > DOCUMENT_UPLOAD_LIMITS.totalBytes) {
      reject(`${file.name}: the queue can hold up to 100 MiB. Remove finished files before adding more.`);
    } else {
      items.push({ id: makeId(), file, documentType, title: file.name, status: 'queued', error: '' });
      bytes += file.size;
    }
  }
  if (rejected > messages.length) messages.push(`${rejected - messages.length} more files could not be added.`);
  return { items, messages };
}

interface UploadRunOptions {
  mode: 'queued' | 'failed';
  upload: (file: File, metadata: DocumentUploadMetadata) => Promise<void>;
  update: (item: DocumentUploadItem) => void;
  blocked: () => boolean;
}

/** One runner per mounted queue. Cancellation stops later requests, never assumes an in-flight upload failed. */
export function createDocumentUploadRunner() {
  let active = false;
  let cancelled = false;
  return {
    cancel() { cancelled = true; },
    async run(items: readonly DocumentUploadItem[], options: UploadRunOptions) {
      const result = { started: false, uploaded: 0, failed: 0, cancelled: false };
      if (active || options.blocked()) return result;
      active = true;
      cancelled = false;
      result.started = true;
      // Snapshot eligibility and labels before the first asynchronous request.
      const selected = items.filter(item => item.status === options.mode).map(item => ({ ...item }));
      try {
        for (const item of selected) {
          if (cancelled || options.blocked()) break;
          options.update({ ...item, status: 'uploading', error: '' });
          try {
            await options.upload(item.file, { documentType: item.documentType, title: item.title || item.file.name });
            result.uploaded += 1;
            options.update({ ...item, status: 'uploaded', error: '' });
          } catch (error) {
            result.failed += 1;
            options.update({
              ...item,
              status: 'failed',
              error: error instanceof Error && error.message ? error.message.slice(0, 350) : 'The upload did not finish.',
            });
          }
        }
        result.cancelled = cancelled || options.blocked();
        return result;
      } finally {
        active = false;
      }
    },
  };
}
