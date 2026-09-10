import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortSupportedInputs as build, getCustomCohortSupportedInputsProfile as profile,
  CUSTOM_COHORT_SUPPORTED_INPUT_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortSupportedInputs.js';
import { summarizeNeighborhoodPopulations } from '../src/services/neighborhoodAssessment/statistics.js';
import { supportedInputsFixture, SUPPORTED_DERIVED_AT } from './fixtures/customCohortSupportedInputsFixture.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const REQUIRED = profile().required_fitness_fact_kinds;
const payload = (result, role) => result.derived_source_payloads.find(source => source.payload.role === role).payload;
const tx = result => payload(result, 'transactions').evidence;
const stock = result => payload(result, 'parcels').rows;
const current = (f, kind, key = f.candidates[0].id) => [...f.current.values()].find(r =>
  r.record.command.claim.kind === kind && r.record.command.subject_ref.key === key);
async function replace(f, kind, change, key = f.candidates[0].id) {
  const original = current(f, kind, key).record.command;
  const command = f.command(kind, key, structuredClone(original.claim.value), structuredClone(original.evidence_refs), structuredClone(original.claim.decision_refs));
  command.claim.qualifier = structuredClone(original.claim.qualifier); change(command);
  return f.append(command);
}
async function fitness(f, candidate = f.candidates[0]) {
  const records = [...f.current.values()].filter(r => r.record.command.subject_ref.key === candidate.id);
  const required = records.filter(r => REQUIRED.includes(r.record.command.claim.kind)).map(r => r.decision_ref);
  const conditions = records.filter(r => r.record.command.claim.kind === 'material_condition').map(r => r.decision_ref);
  return f.append(f.command('study_fitness_review', candidate.id, { conclusion: 'compatible', required_fact_refs: required,
    condition_review_refs: conditions }, [candidate.ref], [...required, ...conditions]));
}
function unknown(command, reason = 'missing_evidence') {
  command.claim.state = 'unknown'; command.claim.value = null; command.claim.unknown_reason = reason;
}
function frozenTree(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozenTree); } }

test('actual retained mapping2 and current review ledger produce exact cached/statistics inputs without CAD promotion or Apply authority', async () => {
  const f = await supportedInputsFixture(); await f.reviewAll();
  const input = await f.adapterInput(), calls = f.calls.length, before = json(input.preparation_input.retained_inputs.subject);
  const result = build(input);
  assert.equal(result.status, 'computed'); assert.equal(result.authority, 'not_established');
  assert.equal(result.support_basis, 'retained_reviewer_reconstruction'); assert.equal(result.apply.status, 'blocked');
  assert.equal(result.assessment, null); assert.equal(result.publication, null); assert.equal(f.calls.length, calls);
  assert.equal(result.cached_inputs.status, 'ready'); assert.equal(result.statistics.sales.transaction_count, 3);
  assert.equal(result.statistics.sales.recorded_transaction_price.median, 276000);
  assert.equal(result.statistics.sales.recorded_transaction_price.unit, 'USD');
  assert.equal(result.statistics.sales.unique_sold_account_count, 1); assert.equal(result.statistics.stock.property_count, 2);
  assert.deepEqual(result.statistics, summarizeNeighborhoodPopulations(result.cached_inputs.statistics_input));
  assert.equal(result.statistics.stock.year_built.count, 0); assert.equal(result.statistics.stock.gla_sqft.count, 0);
  assert.deepEqual(result.statistics.stock.assessed_values_by_tax_year, []);
  assert.equal(result.statistics.sales.sale_price_per_sqft.count, 0); assert.equal(result.statistics.predominant_value.state, 'unsupported');
  for (const row of stock(result)) for (const key of ['year_built', 'gla_sqft', 'site_area_sqft', 'assessed_value', 'assessment_tax_year', 'subdivision_key']) assert.equal(row[key], null, key);
  assert.equal(json(input.preparation_input.retained_inputs.subject), before);
  for (const source of result.derived_source_payloads) {
    assert.equal(source.content_sha256, sha(json(source.payload)));
    assert.equal(source.canonical_utf8_bytes, String(Buffer.byteLength(json(source.payload))));
    assert.equal(source.payload.binding.review_state_sha256, input.review_state.state_sha256);
  }
  assert.equal(payload(result, 'parcels').evidence[0].temporal_support[0].value.observed_at, '2026-09-08T12:00:00.123456789Z');
  assert.equal(stock(result)[0].observed_at, SUPPORTED_DERIVED_AT);
  assert.equal(result.disclosure.actor_authority, 'not_established'); frozenTree(result);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < LIMITS.output_utf8_bytes);
});

test('original mapping3 is admitted without currency or housing truth from witness flags', async () => {
  const f = await supportedInputsFixture({ mappingVersion: 3, saleCount: 1 });
  const empty = build(await f.adapterInput()); assert.equal(empty.status, 'incomplete'); assert.equal(empty.cached_inputs, null);
  await f.reviewAll(); const result = build(await f.adapterInput());
  assert.equal(result.statistics.sales.recorded_transaction_price.count, 1);
  assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
});

test('missing subject housing returns honest unavailable without invented eligible types', async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); const result = build(await f.adapterInput());
  assert.equal(result.cached_inputs, null); assert.equal(result.statistics, null); assert.equal(result.subject_housing.code, null);
  assert.equal(result.coverage.selected_account_count, 2); assert.equal(result.selection.account_ids.length, 2);
  assert.equal(result.coverage.retained_candidate_count, 0); assert.equal(stock(result).length, 2);
});

for (const code of ['single_family_attached', 'condominium_unit', 'manufactured_home', 'two_to_four_units']) {
  test(`subject-reviewed ${code} sets the sole eligible type without arbitrary caller types`, async () => {
    const f = await supportedInputsFixture({ saleCount: 0 });
    await f.housing(f.accountIds[0], code); await f.housing(f.accountIds[1], 'single_family_detached');
    const result = build(await f.adapterInput()); assert.equal(result.subject_housing.code, code);
    assert.equal(result.statistics.stock.property_count, 1);
    assert.equal(result.cached_inputs.geographic_members.find(r => r.account_id === f.accountIds[1]).competitive_eligibility, 'ineligible');
  });
}
for (const code of ['nonresidential', 'vacant_land', 'other']) test(`subject ${code} is not invented residential eligibility`, async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); await f.housing(f.accountIds[0], code);
  assert.equal(build(await f.adapterInput()).cached_inputs, null);
});

test('latest unknown effective-date housing masks old known; another qualifier cannot fill it', async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
  await replace(f, 'housing_at_date', c => unknown(c, 'unsupported_temporal_basis'), f.accountIds[0]);
  const other = f.command('housing_at_date', f.accountIds[0], { ...current(f, 'housing_at_date', f.accountIds[1]).record.command.claim.value,
    evaluated_on: '2026-09-05' }, [f.accountRecords[0].ref]);
  other.claim.value.temporal_support = f.temporal('2026-09-05', f.accountRecords[0].ref); await f.append(other);
  const result = build(await f.adapterInput()); assert.equal(result.subject_housing.code, null);
  assert.ok(result.support_gaps.some(g => g.reason === 'housing_unknown:unsupported_temporal_basis'));
});

for (const state of ['known', 'unknown']) test(`housing cannot import ${state} other-date decision dependency meaning`, async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
  const base = current(f, 'housing_at_date', f.accountIds[0]).record.command;
  const other = f.command('housing_at_date', f.accountIds[0], { ...structuredClone(base.claim.value), evaluated_on: '2026-09-05' }, base.evidence_refs);
  other.claim.value.temporal_support = f.temporal('2026-09-05', f.accountRecords[0].ref);
  if (state === 'unknown') unknown(other);
  const saved = await f.append(other);
  await replace(f, 'housing_at_date', c => { c.claim.decision_refs = [saved.decision_ref]; }, f.accountIds[0]);
  assert.equal(build(await f.adapterInput()).cached_inputs, null);
});

for (const mutation of ['catalog', 'date-interval', 'missing-time', 'reversed-clocks', 'future-nanosecond']) {
  test(`housing support refuses ${mutation}`, async () => {
    const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
    await replace(f, 'housing_at_date', c => {
      if (mutation === 'catalog') c.claim.value.housing_catalog_revision = '2';
      const t = c.claim.value.temporal_support;
      if (mutation === 'date-interval') t.valid_through = '2026-09-05', t.valid_from = '2026-09-05';
      if (mutation === 'missing-time') t.available_at = null;
      if (mutation === 'reversed-clocks') t.observed_at = '2026-09-08T12:00:01Z';
      if (mutation === 'future-nanosecond') t.observed_at = t.captured_at = '2026-09-09T12:00:00.000000001Z';
    }, f.accountIds[0]);
    assert.equal(build(await f.adapterInput()).cached_inputs, null);
  });
}
test('equal variable-precision times compare exactly, preserving original strings', async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
  await replace(f, 'housing_at_date', c => Object.assign(c.claim.value.temporal_support, {
    observed_at: '2026-09-09T12:00:00.000000000Z', captured_at: '2026-09-09T12:00:00.000Z', available_at: '2026-09-09T12:00:00Z' }), f.accountIds[0]);
  const result = build(await f.adapterInput()); assert.equal(result.status, 'computed');
  assert.equal(result.subject_housing.temporal_support[0].value.observed_at, '2026-09-09T12:00:00.000000000Z');
});

test('subject outside selection still controls housing and retains its review evidence', async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
  f.input.selection.included_recorded_group_ids = f.catalog.pockets.filter(p => !p.account_ids.includes(f.accountIds[0])).map(p => p.id);
  const result = build(await f.adapterInput()); assert.deepEqual(result.selection.account_ids, [f.accountIds[1]]);
  assert.equal(stock(result).length, 1); assert.equal(result.subject_housing.decision_refs.length, 1);
  assert.equal(result.subject_housing.account_id, f.accountIds[0]);
});

for (const kind of REQUIRED) test(`latest unknown ${kind} prevents old fitness/support fallback`, async () => {
  const f = await supportedInputsFixture({ saleCount: 1 }); await f.reviewAll();
  await replace(f, kind, c => unknown(c)); const result = build(await f.adapterInput());
  assert.equal(result.status, 'incomplete'); assert.equal(result.statistics.sales.transaction_count, 0);
  assert.equal(tx(result)[0].candidate_fact_states[0].facts.find(r => r.kind === kind).state, 'unknown');
});

for (const mutation of ['missing', 'extra', 'wrong-current-kind', 'stale']) test(`fitness cannot certify ${mutation} required-head coverage`, async () => {
  const f = await supportedInputsFixture({ saleCount: 1 }); await f.reviewAll();
  if (mutation === 'stale') await replace(f, 'closing_date', () => {});
  else await replace(f, 'study_fitness_review', c => {
    if (mutation === 'missing') c.claim.value.required_fact_refs.pop();
    if (mutation === 'extra') c.claim.value.condition_review_refs = [c.claim.value.required_fact_refs[0]];
    if (mutation === 'wrong-current-kind') c.claim.value.required_fact_refs = c.claim.value.required_fact_refs.slice(1);
  });
  assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 0);
});

test('compatible is explicit reconstruction assertion; absent current conditions must be covered and adverse/unknown blocks', async () => {
  const f = await supportedInputsFixture({ saleCount: 1 }); await f.housing(f.accountIds[0]); await f.housing(f.accountIds[1]);
  await f.reviewCandidate(f.candidates[0], { condition: false });
  assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 1);
  await replace(f, 'material_condition', c => { c.claim.value.present = true; }); await fitness(f);
  assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 0);
  await replace(f, 'material_condition', c => unknown(c, 'unreviewed_material_condition')); await fitness(f);
  assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 0);
});

for (const mutation of ['false-completion', 'false-home', 'source-price-only', 'currency', 'amount-conflict', 'missing-equivalence']) {
  test(`recorded price requires reviewed fact meaning: ${mutation}`, async () => {
    const f = await supportedInputsFixture({ saleCount: 1 }); await f.reviewAll();
    const kind = mutation === 'false-completion' ? 'sale_completion' : mutation === 'false-home' ? 'completed_home_at_closing'
      : mutation === 'missing-equivalence' ? 'transaction_equivalence' : 'recorded_consideration';
    await replace(f, kind, c => {
      if (mutation === 'false-completion') c.claim.value.completed = false;
      if (mutation === 'false-home') c.claim.value.completed_home = false;
      if (mutation === 'currency') c.claim.value.currency = 'CAD';
      if (mutation === 'amount-conflict' || mutation === 'source-price-only') c.claim.value.amount_decimal = '300000';
      if (mutation === 'missing-equivalence') c.claim.value.candidate_keys.push('not-retained');
    }); await fitness(f);
    assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 0);
  });
}

for (const amount of ['9007199254740993', '275000.00000000000000001', '0.0000001']) test(`rejects Number collapse/unrepresentable price ${amount}`, async () => {
  const f = await supportedInputsFixture({ saleCount: 1, saleOverrides: { sale_price: amount } }); await f.reviewAll();
  assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 0);
});
test('exact retained decimal comparison admits trailing zeros without changing original consideration', async () => {
  const f = await supportedInputsFixture({ saleCount: 1 }); await f.reviewAll();
  await replace(f, 'recorded_consideration', c => { c.claim.value.amount_decimal = '275000.0000'; }); await fitness(f);
  assert.equal(build(await f.adapterInput()).statistics.sales.recorded_transaction_price.low, 275000);
});

test('complete package retains outside-selected co-parcel and total once; no allocation/PPSF substitution', async () => {
  const f = await supportedInputsFixture({ saleCount: 1, packageSale: true }); await f.reviewAll();
  f.input.selection.included_recorded_group_ids = f.catalog.pockets.filter(p => p.account_ids.includes(f.accountIds[0])).map(p => p.id);
  const result = build(await f.adapterInput());
  assert.equal(result.statistics.sales.transaction_count, 1); assert.equal(result.statistics.sales.recorded_transaction_price.count, 1);
  assert.equal(result.statistics.sales.property_sale_price.count, 0); assert.equal(result.statistics.sales.sale_price_per_sqft.count, 0);
  assert.equal(result.cached_inputs.statistics_input.sales[0].parcel_count, 2);
  assert.deepEqual(result.cached_inputs.statistics_input.sales[0].parcels.map(p => p.account_id), f.accountIds);
  assert.equal(result.statistics.state, 'insufficient'); assert.equal(result.status, 'computed');
});
for (const mutation of ['partial', 'missing-county', 'wrong-provider', 'wrong-county', 'interest-collapse', 'unmapped']) {
  test(`economic membership refuses ${mutation}`, async () => {
    const f = await supportedInputsFixture({ saleCount: 1, packageSale: true, missingCounty: mutation === 'missing-county' }); await f.reviewAll();
    if (mutation !== 'missing-county') await replace(f, 'economic_property_membership', c => {
      if (mutation === 'partial') c.claim.value.interest_members.pop();
      if (mutation === 'wrong-provider') c.claim.value.interest_members[0].cad_link.provider_key = 'provider-from-client';
      if (mutation === 'wrong-county') c.claim.value.interest_members[0].cad_link.jurisdiction_key = 'dallas';
      if (mutation === 'unmapped') c.claim.value.interest_members[0].cad_link = null;
      if (mutation === 'interest-collapse') c.claim.value.interest_members[1].cad_link = structuredClone(c.claim.value.interest_members[0].cad_link);
    });
    if (mutation !== 'missing-county') await fitness(f);
    assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 0);
  });
}

test('proven disjoint membership is explicitly excluded; unknown membership cannot prove outside selection', async () => {
  const f = await supportedInputsFixture({ saleCount: 1 }); await f.reviewAll();
  f.input.selection.included_recorded_group_ids = f.catalog.pockets.filter(p => !p.account_ids.includes(f.accountIds[0])).map(p => p.id);
  let result = build(await f.adapterInput()); assert.equal(result.status, 'computed');
  assert.equal(result.coverage.retained_candidate_count, 1); assert.equal(result.coverage.derived_transaction_count, 0);
  assert.equal(tx(result)[0].status, 'outside_selection'); assert.equal(tx(result)[0].economic_membership.account_ids[0], f.accountIds[0]);
  await replace(f, 'economic_property_membership', c => unknown(c, 'incomplete_membership'));
  result = build(await f.adapterInput()); assert.equal(result.status, 'incomplete'); assert.equal(tx(result)[0].status, 'unavailable');
  assert.equal(result.coverage.derived_transaction_count, 1);
});

for (const scenario of ['reused-event-key', 'overlap', 'convenient-peer']) test(`equivalence refuses ${scenario} without dropping candidates`, async () => {
  const f = await supportedInputsFixture({ saleCount: 2 }); await f.reviewAll();
  const [a, b] = f.candidates;
  if (scenario === 'reused-event-key') {
    await replace(f, 'transaction_equivalence', c => { c.claim.value.canonical_event_key = 'same-event'; }, a.id);
    await replace(f, 'transaction_equivalence', c => { c.claim.value.canonical_event_key = 'same-event'; }, b.id);
  } else {
    await replace(f, 'transaction_equivalence', c => {
      c.claim.value.canonical_event_key = 'combined-event'; c.claim.value.candidate_keys = [a.id, b.id];
      c.claim.value.equivalence_evidence_refs = [a.ref, b.ref]; c.evidence_refs = [a.ref, b.ref];
    }, a.id);
    if (scenario === 'convenient-peer') await replace(f, 'closing_date', unknown, b.id);
  }
  await fitness(f, a); await fitness(f, b);
  const result = build(await f.adapterInput()); assert.equal(result.statistics.sales.transaction_count, 0);
  assert.deepEqual(tx(result).flatMap(r => r.candidate_keys).sort(), f.candidates.map(c => c.id).sort());
  assert.equal(result.status, 'incomplete');
});

test('all 31 separately reviewed repeat sales survive without a30-sale cap', async () => {
  const f = await supportedInputsFixture({ saleCount: 31 }); await f.reviewAll();
  const result = build(await f.adapterInput()); assert.equal(result.statistics.sales.transaction_count, 31);
  assert.equal(result.statistics.sales.unique_sold_account_count, 1); assert.equal(result.coverage.retained_candidate_count, 31);
  assert.equal(result.coverage.review_cap_is_population_limit, false);
});

async function joinCandidates(f) {
  const ids = f.candidates.map(c => c.id), refs = f.candidates.map(c => c.ref);
  for (const candidate of f.candidates) {
    await replace(f, 'economic_property_membership', c => { c.claim.value.economic_property_key = 'same-whole-property'; }, candidate.id);
    await replace(f, 'transaction_equivalence', c => {
      c.claim.value.canonical_event_key = 'same-reviewed-event'; c.claim.value.candidate_keys = ids;
      c.claim.value.equivalence_evidence_refs = refs; c.evidence_refs = refs;
    }, candidate.id);
    await fitness(f, candidate);
  }
}
test('explicit consistent cross-canonical equivalence counts total once, then a peer correction blocks the entire group', async () => {
  const f = await supportedInputsFixture({ saleCount: 2, saleOverrides: {
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-01', sale_price: '275000' } });
  await f.reviewAll(); await joinCandidates(f);
  let result = build(await f.adapterInput()); assert.equal(result.statistics.sales.transaction_count, 1);
  assert.equal(result.coverage.retained_candidate_count, 2); assert.equal(tx(result).length, 1);
  assert.equal(tx(result)[0].candidate_keys.length, 2);
  await replace(f, 'recorded_consideration', c => unknown(c), f.candidates[1].id);
  result = build(await f.adapterInput()); assert.equal(result.statistics.sales.transaction_count, 0);
  assert.equal(tx(result).length, 1); assert.equal(tx(result)[0].candidate_keys.length, 2);
  assert.equal(result.status, 'incomplete');
});
test('candidate date/price contradictions cannot be hidden by explicit equivalence alone', async () => {
  const f = await supportedInputsFixture({ saleCount: 2 }); await f.reviewAll(); await joinCandidates(f);
  const result = build(await f.adapterInput()); assert.equal(result.statistics.sales.transaction_count, 0);
  assert.equal(tx(result)[0].reason, 'equivalent_candidate_facts_conflict');
});
test('outside-period exclusion needs matching current dates for the whole candidate component', async () => {
  const f = await supportedInputsFixture({ saleCount: 2, saleOverrides: {
    sale_closing_date: '2024-07-01', source_close_date: '2024-07-01', sale_price: '275000' } });
  await f.reviewAll(); await joinCandidates(f);
  let result = build(await f.adapterInput()); assert.equal(result.status, 'computed');
  assert.equal(tx(result)[0].status, 'outside_observation_period'); assert.equal(result.statistics.sales.transaction_count, 0);
  await replace(f, 'closing_date', c => unknown(c), f.candidates[1].id);
  result = build(await f.adapterInput()); assert.equal(result.status, 'incomplete');
  assert.equal(tx(result)[0].status, 'unavailable'); assert.equal(tx(result)[0].candidate_keys.length, 2);
});
test('partial and contradictory membership do not establish disjoint selection exclusion', async () => {
  const f = await supportedInputsFixture({ saleCount: 2, saleOverrides: {
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-01', sale_price: '275000' } });
  await f.reviewAll(); await joinCandidates(f);
  f.input.selection.included_recorded_group_ids = f.catalog.pockets.filter(p => !p.account_ids.includes(f.accountIds[0])).map(p => p.id);
  assert.equal(tx(build(await f.adapterInput()))[0].status, 'outside_selection');
  await replace(f, 'economic_property_membership', c => { c.claim.value.economic_property_key = 'contradictory-property'; }, f.candidates[1].id);
  let result = build(await f.adapterInput()); assert.equal(result.status, 'incomplete'); assert.notEqual(tx(result)[0].status, 'outside_selection');
  await replace(f, 'economic_property_membership', c => { c.claim.value.interest_members[0].cad_link = null; }, f.candidates[1].id);
  result = build(await f.adapterInput()); assert.equal(result.status, 'incomplete'); assert.notEqual(tx(result)[0].status, 'outside_selection');
});
test('actual capture refuses duplicate canonical identities rather than relabeling modified retained bytes as valid', async () => {
  await assert.rejects(supportedInputsFixture({ saleCount: 2, saleOverrides: { sale_id: '20' } }), /duplicate_sale_id/);
});
test('stored canonical/source date conflict and missing canonical price remain unavailable, not CurrentPrice fallback', async () => {
  for (const saleOverrides of [{ source_close_date: '2024-03-02' }, { sale_price: null, source_current_price: '275000' }]) {
    const f = await supportedInputsFixture({ saleCount: 1, saleOverrides });
    await f.housing(f.accountIds[0]); await f.housing(f.accountIds[1]);
    if (saleOverrides.sale_price === null) {
      // The reviewer may assert an amount, but the captured canonical amount
      // is still absent and cannot be silently supplied from CurrentPrice.
      await f.reviewCandidate(f.candidates[0], { considerationAmount: '275000' });
    } else await f.reviewCandidate(f.candidates[0]);
    assert.equal(build(await f.adapterInput()).statistics.sales.transaction_count, 0);
  }
});
test('review operational bounds reject oversized complete sets, never return partial heads', async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
  const input = structuredClone(await f.adapterInput());
  input.review_state.heads = Array(5001).fill(input.review_state.heads[0]); input.review_state.head_count = 5001;
  assert.throws(() => build(input), /review_limit/);
});
test('the installed profile is closed, detached and content bound; selecting different groups changes derived hashes', async () => {
  const installed = profile(), { profile_sha256, ...body } = installed;
  assert.equal(profile_sha256, sha(json(body))); frozenTree(installed);
  const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
  const first = build(await f.adapterInput()); f.input.selection.included_recorded_group_ids = [];
  const second = build(await f.adapterInput());
  assert.notEqual(first.binding.selection_sha256, second.binding.selection_sha256);
  assert.notEqual(first.cached_inputs.captured_input_sha256, second.cached_inputs.captured_input_sha256);
  assert.notEqual(first.derived_source_payloads[0].content_sha256, second.derived_source_payloads[0].content_sha256);
});

for (const mutation of ['context', 'generation', 'hash', 'record', 'selection', 'retained', 'extra-flag', 'time']) {
  test(`fails closed on altered ${mutation} input`, async () => {
    const f = await supportedInputsFixture({ saleCount: 0 }); await f.reviewAll();
    const input = structuredClone(await f.adapterInput());
    if (mutation === 'context') input.review_state.binding.context_ref.context_revision = '2';
    if (mutation === 'generation') input.review_state.binding.generation = '9';
    if (mutation === 'hash') input.review_state.state_sha256 = 'f'.repeat(64);
    if (mutation === 'record') input.review_state.heads[0].record.command.rationale = 'altered';
    if (mutation === 'selection') input.preparation_input.selection.included_recorded_group_ids = ['unknown'];
    if (mutation === 'retained') input.preparation_input.retained_inputs.subject.effective_date = '2026-09-05';
    if (mutation === 'extra-flag') input.supported = true;
    if (mutation === 'time') input.derived_at = '2026-09-06T08:00:00.123Z';
    assert.throws(() => build(input));
  });
}
test('getter/proxy review input never executes and malformed ownership metadata is rejected', async () => {
  const f = await supportedInputsFixture({ saleCount: 0 }); const input = await f.adapterInput(); let called = 0;
  for (const review_state of [new Proxy({}, { getPrototypeOf() { called++; throw Error('trap'); } }),
    { get status() { called++; throw Error('getter'); } }]) assert.throws(() => build({ ...input, review_state }));
  const object = { preparation_input: input.preparation_input, review_state: input.review_state, get derived_at() { called++; return SUPPORTED_DERIVED_AT; } };
  assert.throws(() => build(object)); assert.equal(called, 0);
});
test('empty explicit selection remains empty, incomplete, and preserves the audit', async () => {
  const f = await supportedInputsFixture({ saleCount: 1 }); await f.reviewAll(); f.input.selection.included_recorded_group_ids = [];
  const result = build(await f.adapterInput()); assert.deepEqual(result.selection.account_ids, []);
  assert.equal(result.statistics.stock.property_count, 0); assert.equal(result.status, 'incomplete');
  assert.equal(result.coverage.retained_candidate_count, 1); assert.equal(tx(result).length, 1);
});
