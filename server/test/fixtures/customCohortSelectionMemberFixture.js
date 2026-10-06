import { denseMemberWorkFixture } from './customCohortDenseMemberWorkFixture.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview, inspectCustomCohortPreviewMembers } from '../../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { prepareAssignmentSalesCsv } from '../../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../../src/services/assignmentSalesCsv/review.js';
import { buildCustomCohortPrivateSalesObservations, presentCustomCohortPrivateSalesObservations,
  CUSTOM_COHORT_PRIVATE_SALES_PROFILE } from '../../src/services/neighborhoodAssessment/customCohortPrivateSales.js';

function privateProjection({ request, summary, accounts, selected }) {
  const uuid = n => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const { rows, ...header } = prepareAssignmentSalesCsv(Buffer.from([
    'ListingId,CloseDate,ClosePrice,ParcelNumber,County,MlsStatus,LivingArea,YearBuilt,DaysOnMarket',
    `SYNTHETIC-1,2024-03-01,300000,${accounts[0]},Dallas,Closed,1600,1990,12`,
  ].join('\n')));
  const source_interpretation = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0,
    row_decisions: [], source_interpretation: { source_name: 'Synthetic private export', provenance_note: '',
      currency: 'USD', living_area_unit: 'sqft', site_area_unit: 'acre', consideration_field: 'close_price',
      marketing_time_field: 'days_on_market', source_use_confirmed: true } }).source_interpretation;
  const supplement = { private_sales_capture_version: 1, profile_id: CUSTOM_COHORT_PRIVATE_SALES_PROFILE,
    target: { organization_id: uuid(1), report_file_id: uuid(2), assignment_file_id: request.assignment_file_id,
      account_id: request.accountId }, batch: { batch_id: uuid(3), source_sha256: header.source_sha256,
      preparation_sha256: digestPreparedSalesParts(header, rows) },
    review: { revision: 1, head_review_id: uuid(4), source_review_id: uuid(4) },
    source_interpretation, captured_at: '2026-09-19T12:00:00.000000Z',
    rows: rows.map((record_data, i) => ({ receipt_id: uuid(10 + i), source_row_number: i + 2, record_data,
      review: { review_id: uuid(4), revision: 1, decision: 'confirm_proposed_match', account_ids: [accounts[0]], note: '' } })) };
  const observations = buildCustomCohortPrivateSalesObservations({ supplement, context_ref: request.context_ref,
    effective_date: summary.effective_date, observation_period: summary.observation_period,
    selection: { revision: request.selection_ref.selection_revision, account_ids: selected } });
  return presentCustomCohortPrivateSalesObservations({ observations, binding: summary.binding });
}

/** Actual row mapping -> numeric kernel -> public page over synthetic accounts.
 * No SQL/source-grant/production capacity or latency claim is established here. */
export async function selectionMemberFixture({ accountId = 'R-001', assignmentFileId = '9007199254740993',
  contextRef = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) },
  revision = 1, empty = false, accountCount = 3, privateSales = false } = {}) {
  const input = await denseMemberWorkFixture({ accountCount, saleCount: accountCount,
    pockets: accounts => empty ? [] : [{ id: 'discovery:selected', label: 'Selected observations',
      account_ids: accounts.slice(0, accountCount - 1) }] });
  input.context_ref = contextRef; input.selection.revision = revision;
  const preview = buildCustomCohortObservationPreview(input), expected = { context_ref: contextRef, selection_revision: revision };
  const summary = presentCustomCohortPreview({ preview, expected });
  const selection_ref = { selection_version: 1, selection_revision: revision, selection_sha256: summary.binding.selection_sha256,
    manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '750000' } };
  const population = { group: 'selected', kind: 'stock' }, page = { limit: 1, after_member_id: null };
  const request = { assignment_file_id: assignmentFileId, context_ref: contextRef, selection_ref, population, page };
  const private_sales = privateSales ? privateProjection({ request: { ...request, accountId }, summary,
    accounts: preview.all.account_ids, selected: preview.selected.account_ids }) : null;
  const resultFor = (p = population, q = page) => ({ status: 'members', authority: 'not_established',
    target: { account_id: accountId, assignment_file_id: assignmentFileId }, context_ref: contextRef, selection_ref,
    selection_revision: revision, subject_freshness: 'matched',
    page: inspectCustomCohortPreviewMembers({ preview, expected, population: p, page: q }),
    ...(private_sales ? { private_sales } : {}),
    apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
  return { request, result: resultFor(), resultFor, summary, accounts: preview.all.account_ids,
    selected: preview.selected.account_ids };
}
