import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { proposeAssignmentSalesMatchPage, ASSIGNMENT_SALES_MATCH_PROPOSAL_LIMITS } from '../src/services/assignmentSalesCsv/matchProposals.js';

const A = '00000000000000001', B = '00000000000000002';
const at = '2026-09-10T13:14:15.123456Z';
const defaults = { ListingId: 'MLS-1', Address: '513 Synthetic Drive', City: 'Garland', County: 'Dallas County',
  PostalCode: '75041', ParcelNumber: A, ParcelNumber2: '', CloseDate: '8/25/2020', ClosePrice: '282500',
  MlsStatus: 'Closed', StructuralStyle: 'Single Detached', BuyerFinancing: 'Conventional', SellerContributions: '0' };
const quote = value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
function fixture(overrides = [{}]) {
  const records = overrides.map((item, index) => ({ ...defaults, ListingId: `MLS-${index + 1}`, ...item }));
  const headers = [...new Set(records.flatMap(Object.keys))];
  const bytes = Buffer.from([headers, ...records.map(row => headers.map(key => row[key] ?? ''))]
    .map(row => row.map(quote).join(',')).join('\r\n'));
  return fixtureBytes(bytes);
}
function fixtureBytes(bytes) {
  const prepared = prepareAssignmentSalesCsv(bytes), { rows, ...header } = prepared;
  return { batch: { batch_id: '10000000-0000-4000-8000-000000000001', source_sha256: prepared.source_sha256,
    preparation_sha256: digestPreparedSalesParts(header, rows) },
  rows: rows.map((row, index) => ({ receipt_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    source_row_number: row.source_row_number, record_data: row })) };
}
const candidate = (accountId = A, overrides = {}) => ({ account_id: accountId, address: '513 Synthetic Dr',
  city: 'GARLAND', county: 'DALLAS', postal_code: '75041', ...overrides });
function reader(responseFor = () => ({ status: 'complete', candidates: [candidate()] })) {
  const calls = [];
  return { calls, readCandidates: async input => {
    calls.push(input);
    return { observed_at: at, results: input.requests.map(request => ({ request_id: request.request_id, ...responseFor(request) })) };
  } };
}
const run = async (input = fixture(), responseFor) => {
  const observed = reader(responseFor), result = await proposeAssignmentSalesMatchPage(input, observed);
  return { result, observed };
};
const clone = value => JSON.parse(JSON.stringify(value));

test('real prepared rows yield bound current-observation proposals, not accepted matches or analysis membership', async () => {
  const input = fixture(), before = JSON.stringify(input), { result, observed } = await run(input);
  assert.deepEqual(result.binding, input.batch);
  assert.equal(result.observed_at, at);
  assert.equal(result.basis, 'observed_current_cad_candidates');
  assert.equal(result.rows[0].proposal_status, 'proposed');
  assert.equal(result.rows[0].method, 'supplied_parcel_identifiers');
  assert.deepEqual(result.rows[0].proposed_account_ids, [A]);
  assert.equal(result.accepted, false);
  assert.equal(result.rows[0].accepted, false);
  assert.equal(result.rows[0].review_required, true);
  assert.equal(result.matching_status, 'proposal_only');
  assert.equal(result.analysis_status, 'not_evaluated');
  assert.equal(result.rows[0].analysis_status, 'not_evaluated');
  assert.equal(observed.calls.length, 1);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(result.rows[0].proposed_account_ids));
  assert.ok(Object.isFrozen(observed.calls[0].requests[0]));
});

test('one deduplicated page lookup covers all rows without selecting a 30-sale subset', async () => {
  const input = fixture(Array.from({ length: 100 }, () => ({})));
  const { result, observed } = await run(input);
  assert.equal(result.rows.length, 100);
  assert.equal(observed.calls.length, 1);
  assert.equal(observed.calls[0].requests.length, 2);
  assert.equal(result.rows.filter(row => row.proposal_status === 'proposed').length, 100);
  assert.deepEqual(result.rows.map(row => row.source_row_number), input.rows.map(row => row.source_row_number));
});

test('an explicit empty page remains empty and never requests candidates', async () => {
  const input = fixture(); input.rows = [];
  const { result, observed } = await run(input);
  assert.deepEqual(result.rows, []); assert.deepEqual(result.lookups, []);
  assert.equal(result.observed_at, null); assert.equal(observed.calls.length, 0);
});

test('a bounded later page preserves actual logical ordinals without renumbering', async () => {
  const input = fixture(Array.from({ length: 4 }, () => ({}))); input.rows = input.rows.slice(2);
  const { result } = await run(input);
  assert.deepEqual(result.rows.map(row => row.source_row_number), [4, 5]);
});

test('address-only matching requires exact normalized address, city and reported county/postal evidence', async () => {
  const { result, observed } = await run(fixture([{ ParcelNumber: '' }]));
  assert.deepEqual(observed.calls[0].requests[0], { request_id: 'lookup:1', kind: 'address', identifier: null,
    address_key: '513 SYNTHETIC DR', city_key: 'GARLAND', county_key: 'DALLAS', postal_code5: '75041' });
  assert.equal(result.rows[0].method, 'unique_exact_address');
});

test('supported full addresses reconcile their own city/state/postal tails without a subject or filename fallback', async () => {
  const { result } = await run(fixture([{ ParcelNumber: '', Address: '513 Synthetic Drive, Garland, TX 75041', City: '', PostalCode: '' }]));
  assert.equal(result.rows[0].proposal_status, 'proposed');
  assert.equal(result.rows[0].method, 'unique_exact_address');
});

test('missing city remains unavailable, never inferred from the assignment or file name', async () => {
  const { result, observed } = await run(fixture([{ ParcelNumber: '', City: '' }]));
  assert.equal(observed.calls.length, 0);
  assert.ok(result.rows[0].reasons.includes('address_city_required'));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('native county IDs preserve letters and punctuation and do not become zero-padded global IDs', async () => {
  const { result, observed } = await run(fixture([{ ParcelNumber: 'R-0001-AB', County: 'Collin', Address: '', City: '', PostalCode: '' }]),
    () => ({ status: 'complete', candidates: [candidate(B, { county: 'COLLIN' })] }));
  assert.equal(observed.calls[0].requests[0].identifier, 'R-0001-AB');
  assert.equal(observed.calls[0].requests[0].county_key, 'COLLIN');
  assert.deepEqual(result.rows[0].proposed_account_ids, [B]);
});

test('a Dallas/native-county inconsistency does not get normalized into a match', async () => {
  const { result } = await run(fixture([{ ParcelNumber: 'R-0001-AB' }]));
  assert.ok(result.rows[0].reasons.includes('parcel_identifier_requires_review'));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('every supplied parcel must resolve before a multi-parcel set can be proposed', async () => {
  const input = fixture([{ ParcelNumber2: B }]);
  const complete = await run(input, request => ({ status: 'complete', candidates: [candidate(request.identifier === B ? B : A)] }));
  assert.deepEqual(complete.result.rows[0].proposed_account_ids, [A, B]);
  const incomplete = await run(input, request => ({ status: 'complete', candidates: request.identifier === B ? [] : [candidate()] }));
  assert.deepEqual(incomplete.result.rows[0].proposed_account_ids, []);
  assert.ok(incomplete.result.rows[0].reasons.includes('incomplete_supplied_parcel_set'));
  assert.ok(incomplete.result.rows[0].observed_candidate_account_ids.includes(A));
  assert.equal(incomplete.result.rows[0].reasons.includes('parcel_reference_alias_collision'), false);
});

test('two supplied identifiers resolving to one account require review rather than silently collapsing a parcel set', async () => {
  const { result } = await run(fixture([{ ParcelNumber2: B }]));
  assert.ok(result.rows[0].reasons.includes('parcel_reference_alias_collision'));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('an invalid second parcel prevents address fallback even if a unique address candidate exists', async () => {
  const { result } = await run(fixture([{ ParcelNumber2: '123,456' }]));
  assert.ok(result.rows[0].reasons.includes('parcel_identifier_requires_review'));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('an address proposing an account outside the exact parcel set is a conflict', async () => {
  const { result } = await run(fixture(), request => ({ status: 'complete', candidates: [candidate(request.kind === 'address' ? B : A)] }));
  assert.ok(result.rows[0].reasons.includes('parcel_address_conflict'));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('real CSV normalization supplies both exact parcel field names consumed by the kernel', async () => {
  const input = fixture([{ ParcelNumber: ` ${A} `, ParcelNumber2: ` ${B} ` }]);
  assert.equal(input.rows[0].record_data.values.parcel_number_raw, A);
  assert.equal(input.rows[0].record_data.values.parcel_number2_raw, B);
  assert.equal(Object.hasOwn(input.rows[0].record_data.values, 'parcel_number'), false);
  const { observed } = await run(input, request => ({ status: 'complete', candidates: [candidate(request.identifier === B ? B : A)] }));
  assert.deepEqual(observed.calls[0].requests.filter(request => request.kind === 'identifier').map(request => request.identifier), [A, B]);
});

for (const second of ['', B]) {
  test(`complete empty alias lookup is corroborated by every supplied canonical parcel situs (${second ? 'two parcels' : 'one parcel'})`, async () => {
    const { result } = await run(fixture([{ ParcelNumber2: second }]), request => ({ status: 'complete',
      candidates: request.kind === 'address' ? [] : [candidate(request.identifier)] }));
    assert.equal(result.rows[0].proposal_status, 'proposed');
    assert.equal(result.rows[0].method, 'supplied_parcel_identifiers');
    assert.deepEqual(result.rows[0].proposed_account_ids, second ? [A, B] : [A]);
    assert.deepEqual(result.rows[0].reasons, []);
    assert.equal(result.rows[0].accepted, false);
    assert.equal(result.rows[0].analysis_status, 'not_evaluated');
    assert.equal(result.lookups.find(lookup => lookup.request.kind === 'address').candidates.length, 0);
  });
}

for (const overrides of [{ address: '99 Other Dr' }, { address: null }, { address: '513 Synthetic Dr Unit 4' },
  { city: 'IRVING' }, { city: null }, { county: 'COLLIN' }, { county: null }, { postal_code: '99999' }]) {
  test(`empty-alias fallback cannot discard one differing or unavailable canonical parcel situs: ${JSON.stringify(overrides)}`, async () => {
    const { result } = await run(fixture([{ ParcelNumber2: B }]), request => ({ status: 'complete',
      candidates: request.kind === 'address' ? [] : [candidate(request.identifier, request.identifier === B ? overrides : {})] }));
    assert.deepEqual(result.rows[0].proposed_account_ids, []);
    assert.equal(result.rows[0].proposal_status, 'review_required');
  });
}

test('empty-alias fallback does not stand in for a missing member of a supplied parcel set', async () => {
  const { result } = await run(fixture([{ ParcelNumber2: B }]), request => ({ status: 'complete',
    candidates: request.kind === 'address' || request.identifier === B ? [] : [candidate()] }));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
  assert.ok(result.rows[0].reasons.includes('incomplete_supplied_parcel_set'));
  assert.equal(result.rows[0].reasons.includes('parcel_reference_alias_collision'), false);
});

test('empty-alias fallback requires reported county rather than borrowing it from a CAD candidate', async () => {
  const { result } = await run(fixture([{ County: '' }]), request => ({ status: 'complete',
    candidates: request.kind === 'address' ? [] : [candidate()] }));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
  assert.ok(result.rows[0].reasons.includes('parcel_address_unverified'));
});

for (const outcome of [{ status: 'unavailable', candidates: [] },
  { status: 'complete', candidates: [candidate(), candidate(B)] }]) {
  test(`matching canonical situs never replaces an ${outcome.status === 'unavailable' ? 'unavailable' : 'ambiguous'} address lookup`, async () => {
    const { result } = await run(fixture(), request => request.kind === 'address' ? outcome : { status: 'complete', candidates: [candidate()] });
    assert.deepEqual(result.rows[0].proposed_account_ids, []);
    assert.ok(result.rows[0].reasons.includes(outcome.status === 'unavailable' ? 'candidate_lookup_unavailable' : 'ambiguous_candidate'));
  });
}

test('empty address lookup without any supplied parcel cannot use the canonical-situs fallback', async () => {
  const { result } = await run(fixture([{ ParcelNumber: '' }]), () => ({ status: 'complete', candidates: [] }));
  assert.equal(result.rows[0].proposal_status, 'unresolved');
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('different primary/alternate address fields are not silently coalesced', async () => {
  const { result } = await run(fixture([{ PropertyAddress: '99 Other Road' }]));
  assert.ok(result.rows[0].reasons.includes('conflicting_address_fields'));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('equivalent alternate address spellings deduplicate rather than conflict', async () => {
  const { result, observed } = await run(fixture([{ PropertyAddress: '513 SYNTHETIC DR' }]));
  assert.equal(result.rows[0].proposal_status, 'proposed');
  assert.equal(observed.calls[0].requests.filter(request => request.kind === 'address').length, 1);
});

for (const fields of [{ CountyOrParish: 'Collin' }, { Zip: '99999' }, { State: 'CA' },
  { State: 'TX', StateOrProvince: 'CA' }, { Address: '513 Synthetic Drive, Irving, TX 75041' },
  { Address: '513 Synthetic Drive, Garland, TX 99999' }]) {
  test(`conflicting/unsupported location evidence blocks a proposal: ${JSON.stringify(fields)}`, async () => {
    const { result } = await run(fixture([fields]));
    assert.deepEqual(result.rows[0].proposed_account_ids, []);
    assert.equal(result.rows[0].proposal_status, 'review_required');
  });
}

for (const address of ['513 Synthetic Drive, #1104, Garland, TX 75041', '513 Synthetic Drive Apt 2',
  '513 Synthetic Drive, Building B', '513 Synthetic Drive Unit 4']) {
  test(`unit/building identity is never discarded for a street-only proposal: ${address}`, async () => {
    const { result, observed } = await run(fixture([{ Address: address }]));
    assert.ok(result.rows[0].reasons.includes('unit_or_building_review_required'));
    assert.deepEqual(result.rows[0].proposed_account_ids, []);
    assert.equal(observed.calls[0].requests.some(request => request.kind === 'address'), false);
  });
}

test('candidate unit or different situs addresses cannot corroborate an address-only source', async () => {
  for (const address of ['513 Synthetic Dr Unit 4', '513 Synthetic Dr, #4', '99 Other St']) {
    const { result } = await run(fixture([{ ParcelNumber: '' }]), () => ({ status: 'complete', candidates: [candidate(A, { address })] }));
    assert.ok(result.rows[0].reasons.includes('candidate_address_conflict'));
    assert.deepEqual(result.rows[0].proposed_account_ids, []);
  }
});

test('reported county conflicts with observed candidates remain explicit', async () => {
  const { result } = await run(fixture(), () => ({ status: 'complete', candidates: [candidate(A, { county: 'TARRANT' })] }));
  assert.ok(result.rows[0].reasons.includes('candidate_county_conflict'));
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('multiple observed candidates and unavailable lookup evidence never select an arbitrary account', async () => {
  for (const outcome of [{ status: 'complete', candidates: [candidate(), candidate(B)] },
    { status: 'unavailable', candidates: [candidate()] }]) {
    const { result } = await run(fixture([{ ParcelNumber: '' }]), () => outcome);
    assert.equal(result.rows[0].proposal_status, 'review_required');
    assert.deepEqual(result.rows[0].proposed_account_ids, []);
    assert.ok(result.rows[0].observed_candidate_account_ids.includes(A));
  }
});

test('a fully observed lookup with no result stays unresolved', async () => {
  const { result } = await run(fixture(), () => ({ status: 'complete', candidates: [] }));
  assert.equal(result.rows[0].proposal_status, 'unresolved');
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('rejected, empty, duplicate and conflicting source rows all retain their original disposition and identity', async () => {
  const input = fixture([{ ListingId: 'dup' }, { ListingId: 'dup' }, { ListingId: 'conflict', ClosePrice: '1' },
    { ListingId: 'conflict', ClosePrice: '2' }]);
  const extra = clone(input.rows[0]); extra.receipt_id = '20000000-0000-4000-8000-000000000005'; extra.source_row_number = 6;
  extra.record_data = { ...extra.record_data, source_row_number: 6, preparation_disposition: 'rejected', values: null, issues: ['column_count_mismatch'] };
  input.rows.push(extra);
  const empty = clone(extra); empty.receipt_id = '20000000-0000-4000-8000-000000000006'; empty.source_row_number = 7;
  empty.record_data = { ...empty.record_data, source_row_number: 7, preparation_disposition: 'empty', issues: ['empty_record'] }; input.rows.push(empty);
  const { result } = await run(input);
  assert.deepEqual(result.rows.map(row => row.preparation_disposition), ['prepared', 'duplicate', 'identity_conflict', 'identity_conflict', 'rejected', 'empty']);
  assert.deepEqual(result.rows.map(row => row.receipt_id), input.rows.map(row => row.receipt_id));
  assert.deepEqual(result.rows.slice(-2).map(row => row.proposal_status), ['not_proposed', 'not_proposed']);
  assert.ok(result.rows[1].reasons.includes('duplicate_source_row'));
  assert.ok(result.rows[2].reasons.includes('source_identity_conflict'));
});

test('genuine ragged and empty prepared CSV receipts remain present without candidate calls', async () => {
  const input = fixtureBytes(Buffer.from('Address,CloseDate,ClosePrice\n513 Synthetic Dr,8/25/2020\n,,\n'));
  const { result, observed } = await run(input);
  assert.deepEqual(input.rows.map(row => row.record_data.preparation_disposition), ['rejected', 'empty']);
  assert.deepEqual(result.rows.map(row => row.preparation_disposition), ['rejected', 'empty']);
  assert.deepEqual(result.rows.map(row => row.proposal_status), ['not_proposed', 'not_proposed']);
  assert.deepEqual(result.rows.map(row => row.receipt_id), input.rows.map(row => row.receipt_id));
  assert.equal(observed.calls.length, 0);
});

test('money, area, units and historical dates never alter property identity or grant sale eligibility', async () => {
  const { result } = await run(fixture([{ CurrentPrice: '999999999999999999999.123456789', Currency: 'CAD', LivingAreaUnits: 'Square Meters',
    ClosePrice: '', CloseDate: '1/2/1900', MlsStatus: 'Active', LivingArea: '1' }]));
  assert.deepEqual(result.rows[0].proposed_account_ids, [A]);
  assert.equal(result.rows[0].analysis_status, 'not_evaluated');
  assert.ok(!Object.hasOwn(result.rows[0], 'eligible'));
  assert.ok(result.limitations.includes('no_unit_currency_or_source_meaning_inference'));
});

test('empty/overlong/unsupported identity text is not truncated into a usable address or identifier', async () => {
  const { result, observed } = await run(fixture([{ ParcelNumber: 'A'.repeat(101), Address: '1 ' + 'x'.repeat(500) }]));
  assert.ok(result.rows[0].reasons.includes('unsupported_identity_field'));
  assert.equal(observed.calls.length, 0);
  assert.deepEqual(result.rows[0].proposed_account_ids, []);
});

test('normalization expansion and invalid location literals never become truncated or omitted evidence', async () => {
  for (const fields of [{ ParcelNumber: '', Address: '1 ' + '\u2167'.repeat(130) },
    { ParcelNumber: '', Address: '1 Main St, ' + 'A'.repeat(201) },
    { Address: '', County: '!!!' }, { Address: '', City: '\u2167'.repeat(60) }]) {
    const { result } = await run(fixture([fields]));
    assert.equal(result.rows[0].proposal_status, 'review_required');
    assert.deepEqual(result.rows[0].proposed_account_ids, []);
  }
});

test('snapshot binding survives caller mutation during the single observed-candidate await', async () => {
  const input = clone(fixture()), original = clone(input); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const task = proposeAssignmentSalesMatchPage(input, { readCandidates: async ({ requests }) => {
    entered(); await new Promise(resolve => { release = resolve; });
    return { observed_at: at, results: requests.map(request => ({ request_id: request.request_id, status: 'complete', candidates: [candidate()] })) };
  } });
  await ready;
  input.batch.batch_id = '90000000-0000-4000-8000-000000000009';
  input.rows[0].record_data.values.parcel_number_raw = B;
  release(); const result = await task;
  assert.deepEqual(result.binding, original.batch);
  assert.deepEqual(result.rows[0].proposed_account_ids, [A]);
});

for (const mutate of [input => { input.batch.source_sha256 = 'bad'; }, input => { input.extra = true; },
  input => { input.rows[0].source_row_number = 3; }, input => { input.rows = new Array(2); },
  input => { input.rows.push(clone(input.rows[0])); }, input => { input.rows[0].record_data.preparation_disposition = 'accepted'; }]) {
  test('malformed page binding fails before candidate acquisition', async () => {
    const input = clone(fixture()); mutate(input); const observed = reader();
    await assert.rejects(proposeAssignmentSalesMatchPage(input, observed));
    assert.equal(observed.calls.length, 0);
  });
}

test('page size and per-lookup candidate limits reject excess rather than clipping', async () => {
  const input = fixture(Array.from({ length: 101 }, () => ({}))), observed = reader();
  await assert.rejects(proposeAssignmentSalesMatchPage(input, observed), /page_limit/);
  assert.equal(observed.calls.length, 0);
  await assert.rejects(run(fixture(), () => ({ status: 'complete', candidates: Array.from({ length: 6 }, (_, index) =>
    candidate(String(index + 1).padStart(17, '0'))) })), /evidence_limit/);
  assert.equal(ASSIGNMENT_SALES_MATCH_PROPOSAL_LIMITS.page_rows, 100);
});

test('getters and proxies are rejected without executing caller code', async () => {
  let invoked = false;
  const input = fixture(); Object.defineProperty(input.batch, 'source_sha256', { enumerable: true, get() { invoked = true; throw Error('unsafe'); } });
  await assert.rejects(run(input)); assert.equal(invoked, false);
  const other = clone(fixture()); other.rows[0].record_data.values = new Proxy({}, { ownKeys() { invoked = true; return []; } });
  await assert.rejects(run(other)); assert.equal(invoked, false);
  const unsafeCandidate = candidate();
  Object.defineProperty(unsafeCandidate, 'address', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
  await assert.rejects(run(fixture(), () => ({ status: 'complete', candidates: [unsafeCandidate] })));
  assert.equal(invoked, false);
});

test('a real prepared page over the bounded receipt byte limit fails before any lookup', async () => {
  const headers = ['ParcelNumber', 'CloseDate', 'ClosePrice', ...Array.from({ length: 100 }, (_, index) => `Unused${index}`)];
  const row = [A, '8/25/2020', '282500', ...Array.from({ length: 100 }, () => 'x'.repeat(15000))];
  const bytes = Buffer.from([headers, row, row, row].map(cells => cells.join(',')).join('\n'));
  const observed = reader();
  await assert.rejects(proposeAssignmentSalesMatchPage(fixtureBytes(bytes), observed), /page_limit/);
  assert.equal(observed.calls.length, 0);
});

test('one candidate account cannot change its current canonical evidence within a coherent page response', async () => {
  await assert.rejects(run(fixture(), request => ({ status: 'complete', candidates: [candidate(A,
    { address: request.kind === 'address' ? '99 Other Dr' : '513 Synthetic Dr' })] })), /candidate_evidence_conflict/);
});

test('missing/duplicated/foreign request responses are rejected as an incoherent page', async () => {
  for (const mutate of [results => results.slice(1), results => [...results, results[0]],
    results => results.map((result, index) => index ? result : { ...result, request_id: 'other-page' }),
    results => results.map(result => ({ ...result, accepted: true }))]) {
    await assert.rejects(proposeAssignmentSalesMatchPage(fixture(), { readCandidates: async ({ requests }) => ({ observed_at: at,
      results: mutate(requests.map(request => ({ request_id: request.request_id, status: 'complete', candidates: [candidate()] }))) }) }));
  }
});

test('candidate shape, duplicate identity, observation time and excessive fields fail closed', async () => {
  for (const outcome of [{ status: 'complete', candidates: [candidate(), candidate()] },
    { status: 'complete', candidates: [candidate(A, { private_owner: 'not requested' })] },
    { status: 'complete', candidates: [candidate(A, { address: 'a'.repeat(501) })] }]) {
    await assert.rejects(run(fixture(), () => outcome));
  }
  await assert.rejects(proposeAssignmentSalesMatchPage(fixture(), { readCandidates: async ({ requests }) => ({ observed_at: '2026-02-30T00:00:00Z',
    results: requests.map(request => ({ request_id: request.request_id, status: 'complete', candidates: [] })) }) }), /observation_time/);
});

test('an unavailable or failed injected reader cannot trigger retries, writes or a partial success', async () => {
  let calls = 0;
  await assert.rejects(proposeAssignmentSalesMatchPage(fixture(), { readCandidates: async () => { calls += 1; throw Error('reader unavailable'); } }), /reader unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(proposeAssignmentSalesMatchPage(fixture()), /candidate_reader_required/);
});
