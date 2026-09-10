import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCadEvidenceSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodCadEvidenceReadAccess } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { decisionEvidenceFixture } from './customCohortDecisionEvidenceFixture.js';
import { createTestCachedReadAccess } from './neighborhoodCachedReadAccessFixture.js';

const CAD_FIELDS = ['class_code', 'class_description', 'use_description', 'structure_type', 'built_up'];
const DEFAULT_CAD = Object.freeze({ class_code: '  A1 ', class_description: '  Residential class observation  ',
  use_description: 'Unknown retained use', structure_type: 'Provider-specific structure', built_up: false });
const MS = '2026-09-06T08:00:00.123Z', PRECISE = '2026-09-06T08:00:00.123456Z';

/** Actual opt-in mapping4 source acquisition, persistence and reopen over
 * bounded SQL-result fakes. Existing admitted subject/spatial/intent evidence is
 * reused unchanged, never relabeled as a new acquisition. This is not native SQL,
 * schema/ingestion, provider truth, historical support or production activation.
 */
export async function cadEvidenceFixture({ parcelOverrides = {}, omitParcelFields = [], legacy = false } = {}) {
  const base = await decisionEvidenceFixture(), old = base.input.retained_inputs;
  const oldCapture = old.acquisition.capture_result;
  const sourceRows = role => oldCapture.source_capture.sources.filter(s => s.payload.projection.definition.role === role)
    .flatMap(s => s.payload.records.map(r => structuredClone(r.data.raw_projection ?? r.data)));
  const parcels = sourceRows('parcels').map(row => {
    const result = { ...row, ...DEFAULT_CAD, ...parcelOverrides };
    for (const field of omitParcelFields) delete result[field];
    return result;
  });
  const accounts = sourceRows('accounts'), transactions = sourceRows('transactions'), links = sourceRows('sale_links');
  const legacyRows = legacy ? [{ source_record_id: null, sale_id: '22', sale_account_id: 'R-001',
    sale_closing_date: '2024-04-01', sale_price: '300000', sale_source: 'Synthetic canonical-only observation',
    sale_loaded_at: '2026-09-05T00:00:00.000Z' }] : [];
  const identities = transactions.map(row => Object.fromEntries(['source_record_id', 'sale_id', 'primary_account_id',
    'sale_account_id', 'source_record_hash'].map(key => [key, row[key]])));
  const readerText = readFileSync(new URL('../../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
  const schema = [...readerText.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1]
    .matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
    .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
  schema.push(...CAD_FIELDS.map(column => ({ relation: 'gis.dcad_parcels', column })));
  const queryCalls = [], marketPurposes = [];
  const client = { release() { assert.fail('caller-owned transaction only'); }, async query(config) {
    queryCalls.push(config.text);
    const values = config.values ?? [], tag = config.text.match(/neighborhood-cache:([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...oldCapture.snapshot,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true,
      statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'scope') return { rows: [{ case_date: old.subject.effective_date, snapshot_date: old.subject.effective_date,
      effective_date: old.subject.effective_date, captured_at: MS, captured_at_precise: PRECISE }] };
    if (tag === 'capabilities') return { rows: schema };
    let result;
    switch (tag) {
      case 'parcels': result = parcels.filter(r => BigInt(r.object_id) > BigInt(values[1])).slice(0, values[2]); break;
      case 'accounts': result = accounts.filter(r => r.account_id > values[1]).slice(0, values[2]); break;
      case 'sync-state': result = sourceRows('gis_sync').filter(r => r.source_key === 'dcad_parcels' && !r.id); break;
      case 'sync-runs': result = sourceRows('gis_sync').filter(r => r.id); break;
      case 'source-ids': result = values[1] === '0' ? identities.map(r => ({ source_record_id: r.source_record_id })) : []; break;
      case 'transaction-identities': result = identities.filter(r => values[0].includes(r.source_record_id)); break;
      case 'transactions': result = transactions.filter(r => values[0].includes(r.source_record_id)); break;
      case 'link-identities': case 'sale-links': result = links.filter(r => values[0].includes(r.source_record_id)
        && (BigInt(r.source_record_id) > BigInt(values[1]) || (r.source_record_id === values[1]
          && (r.source_position > values[2] || (r.source_position === values[2] && r.parcel_sequence > values[3])))))
        .slice(0, values[4]); break;
      case 'legacy-identities': result = legacyRows.filter(r => BigInt(r.sale_id) > BigInt(values[1])).slice(0, values[2])
        .map(r => ({ sale_id: r.sale_id, sale_account_id: r.sale_account_id })); break;
      case 'legacy': result = legacyRows.filter(r => BigInt(r.sale_id) > BigInt(values[1])).slice(0, values[2]); break;
      default: assert.fail(`Unexpected capture query: ${tag}`);
    }
    return { rows: result.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const subjectTarget = old.subject.target;
  const target = { report_file_id: subjectTarget.report_file_id, workflow_type: 'custom_appraisal',
    workflow_target_id: subjectTarget.assignment_file_id };
  const access = createTestCachedReadAccess({ target, scope: oldCapture.scope, effective_date: old.subject.effective_date,
    selection: old.selector.selection, account_ids: base.accountIds, ...old.study }, {
    accessFactory: createNeighborhoodCadEvidenceReadAccess,
    authorizeMarketData: async (_auth, _context, purpose) => {
      marketPurposes.push(structuredClone(purpose));
      assert.equal(Object.hasOwn(purpose, 'source_projection'), false, 'v4 does not request sale-witness exposure');
      return { allowed: true, decision_id: 'synthetic-cad-field-test', policy_revision: 'synthetic-cad-field-v1' };
    },
    transactionClosure: { source_revision: 'synthetic-cad-evidence-closure', transactions: identities, links,
      legacy: legacyRows.map(r => ({ sale_id: r.sale_id, sale_account_id: r.sale_account_id })) },
  });
  const issued = await access.prepare();
  const reader = createNeighborhoodCadEvidenceSourceReader({ connect() { assert.fail('caller-owned transaction only'); } }, { access: access.access });
  const captureResult = await reader.captureInSnapshot(client, { ...issued.request, auth: access.auth,
    selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  assert.equal(captureResult.status, 'captured', JSON.stringify(captureResult.incomplete_reasons));
  const originalRetained = { ...old, acquisition: consumeNeighborhoodCachedAcquisition(reader, captureResult) };
  const refs = await persistCustomCohortCaptureInputs(base.client, base.scopeJson, prepareCustomCohortCaptureInputs(originalRetained));
  const reopened = await loadCustomCohortCaptureInputs(base.client, base.scopeJson, refs);
  const header = prepareCustomCohortContextHeader(base.input.context_header_json);
  const headerJson = json({ ...header.body, ...refs });
  const context = prepareCustomCohortContextHeader(headerJson).context_ref;
  const input = { context_header_json: headerJson, expected: { ...base.input.expected, context_ref: context },
    retained_inputs: reopened.retained_inputs, selection: { ...base.input.selection } };
  const preview = buildCustomCohortObservationPreview({ context_ref: context, retained_inputs: input.retained_inputs,
    selection: { revision: input.selection.revision, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: input.retained_inputs, preview });
  base.f.state.calls.length = 0;
  return { base, input, preview, catalog, reader, captureResult, originalRetained, queryCalls, marketPurposes };
}
