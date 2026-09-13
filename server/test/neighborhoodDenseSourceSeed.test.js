import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { seedNeighborhoodDenseSource } from './helpers/neighborhoodDenseSourceSeed.js';

const options = {org:'11111111-1111-4111-8111-111111111111',actor:'22222222-2222-4222-8222-222222222222',caseId:'33333333-3333-4333-8333-333333333333',snapshotId:'44444444-4444-4444-8444-444444444444',reportId:'55555555-5555-4555-8555-555555555555',run:'66666666-6666-4666-8666-666666666666',operation:'77777777-7777-4777-8777-777777777777',account:'DENSE-000000',parcelCount:38347,accountCount:38106,effectiveDate:'2026-09-13',geometry:'POLYGON((-97 32,-96 32,-96 33,-97 33,-97 32))'};
// Full original SQL+parameter+scope bytes captured directly from the unedited
// adffc056 helper before extraction. No database, fake source grant or rows run.
for (const [combined, queries, bytes, sha256] of [
  [false, 14, 4876, '87d19c4ad3085a2088bb2aed3693b6c8d20b63d4bd6fd03b9bc9456403f5a614'],
  [true, 15, 8820, '6c939e4654ef78c8f47d8f38093de3a9ec3e2e6ad1adfcf179fe01631e958b4f'],
]) test('original dense seed exact query bytes and order: '+(combined ? 'witness2' : 'default CAD4'), async () => {
  const calls = [], input = structuredClone(options), before = JSON.stringify(input);
  if (combined) input.interpretation = {};
  const result = await seedNeighborhoodDenseSource({ async query(text, values) {
    calls.push({ text, values }); return { rows: [{ id: '41' }] };
  } }, input);
  const encoded = JSON.stringify({ calls, result });
  assert.equal(calls.length, queries); assert.equal(Buffer.byteLength(encoded), bytes);
  assert.equal(createHash('sha256').update(encoded).digest('hex'), sha256);
  delete input.interpretation; assert.equal(JSON.stringify(input), before);
  assert.ok(calls.every(call => !/BEGIN|COMMIT|ROLLBACK|DROP|TRUNCATE/.test(call.text)));
});

test('dense seed rejects partial counts before any source write and preserves database errors', async () => {
  for (const patch of [{ accountCount: 1000 }, { parcelCount: 38346 }, { account: 'outside' }]) {
    await assert.rejects(seedNeighborhoodDenseSource({ query() { assert.fail('must not query'); } }, { ...options, ...patch }));
  }
  const error = Object.assign(new Error('sentinel'), { code: '57014' }); let calls = 0;
  await assert.rejects(seedNeighborhoodDenseSource({ async query() { calls++; throw error; } }, options), value => value === error);
  assert.equal(calls, 1);
});

