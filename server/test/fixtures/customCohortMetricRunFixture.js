import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { buildCachedSourceCaptures } from '../../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow, mapCachedSaleLinkRow } from '../../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { buildCustomCohortIndexedObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { customCohortPreviewBinding } from '../../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { contextFixture } from './customCohortContextFixture.js';

/** Synthetic mapping-v2/source-chunker fixture only. No original SQL source,
 * licensed grant, historical stock, current assignment rights or live facts. */
export function customCohortMetricRunFixture({ count = 3, selectionRevision = 2, empty = false,
  price = '330000.125', periodEnd = '2024-06-30', organization, accountPrefix = 'MR-' } = {}) {
  const accounts = Array.from({ length: count }, (_, i) => `${accountPrefix}${String(i).padStart(6, '0')}`);
  const target = { ...contextFixture().target, account_id: accounts[0] ?? `${accountPrefix}EMPTY`, assignment_file_id: '17',
    ...(organization ? { organization_id: organization } : {}) };
  const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const parcels = accounts.map((account_id, i) => ({ object_id: String(i + 1), account_id,
    residential_year_built: 1950 + i % 70, residential_area_sqft: String(1500 + i * .125),
    parcel_area_sqft: i % 11 ? '6000' : '-0', current_market_value: '300000' }));
  const sale = (id, extra = {}) => ({ source_record_id: String(id), sale_id: String(id), primary_account_id: accounts[0],
    sale_account_id: accounts[0], record_type: 'closed_sale', sale_closing_date: '2024-03-01', source_close_date: '2024-03-01',
    sale_price: price, source_living_area: '1800.125', source_lot_size_area: '.2', source_year_built: 2001,
    source_bedrooms_total: '3', source_bathrooms_total_integer: 2, source_bathrooms_full: 2, source_bathrooms_half: 0,
    source_garage_spaces: '1', source_days_on_market: 0, source_current_price: '335000', ...extra });
  const sales = count ? [sale(1), sale(2, { sale_closing_date: '2025-01-01', source_days_on_market: null }),
    sale(3, { sale_id: '1', sale_price: '330000.125000000000000001' }),
    sale(4, { sale_id: '4', sale_price: 'bad', source_living_area: 'bad', source_days_on_market: 12 })] : [];
  const links = count ? [{ parcel_link_id: '1', source_record_id: '1', source_position: 1, parcel_sequence: 1,
    account_id: accounts[1] ?? accounts[0], is_resolved: true, match_method: 'exact' },
  { parcel_link_id: '2', source_record_id: '1', source_position: 1, parcel_sequence: 2,
    account_id: 'OUTSIDE', is_resolved: true, match_method: 'exact' }] : [];
  const wrap = (rows, mapper, prefix) => rows.map(row => { const mapped = mapper(row);
    return { record_id: `${prefix}:${mapped.record_id}`, data: mapped }; });
  const groups = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCachedParcelRow, 'parcel'),
    accounts: wrap(accounts.map(account_id => ({ account_id })), mapCachedAccountRow, 'account'),
    transactions: wrap(sales, mapCachedSaleRow, 'sale'), sale_links: wrap(links, mapCachedSaleLinkRow, 'link'), gis_sync: [] };
  const now = '2026-09-06T08:00:00.123Z';
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(groups).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: now, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic metric source', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: now, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  const input = { context_ref, retained_inputs: { subject: { target, effective_date: '2024-06-30' },
    study: { observation_period: { start_date: '2023-07-01', end_date: periodEnd } },
    spatial: { query_complete: true, account_ids: accounts, parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts }, capture_result: { query_complete: true, captured_at: now, source_capture: capture } } },
  selection: { revision: selectionRevision, pockets: empty ? [] : [{ id: 'discovery:selected', label: 'Selected observations', account_ids: accounts }] } };
  const preview = buildCustomCohortIndexedObservationPreview(input);
  const binding = customCohortPreviewBinding(preview, { context_ref, selection_revision: selectionRevision });
  const rootText = json({ synthetic_selection_only: true, revision: selectionRevision });
  const selectionRef = { selection_version: 1, selection_revision: selectionRevision, selection_sha256: binding.selection_sha256,
    manifest_ref: { content_sha256: createHash('sha256').update(rootText).digest('hex'), canonical_utf8_bytes: String(Buffer.byteLength(rootText)) } };
  return { input, preview, selectionRef };
}
