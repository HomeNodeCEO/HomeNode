import assert from 'node:assert/strict';
import test from 'node:test';
import { customCohortReadDiagnostic } from '../src/services/neighborhoodAssessment/customCohortReadDiagnostics.js';

test('read diagnostics expose only closed action, family and check labels', () => {
  for (const action of ['catalog', 'preview', 'members']) {
    assert.deepEqual(customCohortReadDiagnostic(action, new TypeError('custom_cohort_observation_preview_source_routing')),
      { action, family: 'observations', check: 'source_routing' });
    assert.deepEqual(customCohortReadDiagnostic(action, new TypeError('custom_cohort_preview_presentation_denominator_mismatch')),
      { action, family: 'presentation', check: 'denominator_mismatch' });
    assert.deepEqual(customCohortReadDiagnostic(action, new TypeError('invalid_neighborhood_assessment:effective_date')),
      { action, family: 'contract', check: 'effective_date' });
  }
});

test('private error text, fields and identities never enter read diagnostics', () => {
  const secret = 'PRIVATE account SQL filename password';
  for (const prefix of ['custom_cohort_observation_preview_', 'custom_cohort_preview_presentation_', 'invalid_neighborhood_assessment:']) {
    const diagnostic = customCohortReadDiagnostic('catalog', Object.assign(new TypeError(prefix + secret), { cause: secret, detail: secret }));
    assert.equal(diagnostic.check, 'unclassified');
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
  }
  for (const error of [null, new Error(secret), new TypeError(secret), { message: secret }]) {
    assert.equal(customCohortReadDiagnostic('catalog', error), null);
  }
  for (const action of ['capture', 'reported-apply', secret]) {
    assert.equal(customCohortReadDiagnostic(action, new TypeError('custom_cohort_preview_presentation_text_limit')), null);
  }
});

test('installed combined mapping failures have a closed diagnostic without accepting future versions', () => {
  for (const family of ['observations', 'reported_sales']) {
    const prefix = family === 'observations' ? 'custom_cohort_observation_preview_' : 'custom_cohort_reported_shared_sales_';
    assert.deepEqual(customCohortReadDiagnostic('preview', new TypeError(prefix + 'mapping_v5_required')),
      { action: 'preview', family, check: 'mapping_v5_required' });
    assert.deepEqual(customCohortReadDiagnostic('preview', new TypeError(prefix + 'mapping_v6_required')),
      { action: 'preview', family, check: 'unclassified' });
  }
});

test('coordinator and context failures retain only fixed checks, including plain Error validators', () => {
  assert.deepEqual(customCohortReadDiagnostic('catalog', Object.assign(new Error('PRIVATE'), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason: 'invalid_input', detail: 'PRIVATE' })),
  { action: 'catalog', family: 'coordinator', check: 'invalid_input' });
  assert.deepEqual(customCohortReadDiagnostic('catalog', Object.assign(new Error('PRIVATE'), {
    code: 'custom_cohort_context_input_limit' })), { action: 'catalog', family: 'context', check: 'input_limit' });
  assert.equal(customCohortReadDiagnostic('catalog', Object.assign(new Error('PRIVATE'), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason: 'PRIVATE' })), null);
  assert.deepEqual(customCohortReadDiagnostic('catalog', Object.assign(new Error('PRIVATE'), {
    code: 'custom_cohort_context_PRIVATE' })), { action: 'catalog', family: 'context', check: 'unclassified' });
  assert.deepEqual(customCohortReadDiagnostic('catalog', Object.assign(new TypeError('custom_cohort_invalid_selection'), {
    reason: 'invalid_selection' })), { action: 'catalog', family: 'validator', check: 'invalid_selection' });
});

test('report proposal failures use closed diagnostics without exposing source data or changing Apply logging', () => {
  for (const [message, family, check] of [
    ['custom_cohort_reported_shared_sales_record_limit', 'reported_sales', 'record_limit'],
    ['custom_cohort_reported_assessment_catalog_incomplete', 'reported_assessment', 'catalog_incomplete'],
    ['custom_cohort_reported_assessment_PRIVATE SQL address', 'reported_assessment', 'unclassified'],
  ]) {
    const error = new TypeError(message);
    assert.deepEqual(customCohortReadDiagnostic('reported-proposal', error), { action: 'reported-proposal', family, check });
    assert.equal(customCohortReadDiagnostic('reported-apply', error), null);
  }
  const oversized = Object.assign(new Error('PRIVATE source detail'), { code: 'neighborhood_publication_bytes' });
  assert.deepEqual(customCohortReadDiagnostic('reported-proposal', oversized),
    { action: 'reported-proposal', family: 'publication', check: 'publication_bytes' });
  assert.equal(customCohortReadDiagnostic('reported-apply', oversized), null);
  assert.equal(customCohortReadDiagnostic('reported-proposal', Object.assign(new Error('PRIVATE'),
    { code: 'neighborhood_PRIVATE' })), null);
});
