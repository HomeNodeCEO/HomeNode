import assert from 'node:assert/strict';
import { createCustomCohortSubjectRepository } from '../../src/services/neighborhoodAssessment/customCohortSubjectRepository.js';
import { canonicalAssessmentJson } from '../../src/services/neighborhoodAssessment/contract.js';
import { inputs, setSection, setPublic } from './neighborhoodCustomMaterialInputsFixture.js';
import { makeCohortLocalQueryMetadata, createCohortLocalQueryEvidenceFixture } from './neighborhoodCohortLocalQueryEvidenceFixture.js';

export const customCohortScopeOf = input => Object.fromEntries(
  ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'].map(key => [key, input.target[key]]));
const row = value => ({ rowCount: 1, rows: [value] });
const absent = () => ({ rowCount: 0, rows: [] });

export function customCohortQueryFixture(subject, { accountIds = [subject.target.account_id, 'R-001', 'r-001'], mutateMetadata } = {}) {
  const t = subject.target, metadata = makeCohortLocalQueryMetadata({ subjectId: t.account_id });
  metadata.scope = { organization_id: t.organization_id, appraisal_case_id: t.appraisal_case_id,
    subject_snapshot_id: t.subject_snapshot_id, account_id: t.account_id };
  metadata.effective_date = subject.effective_date;
  metadata.authorization.target = { report_file_id: t.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: t.assignment_file_id };
  if (mutateMetadata) mutateMetadata(metadata);
  return createCohortLocalQueryEvidenceFixture({ accountIds, metadata });
}

export function customCohortRepositoryFixture() {
  const input = inputs(); input.snapshot.effective_date = '2026-09-06';
  setPublic(input, { account: { account_id: input.target.account_id }, improvement: { living_area_sqft: 2000 } });
  setSection(input, 1, '{"main_improvement":{"living_area_sqft":2100.00},"review_note":"keep me"}');
  const state = { input, caseDate: '2026-09-06', status: 'draft', signedAt: null, signed: false,
    calls: [], missing: null, db: new Map(), transforms: {}, error: null };
  const client = { release() { throw new Error('repository must not release'); }, async query(sql, params) {
    const tag = sql.match(/\/\* (?:custom-cohort-subject|custom-cohort-selection|neighborhood-cohort-blob):([a-z-]+) \*\//)?.[1];
    assert.ok(tag, sql); state.calls.push({ tag, sql, params });
    if (state.error?.tag === tag) throw state.error.value;
    if (state.missing === tag) return absent();
    const t = state.input.target;
    let value;
    switch (tag) {
      case 'transaction': value = { transaction_id: '123456789' }; break;
      case 'assignment': value = { id: t.assignment_file_id, transaction_id: '123456789' }; break;
      case 'workfile': value = { status: state.status, signed_at: state.signedAt }; break;
      case 'signature': value = { present: state.signed }; break;
      case 'report': value = { appraisal_case_id: t.appraisal_case_id, subject_snapshot_id: t.subject_snapshot_id }; break;
      case 'case': value = { effective_date: state.caseDate }; break;
      case 'snapshot': value = { original_json: JSON.stringify(state.input.snapshot) }; break;
      case 'sections': value = { original_json: JSON.stringify(state.input.sections) }; break;
      case 'history-target': value = { id: t.report_file_id }; break;
      case 'insert': {
        const [org, hash, bytes, text] = params, key = `${org}:${hash}`;
        if (state.db.has(key)) return absent();
        const stored = { content_sha256: hash, canonical_utf8_bytes: bytes, canonical_utf8: text };
        state.db.set(key, stored); return row(stored);
      }
      case 'read': return state.db.has(`${params[0]}:${params[1]}`) ? row(state.db.get(`${params[0]}:${params[1]}`)) : absent();
      default: assert.fail(tag);
    }
    return row(state.transforms[tag] ? state.transforms[tag](value) : value);
  } };
  return { state, client, repo: createCustomCohortSubjectRepository(client, canonicalAssessmentJson(customCohortScopeOf(input))) };
}
