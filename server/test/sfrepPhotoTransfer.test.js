import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readSfrepPhotos, projectSfrepPhotos, addSfrepPhotoViewUrls, loadSfrepPhotoBytes } from '../src/services/sfrepPhotoTransfer.js';
import { sfrepTransferInput, previewSfrepDocuments, packageSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { checkSfrepPreview } from '../../dcad-frontend/src/features/sfrep/sfrepTransport.ts';

const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#7c3aed' } }).png().toBuffer();
const checksum = value => createHash('sha256').update(value).digest('hex');
const options = () => ({ accountId: 'synthetic-account', assignmentFileId: 14, documentIds: [],
  includeDocuments: false, includePhotos: true, formId: 'FNMA-1004-0911' });
const photo = (index = 1, change = {}) => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  account_id: 'synthetic-account', assignment_file_id: 14, category: 'Front', room_label: null,
  caption: 'North exterior', position: index, revision: 1, status: 'verified',
  verified_at: '2026-10-06T12:00:00Z', object_verified_at: '2026-10-06T12:00:00Z',
  object_id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, variant: 'display',
  object_key: `private/synthetic/photo-${index}.png`, content_type: 'image/png', byte_size: png.length,
  checksum_sha256: checksum(png), ...change });

function entries(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18), nameSize = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28), start = offset + 30 + nameSize + extra;
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString();
    files.set(name, buffer.subarray(start, start + size)); offset = start + size;
  }
  return files;
}

test('optional photo inclusion is backward compatible and strictly boolean', () => {
  const request = { assignment_file_id: 14, document_ids: [], include_documents: false, form_id: options().formId };
  assert.equal(sfrepTransferInput(request).includePhotos, false);
  assert.equal(sfrepTransferInput({ ...request, include_photos: true }).includePhotos, true);
  for (const include_photos of ['true', 1, null, [], {}]) assert.throws(() => sfrepTransferInput({ ...request, include_photos }), /invalid_sfrep_request/);
});

test('one bounded metadata query binds account, organization, assignment, workflow and verified image objects', async () => {
  const rows = [photo()]; let reads = 0;
  const result = await readSfrepPhotos({ query: async (sql, values) => {
    reads++; assert.deepEqual(values, ['synthetic-account', 14]);
    for (const expected of ['report.custom_assignment_file_id = assignment.id',
      'report.organization_id = assignment.organization_id', 'photo.organization_id = report.organization_id',
      "photo.workflow_type = 'custom_appraisal'", "status = 'verified'", "photo.status NOT IN ('excluded', 'deleted')", 'LIMIT 101']) assert.ok(sql.includes(expected));
    assert.doesNotMatch(sql, /createDownloadUrl|signed_url|photo\.content\b/);
    return { rows };
  } }, options());
  assert.equal(result, rows); assert.equal(reads, 1);
  assert.deepEqual(await readSfrepPhotos({ query() { assert.fail('no read when disabled'); } }, { ...options(), includePhotos: false }), []);
  await assert.rejects(readSfrepPhotos({ query: async () => ({ rows: Array(101).fill(photo()) }) }, options()), /evidence_limit/);
});

test('photos retain labels and captions and use native repeatable SFREP photo fields without blank slots', () => {
  const projected = projectSfrepPhotos([photo(), photo(2, { category: 'Kitchen', room_label: 'Kitchen / first floor', caption: 'North "wall"\n<roof & trim>' }),
    photo(3), photo(4)], options());
  assert.equal(projected.photos[1].label, 'North "wall"\n<roof & trim>');
  assert.equal(projected.photos[1].included, true);
  const xml = projected.formXml.join('\n');
  assert.equal((xml.match(/<Form /g) || []).length, 2);
  assert.equal((xml.match(/<ImageField /g) || []).length, 4);
  assert.match(xml, /GeneralPhoto2Label" Data="North &quot;wall&quot;&#10;&lt;roof &amp; trim&gt;/);
  assert.match(xml, /North &quot;wall&quot;&#10;&lt;roof &amp; trim&gt;/);
  assert.match(xml, /GeneralPhotos-4x6/);
  assert.doesNotMatch(xml, /Data=""/);
  assert.doesNotMatch(xml, /GeneralPhoto\dDescription/, 'Do not duplicate the existing display label as a second description line.');
  assert.equal(projectSfrepPhotos([photo(1, { caption: null, room_label: 'Kitchen / first floor' })], options()).photos[0].label, 'Kitchen / first floor');
  assert.equal(projectSfrepPhotos([photo(1, { caption: null })], options()).photos[0].label, 'Front');
  assert.equal(projectSfrepPhotos(Array.from({ length: 100 }, (_, index) => photo(index + 1)), options()).imageAddenda.length, 100);
});

test('pending and failed uploads stay visible but never become exportable or verified', () => {
  const pending = photo(1, { status: 'pending_upload', verified_at: null, object_id: null });
  const failed = photo(2, { status: 'failed', verified_at: null, object_id: null });
  const projected = projectSfrepPhotos([pending, failed, photo(3, { object_id: null })], options());
  assert.equal(projected.imageAddenda.length, 0); assert.equal(projected.formXml.length, 0);
  assert.ok(projected.photos.every(value => !value.included && value.fileName === null && value.reason));
});

test('foreign ownership, duplicate IDs, deleted records and unsafe or unverified image metadata fail closed', () => {
  for (const change of [{ account_id: 'foreign-account' }, { assignment_file_id: 15 }, { id: '../../path' },
    { status: 'deleted' }, { revision: 0 }, { position: 0 }, { caption: 'bad\u0000caption' },
    { checksum_sha256: 'wrong' }, { byte_size: 0 }, { object_key: '' }, { content_type: 'image/heic' },
    { verified_at: null }, { object_verified_at: null }, { object_id: 'bad-id' }, { variant: 'thumbnail' }]) {
    assert.throws(() => projectSfrepPhotos([photo(1, change)], options()), /photo_integrity_failed/);
  }
  assert.throws(() => projectSfrepPhotos([photo(), photo()], options()), /photo_integrity_failed/);
});

test('photo digest binds membership, labels, revisions, bytes, checksums and inclusion but excludes expiring URLs', () => {
  const input = options(), original = previewSfrepDocuments([], input, [photo()]);
  assert.equal(original.preview_digest, previewSfrepDocuments([], input, [photo()]).preview_digest);
  for (const change of [{ caption: 'Different wall' }, { room_label: 'Garage' }, { revision: 2 },
    { checksum_sha256: 'a'.repeat(64) }, { byte_size: png.length + 1 }, { object_key: 'different/private/key' }]) {
    assert.notEqual(original.preview_digest, previewSfrepDocuments([], input, [photo(1, change)]).preview_digest);
  }
  assert.notEqual(original.preview_digest, previewSfrepDocuments([], { ...input, includePhotos: false }, [photo()]).preview_digest);
  assert.notEqual(original.preview_digest, previewSfrepDocuments([], input, [photo(), photo(2)]).preview_digest);
  let views = 0;
  const storage = { configured: true, createDownloadUrl() { return { url: `https://synthetic.example/photo?token=${++views}` }; } };
  assert.notEqual(addSfrepPhotoViewUrls(original.photos, original.imageAddenda, storage)[0].view_url,
    addSfrepPhotoViewUrls(original.photos, original.imageAddenda, storage)[0].view_url);
  assert.equal(original.preview_digest, previewSfrepDocuments([], input, [photo()]).preview_digest);
  const { reportXml: _xml, pdfAddenda: _pdfs, imageAddenda: _images, ...publicPreview } = original;
  const publicValue = { ok: true, ...publicPreview, photos: addSfrepPhotoViewUrls(original.photos, original.imageAddenda, storage) };
  assert.equal(checkSfrepPreview(publicValue, []), publicValue);
  assert.doesNotMatch(JSON.stringify(publicValue), /objectKey|checksumSha256|private\/synthetic/);
});

test('photo-only 1004 RPTI embeds the exact verified PNG and label and cannot fetch with a stale preview', async () => {
  const input = options(), preview = previewSfrepDocuments([], input, [photo()]); let reads = 0;
  const storage = { configured: true, async getObject(request) {
    reads++; assert.equal(request.objectKey, photo().object_key); assert.equal(request.maxBytes, png.length);
    assert.ok(request.signal instanceof AbortSignal); return { body: png, byte_size: png.length };
  } };
  await assert.rejects(packageSfrepDocuments({}, storage, [], preview, { ...input, previewDigest: '0'.repeat(64) }), /preview_changed/);
  assert.equal(reads, 0);
  const result = await packageSfrepDocuments({}, storage, [], preview, { ...input, previewDigest: preview.preview_digest });
  const files = entries(result.content), name = `Images/photo-${photo().id}.png`;
  assert.deepEqual([...files.keys()].sort(), [name, 'Report.xml']);
  assert.deepEqual(files.get(name), png);
  assert.match(files.get('Report.xml').toString(), /FNMA-1004-0911/);
  assert.match(files.get('Report.xml').toString(), /GeneralPhoto1Label" Data="North exterior"/);
  assert.equal((await sharp(files.get(name)).metadata()).width, 8);
});

test('combined report, source PDF and verified photo are preserved in one RPTI', async () => {
  const pdf = Buffer.from('%PDF-1.7 synthetic source'), input = { ...options(), documentIds: [2], includeDocuments: true };
  const source = { id: 2, account_id: input.accountId, assignment_file_id: 14, document_type: 'engagement_letter',
    title: 'Synthetic engagement', file_name: 'synthetic.pdf', content_type: 'application/pdf',
    file_size_bytes: pdf.length, checksum_sha256: checksum(pdf), processing_status: 'reviewed',
    candidates: [{ id: 20, document_id: 2, field_key: 'lender_client_name', confirmed_value: 'Synthetic Bank', review_status: 'confirmed' }] };
  const preview = previewSfrepDocuments([source], input, [photo()]);
  const result = await packageSfrepDocuments({}, { configured: true, getObject: async () => ({ body: png, byte_size: png.length }) }, [source], preview,
    { ...input, previewDigest: preview.preview_digest }, { loadContent: async () => ({ ...source, content: pdf }) });
  const files = entries(result.content);
  assert.equal(files.size, 3);
  assert.deepEqual(files.get('Pdf/document-2.pdf'), pdf);
  assert.deepEqual(files.get(`Images/photo-${photo().id}.png`), png);
  const xml = files.get('Report.xml').toString();
  assert.match(xml, /Synthetic Bank/); assert.match(xml, /<PdfField /); assert.match(xml, /<ImageField /);
});

test('download rechecks bytes, checksum and signature and obeys cancellation and storage availability', async () => {
  const image = projectSfrepPhotos([photo()], options()).imageAddenda[0];
  for (const downloaded of [{ body: Buffer.from('tampered'), byte_size: png.length },
    { body: png, byte_size: png.length + 1 }, { body: png.subarray(0, -1), byte_size: png.length - 1 }]) {
    await assert.rejects(loadSfrepPhotoBytes({ configured: true, getObject: async () => downloaded }, image,
      { signal: new AbortController().signal, maxBytes: png.length }), /photo_integrity_failed/);
  }
  await assert.rejects(loadSfrepPhotoBytes({}, image, { signal: new AbortController().signal, maxBytes: png.length }), /storage_unavailable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadSfrepPhotoBytes({ configured: true, getObject() { assert.fail('aborted'); } }, image,
    { signal: controller.signal, maxBytes: png.length }), { name: 'AbortError' });
});

test('combined byte limits reject oversized selected images before any storage fetch', () => {
  assert.throws(() => previewSfrepDocuments([], options(), [photo(1, { byte_size: 51 * 1024 * 1024 })]), /package_too_large/);
});
