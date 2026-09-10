import { createHash } from 'node:crypto';
import { prepareAssignmentSalesCsv } from '../../../server/src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../../../server/src/services/assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../../../server/src/services/assignmentSalesCsv/review.js';
import { buildCustomCohortPrivateSalesObservations, presentCustomCohortPrivateSalesObservations } from '../../../server/src/services/neighborhoodAssessment/customCohortPrivateSales.js';

/** Synthetic zero-row import with explicit source interpretation, generated
 * through the actual parser/digest/observation/public presenter. For transport
 * and checkpoint tests, not a DB receipt or source-rights grant. */
export function privateSalesSummaryFixture({ input, privateSalesImport, period }) {
  const { rows, ...header } = prepareAssignmentSalesCsv(Buffer.from('ListingId,CloseDate,ClosePrice\n'));
  const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  const source_interpretation = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0, row_decisions: [],
    source_interpretation: { source_name: 'Synthetic empty reviewed CSV', provenance_note: '', currency: null, living_area_unit: null,
      site_area_unit: null, consideration_field: null, marketing_time_field: null, source_use_confirmed: true } }).source_interpretation;
  const supplement = { private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1',
    target: { organization_id: uuid(2), report_file_id: uuid(3), assignment_file_id: input.assignmentFileId, account_id: input.accountId },
    batch: { batch_id: privateSalesImport.batch_id, source_sha256: header.source_sha256, preparation_sha256: digestPreparedSalesParts(header, rows) },
    review: { revision: privateSalesImport.expected_review_revision, head_review_id: uuid(5), source_review_id: uuid(5) },
    source_interpretation, captured_at: '2026-09-10T12:00:00.123456Z', rows: [] };
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const pockets = input.selection.pockets.map(p => ({ account_ids: [...p.account_ids].sort(cmp), id: p.id, label: p.label })).sort((a, b) => cmp(a.id, b.id));
  const selection_sha256 = createHash('sha256').update(JSON.stringify({ pockets, revision: input.selection.revision })).digest('hex');
  const observations = buildCustomCohortPrivateSalesObservations({ supplement, context_ref: input.contextRef,
    effective_date: period.end_date, observation_period: period,
    selection: { revision: input.selection.revision, account_ids: [...new Set(pockets.flatMap(p => p.account_ids))] } });
  return presentCustomCohortPrivateSalesObservations({ observations,
    binding: { context_ref: input.contextRef, selection_revision: input.selection.revision, selection_sha256 } });
}
