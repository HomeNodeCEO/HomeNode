import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedInputsFixture } from './customCohortSupportedInputsFixture.js';
import { prepareCustomCohortReportGeography, completeCustomCohortReportGeography } from '../../src/services/neighborhoodAssessment/customCohortReportGeography.js';
import { prepareAssignmentSalesCsv } from '../../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../../src/services/assignmentSalesCsv/review.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { captureNeighborhoodSpatialMembership } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { prepareNeighborhoodSelectorInputV1 } from '../../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { createTestCachedReadAccess } from './neighborhoodCachedReadAccessFixture.js';

const uuid = n => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
// A NEW original acquisition over synthetic SQL rows, not edits to retained
// projections/hashes. Reuse the real subject and run actual spatial capture,
// mapping2 reader, one-use consume, persistence and verified reopen again.
async function captureRecordedLabels(base, labels) {
  assert.ok(Array.isArray(labels) && labels.length > 0 && labels.length <= 129);
  const old = base.input.retained_inputs, owner = base.base, subject = old.subject;
  const point = await owner.f.repo.loadRecordedPoint(old.subject_reference);
  const ids = [subject.target.account_id, ...labels.slice(1).map((_, i) => `SYNTHETIC-GROUP-${String(i + 1).padStart(3, '0')}`)];
  const accounts = ids.map((account_id, i) => ({ account_id, county: 'Dallas', subdivision: labels[i] }));
  const originalRows = role => old.acquisition.capture_result.source_capture.sources
    .filter(s => s.payload.projection.definition.role === role).flatMap(s => s.payload.records.map(r => structuredClone(r.data.raw_projection)));
  const template = originalRows('parcels')[0];
  const parcels = ids.map((account_id, i) => ({ ...template, account_id, object_id: String(9007199254740993n + BigInt(i)), subdivision_name: labels[i] }));
  const spatialRows = parcels.map(p => ({ ...old.spatial.parcels[0], account_id: p.account_id, object_id: p.object_id }));
  const sales = originalRows('transactions');
  const identities = sales.map(row => Object.fromEntries(['source_record_id', 'sale_id', 'primary_account_id', 'sale_account_id', 'source_record_hash'].map(key => [key, row[key]])));
  const source = readFileSync(new URL('../../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
  const schema = [...source.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1].matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
    .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
  const captured = old.acquisition.capture_result.captured_at;
  const client = { release() { assert.fail('owned fixture snapshot'); }, async query(config) {
    const v = config.values ?? [], tag = config.text.match(/neighborhood-(?:cache|membership):([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...old.spatial.snapshot,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true, statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'geometry-eligibility') return { rows: [] };
    if (config.text.includes('neighborhood-membership:parcels')) return { rows: spatialRows
      .filter(p => v[2] === null || BigInt(p.object_id) > BigInt(v[2])).slice(0, v[3]).map(payload => ({ payload })) };
    if (tag === 'scope') return { rows: [{ effective_date: subject.effective_date, case_date: subject.effective_date,
      snapshot_date: subject.effective_date, captured_at: '2026-09-06T08:00:00.123Z', captured_at_precise: '2026-09-06T08:00:00.123456Z' }] };
    if (tag === 'capabilities') return { rows: schema };
    let rows;
    switch (tag) {
      case 'parcels': rows = parcels.filter(p => BigInt(p.object_id) > BigInt(v[1])).slice(0, v[2]); break;
      case 'accounts': rows = [...accounts].sort((a, b) => a.account_id < b.account_id ? -1 : 1).filter(p => p.account_id > v[1]).slice(0, v[2]); break;
      case 'sync-state': rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: String(ids.length), last_run_id: template.sync_run_id, last_success_at: captured }]; break;
      case 'sync-runs': rows = [{ id: template.sync_run_id, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T00:00:00.000Z', completed_at: captured }]; break;
      case 'source-ids': rows = v[1] === '0' ? sales.map(r => ({ source_record_id: r.source_record_id })) : []; break;
      case 'transaction-identities': rows = identities.filter(r => v[0].includes(r.source_record_id)); break;
      case 'transactions': rows = sales.filter(r => v[0].includes(r.source_record_id)); break;
      case 'sale-links': case 'link-identities': case 'legacy': case 'legacy-identities': rows = []; break;
      default: assert.fail(tag);
    }
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const spatial = await captureNeighborhoodSpatialMembership(client, point.geometry_input);
  assert.equal(spatial.status, 'captured');
  const target = { report_file_id: subject.target.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: '41' };
  const scope = old.acquisition.capture_result.scope;
  const selector = prepareNeighborhoodSelectorInputV1({ profile_id: old.selector.query_input.definition.profile_id,
    target, scope, effective_date: subject.effective_date,
    selection: { id: 'reported-catalog-capacity-fixture', revision: 1, source_sha256: spatial.membership_sha256 },
    geometry_input: point.geometry_input, discovery: old.selector.query_input.definition.discovery,
    roster: { complete: true, account_count: ids.length, account_ids: spatial.account_ids } });
  const access = createTestCachedReadAccess({ target, scope, effective_date: subject.effective_date,
    selection: selector.selection, account_ids: spatial.account_ids, ...old.study }, {
    transactionClosure: { source_revision: 'reported-catalog-fixture', transactions: identities, links: [], legacy: [] } });
  const issued = await access.prepare(), reader = createNeighborhoodCachedSourceReader({ connect() { assert.fail('caller-owned'); } }, { access: access.access });
  const result = await reader.captureInSnapshot(client, { ...issued.request, auth: access.auth, selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  assert.equal(result.status, 'captured', JSON.stringify(result.incomplete_reasons));
  const original = { ...old, acquisition: consumeNeighborhoodCachedAcquisition(reader, result), spatial, selector };
  const refs = await persistCustomCohortCaptureInputs(owner.client, owner.scopeJson, prepareCustomCohortCaptureInputs(original));
  const reopened = await loadCustomCohortCaptureInputs(owner.client, owner.scopeJson, refs);
  const oldHeader = prepareCustomCohortContextHeader(base.input.context_header_json);
  const header = prepareCustomCohortContextHeader(json({ ...oldHeader.body, ...refs }));
  const preview = buildCustomCohortObservationPreview({ context_ref: header.context_ref, retained_inputs: reopened.retained_inputs,
    selection: { revision: 1, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: reopened.retained_inputs, preview });
  assert.equal(catalog.catalog_complete, true);
  return { retained_inputs: reopened.retained_inputs, context_ref: header.context_ref, catalog,
    group_ids: [...catalog.pockets.map(p => p.id), ...(catalog.unassigned.member_count ? ['discovery:unassigned'] : [])] };
}
export async function customCohortReportedAssessmentFixture({ privateRows = null, emptySelection = false,
  geographyChanges = {}, oracleChanges = {}, effectiveDate = '2026-09-10', recordedLabels = null } = {}) {
  const base = await supportedInputsFixture({ assignmentFileId: '41', effectiveDate });
  const recorded = recordedLabels === null ? null : await captureRecordedLabels(base, recordedLabels);
  const original = recorded?.retained_inputs ?? base.input.retained_inputs;
  const retained = structuredClone(original), subject = retained.subject.target;
  const target = { scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
    .map(key => [key, subject[key]])), report_file_id: subject.report_file_id, custom_assignment_file_id: 41,
    editor_revision: 0, effective_date: effectiveDate, data_cutoff: effectiveDate };
  const derivedAt = '2026-09-10T16:00:00.000Z';
  const saved = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
    neighborhood_boundary_north: 'Manual north', neighborhood_boundary_east: 'Manual east',
    neighborhood_boundary_south: 'Manual south', neighborhood_boundary_west: 'Manual west', ...geographyChanges };
  const text = JSON.stringify(saved), admitted = prepareCustomCohortReportGeography({
    target: { organization_id: subject.organization_id, report_file_id: subject.report_file_id,
      assignment_file_id: '41', account_id: subject.account_id }, assignment_revision: 1,
    projection: { details_type: 'object', projected_utf8_bytes: Buffer.byteLength(text),
      projected_sha256: createHash('sha256').update(text).digest('hex'), projected_json: text },
    captured_at: derivedAt, retained_subject: retained.subject,
  });
  const geography = completeCustomCohortReportGeography(admitted, admitted.geometry_for_validation ? {
    is_valid: true, validation_reason: 'Synthetic native oracle', postgis_version: 'synthetic-only',
    geometry_type: 'ST_Polygon', is_empty: false, component_count: 1,
    covers_recorded_subject_point: true, contains_recorded_subject_point: true, ...oracleChanges,
  } : null);
  if (privateRows !== null) {
    const defaults = { ListingId: '', CloseDate: retained.study.observation_period.end_date,
      ClosePrice: '282500', CurrentPrice: '285000', ParcelNumber: subject.account_id,
      County: 'Dallas', MlsStatus: 'Closed', LivingArea: '1800', LotSizeArea: '0.2', YearBuilt: '1985', DaysOnMarket: '0' };
    const records = privateRows.map((changes, n) => ({ ...defaults, ListingId: `SYNTHETIC-${n}`, ...changes }));
    const headers = [...new Set(records.flatMap(Object.keys))];
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = [headers, ...records.map(row => headers.map(key => row[key]))].map(row => row.map(quote).join(',')).join('\n');
    const { rows, ...header } = prepareAssignmentSalesCsv(Buffer.from(csv));
    const interpretation = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0, row_decisions: [],
      source_interpretation: { source_name: 'Synthetic assignment export', provenance_note: '', currency: 'USD', living_area_unit: 'sqft',
        site_area_unit: 'acre', consideration_field: 'close_price', marketing_time_field: 'days_on_market', source_use_confirmed: true } }).source_interpretation;
    retained.private_sales = { authorization: { decision_id: 'synthetic-only', policy_revision: 'synthetic-v1' }, capture: {
      private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1',
      target: { organization_id: subject.organization_id, report_file_id: subject.report_file_id, assignment_file_id: '41', account_id: subject.account_id },
      batch: { batch_id: uuid(4), source_sha256: header.source_sha256, preparation_sha256: digestPreparedSalesParts(header, rows) },
      review: { revision: 1, head_review_id: uuid(5), source_review_id: uuid(5) }, source_interpretation: interpretation,
      captured_at: '2026-09-10T15:00:00.123456Z', rows: rows.map((record_data, n) => ({ receipt_id: uuid(100 + n),
        source_row_number: n + 2, record_data, review: { review_id: uuid(5), revision: 1, decision: 'confirm_proposed_match',
          account_ids: [subject.account_id], note: '' } })) } };
  }
  return { base, ...(recorded ? { recorded } : {}), input: { context_ref: recorded?.context_ref ?? base.input.expected.context_ref, retained_inputs: retained,
    selection: { revision: 1, included_recorded_group_ids: emptySelection ? [] : [...(recorded?.group_ids ?? base.input.selection.included_recorded_group_ids)] },
    target, preparation_identity: { assessment_id: uuid(1), assessment_revision: 1, attachment_id: uuid(2), attachment_revision: 1 },
    report_geography: geography, derived_at: derivedAt } };
}
