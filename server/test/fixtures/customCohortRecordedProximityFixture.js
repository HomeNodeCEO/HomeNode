import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decisionEvidenceFixture } from './customCohortDecisionEvidenceFixture.js';
import { createTestCachedReadAccess } from './neighborhoodCachedReadAccessFixture.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { captureNeighborhoodSpatialMembership } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { prepareNeighborhoodSelectorInput, prepareNeighborhoodDiscoveryChoice } from '../../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';

const reader = readFileSync(new URL('../../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const schema = [...reader.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1].matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
const OP = '50000000-0000-4000-8000-000000000001', NOW = '2026-09-06T08:00:00.123456Z';
export const proximityPolygon = (x = -96.65, y = 32.91, width = .001) => ({ type: 'Polygon',
  coordinates: [[[x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]]] });
function ewkb(geometry, nested = false) {
  const uint = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const prefix = [Buffer.from([1]), uint((geometry.type === 'Polygon' ? 3 : 6) + (nested ? 0 : 0x20000000)),
    ...(nested ? [] : [uint(4326)]), uint(geometry.coordinates.length)];
  return Buffer.concat(geometry.type === 'MultiPolygon' ? [...prefix,
    ...geometry.coordinates.map(coordinates => ewkb({ type: 'Polygon', coordinates }, true))] : [...prefix,
    ...geometry.coordinates.flatMap(ring => [uint(ring.length), ...ring.map(point => {
      const b = Buffer.alloc(16); b.writeDoubleLE(point[0]); b.writeDoubleLE(point[1], 8); return b;
    })])]);
}

/** Genuine NEW installed source/spatial capture and persistence/reopen over
 * query-result fakes. Geometry is fixed before that capture, never relabeled in
 * an existing context. Native validity/distance is NOT asserted by this fixture;
 * focused tests stub only that later query, and root runs actual PostGIS tests.
 */
export async function recordedProximityFixture({ radius, parcels: specs } = {}) {
  const base = await decisionEvidenceFixture(), old = base.input.retained_inputs;
  const choice = radius === undefined ? undefined : prepareNeighborhoodDiscoveryChoice({ profile_id: 'custom-suburban-radius-v2', radius_metres: radius });
  const groups = Object.fromEntries(old.acquisition.capture_result.source_capture.sources.map(source => [
    source.payload.projection.definition.role, source.payload.records.map(row => structuredClone(row.data.raw_projection ?? row.data))]));
  const parcels = (specs ?? [{ account_id: 'subject', geometry: proximityPolygon() },
    { account_id: 'R-001', geometry: proximityPolygon(-96.64) }]).map((spec, i) => {
    const bytes = ewkb(spec.geometry);
    return { object_id: String(9007199254740993n + BigInt(i)), account_id: spec.account_id === 'subject' ? old.subject.target.account_id : spec.account_id,
      geometry: spec.geometry, geometry_ewkb: bytes.toString('hex'), geometry_sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const accounts = [...new Set(parcels.map(p => p.account_id))].sort();
  const spatialRows = parcels.map(p => ({ ...old.spatial.parcels[0], object_id: p.object_id, account_id: p.account_id, geometry_sha256: p.geometry_sha256 }));
  groups.parcels = parcels.map(p => ({ ...groups.parcels[0], object_id: p.object_id, account_id: p.account_id, stored_geometry_ewkb: p.geometry_ewkb }));
  groups.accounts = accounts.map(account_id => ({ account_id, county: 'Dallas', subdivision: account_id === old.subject.target.account_id ? 'Recorded Subject Plat' : 'Recorded Other Plat' }));
  const cacheClient = { release() { assert.fail('caller owns connection'); }, async query(config) {
    const values = config.values ?? [], tag = config.text.match(/neighborhood-(?:cache|membership):([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...old.spatial.snapshot,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true, statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'geometry-eligibility') return { rows: [] };
    if (config.text.includes('neighborhood-membership:parcels')) return { rows: spatialRows
      .filter(p => values[2] === null || BigInt(p.object_id) > BigInt(values[2])).slice(0, values[3]).map(payload => ({ payload })) };
    if (tag === 'scope') return { rows: [{ case_date: old.subject.effective_date, snapshot_date: old.subject.effective_date,
      effective_date: old.subject.effective_date, captured_at: '2026-09-06T08:00:00.123Z', captured_at_precise: NOW }] };
    if (tag === 'capabilities') return { rows: schema };
    let rows;
    switch (tag) {
      case 'parcels': rows = groups.parcels.filter(p => values[0].includes(p.account_id) && BigInt(p.object_id) > BigInt(values[1])).slice(0, values[2]); break;
      case 'accounts': rows = groups.accounts.filter(p => values[0].includes(p.account_id) && p.account_id > values[1]).slice(0, values[2]); break;
      case 'sync-state': rows = groups.gis_sync.filter(p => !p.id).map(p => ({ ...p, row_count: String(parcels.length) })); break;
      case 'sync-runs': rows = groups.gis_sync.filter(p => p.id); break;
      case 'source-ids': rows = values[1] === '0' ? [{ source_record_id: '10' }] : []; break;
      case 'transaction-identities': rows = old.acquisition.captured_query_request.transaction_closure.transactions; break;
      case 'transactions': rows = groups.transactions; break;
      case 'link-identities': case 'sale-links': rows = groups.sale_links.filter(p => p.parcel_sequence > values[3]).slice(0, values[4]); break;
      case 'legacy-identities': case 'legacy': rows = []; break;
      default: assert.fail(`Unexpected synthetic query ${tag}`);
    }
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const spatial = await captureNeighborhoodSpatialMembership(cacheClient, old.spatial.geometry_input, {}, choice);
  assert.equal(spatial.status, 'captured');
  const selector = prepareNeighborhoodSelectorInput({ profile_id: choice?.profile_id ?? old.study.profile_id,
    target: old.selector.target, scope: old.selector.scope, effective_date: old.subject.effective_date,
    selection: { id: OP, revision: 1, source_sha256: spatial.membership_sha256 }, geometry_input: spatial.geometry_input,
    discovery: { ...old.selector.query_input.definition.discovery, radius_metres: spatial.radius_metres },
    roster: { complete: true, account_count: accounts.length, account_ids: accounts } });
  assert.equal(selector.status, 'prepared');
  const study = { profile_id: selector.query_input.definition.profile_id, ...(choice ? { discovery: choice } : {}),
    observation_period: old.study.observation_period, knowledge_cutoff: null };
  const access = createTestCachedReadAccess({ target: selector.target, scope: selector.scope, effective_date: selector.effective_date,
    selection: selector.selection, account_ids: accounts, observation_period: study.observation_period, knowledge_cutoff: null }, {
    transactionClosure: { ...old.acquisition.captured_query_request.transaction_closure, selected_account_ids: accounts } });
  const grants = await access.prepare(), sourceReader = createNeighborhoodCachedSourceReader({ connect() { assert.fail('caller owns connection'); } }, { access: access.access });
  const captured = await sourceReader.captureInSnapshot(cacheClient, { ...grants.request, auth: access.auth,
    selection_grant: grants.selection_grant, market_grant: grants.market_grant });
  assert.equal(captured.status, 'captured', JSON.stringify(captured.incomplete_reasons));
  const acquisition = consumeNeighborhoodCachedAcquisition(sourceReader, captured), body = { ...old.acquisition_intent.body, operation_id: OP, study };
  const retained = { ...old, acquisition, spatial, selector, study, acquisition_intent: { body, reference: await base.store.put(json(body)) } };
  const refs = await persistCustomCohortCaptureInputs(base.client, base.scopeJson, prepareCustomCohortCaptureInputs(retained));
  const reopened = await loadCustomCohortCaptureInputs(base.client, base.scopeJson, refs);
  const headerJson = json({ ...JSON.parse(base.input.context_header_json), context_id: OP, ...refs });
  const context_ref = prepareCustomCohortContextHeader(headerJson).context_ref;
  const preview = buildCustomCohortObservationPreview({ context_ref, retained_inputs: reopened.retained_inputs, selection: { revision: 7, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: reopened.retained_inputs, preview });
  const input = { context_header_json: headerJson, expected: { ...base.input.expected, context_ref }, retained_inputs: reopened.retained_inputs,
    selection: { revision: 7, included_recorded_group_ids: catalog.pockets.map(p => p.id) } };
  return { ...base, input, context_ref, retained_inputs: input.retained_inputs, parcels, preview, catalog, accountIds: accounts };
}
