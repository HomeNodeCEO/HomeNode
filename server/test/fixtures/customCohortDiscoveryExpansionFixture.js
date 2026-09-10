import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decisionEvidenceFixture } from './customCohortDecisionEvidenceFixture.js';
import { createTestCachedReadAccess } from './neighborhoodCachedReadAccessFixture.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { captureNeighborhoodSpatialMembership } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { prepareNeighborhoodSelectorInput, prepareNeighborhoodDiscoveryChoice } from '../../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareAssignmentSalesCsv } from '../../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../../src/services/assignmentSalesCsv/receiptIntegrity.js';

const readerText = readFileSync(new URL('../../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const schema = [...readerText.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1].matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
const NOW = '2026-09-06T08:00:00.123456Z';
const UUID = '40000000-0000-4000-8000-000000000001';

/** Query-result fakes only, NOT native distance/coverage evidence. Reuses an
 * actual retained subject fixture, then performs a NEW installed spatial/read
 * acquisition and one-use handoff for each radius; never relabels old captures.
 * The fake distance bands deliberately add accounts at five and ten miles. */
export async function customCohortDiscoveryExpansionFixture({ radius = '8046.72', privateSales = false } = {}) {
  const base = await decisionEvidenceFixture(), previous = base.input.retained_inputs;
  const discovery = prepareNeighborhoodDiscoveryChoice({ profile_id: 'custom-suburban-radius-v2', radius_metres: radius });
  const groups = Object.fromEntries(previous.acquisition.capture_result.source_capture.sources.map(source => [
    source.payload.projection.definition.role, source.payload.records.map(row => structuredClone(row.data.raw_projection ?? row.data))]));
  const spatialRows = structuredClone(previous.spatial.parcels);
  for (let index = 0; index < 2; index += 1) {
    const account_id = `R-00${index + 2}`, object_id = String(9007199254740995n + BigInt(index));
    spatialRows.push({ ...spatialRows[0], account_id, object_id });
    groups.parcels.push({ ...groups.parcels[0], account_id, object_id });
    groups.accounts.push({ account_id, county: 'Dallas', subdivision: `Synthetic radius band ${index + 1}` });
  }
  const size = radius === '4828.032' ? 2 : radius === '8046.72' ? 3 : 4;
  const parcels = spatialRows.slice(0, size), accounts = parcels.map(p => p.account_id).sort();
  const snapshot = previous.spatial.snapshot, queryCalls = [];
  const cacheClient = { release() { assert.fail('caller owns transaction'); }, async query(config) {
    queryCalls.push(config);
    const v = config.values ?? [], tag = config.text.match(/neighborhood-(?:cache|membership):([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...snapshot,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true,
      statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'geometry-eligibility') return { rows: [] };
    if (config.text.includes('neighborhood-membership:parcels')) {
      assert.equal(v[4], radius); assert.match(config.text, /\$5::double precision, true/);
      return { rows: parcels.filter(p => v[2] === null || BigInt(p.object_id) > BigInt(v[2]))
        .slice(0, v[3]).map(payload => ({ payload })) };
    }
    if (tag === 'scope') return { rows: [{ case_date: previous.subject.effective_date, snapshot_date: previous.subject.effective_date,
      effective_date: previous.subject.effective_date, captured_at: '2026-09-06T08:00:00.123Z', captured_at_precise: NOW }] };
    if (tag === 'capabilities') return { rows: schema };
    let rows;
    switch (tag) {
      case 'parcels': rows = groups.parcels.filter(p => v[0].includes(p.account_id) && BigInt(p.object_id) > BigInt(v[1])).slice(0, v[2]); break;
      case 'accounts': rows = groups.accounts.filter(p => v[0].includes(p.account_id) && p.account_id > v[1]).slice(0, v[2]); break;
      case 'sync-state': rows = groups.gis_sync.filter(p => !p.id).map(p => ({ ...p, row_count: '4' })); break;
      case 'sync-runs': rows = groups.gis_sync.filter(p => p.id); break;
      case 'source-ids': rows = v[1] === '0' ? [{ source_record_id: '10' }] : []; break;
      case 'transaction-identities': rows = previous.acquisition.captured_query_request.transaction_closure.transactions; break;
      case 'transactions': rows = groups.transactions; break;
      case 'link-identities': case 'sale-links': rows = groups.sale_links.filter(p => p.parcel_sequence > v[3]).slice(0, v[4]); break;
      case 'legacy-identities': case 'legacy': rows = []; break;
      default: assert.fail(`Unexpected synthetic query ${tag}`);
    }
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const spatial = await captureNeighborhoodSpatialMembership(cacheClient, previous.spatial.geometry_input, {}, discovery);
  assert.equal(spatial.status, 'captured');
  const selected = prepareNeighborhoodSelectorInput({ profile_id: discovery.profile_id,
    target: previous.selector.target, scope: previous.selector.scope, effective_date: previous.subject.effective_date,
    selection: { id: UUID, revision: 1, source_sha256: spatial.membership_sha256 }, geometry_input: spatial.geometry_input,
    discovery: { ...previous.selector.query_input.definition.discovery, radius_metres: radius },
    roster: { complete: true, account_count: accounts.length, account_ids: accounts } });
  assert.equal(selected.status, 'prepared');
  const study = { profile_id: discovery.profile_id, discovery, observation_period: previous.study.observation_period, knowledge_cutoff: null };
  const access = createTestCachedReadAccess({ target: selected.target, scope: selected.scope, effective_date: selected.effective_date,
    selection: selected.selection, account_ids: accounts, observation_period: study.observation_period, knowledge_cutoff: null }, {
    transactionClosure: { ...previous.acquisition.captured_query_request.transaction_closure, selected_account_ids: accounts } });
  const grants = await access.prepare(), reader = createNeighborhoodCachedSourceReader({ connect() { assert.fail('caller owns connection'); } }, { access: access.access });
  const result = await reader.captureInSnapshot(cacheClient, { ...grants.request, auth: access.auth,
    selection_grant: grants.selection_grant, market_grant: grants.market_grant });
  assert.equal(result.status, 'captured', JSON.stringify(result.incomplete_reasons));
  const acquisition = consumeNeighborhoodCachedAcquisition(reader, result);
  const body = { ...previous.acquisition_intent.body, operation_id: UUID, study };
  const input = { ...previous, acquisition, spatial, selector: selected, study, acquisition_intent: null };
  if (privateSales) {
    const prepared = prepareAssignmentSalesCsv(Buffer.from('ListingId,CloseDate,ClosePrice,ParcelNumber,MlsStatus,LivingArea\nPRIVATE1,2024-03-01,275000,R-001,Closed,1800'));
    const { rows, ...header } = prepared;
    body.intent_version = 2; body.private_sales_import = { batch_id: UUID, expected_review_revision: 1 };
    input.private_sales = { authorization: { decision_id: 'synthetic-private', policy_revision: 'synthetic-private-v1' }, capture: {
      private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1', target: base.input.expected.target,
      batch: { batch_id: UUID, source_sha256: prepared.source_sha256, preparation_sha256: digestPreparedSalesParts(header, rows) },
      review: { revision: 1, head_review_id: UUID, source_review_id: UUID }, captured_at: NOW,
      source_interpretation: { source_name: 'Synthetic private source', provenance_note: '', currency: 'USD', living_area_unit: 'sqft',
        site_area_unit: null, consideration_field: 'close_price', marketing_time_field: null, source_use_confirmed: true },
      rows: rows.map(record_data => ({ receipt_id: UUID, source_row_number: record_data.source_row_number, record_data,
        review: { review_id: UUID, revision: 1, decision: 'confirm_proposed_match', account_ids: ['R-001'], note: '' } })) } };
  }
  input.acquisition_intent = { body, reference: await base.store.put(json(body)) };
  const prepared = prepareCustomCohortCaptureInputs(input);
  const refs = await persistCustomCohortCaptureInputs(base.client, base.scopeJson, prepared);
  const reopened = await loadCustomCohortCaptureInputs(base.client, base.scopeJson, refs);
  return { ...base, originalContextHeaderJson: base.input.context_header_json,
    previous, input, prepared, refs, reopened, queryCalls, cacheClient, discovery };
}
