import {
  fetchJSON,
  fetchWithApplicationAuthentication,
  makeUrl,
} from '@/lib/api';

export interface AssignmentWorkfileItem {
  id: string;
  item_type: 'file' | 'link';
  title: string;
  original_file_name: string | null;
  content_type: string | null;
  file_size_bytes: number | null;
  checksum_sha256: string | null;
  external_url: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export type AssignmentWorkfileItemScope =
  | { workflow: 'custom_appraisal'; accountId: string; assignmentFileId: number }
  | { workflow: 'uad_3_6'; uadWorkfileId: string };

function itemsPath(scope: AssignmentWorkfileItemScope) {
  return scope.workflow === 'custom_appraisal'
    ? `/api/accounts/${encodeURIComponent(scope.accountId.trim())}/assignment-files/${encodeURIComponent(String(scope.assignmentFileId))}/workfile/items`
    : `/api/appraisal-workfiles/uad/${encodeURIComponent(scope.uadWorkfileId)}/items`;
}

export async function getAssignmentWorkfileItems(scope: AssignmentWorkfileItemScope) {
  const response = await fetchJSON<{ ok: true; items: AssignmentWorkfileItem[]; mutable: boolean }>(
    makeUrl(itemsPath(scope)),
    { cache: 'no-store' },
  );
  return { items: response.items || [], mutable: response.mutable === true };
}

export async function uploadAssignmentWorkfileItem(
  scope: AssignmentWorkfileItemScope,
  file: File,
  title = '',
) {
  const response = await fetchJSON<{ ok: true; item: AssignmentWorkfileItem }>(
    makeUrl(`${itemsPath(scope)}/files`),
    {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-workfile-file-name': encodeURIComponent(file.name),
        'x-workfile-item-title': encodeURIComponent(title.trim() || file.name),
      },
      body: file,
      timeoutMs: 120_000,
    },
  );
  return response.item;
}

export async function createAssignmentWorkfileLink(
  scope: AssignmentWorkfileItemScope,
  input: { title: string; external_url: string },
) {
  const response = await fetchJSON<{ ok: true; item: AssignmentWorkfileItem }>(
    makeUrl(`${itemsPath(scope)}/links`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return response.item;
}

export async function downloadAssignmentWorkfileItem(
  scope: AssignmentWorkfileItemScope,
  item: AssignmentWorkfileItem,
) {
  const response = await fetchWithApplicationAuthentication(
    makeUrl(`${itemsPath(scope)}/${encodeURIComponent(item.id)}/content`),
    { cache: 'no-store' },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return response.blob();
}

export async function deleteAssignmentWorkfileItem(
  scope: AssignmentWorkfileItemScope,
  itemId: string,
) {
  const response = await fetchWithApplicationAuthentication(
    makeUrl(`${itemsPath(scope)}/${encodeURIComponent(itemId)}`),
    { method: 'DELETE' },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
}
