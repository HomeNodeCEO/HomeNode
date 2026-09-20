import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCustomNeighborhoodSubjectEvidenceRecovery,
  refreshCustomNeighborhoodSubjectEvidence,
} from '../src/services/neighborhoodAssessment/customSubjectEvidenceRecovery.js';

const auth = Object.freeze({ userId: 'user-1', organizations: [Object.freeze({
  organizationId: '10000000-0000-4000-8000-000000000001', roles: ['appraiser'],
})] });
const input = Object.freeze({ accountId: '00000792229000000', assignmentFileId: '11', auth });
const location = () => ({ account_id: input.accountId, latitude: 32.8, longitude: -96.7,
  status: 'matched', source: 'dcad_parcel_query', precision: 'parcel_centroid', confidence: 'high',
  match_method: 'parcel_id', source_parcel_id: input.accountId, feature_count: 1,
  review_required: false, review_reason: null, metadata: { address_agreement: true } });

function database(overrides = {}) {
  const calls = [], client = { release() { calls.push(['release']); }, async query(sql, values) {
    calls.push([String(sql).trim().split('\n')[0], values]);
    if (String(sql).startsWith('BEGIN') || String(sql) === 'COMMIT' || String(sql) === 'ROLLBACK') return { rowCount: null, rows: [] };
    if (String(sql).includes(':workfile')) return { rowCount: 1, rows: [{ status: 'draft', signed_at: null, has_signed_snapshot: false, ...overrides.workfile }] };
    if (String(sql).includes(':assignment')) return { rowCount: 1, rows: [{ assignment_file_id: '11', account_id: input.accountId,
      organization_id: auth.organizations[0].organizationId, assigned_appraiser_user_id: auth.userId,
      supervisory_appraiser_user_id: null, ...overrides.assignment }] };
    if (String(sql).includes(':report')) return { rowCount: 1, rows: [{ id: '20000000-0000-4000-8000-000000000001',
      subject_snapshot_id: '30000000-0000-4000-8000-000000000001', ...overrides.report }] };
    if (String(sql).includes(':accepted')) return { rowCount: 1, rows: [{ present: overrides.accepted ?? false }] };
    throw new Error(`unexpected_query:${sql}`);
  } };
  return { pool: { connect: async () => client }, calls };
}

test('recoverable missing retained location refreshes one authorized draft snapshot and retries the same operation', async () => {
  const original = Object.assign(new Error('missing retained point'), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason: 'recorded_point_required', detail: 'recorded_location_missing',
  });
  const calls = [], options = { signal: new AbortController().signal, deadline: 12345 };
  const cohortService = { async capture(value, io) {
    calls.push(['capture', value, io]);
    if (calls.filter(([kind]) => kind === 'capture').length === 1) throw original;
    return { status: 'registered', reused: false };
  }, present() {}, inspect() {}, catalog() {} };
  const wrapped = createCustomNeighborhoodSubjectEvidenceRecovery({ pool: { marker: true }, cohortService,
    refresh: async (pool, value) => { calls.push(['refresh', pool, value]); } });
  assert.deepEqual(await wrapped.capture(input, options), { status: 'registered', reused: false });
  assert.equal(calls.length, 3); assert.equal(calls[0][1], input); assert.equal(calls[0][2], options);
  assert.equal(calls[1][2], input); assert.equal(calls[2][1], input); assert.equal(calls[2][2], options);
  assert.equal(wrapped.present, cohortService.present); assert.ok(Object.isFrozen(wrapped));
});

for (const patch of [
  { reason: 'recorded_point_required', detail: 'recorded_location_needs_review' },
  { reason: 'source_incomplete', detail: 'source_query_unavailable' },
  { reason: 'recorded_point_required', detail: 'recorded_location_missing', code: 'OTHER' },
]) test(`nonrecoverable capture ${JSON.stringify(patch)} never refreshes`, async () => {
  const original = Object.assign(new Error('refused'), { code: 'CUSTOM_COHORT_CAPTURE_FAILED', ...patch });
  let refreshes = 0;
  const wrapped = createCustomNeighborhoodSubjectEvidenceRecovery({ pool: {}, cohortService: {
    async capture() { throw original; }, present() {}, inspect() {}, catalog() {},
  }, refresh: async () => { refreshes += 1; } });
  await assert.rejects(wrapped.capture(input, {}), error => error === original);
  assert.equal(refreshes, 0);
});

test('failed evidence refresh preserves the original fail-closed capture refusal', async () => {
  const original = Object.assign(new Error('missing retained point'), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason: 'recorded_point_required', detail: 'recorded_location_missing',
  });
  const wrapped = createCustomNeighborhoodSubjectEvidenceRecovery({ pool: {}, cohortService: {
    async capture() { throw original; }, present() {}, inspect() {}, catalog() {},
  }, refresh: async () => { throw new Error('private database detail'); } });
  await assert.rejects(wrapped.capture(input, {}), error => error === original);
});

test('subject evidence refresh validates current CAD proof, appends an audited snapshot, and commits', async () => {
  const db = database();
  let loaded, captured;
  const result = await refreshCustomNeighborhoodSubjectEvidence(db.pool, input, {
    loadProperty: async (client, target) => { loaded = { client, target }; return { location: location() }; },
    captureSnapshot: async (client, reportId, options) => {
      captured = { client, reportId, options };
      return { id: '40000000-0000-4000-8000-000000000001', snapshotVersion: 2,
        verificationStatus: 'captured', subjectData: { custom_property_snapshot: { location: location() } } };
    },
  });
  assert.deepEqual(result, { refreshed: true, subject_snapshot_id: '40000000-0000-4000-8000-000000000001',
    snapshot_version: 2, verification_status: 'captured' });
  assert.deepEqual(loaded.target, { accountId: input.accountId, assignmentFileId: '11' });
  assert.equal(captured.reportId, '20000000-0000-4000-8000-000000000001');
  assert.deepEqual(captured.options, { actorUserId: auth.userId,
    captureReason: 'neighborhood_capture_verified_subject_evidence_refresh' });
  assert.equal(db.calls.at(-2)[0], 'COMMIT'); assert.equal(db.calls.at(-1)[0], 'release');
  assert.ok(Object.isFrozen(result));
});

for (const [name, databasePatch, propertyPatch, expected] of [
  ['signed workfile', { workfile: { status: 'signed' } }, {}, 'custom_appraisal_workfile_signed'],
  ['accepted neighborhood', { accepted: true }, {}, 'custom_subject_evidence_accepted_group_present'],
  ['unverified location', {}, { review_required: true }, 'custom_subject_evidence_location_unavailable'],
  ['other organization', { assignment: { organization_id: '90000000-0000-4000-8000-000000000009' } }, {}, 'assignment_access_denied'],
]) test(`subject evidence refresh fails closed for ${name}`, async () => {
  const db = database(databasePatch); let captures = 0;
  await assert.rejects(refreshCustomNeighborhoodSubjectEvidence(db.pool, input, {
    loadProperty: async () => ({ location: { ...location(), ...propertyPatch } }),
    captureSnapshot: async () => { captures += 1; },
  }), new RegExp(expected));
  assert.equal(captures, 0); assert.ok(db.calls.some(([sql]) => sql === 'ROLLBACK'));
  assert.equal(db.calls.at(-1)[0], 'release');
});
