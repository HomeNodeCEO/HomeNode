import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const source = new URL('../src/lib/contractSubjectAssociation.ts', import.meta.url);
const doc = () => ({ id: 2, document_type: 'purchase_contract', processing_status: 'reviewed', checksum_sha256: 'a'.repeat(64),
  candidates: [
    { id: 21, field_key: 'contract_date', raw_value: 'March 20, 2026', normalized_value: '2026-03-20', confirmed_value: '2026-03-20', review_status: 'confirmed' },
    { id: 20, field_key: 'contract_printed_subject_addresses', raw_value: 'Main: Dallas\nAddendum: Garland', normalized_value: 'Main: Dallas\nAddendum: Garland', confirmed_value: 'Main: Dallas\nAddendum: Garland', review_status: 'confirmed' },
    { id: 22, field_key: 'contract_price', raw_value: '345000', review_status: 'suggested' },
  ] });
function helpers(calls = []) {
  return loadTrustedRepositoryCommonJs(source, name => {
    assert.equal(name, './api');
    return { makeUrl: path => `https://example.test${path}`, fetchJSON: async (...args) => { calls.push(args); return { ok: true, document: doc() }; } };
  });
}

test('contract association posts exact source/account/file review snapshot without confirmations or identity mutations', async () => {
  const calls = [], api = helpers(calls), document = doc();
  assert.equal(api.canAssociateContractSubject(document), true);
  const before = structuredClone(document);
  assert.deepEqual(await api.associateContractSubject(document, '123', 4, 'editor-key'), document);
  assert.deepEqual(document, before);
  assert.equal(calls.length, 1);
  const [url, request] = calls[0];
  assert.equal(url, 'https://example.test/api/documents/2/subject-address-override');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-homenode-editor-key'], 'editor-key');
  const body = JSON.parse(request.body);
  assert.deepEqual(Object.keys(body), ['contract_subject_association']);
  assert.deepEqual(body.contract_subject_association, { accountId: '123', assignmentFileId: 4,
    documentChecksumSha256: 'a'.repeat(64), reviewedCandidates: [
      { id: 20, fieldKey: 'contract_printed_subject_addresses', rawValue: 'Main: Dallas\nAddendum: Garland', normalizedValue: 'Main: Dallas\nAddendum: Garland', confirmedValue: 'Main: Dallas\nAddendum: Garland', reviewStatus: 'confirmed' },
      { id: 21, fieldKey: 'contract_date', rawValue: 'March 20, 2026', normalizedValue: '2026-03-20', confirmedValue: '2026-03-20', reviewStatus: 'confirmed' },
    ] });
});

test('contract association readiness requires reviewed identity/date, correct type and fresh source checksum', () => {
  const api = helpers();
  for (const change of [
    doc => { doc.candidates[0].review_status = 'suggested'; }, doc => { doc.candidates[1].review_status = 'rejected'; },
    doc => { doc.candidates = doc.candidates.filter(item => item.field_key !== 'contract_date'); },
    doc => { doc.candidates = doc.candidates.filter(item => item.field_key !== 'contract_printed_subject_addresses'); },
    doc => { doc.document_type = 'engagement_letter'; }, doc => { doc.processing_status = 'processing'; },
    doc => { doc.checksum_sha256 = 'not-a-hash'; },
  ]) {
    const document = doc(); change(document);
    assert.equal(api.canAssociateContractSubject(document), false, String(change));
  }
});
