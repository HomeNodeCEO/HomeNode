import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUadDocumentHoaPlan, synchronizeUadDocumentHoa } from '../src/modules/uad/documentHoa.js';
import { uadDocumentCandidateIsApplicable } from '../src/modules/uad/documentEvidence.js';

const FILE = 'd51f534a-9447-4c36-8c09-36b530b64c21';
const ACCOUNT = 'TEST-HOA';
const context = { accountId: ACCOUNT, address: '100 Test Lane', city: 'Garland', postalCode: '75044' };
const document = (values = {}) => ({ id: 3, account_id: ACCOUNT, uad_workfile_id: FILE, document_type: 'mls_sheet',
  checksum_sha256: 'a'.repeat(64), processing_status: 'review_required',
  candidates: Object.entries({ subject_street_address: '100 Test Lane', subject_city: 'Garland', ...values })
    .map(([field_key, value], index) => ({ id: 10 + index, document_id: 3, field_key, raw_value: value,
      normalized_value: value, confirmed_value: value, review_status: 'confirmed' })) });
const row = (key, value, extra = {}) => {
  const [field_context, uad_uid] = key.split(':');
  return { id: key, entity_id: null, field_context, uad_uid, value, source_type: 'appraiser', is_appraiser_confirmed: true, ...extra };
};
const values = plan => plan.sections.flatMap(section => section.values);

test('PUD and dues fields are wired to the protected direct document path', () => {
  for (const field of ['pud', 'hoa_dues_amount', 'hoa_frequency']) assert.equal(uadDocumentCandidateIsApplicable(field), true);
});

for (const [frequency, amount, monthly] of [['per_month', '100', 100], ['per_year', '1200', 100], ['per_quarter', '450', 150]]) {
  test(`reviewed HOA affirmative maps PUD and ${frequency} dues without requiring the word mandatory`, () => {
    const source = document({ pud: 'true', hoa_dues_amount: amount, hoa_frequency: frequency });
    const pud = source.candidates.find(candidate => candidate.field_key === 'pud');
    pud.raw_value = 'Yes'; pud.extraction_method = 'urar_subject_v1:hoa_workflow_proxy';
    const plan = buildUadDocumentHoaPlan(source, context);
    assert.deepEqual(values(plan), [{ context_key: 'subject', uid: '0100.0026', value: true },
      { context_key: 'project_association_dues', uid: '2500.0007', value: monthly }]);
    assert.ok(plan.warnings.some(warning => warning.includes('not legal proof')));
  });
}

test('None and voluntary false leave mandatory dues unset; voluntary is visibly flagged', () => {
  for (const raw of ['None', 'Voluntary']) {
    const source = document({ pud: 'false', hoa_dues_amount: '100', hoa_frequency: 'per_year' });
    source.candidates.find(candidate => candidate.field_key === 'pud').raw_value = raw;
    const plan = buildUadDocumentHoaPlan(source, context);
    assert.deepEqual(values(plan), [{ context_key: 'subject', uid: '0100.0026', value: false }]);
    if (raw === 'Voluntary') assert.ok(plan.warnings.some(warning => warning.includes('Voluntary HOA')));
  }
});

test('dues alone do not imply PUD and missing or other frequency does not guess a monthly amount', () => {
  assert.deepEqual(values(buildUadDocumentHoaPlan(document({ hoa_dues_amount: '100', hoa_frequency: 'per_month' }), context)), []);
  for (const extra of [{}, { hoa_frequency: 'other' }]) {
    const plan = buildUadDocumentHoaPlan(document({ pud: 'true', hoa_dues_amount: '100', ...extra }), context);
    assert.equal(values(plan).length, 1);
    assert.ok(plan.warnings.some(warning => warning.includes('frequency')));
  }
});

test('manual PUD false, true, and explicit blank decisions cannot be overwritten by document application', () => {
  for (const value of [false, null, '']) {
    const plan = buildUadDocumentHoaPlan(document({ pud: 'true', hoa_dues_amount: '100', hoa_frequency: 'per_month' }), context,
      [row('subject:0100.0026', value)]);
    assert.deepEqual(values(plan), []);
    assert.equal(plan.conflicts[0].reason, 'existing_value_preserved');
  }
  assert.deepEqual(values(buildUadDocumentHoaPlan(document({ pud: 'false' }), context, [row('subject:0100.0026', true)])), []);
  const plan = buildUadDocumentHoaPlan(document({ pud: 'true', hoa_dues_amount: '100', hoa_frequency: 'per_month' }), context,
    [row('subject:0100.0026', true), row('project_association_dues:2500.0007', null)]);
  assert.deepEqual(values(plan), []);
  assert.equal(plan.conflicts[0].field_key, 'project_association_dues:2500.0007');
});

test('same-document automatic values can refresh together, but other document values remain protected', () => {
  const source = document({ pud: 'true', hoa_dues_amount: '100', hoa_frequency: 'per_month' });
  const initial = buildUadDocumentHoaPlan(source, context);
  const old = [row('subject:0100.0026', true, { source_type: 'document', source_reference: initial.sourceReference }),
    row('project_association_dues:2500.0007', 100, { source_type: 'document', source_reference: initial.sourceReference })];
  const next = buildUadDocumentHoaPlan(document({ pud: 'false' }), context, old);
  assert.deepEqual(values(next), [{ context_key: 'subject', uid: '0100.0026', value: false },
    { context_key: 'project_association_dues', uid: '2500.0007', value: null }]);
  assert.equal(values(buildUadDocumentHoaPlan(document({ pud: 'false' }), context,
    old.map(item => ({ ...item, source_reference: 'assignment_document:OTHER' })))).length, 0);
});

test('protected manual dues preserve the whole group when a refreshed MLS proposes no PUD', () => {
  const prior = buildUadDocumentHoaPlan(document({ pud: 'true', hoa_dues_amount: '100', hoa_frequency: 'per_month' }), context);
  const existing = [row('subject:0100.0026', true, { source_type: 'document', source_reference: prior.sourceReference }),
    row('project_association_dues:2500.0007', 125)];
  const plan = buildUadDocumentHoaPlan(document({ pud: 'false' }), context, existing);
  assert.deepEqual(values(plan), []);
  assert.equal(plan.conflicts[0].field_key, 'project_association_dues:2500.0007');
});

test('conflicting confirmed values, unready sources, and wrong-property MLS sheets are rejected', () => {
  const source = document({ pud: 'true' });
  source.candidates.push({ ...source.candidates.at(-1), id: 90, confirmed_value: 'false' });
  assert.throws(() => buildUadDocumentHoaPlan(source, context), /conflicting_values_requires_manual_entry/);
  for (const patch of [{ processing_status: 'processing' }, { document_type: 'purchase_contract' }]) {
    assert.throws(() => buildUadDocumentHoaPlan({ ...document({ pud: 'true' }), ...patch }, context), /requires_manual_entry/);
  }
  assert.throws(() => buildUadDocumentHoaPlan(document({ subject_street_address: '900 Other Road', pud: 'true' }), context), /subject_requires_manual_entry/);
});

function harness({ source = document({ pud: 'true', hoa_dues_amount: '1200', hoa_frequency: 'per_year' }), existing = [],
  signed = false, failProject = false, failRollback = false, unconfirm = false } = {}) {
  const log = [], releases = [], fields = structuredClone(existing), initial = structuredClone(existing);
  let revision = 1;
  const client = { async query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim(); log.push(text);
    if (text.startsWith('BEGIN')) return { rows: [] };
    if (text === 'COMMIT') return { rows: [] };
    if (text === 'ROLLBACK') { fields.splice(0, fields.length, ...initial); revision = 1; if (failRollback) throw new Error('private rollback'); return { rows: [] }; }
    if (text.includes('FROM appraisal.uad_workfiles')) return { rows: [{ id: FILE, account_id: ACCOUNT, status: 'draft', signed_at: null,
      current_revision: revision, specification_release_key: 'test' }] };
    if (text.includes('FROM appraisal.uad_signatures')) return { rows: [{ has_signatures: signed }] };
    if (text.includes('FROM app.assignment_documents')) {
      assert.deepEqual(params, [3, FILE, ACCOUNT]);
      return { rows: [source] };
    }
    if (text.includes('FROM appraisal.uad_subject_snapshots')) return { rows: [{ subject_data: { account: { account_id: ACCOUNT,
      address: context.address, city: context.city, postal_code: context.postalCode } } }] };
    if (text.includes('FROM app.assignment_document_field_candidates')) return { rows: unconfirm
      ? source.candidates.map(item => item.field_key === 'pud' ? { ...item, review_status: 'pending' } : item) : source.candidates };
    if (text.includes('FROM appraisal.uad_field_values')) return { rows: structuredClone(fields) };
    if (text.includes('FROM appraisal.uad_entities') || text.includes('FROM appraisal.uad_assets')) return { rows: [] };
    if (text.startsWith('INSERT INTO appraisal.uad_field_values')) {
      if (failProject && params[3] === 'project_association_dues') throw new Error('project-write-failed');
      fields.push({ id: params[0], entity_id: params[2], field_context: params[3], uad_uid: params[4], value: JSON.parse(params[6]),
        source_type: params[7], source_reference: params[8], is_appraiser_confirmed: true }); return { rows: [] };
    }
    if (text.startsWith('UPDATE appraisal.uad_field_values')) {
      const saved = fields.find(item => item.id === params[0]);
      if (failProject && saved.field_context === 'project_association_dues') throw new Error('project-write-failed');
      Object.assign(saved, { value: JSON.parse(params[1]), source_type: params[3], source_reference: params[4],
        is_appraiser_confirmed: true }); return { rows: [] };
    }
    if (text.startsWith('UPDATE appraisal.uad_workfiles')) { revision = params[1]; return { rows: [] }; }
    if (text.startsWith('INSERT INTO appraisal.uad_revisions') || text.startsWith('INSERT INTO appraisal.uad_audit_events')) return { rows: [] };
    throw new Error(`Unexpected query: ${text}`);
  }, release(error) { releases.push(error); } };
  return { log, fields, releases, run: () => synchronizeUadDocumentHoa({ connect: async () => client }, FILE, 3, 12) };
}

test('real section persistence writes Subject and Project Information in one transaction', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.changed_field_count, 2);
  assert.ok(result.applied_fields.every(item => item.entity_id === null));
  assert.deepEqual(h.fields.map(item => [item.field_context, item.value]), [['subject', true], ['project_association_dues', 100]]);
  assert.equal(h.log.filter(sql => sql.startsWith('BEGIN')).length, 1);
  assert.equal(h.log.filter(sql => sql === 'COMMIT').length, 1);
  assert.equal(h.log.at(-1), 'COMMIT'); assert.deepEqual(h.releases, [undefined]);
});

test('reapplying the same approved source is idempotent', async () => {
  const h = harness();
  const first = await h.run();
  const fields = structuredClone(h.fields);
  const repeated = await h.run();
  assert.equal(repeated.applied, false);
  assert.equal(repeated.current_revision, first.current_revision);
  assert.deepEqual(h.fields, fields);
});

test('refreshing previously applied fields also rolls back both updates on a second-section failure', async () => {
  const prior = buildUadDocumentHoaPlan(document({ pud: 'true', hoa_dues_amount: '100', hoa_frequency: 'per_month' }), context);
  const existing = [row('subject:0100.0026', true, { source_type: 'document', source_reference: prior.sourceReference }),
    row('project_association_dues:2500.0007', 100, { source_type: 'document', source_reference: prior.sourceReference })];
  const h = harness({ source: document({ pud: 'false' }), existing, failProject: true });
  await assert.rejects(h.run(), /project-write-failed/);
  assert.deepEqual(h.fields, existing);
  assert.equal(h.log.includes('COMMIT'), false);
});

test('failure in the second section rolls back the first with no blind retry', async () => {
  const h = harness({ failProject: true });
  await assert.rejects(h.run(), /project-write-failed/);
  assert.deepEqual(h.fields, []);
  assert.equal(h.log.filter(sql => sql.startsWith('BEGIN')).length, 1);
  assert.equal(h.log.includes('COMMIT'), false);
  assert.equal(h.log.at(-1), 'ROLLBACK');
});

test('locked signature and confirmation recheck stop writes before either section is changed', async () => {
  for (const [option, error] of [['signed', /status_locked/], ['unconfirm', /confirmation_required/]]) {
    const h = harness({ [option]: true });
    await assert.rejects(h.run(), error);
    assert.deepEqual(h.fields, []);
    assert.equal(h.log.some(sql => sql.startsWith('INSERT')), false);
  }
});

test('transaction preserves manual false and blank dues, including deliberate clears', async () => {
  for (const existing of [[row('subject:0100.0026', false)],
    [row('subject:0100.0026', true), row('project_association_dues:2500.0007', null)]]) {
    const h = harness({ existing });
    const result = await h.run();
    assert.equal(result.applied, false); assert.deepEqual(h.fields, existing);
    assert.equal(h.log.some(sql => sql.startsWith('INSERT')), false);
  }
});

test('rollback failure retires the client with a bounded error while preserving the write failure', async () => {
  const h = harness({ failProject: true, failRollback: true });
  await assert.rejects(h.run(), /project-write-failed/);
  assert.equal(h.releases.length, 1);
  assert.equal(h.releases[0].message, 'uad_document_project_rollback_failed');
  assert.equal(h.releases[0].cause, undefined);
});
