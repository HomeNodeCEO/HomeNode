import {
  fetchJSON,
  fetchWithApplicationAuthentication,
  makeUrl,
  type AssignmentDocument,
  type EvidenceVersion,
  type PropertyTaxProtestFile,
} from '@/lib/api';

function propertyTaxPath(accountId: string, fileId?: string): string {
  const accountPath = `/api/accounts/${encodeURIComponent(accountId)}/property-tax-protest`;
  return fileId ? `${accountPath}/${encodeURIComponent(fileId)}` : accountPath;
}

export async function getPropertyTaxProtestFile(
  accountId: string,
  fileId?: string,
): Promise<PropertyTaxProtestFile | null> {
  const params = fileId ? `?file_id=${encodeURIComponent(fileId)}` : '';
  const response = await fetchJSON<{ account_id: string; file: PropertyTaxProtestFile | null }>(
    makeUrl(`${propertyTaxPath(accountId)}${params}`),
  );
  return response.file;
}

export async function getPropertyTaxEvidenceVersion(
  accountId: string,
  fileId: string,
): Promise<EvidenceVersion> {
  const response = await fetchJSON<{ account_id: string; file: EvidenceVersion }>(
    makeUrl(`${propertyTaxPath(accountId, fileId)}/evidence/version`),
    { cache: 'no-store', timeoutMs: 10_000, retryTransient: true },
  );
  return response.file;
}

export async function updatePropertyTaxProtestFile(
  accountId: string,
  fileId: string,
  input: { expected_revision: number; workfile_data: Record<string, unknown>; reviewer?: string },
  editorKey: string,
): Promise<PropertyTaxProtestFile> {
  const response = await fetchJSON<{ ok: true; file: PropertyTaxProtestFile }>(
    makeUrl(propertyTaxPath(accountId, fileId)),
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-homenode-editor-key': editorKey,
      },
      body: JSON.stringify(input),
    },
  );
  return response.file;
}

export async function getPropertyTaxDocuments(
  accountId: string,
  fileId: string,
): Promise<AssignmentDocument[]> {
  const response = await fetchJSON<{ ok: true; documents: AssignmentDocument[] }>(
    makeUrl(`${propertyTaxPath(accountId, fileId)}/documents`),
  );
  return response.documents;
}

export async function getPropertyTaxDocument(
  accountId: string,
  fileId: string,
  documentId: number,
): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`${propertyTaxPath(accountId, fileId)}/documents/${documentId}`),
  );
  return response.document;
}

export async function getPropertyTaxDocumentContent(
  accountId: string,
  fileId: string,
  documentId: number,
): Promise<Blob> {
  const response = await fetchWithApplicationAuthentication(
    makeUrl(`${propertyTaxPath(accountId, fileId)}/documents/${documentId}/content`),
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return response.blob();
}

export async function uploadPropertyTaxDocument(
  accountId: string,
  fileId: string,
  file: File,
  metadata: {
    documentType: 'district_evidence' | 'mls_sheet' | 'other';
    title?: string;
    uploadedBy?: string;
  },
  editorKey: string,
): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`${propertyTaxPath(accountId, fileId)}/documents`),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-homenode-editor-key': editorKey,
        'x-document-type': encodeURIComponent(metadata.documentType),
        'x-document-title': encodeURIComponent(metadata.title || file.name),
        'x-document-file-name': encodeURIComponent(file.name),
        'x-document-uploaded-by': encodeURIComponent(metadata.uploadedBy || ''),
      },
      body: file,
      timeoutMs: 120_000,
    },
  );
  return response.document;
}

export async function deletePropertyTaxDocument(
  accountId: string,
  fileId: string,
  documentId: number,
  editorKey: string,
): Promise<void> {
  await fetchJSON(
    makeUrl(`${propertyTaxPath(accountId, fileId)}/documents/${documentId}`),
    { method: 'DELETE', headers: { 'x-homenode-editor-key': editorKey } },
  );
}

export async function reprocessPropertyTaxDocument(
  accountId: string,
  fileId: string,
  documentId: number,
  editorKey: string,
): Promise<AssignmentDocument> {
  const response = await fetchJSON<{ ok: true; document: AssignmentDocument }>(
    makeUrl(`${propertyTaxPath(accountId, fileId)}/documents/${documentId}/reprocess`),
    { method: 'POST', headers: { 'x-homenode-editor-key': editorKey }, timeoutMs: 120_000 },
  );
  return response.document;
}
