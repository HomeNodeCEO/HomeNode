import assert from 'node:assert/strict';
import { buildCachedSourceCaptures } from '../../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow } from '../../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { mapCadEvidenceParcelRow, mapCadEvidenceAccountRow } from '../../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { projectCustomNeighborhoodMaterialInputs } from '../../src/services/neighborhoodAssessment/customMaterialInputs.js';
import { inputs, setPublic, setSection, argumentsOf } from './neighborhoodCustomMaterialInputsFixture.js';
import { contextFixture } from './customCohortContextFixture.js';

const NOW = '2026-09-06T08:00:00.123Z';
const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
const parcel = (account, extra = {}, id = account) => ({ object_id: String(id), account_id: account,
  residential_year_built: 2000, residential_area_sqft: '1800', parcel_area_sqft: '6000', current_market_value: '330000',
  land_use_category: 'one_unit', classification_confidence: 'high', ...extra });
const sale = id => ({ source_record_id: String(id), sale_id: String(id), primary_account_id: 'A', sale_account_id: 'A',
  record_type: 'closed_sale', sale_closing_date: '2024-03-01', source_close_date: '2024-03-01',
  sale_price: '330000', source_current_price: '330000', source_living_area: '1800', source_year_built: 2000,
  source_housing_type: 'Single family', source_days_on_market: 0 });

// Consumer-level cases use ACTUAL projection/mapping/source builders, not a
// claimed supported fact or fake source-rights activation. The separate first
// test exercises actual retained capture/persist/load through the shared fixture.
export function recommendationFixture({ accounts = ['A', 'B'], parcels = accounts.map(id => parcel(id)), sales = [],
  names = {}, county = 'Dallas', subject = 'A', publicProperty = {}, manual, land, revision = 1, mapping4 = false } = {}) {
  parcels = parcels.map((row, index) => ({ ...row, object_id: String(9007199254740993n + BigInt(index)) }));
  const original = inputs(); original.target.account_id = subject;
  setPublic(original, { account: { account_id: subject }, ...publicProperty });
  if (manual !== undefined) setSection(original, 1, JSON.stringify(manual));
  if (land !== undefined) setSection(original, 0, JSON.stringify(land));
  const represented = projectCustomNeighborhoodMaterialInputs(...argumentsOf(original));
  assert.ok(represented.material_input, JSON.stringify(represented));
  const target = original.target;
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const wrap = (rows, mapper, prefix) => rows.map(row => { const mapped = mapper(row); return { record_id: `${prefix}:${mapped.record_id}`, data: mapped }; });
  const roles = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(mapping4 ? parcels.map(p => ({ class_code: 'A11', class_description: null,
      use_description: null, structure_type: null, built_up: true, ...p })) : parcels,
      mapping4 ? mapCadEvidenceParcelRow : mapCachedParcelRow, 'parcel'),
    accounts: wrap(accounts.map(account_id => ({ account_id, county, subdivision: names[account_id] ?? `Group ${account_id}` })),
      mapping4 ? mapCadEvidenceAccountRow : mapCachedAccountRow, 'account'),
    transactions: wrap(sales, mapCachedSaleRow, 'sale'), sale_links: [], gis_sync: [] };
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: NOW, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: NOW, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role, ...(mapping4 ? { mapping_version: 4 } : {}) }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(capture.status, 'ready');
  return { context_ref, retained_inputs: { subject: { target, effective_date: '2026-09-06', material: represented.material_input },
    study: { observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } },
    spatial: { query_complete: true, account_ids: accounts, parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts },
      ...(mapping4 ? { compact_metadata_json: JSON.stringify({ reader_version: 'local-capture-v3', mapping_version: 4, limits: { records: 200_000 } }) } : {}),
      capture_result: { query_complete: true, captured_at: NOW, source_capture: capture } } },
  selection: { revision, included_recorded_group_ids: [] } };
}
