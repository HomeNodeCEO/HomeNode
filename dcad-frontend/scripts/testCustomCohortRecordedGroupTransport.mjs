import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortRecordedGroupTransport } from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { createCustomCohortJsonTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';

const A = `recorded-cad:${'a'.repeat(64)}`, B = `recorded-cad:${'b'.repeat(64)}`;
const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const operation = '70000000-0000-4000-8000-000000000002';
const ref = (revision = 1) => ({ selection_version: 1, selection_revision: revision, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '750000' } });
const read = () => ({ accountId: 'R-001/#1', assignmentFileId: '9007199254740993', contextRef: structuredClone(context) });
const write = () => ({ ...read(), operationId: operation, expectedSelectionRef: null, includedRecordedGroupIds: [B, A] });
const stored = () => ({ status: 'stored', authority: 'not_established', context_ref: context, selection_ref: ref(),
  included_recorded_group_ids: [A, B], operation_id: operation });
const json = (value, init = {}) => new Response(JSON.stringify(value), { ...init,
  headers: { 'content-type': 'application/json', ...init.headers } });
function harness(respond = () => json(stored())) {
  const calls = [], paths = [], abort = new AbortController();
  const transport = createCustomCohortRecordedGroupTransport({
    request: async (url, init) => { calls.push({ url, init }); return respond(url, init); },
    urlFor: p => { paths.push(p); return `https://example.invalid${p}`; },
  });
  return { calls, paths, abort, select: value => transport.select(value ?? write(), { signal: abort.signal }),
    read: value => transport.read(value ?? read(), { signal: abort.signal }) };
}

test('group-only command uses exact existing authenticated transport and returns an immutable intent receipt', async () => {
  const h = harness(), receipt = await h.select();
  assert.deepEqual(receipt, stored()); assert.equal(h.calls.length, 1);
  assert.equal(h.paths[0], '/api/accounts/R-001%2F%231/neighborhood-cohort/select-groups');
  assert.equal(h.calls[0].init.cache, 'no-store'); assert.equal(h.calls[0].init.signal, h.abort.signal);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { assignment_file_id: '9007199254740993', context_ref: context,
    operation_id: operation, expected_selection_ref: null, included_recorded_group_ids: [A, B] });
  assert.equal(Object.isFrozen(receipt), true); assert.equal(Object.isFrozen(receipt.selection_ref.manifest_ref), true);
  assert.equal(Object.isFrozen(receipt.included_recorded_group_ids), true);
});

test('absent and deliberate empty are distinct; reopens never automatically expand to all groups', async () => {
  const absent = { status: 'absent', authority: 'not_established', context_ref: context,
    selection_ref: null, included_recorded_group_ids: null };
  const h = harness(() => json(absent)); assert.deepEqual(await h.read(), absent);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { assignment_file_id: '9007199254740993', context_ref: context });
  const selected = { status: 'selected', authority: 'not_established', context_ref: context,
    selection_ref: ref(), included_recorded_group_ids: [] };
  const empty = harness(() => json(selected)); assert.deepEqual(await empty.read(), selected);
  const writeEmpty = harness(() => json({ ...stored(), included_recorded_group_ids: [] }));
  assert.deepEqual((await writeEmpty.select({ ...write(), includedRecordedGroupIds: [] })).included_recorded_group_ids, []);
});

test('command detaches all choice/predecessor/context fields before authenticated I/O', async () => {
  let complete;
  const h = harness(() => new Promise(resolve => { complete = resolve; }));
  const value = { ...write(), expectedSelectionRef: ref() }, original = stored(); original.selection_ref = ref(2);
  const pending = h.select(value);
  value.includedRecordedGroupIds.pop(); value.expectedSelectionRef.manifest_ref.content_sha256 = 'd'.repeat(64);
  value.contextRef.context_sha256 = 'e'.repeat(64);
  while (!complete) await Promise.resolve(); complete(json(original));
  assert.deepEqual(await pending, original);
  assert.deepEqual(JSON.parse(h.calls[0].init.body).expected_selection_ref, ref());
  assert.deepEqual(JSON.parse(h.calls[0].init.body).included_recorded_group_ids, [A, B]);
});

test('malformed, ambiguous, member/source/reviewer-bearing requests fail before URL/authentication I/O', async () => {
  const invalid = [
    { ...write(), actor_user_id: operation }, { ...write(), auth: {} }, { ...write(), account_ids: [] },
    { ...write(), includedRecordedGroupIds: [A, A] }, { ...write(), includedRecordedGroupIds: ['R-001'] },
    { ...write(), includedRecordedGroupIds: null }, { ...write(), operationId: 'wrong' },
    { ...write(), expectedSelectionRef: ref(2147483647) }, { ...write(), expectedSelectionRef: { ...ref(), authority: 'granted' } },
    { ...write(), assignmentFileId: 7 }, { ...write(), assignmentFileId: '9223372036854775808' },
    { ...write(), accountId: 'R\u0000-001' }, { ...write(), accountId: 'R\u007f-001' },
    { ...write(), contextRef: { ...context, extra: true } },
  ];
  const h = harness(); for (const value of invalid) await assert.rejects(h.select(value), /invalid_custom_cohort/);
  const getter = Object.defineProperty(write(), 'operationId', { enumerable: true, get() { assert.fail('getter executed'); } });
  await assert.rejects(h.select(getter), /invalid_custom_cohort/);
  assert.equal(h.calls.length, 0); assert.equal(h.paths.length, 0);
});

test('cross-context/revision/operation/groups, unknown payload and report authority are never accepted', async () => {
  for (const value of [
    { ...stored(), source_rows: [] }, { ...stored(), authority: 'established' }, { ...stored(), status: 'applied' },
    { ...stored(), context_ref: { ...context, context_sha256: 'd'.repeat(64) } },
    { ...stored(), selection_ref: ref(2) }, { ...stored(), operation_id: context.context_id },
    { ...stored(), included_recorded_group_ids: [B, A] }, { ...stored(), included_recorded_group_ids: [A] },
    { ...stored(), selection_ref: { ...ref(), manifest_ref: { ...ref().manifest_ref, canonical_utf8_bytes: '750001' } } },
    { ...stored(), selection_ref: { ...ref(), manifest_ref: { ...ref().manifest_ref, canonical_utf8_bytes: '0750' } } },
  ]) {
    const h = harness(() => json(value)); await assert.rejects(h.select(), /invalid_custom_cohort/);
    assert.equal(h.calls.length, 1, 'invalid results are not silently retried');
  }
});

test('maximum recorded ID grammar remains usable without sending any population members', async () => {
  const ids = Array.from({ length: 2048 }, (_, i) => `recorded-cad:${i.toString(16).padStart(64, '0')}`);
  const h = harness(() => json({ ...stored(), included_recorded_group_ids: [...ids, 'discovery:unassigned'].sort() }));
  const result = await h.select({ ...write(), includedRecordedGroupIds: [...ids, 'discovery:unassigned'] });
  assert.equal(result.included_recorded_group_ids.length, 2049);
  assert.ok(new TextEncoder().encode(h.calls[0].init.body).length < 262_144);
  await assert.rejects(h.select({ ...write(), includedRecordedGroupIds: [...ids, `recorded-cad:${'f'.repeat(64)}`] }), /invalid_custom_cohort/);
  assert.equal(h.calls.length, 1);
});

test('ID-only selection additions preserve the existing market-analysis operation and its separate byte ceiling', async () => {
  const signal = new AbortController().signal, calls = [], payload = { synthetic: 'x'.repeat(270_000) };
  let declared = 4_000_000;
  const transport = createCustomCohortJsonTransport({ urlFor: path => path, request: async (url, init) => {
    calls.push({ url, init }); return json(payload, { headers: { 'content-length': String(declared) } });
  } });
  assert.deepEqual(await transport('R-001', 'market-analysis', payload, { signal }), payload);
  assert.equal(calls[0].url, '/api/accounts/R-001/neighborhood-cohort/market-analysis');
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  assert.equal(calls[0].init.signal, signal); assert.equal(calls[0].init.cache, 'no-store');
  declared++;
  await assert.rejects(transport('R-001', 'market-analysis', payload, { signal }), /too large/);
  assert.equal(calls.length, 2, 'an oversized result is not retried');
  await assert.rejects(transport('R-001', 'select-groups', payload, { signal }), /too large/);
  assert.equal(calls.length, 2, 'the smaller selection request ceiling still applies before I/O');
});

test('both closed operations use the smaller decoded request/response ceiling including Content-Length', async () => {
  for (const operation of ['select-groups', 'group-selection']) {
    let calls = 0;
    const t = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => {
      calls++; return json('é'.repeat(140_000));
    } });
    await assert.rejects(t('R-001', operation, {}, { signal: new AbortController().signal }), /too large/);
    assert.equal(calls, 1);
    await assert.rejects(t('R-001', operation, { large: 'é'.repeat(140_000) }, { signal: new AbortController().signal }), /too large/);
    assert.equal(calls, 1);
    let size = 262_144;
    const declared = createCustomCohortJsonTransport({ urlFor: p => p,
      request: async () => json({}, { headers: { 'content-length': String(size) } }) });
    assert.deepEqual(await declared('R-001', operation, {}, { signal: new AbortController().signal }), {});
    size++; await assert.rejects(declared('R-001', operation, {}, { signal: new AbortController().signal }), /too large/);
  }
});

test('cancellation terminates hung authentication and cancels a late body; it never retries a write', async () => {
  let complete, cancelled = 0;
  const h = harness(() => new Promise(resolve => { complete = resolve; }));
  const pending = h.select(); while (!complete) await Promise.resolve(); h.abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  complete(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(cancelled, 1); assert.equal(h.calls.length, 1);
});

test('exact HTTP conflict and lost-acknowledgment errors are returned to caller without replacing a selection', async () => {
  for (const error of ['neighborhood_selection_changed', 'neighborhood_operation_outcome_unknown']) {
    const h = harness(() => json({ error, retry_same_operation: true }, { status: 409 }));
    await assert.rejects(h.select(), e => e.status === 409 && e.errorCode === error);
    assert.equal(h.calls.length, 1);
  }
});
