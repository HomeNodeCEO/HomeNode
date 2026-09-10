import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { saleWitnessMeaningFixture, syntheticSaleWitness } from './customCohortSaleWitnessMeaningFixture.js';
import { createTestCachedReadAccess } from './neighborhoodCachedReadAccessFixture.js';
import { createNeighborhoodCachedSourceReader, createNeighborhoodSaleWitnessSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodSaleWitnessReadAccess } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { createCustomCohortDecisionEvidenceResolver } from '../../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { createCustomCohortReviewRepository } from '../../src/services/neighborhoodAssessment/customCohortReviewRepository.js';
import { cohortCommandFixture, cohortUuid } from './neighborhoodCohortDecisionCommandFixture.js';

const MS = '2026-09-06T08:00:00.123Z', PRECISE = '2026-09-06T08:00:00.123456Z';
export const SUPPORTED_DERIVED_AT = '2026-09-09T12:00:00.000Z';
const row = value => ({ rowCount: value ? 1 : 0, rows: value ? [structuredClone(value)] : [] });

/** Real reader/capture + retained persistence/reopen + actual review repository
 * append/getCurrent, over bounded query fakes. Not native SQL, authorization,
 * provider rights, source truth, clock, licensure, or production readiness.
 */
export async function supportedInputsFixture({ mappingVersion = 2, saleCount = 3, packageSale = false,
  saleOverrides = {}, missingCounty = false, assignmentFileId, effectiveDate } = {}) {
  const base = await saleWitnessMeaningFixture({ assignmentFileId, effectiveDate }), old = base.originalRetained;
  const sourceText = readFileSync(new URL('../../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
  const schema = [...sourceText.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1].matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
    .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
  if (mappingVersion === 3) schema.push(...['mls_status', 'source_row_number', 'raw_payload'].map(column => ({ relation: 'core.sales_source_records', column })));
  const capturedRows = Object.fromEntries(['parcels', 'accounts'].map(role => [role,
    base.input.retained_inputs.acquisition.capture_result.source_capture.sources.filter(s => s.payload.projection.definition.role === role)
      .flatMap(s => s.payload.records.map(r => structuredClone(r.data.raw_projection)))]));
  if (missingCounty) capturedRows.accounts.forEach(r => { r.county = null; });
  const account = base.accountIds[0];
  const sales = Array.from({ length: saleCount }, (_, index) => ({
    source_record_id: String(10 + index), sale_id: String(20 + index), primary_account_id: account, sale_account_id: account,
    source_record_hash: 'b'.repeat(64), record_type: 'closed_sale', sale_closing_date: `2024-03-${String(index % 28 + 1).padStart(2, '0')}`,
    source_close_date: `2024-03-${String(index % 28 + 1).padStart(2, '0')}`, sale_price: String(275000 + index * 1000),
    source_current_price: String(275000 + index * 1000), source_living_area: '1850.125', source_year_built: 2001,
    source_housing_type: 'Single family', data_quality_flags: [],
    ...(mappingVersion === 3 ? { source_mls_status: 'Closed', source_row_number: index,
      source_raw_witness: syntheticSaleWitness({ ClosePrice: String(275000 + index * 1000), Currency: 'USD' }) } : {}),
    ...saleOverrides,
  }));
  const links = packageSale && sales.length ? [{ parcel_link_id: '100', source_record_id: '10', source_position: 1,
    parcel_sequence: 1, account_id: base.accountIds[1], is_resolved: true, match_method: 'exact' }] : [];
  const identities = sales.map(r => Object.fromEntries(['source_record_id', 'sale_id', 'primary_account_id', 'sale_account_id', 'source_record_hash'].map(k => [k, r[k]])));
  const client = { release() { assert.fail('caller transaction only'); }, async query(config) {
    const v = config.values ?? [], tag = config.text.match(/neighborhood-cache:([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...base.captureResult.snapshot,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true,
      statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'scope') return { rows: [{ case_date: old.subject.effective_date, snapshot_date: old.subject.effective_date,
      effective_date: old.subject.effective_date, captured_at: MS, captured_at_precise: PRECISE }] };
    if (tag === 'capabilities') return { rows: schema };
    let rows;
    switch (tag) {
      case 'parcels': rows = capturedRows.parcels.filter(r => BigInt(r.object_id) > BigInt(v[1])).slice(0, v[2]); break;
      case 'accounts': rows = capturedRows.accounts.filter(r => r.account_id > v[1]).slice(0, v[2]); break;
      case 'sync-state': rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: '2', last_run_id: capturedRows.parcels[0].sync_run_id, last_success_at: MS }]; break;
      case 'sync-runs': rows = [{ id: capturedRows.parcels[0].sync_run_id, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T00:00:00.000Z', completed_at: MS }]; break;
      case 'source-ids': rows = v[1] === '0' ? sales.map(r => ({ source_record_id: r.source_record_id })) : []; break;
      case 'transaction-identities': rows = identities.filter(r => v[0].includes(r.source_record_id)); break;
      case 'transactions': rows = sales.filter(r => v[0].includes(r.source_record_id)); break;
      case 'link-identities': case 'sale-links': rows = links.filter(r => v[0].includes(r.source_record_id)
        && (BigInt(r.source_record_id) > BigInt(v[1]) || (r.source_record_id === v[1]
          && (r.source_position > v[2] || (r.source_position === v[2] && r.parcel_sequence > v[3]))))).slice(0, v[4]); break;
      case 'legacy-identities': case 'legacy': rows = []; break;
      default: assert.fail(tag);
    }
    if (tag === 'link-identities') rows = rows.map(({ match_method, ...identity }) => identity);
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const target = { report_file_id: old.subject.target.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: old.subject.target.assignment_file_id };
  const access = createTestCachedReadAccess({ target, scope: base.captureResult.scope,
    effective_date: old.subject.effective_date, selection: old.selector.selection, account_ids: base.accountIds, ...old.study },
  { transactionClosure: { source_revision: 'supported-input-fixture-closure', transactions: identities,
    links: links.map(({ match_method, ...identity }) => identity), legacy: [] },
    ...(mappingVersion === 3 ? { accessFactory: createNeighborhoodSaleWitnessReadAccess } : {}) });
  const issued = await access.prepare();
  const reader = (mappingVersion === 3 ? createNeighborhoodSaleWitnessSourceReader : createNeighborhoodCachedSourceReader)(
    { connect() { assert.fail('caller-owned only'); } }, { access: access.access });
  const result = await reader.captureInSnapshot(client, { ...issued.request, auth: access.auth,
    selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  const original = { ...old, acquisition: consumeNeighborhoodCachedAcquisition(reader, result) };
  const refs = await persistCustomCohortCaptureInputs(base.client, base.scopeJson, prepareCustomCohortCaptureInputs(original));
  const reopened = await loadCustomCohortCaptureInputs(base.client, base.scopeJson, refs);
  const oldHeader = prepareCustomCohortContextHeader(base.input.context_header_json);
  const headerJson = json({ ...oldHeader.body, ...refs }), header = prepareCustomCohortContextHeader(headerJson);
  await base.store.put(headerJson);
  const input = { context_header_json: headerJson, expected: { ...base.input.expected, context_ref: header.context_ref },
    retained_inputs: reopened.retained_inputs, selection: base.input.selection };
  const preview = buildCustomCohortObservationPreview({ context_ref: header.context_ref, retained_inputs: input.retained_inputs,
    selection: { revision: input.selection.revision, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: input.retained_inputs, preview });
  input.selection = { revision: input.selection.revision, included_recorded_group_ids: catalog.pockets.map(p => p.id) };
  const resolver = createCustomCohortDecisionEvidenceResolver(input);
  const records = reopened.retained_inputs.acquisition.capture_result.source_capture.sources.flatMap(source => source.payload.records.map(record => ({
    role: source.payload.projection.definition.role, ref: resolver.deriveEvidenceRef(source.id, record.record_id),
    row: record.data, id: record.record_id })));
  const candidates = records.filter(r => r.role === 'transactions'), accountRecords = records.filter(r => r.role === 'accounts');
  const scope = input.expected.target, c = header.context_ref, storedRows = new Map(), baseQuery = base.client.query.bind(base.client);
  const context = { ...c, header_content_sha256: header.header_blob.ref.content_sha256,
    header_canonical_utf8_bytes: header.header_blob.ref.canonical_utf8_bytes };
  const calls = [];
  base.client.query = async (sql, params = []) => {
    calls.push(sql);
    if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return row();
    const ct = sql.match(/custom-cohort-context:([a-z-]+)/)?.[1];
    if (ct === 'transaction') return row({ transaction_id: '123456789' });
    if (ct === 'target') return row({ id: scope.report_file_id });
    if (ct === 'read') return row(params[4] === c.context_id ? context : null);
    const tag = sql.match(/custom-cohort-review:([a-z-]+)/)?.[1];
    if (!tag) return baseQuery(sql, params);
    const ordered = [...storedRows.values()].sort((a, b) => BigInt(a.generation) < BigInt(b.generation) ? 1 : -1);
    const heads = [...new Map(ordered.map(r => r.fact_key_sha256).filter((v, i, a) => a.indexOf(v) === i)
      .map(key => [key, ordered.find(r => r.fact_key_sha256 === key)])).values()];
    if (tag === 'state-transaction') return row({ isolation: 'read committed', transaction_id: '123456789' });
    if (tag === 'state-context-lock') return row({ ...scope, ...c });
    if (tag === 'state-summary') return row({ head_count: String(heads.length), generation: ordered[0]?.generation ?? '0',
      record_utf8_bytes: String(heads.reduce((sum, r) => sum + Number(r.canonical_utf8_bytes), 0)) });
    if (tag === 'state-heads') return { rows: heads, rowCount: heads.length };
    if (tag === 'state-blobs') {
      const rows = JSON.parse(params[1]).map(ref => ({ content_sha256: ref.content_sha256,
        canonical_utf8_bytes: String(ref.canonical_utf8_bytes), canonical_utf8: base.f.state.db.get(`${scope.organization_id}:${ref.content_sha256}`).canonical_utf8 }));
      return { rows, rowCount: rows.length };
    }
    if (tag === 'actor') return row({ id: params[0] });
    if (tag === 'context-lock') return row({ context_id: c.context_id });
    if (tag === 'head') return row(ordered[0] ? { generation: ordered[0].generation } : null);
    if (tag === 'fact') {
      const f = ordered.find(r => r.fact_key_sha256 === params[2]);
      return row(f ? { operation_id: f.operation_id, content_sha256: f.content_sha256, generation: f.generation } : null);
    }
    if (tag === 'operation') return row(storedRows.get(params[1]));
    if (tag === 'insert') {
      const keys = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'context_id', 'context_revision', 'context_sha256',
        'operation_id', 'generation', 'fact_key_sha256', 'actor_user_id', 'predecessor_operation_id', 'predecessor_content_sha256', 'content_sha256', 'canonical_utf8_bytes'];
      const r = Object.fromEntries(keys.map((key, index) => [key, params[index]])); storedRows.set(r.operation_id, r); return row(r);
    }
    assert.fail(tag);
  };
  const repo = createCustomCohortReviewRepository(base.client, base.scopeJson), current = new Map();
  let generation = '0', operation = 10000;
  const command = (kind, subjectKey, value, evidenceRefs, dependencies = []) => {
    const cmd = cohortCommandFixture(kind), subject = { kind: kind === 'housing_at_date' ? 'stock_member' : 'capture_candidate', key: subjectKey };
    Object.assign(cmd, { operation_id: cohortUuid(++operation), target_ref: resolver.binding.target_ref,
      expected_context: resolver.binding.context_ref, study_ref: resolver.binding.study_ref, subject_ref: subject,
      expected_generation: generation, expected_predecessor: null, evidence_refs: evidenceRefs });
    cmd.claim.value = value; cmd.claim.decision_refs = dependencies;
    if (kind === 'housing_at_date') cmd.claim.qualifier = { basis: 'evaluated_date', evaluated_on: value.evaluated_on };
    if (kind === 'material_condition') cmd.claim.qualifier = { basis: 'condition', condition_code: value.condition_code };
    cmd.expected_predecessor = current.get(json([subject, kind, cmd.claim.qualifier]))?.decision_ref ?? null;
    return cmd;
  };
  async function append(cmd) {
    cmd.expected_generation = generation;
    const key = json([cmd.subject_ref, cmd.claim.kind, cmd.claim.qualifier]);
    cmd.expected_predecessor = current.get(key)?.decision_ref ?? null;
    const saved = await repo.append(json(cmd), cohortUuid(800)); generation = saved.generation; current.set(key, saved); return saved;
  }
  const temporal = (date, ref) => ({ basis: 'reconstructed', valid_from: date, valid_through: date,
    observed_at: '2026-09-08T12:00:00.123456789Z', captured_at: '2026-09-08T12:00:00.123456789Z',
    available_at: '2026-09-08T12:00:00.123456789Z', evidence_refs: [ref] });
  async function housing(accountId, code = 'single_family_detached') {
    const r = accountRecords.find(r => r.row.raw_projection.account_id === accountId), date = original.subject.effective_date;
    return append(command('housing_at_date', accountId, { evaluated_on: date, housing_code: code,
      housing_catalog_id: 'custom-reviewed-housing-v1', housing_catalog_revision: '1', temporal_support: temporal(date, r.ref) }, [r.ref]));
  }
  async function reviewCandidate(candidate, { condition = null, considerationAmount = null } = {}) {
    const raw = candidate.row.raw_projection, own = candidate.ref, date = raw.sale_closing_date, refs = [];
    const add = async (kind, value, evidenceRefs = [own]) => {
      const saved = await append(command(kind, candidate.id, value, evidenceRefs)); refs.push(saved.decision_ref); return saved;
    };
    await add('sale_completion', { completed: true, event_evidence_refs: [own] });
    await add('closing_date', { date, event_evidence_refs: [own] });
    const relatedLinks = records.filter(r => r.role === 'sale_links' && r.row.raw_projection.source_record_id === raw.source_record_id);
    const interests = [{ interest_key: `whole:${raw.primary_account_id}`, source_ref: own, account: raw.primary_account_id },
      ...relatedLinks.map(r => ({ interest_key: `whole:${r.row.raw_projection.account_id}`, source_ref: r.ref, account: r.row.raw_projection.account_id }))];
    const interestRefs = interests.map(({ interest_key, source_ref }) => ({ interest_key, source_ref }));
    const allRefs = [...new Map([own, ...relatedLinks.map(r => r.ref), ...interests.map(i => accountRecords.find(r => r.row.raw_projection.account_id === i.account).ref)]
      .map(ref => [json(ref), ref])).values()];
    await add('recorded_consideration', { currency: 'USD', amount_decimal: considerationAmount ?? raw.sale_price,
      meaning: 'recorded_total_sale_price', interest_scope_refs: interestRefs }, allRefs);
    await add('economic_property_membership', { economic_property_key: `property:${candidate.id}`,
      interest_members: interests.map(i => ({ interest_key: i.interest_key, source_ref: i.source_ref, cad_link: {
        provider_key: 'local:gis.dcad_parcels', jurisdiction_key: 'Dallas', account_id: i.account,
        mapping_evidence_ref: accountRecords.find(r => r.row.raw_projection.account_id === i.account).ref } })),
      completeness_evidence_refs: [own, ...relatedLinks.map(r => r.ref)] }, allRefs);
    await add('completed_home_at_closing', { closing_date: date, completed_home: true, temporal_support: temporal(date, own) });
    await add('transaction_equivalence', { canonical_event_key: `event:${candidate.id}`, candidate_keys: [candidate.id], equivalence_evidence_refs: [own] });
    const conditions = [];
    if (condition !== null) {
      const saved = await append(command('material_condition', candidate.id, { condition_code: 'synthetic:condition', present: condition,
        condition_evidence_refs: [own] }, [own])); conditions.push(saved.decision_ref);
    }
    return append(command('study_fitness_review', candidate.id, { conclusion: 'compatible', required_fact_refs: refs,
      condition_review_refs: conditions }, [own], [...refs, ...conditions]));
  }
  async function reviewAll() { for (const id of base.accountIds) await housing(id); for (const candidate of candidates) await reviewCandidate(candidate); }
  return { input, base, catalog, resolver, records, candidates, accountRecords, accountIds: base.accountIds,
    repo, current, calls, command, append, housing, reviewCandidate, reviewAll, temporal,
    async adapterInput() { return { preparation_input: input, review_state: await repo.getCurrent(json(header.context_ref), generation), derived_at: SUPPORTED_DERIVED_AT }; } };
}
