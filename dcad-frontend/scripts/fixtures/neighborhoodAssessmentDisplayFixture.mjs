// TEST ONLY. These are synthetic records normalized by the real core/UAD
// builders. The fixture grants no source, parcel, geometry or report authority.
import assert from 'node:assert/strict';
import { buildNeighborhoodAssessment } from '../../../server/src/services/neighborhoodAssessment/contract.js';
import { neighborhoodAssessmentFixture } from '../../../server/test/fixtures/neighborhoodAssessmentFixture.js';
import { uadNeighborhoodReviewFixture } from '../../../server/test/fixtures/uadNeighborhoodReviewFixture.js';

// Match JSON transport detachment: builders may share the same immutable period
// object between a population and its statistics, but serialized records do not.
const copy = value => JSON.parse(JSON.stringify(value));
const sorted = values => [...new Set(values)].sort();
const reference = assessment => ({ id: assessment.id, revision: assessment.revision,
  evidence_digest_sha256: assessment.evidence_digest_sha256 });

export function coreDisplayInput(assessment) {
  return copy({ display_input_version: 1, source_contract_version: 1, records_kind: 'all_core_records',
    assessment_reference: reference(assessment), scope: assessment.scope,
    effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff,
    observation_period: assessment.observation_period, populations: assessment.populations,
    statistics: assessment.statistics, source_snapshots: assessment.source_snapshots,
    required_evidence_keys: sorted(['geographic_neighborhood',
      ...assessment.required_population_ids.map(id => `population:${id}`),
      ...assessment.required_statistic_ids.map(id => `statistic:${id}`),
      ...assessment.application_group.source_refs.map(id => `source:${id}`)]),
  });
}

export function uadDisplayInput(candidate) {
  assert.equal(candidate.status, 'ready');
  const { attachment: a, evidence: e } = candidate;
  assert.equal(a.evidence_digest_sha256, e.assessment_digest_sha256);
  assert.equal(a.evidence_digest_sha256, e.market_context.assessment_digest_sha256);
  return copy({ display_input_version: 1, source_contract_version: 1, records_kind: 'candidate_subset',
    assessment_reference: { id: a.assessment_id, revision: a.assessment_revision,
      evidence_digest_sha256: a.evidence_digest_sha256 },
    scope: a.scope, effective_date: a.effective_date, data_cutoff: a.data_cutoff,
    observation_period: e.market_context.observation_period,
    populations: e.populations, statistics: e.statistics, source_snapshots: e.sources,
    required_evidence_keys: sorted(candidate.suggestions.flatMap(item => item.evidence_refs)),
  });
}

export function makeNeighborhoodAssessmentDisplayFixture({ workflow = 'custom_appraisal', zeroSales = false, mutateRaw } = {}) {
  if (workflow === 'uad_3_6') {
    assert.equal(mutateRaw, undefined, 'UAD fixture uses its real pinned candidate builder without a substitute');
    const value = uadNeighborhoodReviewFixture({ zeroSales });
    return { ...value, input: uadDisplayInput(value.candidate) };
  }
  assert.equal(workflow, 'custom_appraisal');
  const raw = neighborhoodAssessmentFixture();
  if (mutateRaw) mutateRaw(raw);
  const assessment = buildNeighborhoodAssessment(raw);
  return { assessment, candidate: null, input: coreDisplayInput(assessment) };
}

export function expectedDisplayNotice(input) {
  const lead = input.records_kind === 'candidate_subset'
    ? 'Supplied candidate evidence subset; other assessment records are not shown.'
    : 'Supplied core population, statistic and source records; this is not a complete assessment display.';
  const basis = { closing_date: 'closing date', contract_date: 'contract date', status_as_of: 'status as of', effective_date: 'effective date' };
  return `${lead} Observation date basis: ${basis[input.observation_period.date_basis]}. Values and statuses were supplied by the producer. This preview does not verify sources or authorize report changes.`;
}

/** Explicit test host, not a production adapter. Check identity and caveat
 * before dropping provenance into the smaller shared-preview document shape. */
export function composeDisplayPreview(input, formatted, { workflow = 'custom_appraisal', blocksReview = true } = {}) {
  assert.equal(formatted.status, 'formatted');
  assert.deepEqual(formatted.provenance, { records_kind: input.records_kind,
    assessment_reference: input.assessment_reference, scope: input.scope,
    observation_date_basis: input.observation_period.date_basis,
    source_authority: 'not_established', report_eligibility: 'not_assessed' });
  assert.deepEqual([formatted.display.effective_date, formatted.display.data_cutoff, formatted.display.observation_period],
    [input.effective_date, input.data_cutoff, { start_date: input.observation_period.start_date, end_date: input.observation_period.end_date }]);
  assert.deepEqual(formatted.display_notice, { id: 'assessment-display:v1:context', label: 'About this evidence', text: expectedDisplayNotice(input) });
  const keys = { target_key: 'synthetic-trusted-target', operation_key: 'synthetic-current-operation', preview_key: 'synthetic-current-preview' };
  const deferred = formatted.deferred_evidence_keys.map(key => ({ key, kind: key, id: null,
    label: key === 'geographic_neighborhood' ? 'Descriptive neighborhood unavailable' : 'Analysis geography unavailable',
    observation_text: null, support: 'unknown', detail: 'Explicit test host placeholder. No geometry or source authority supplied.' }));
  const unavailable = () => ({ status: 'not_available', description: null, evidence_key: null });
  return { preview_version: 1,
    current: { ...keys, access: 'review', read_only: false, dirty: false, spatial_review: 'required',
      actions: { refresh: true, open_review: true, edit_area: false } }, load: 'complete',
    preview: { ...keys, origin: 'synthetic_fixture', workflow, subject_label: 'Synthetic subject; no cadastral identity claim',
      ...copy(formatted.display),
      boundary: { neighborhood: unavailable(), analysis_area: unavailable(),
        cardinals: Object.fromEntries(['north', 'east', 'south', 'west'].map(side => [side,
          { status: 'not_available', text: null, evidence_keys: [] }])),
        outline_required_for_review: false, outline: null }, pockets: [], fields: [],
      evidence: [...copy(formatted.display.evidence), ...deferred],
      review_items: [{ id: formatted.display_notice.id, label: formatted.display_notice.label,
        detail: formatted.display_notice.text, blocks_review: blocksReview, evidence_keys: [] }],
    },
  };
}
