import { createHash } from 'node:crypto';

export const SFREP_MAX_PHOTOS = 100;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalidXml = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const fail = () => { throw new Error('sfrep_photo_integrity_failed'); };
const iso = value => value == null ? null : new Date(value).toISOString();
const text = value => {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 2000 || invalidXml.test(value)) fail();
  return value.trim();
};
const attribute = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

// The router authorizes the exact assignment first. These joins also bind the
// account, organization and Custom Appraisal target. No image bytes or URLs
// are loaded while assembling the metadata snapshot.
export async function readSfrepPhotos(pool, input) {
  if (!input.includePhotos) return [];
  const { rows } = await pool.query(`
    SELECT photo.id, photo.report_file_id, photo.organization_id, photo.category,
           photo.room_label, photo.caption, photo.position, photo.revision,
           photo.status, photo.verified_at, photo.updated_at,
           assignment.account_id, assignment.id AS assignment_file_id,
           object.id AS object_id, object.variant, object.object_key,
           object.content_type, object.byte_size, object.checksum_sha256,
           object.verified_at AS object_verified_at
      FROM app.assignment_files assignment
      JOIN app.report_files report ON report.custom_assignment_file_id = assignment.id
       AND report.account_id = assignment.account_id
       AND report.organization_id = assignment.organization_id
       AND report.workflow_type = 'custom_appraisal'
      JOIN app.inspection_photos photo ON photo.report_file_id = report.id
       AND photo.organization_id = report.organization_id
       AND photo.workflow_type = 'custom_appraisal'
      LEFT JOIN LATERAL (
        SELECT id, variant, object_key, content_type, byte_size, checksum_sha256, verified_at
          FROM app.inspection_photo_objects
         WHERE photo_id = photo.id AND status = 'verified'
           AND variant IN ('display', 'original') AND verified_at IS NOT NULL
           AND checksum_sha256 ~ '^[a-f0-9]{64}$' AND byte_size > 0
           AND content_type IN ('image/jpeg', 'image/png')
         ORDER BY CASE variant WHEN 'display' THEN 0 ELSE 1 END, id LIMIT 1
      ) object ON true
     WHERE assignment.account_id = $1 AND assignment.id = $2
       AND photo.status NOT IN ('excluded', 'deleted')
     ORDER BY photo.position, photo.created_at, photo.id LIMIT 101`,
  [input.accountId, input.assignmentFileId]);
  if (rows.length > SFREP_MAX_PHOTOS) throw new Error('sfrep_evidence_limit');
  return rows;
}

export function projectSfrepPhotos(rows, input) {
  if (!input.includePhotos) return { photos: [], imageAddenda: [], formXml: [] };
  if (!Array.isArray(rows) || rows.length > SFREP_MAX_PHOTOS) throw new Error('sfrep_evidence_limit');
  const ids = new Set();
  const imageAddenda = [];
  const photos = rows.map(row => {
    if (!row || !uuid.test(row.id) || ids.has(row.id) || row.account_id !== input.accountId
      || Number(row.assignment_file_id) !== input.assignmentFileId
      || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1
      || !Number.isSafeInteger(Number(row.position)) || Number(row.position) < 1
      || !['pending_upload', 'verifying', 'verified', 'failed'].includes(row.status)) fail();
    ids.add(row.id);
    const category = text(row.category), roomLabel = text(row.room_label), caption = text(row.caption);
    // Match the existing desktop/mobile display label, including manual edits.
    const label = caption || roomLabel || category || 'Inspection photo';
    const included = row.status === 'verified' && row.object_id != null;
    const fileName = included ? `photo-${row.id.toLowerCase()}.${row.content_type === 'image/png' ? 'png' : 'jpg'}` : null;
    if (included) {
      if (!uuid.test(row.object_id) || !['display', 'original'].includes(row.variant)
        || !['image/jpeg', 'image/png'].includes(row.content_type)
        || typeof row.object_key !== 'string' || !row.object_key
        || !/^[a-f0-9]{64}$/.test(row.checksum_sha256)
        || !Number.isSafeInteger(Number(row.byte_size)) || Number(row.byte_size) < 1
        || !row.verified_at || !row.object_verified_at) fail();
      imageAddenda.push({ photoId: row.id, objectId: row.object_id, fileName, label, caption,
        variant: row.variant, byteSize: Number(row.byte_size), contentType: row.content_type,
        objectKey: row.object_key, checksumSha256: row.checksum_sha256 });
    }
    return { id: row.id, label, category, roomLabel: roomLabel || null, caption: caption || null,
      position: Number(row.position), revision: Number(row.revision), status: row.status, included,
      verifiedAt: iso(row.verified_at), variant: included ? row.variant : null,
      byteSize: included ? Number(row.byte_size) : null, fileName,
      reason: included ? null : row.status === 'verified' ? 'No verified JPEG or PNG is available.' : 'Upload is not verified yet.' };
  });
  // Editable native photo addenda, not PDF screenshots. Image/label/description
  // IDs were checked against the installed SFREP MISMO.2.6.GSE dictionary.
  const formXml = [];
  for (let offset = 0; offset < imageAddenda.length; offset += 3) {
    formXml.push(`    <Form Id="GeneralPhotos-4x6" CustomTitle="HomeNode inspection photos ${offset / 3 + 1}">`, '      <Fields>');
    imageAddenda.slice(offset, offset + 3).forEach((image, index) => {
      const slot = index + 1;
      formXml.push(`        <ImageField Id="GeneralPhoto${slot}Image" Data="${attribute(image.fileName)}" />`,
        `        <TextField Id="GeneralPhoto${slot}Label" Data="${attribute(image.label)}" />`);
      if (image.caption) formXml.push(`        <TextField Id="GeneralPhoto${slot}Description" Data="${attribute(image.caption)}" />`);
    });
    formXml.push('      </Fields>', '    </Form>');
  }
  return { photos, imageAddenda, formXml };
}

export function addSfrepPhotoViewUrls(photos, imageAddenda, storage) {
  return photos.map(photo => {
    const image = imageAddenda.find(item => item.photoId === photo.id);
    const download = image && storage?.configured ? storage.createDownloadUrl({ objectKey: image.objectKey, expiresInSeconds: 300 }) : null;
    return { ...photo, view_url: download?.url || null };
  });
}

export async function loadSfrepPhotoBytes(storage, image, { signal, maxBytes }) {
  if (!storage?.configured || typeof storage.getObject !== 'function') throw new Error('sfrep_photo_storage_unavailable');
  signal.throwIfAborted();
  const downloaded = await storage.getObject({ objectKey: image.objectKey,
    maxBytes: Math.min(image.byteSize, maxBytes), signal });
  const bytes = downloaded?.body;
  const jpeg = image.contentType === 'image/jpeg';
  if (!Buffer.isBuffer(bytes) || bytes.length !== image.byteSize || bytes.length > maxBytes
    || Number(downloaded.byte_size) !== image.byteSize
    || createHash('sha256').update(bytes).digest('hex') !== image.checksumSha256
    || (jpeg ? bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
      : !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) fail();
  signal.throwIfAborted();
  return bytes;
}
