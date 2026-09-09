import assert from 'node:assert/strict';
import { CACHED_SALE_WITNESS_SQL, CACHED_SALE_WITNESS_FIELDS, prepareCachedSaleWitness }
  from '../../src/services/neighborhoodAssessment/cachedSaleWitness.js';

// Read-only literal fixtures on the caller's verified test connection. No source
// table, provider, stored user content, grants or database lifecycle is touched.
export async function runCachedSaleWitnessDatabaseChecks(client) {
  const read = async payload => (await client.query(
    `SELECT ${CACHED_SALE_WITNESS_SQL} AS witness FROM (SELECT $1::jsonb AS raw_payload) src`, [payload])).rows[0].witness;
  for (const [payload, state, type] of [[null, 'sql_null', null], ['null', 'json_null', 'null'],
    ['[]', 'non_object', 'array'], ['"text"', 'non_object', 'string'], ['42', 'non_object', 'number'],
    ['false', 'non_object', 'boolean'], ['{}', 'object', 'object']]) {
    const value = prepareCachedSaleWitness(await read(payload));
    assert.equal(value.root_state, state); assert.equal(value.root_json_type, type);
    assert.equal(value.fields.ClosePrice.state, state === 'object' ? 'absent' : 'payload_unavailable');
  }
  const value = prepareCachedSaleWitness(await read('{"ClosePrice":9007199254740993.123456789,"DaysOnMarket":0,"PropertyAttachedYN":false,"Currency":"","LivingArea":null,"LotSizeArea":[],"StructureType":{}}'));
  assert.equal(value.fields.ClosePrice.value_text, '9007199254740993.123456789');
  assert.equal(value.fields.ClosePrice.json_type, 'number');
  assert.equal(value.fields.DaysOnMarket.value_text, '0');
  assert.equal(value.fields.PropertyAttachedYN.value_text, 'false');
  assert.equal(value.fields.Currency.value_text, ''); assert.equal(value.fields.Currency.utf8_bytes, 0);
  assert.equal(value.fields.LivingArea.state, 'json_null');
  assert.equal(value.fields.LotSizeArea.state, 'non_scalar'); assert.equal(value.fields.StructureType.state, 'non_scalar');
  for (const text of ['a'.repeat(512), 'é'.repeat(256)]) {
    const item = prepareCachedSaleWitness(await read(JSON.stringify({ CurrentPrice: text }))).fields.CurrentPrice;
    assert.equal(item.state, 'scalar'); assert.equal(item.utf8_bytes, 512); assert.equal(item.value_text, text);
  }
  const oversized = prepareCachedSaleWitness(await read(JSON.stringify({ CurrentPrice: 'é'.repeat(257) })));
  assert.deepEqual(oversized.fields.CurrentPrice, { state: 'oversize', json_type: 'string', value_text: null, utf8_bytes: 514 });
  const privatePayload = { ClosePrice: '282500.00', PrivateRemarks: 'PRIVATE'.repeat(20_000), OwnerEmail: 'secret@example.invalid', BuyerPhone: 'private' };
  const compact = prepareCachedSaleWitness(await read(JSON.stringify(privatePayload)));
  assert.equal(compact.fields.ClosePrice.value_text, '282500.00');
  assert.doesNotMatch(JSON.stringify(compact), /PRIVATE|secret|BuyerPhone|OwnerEmail|PrivateRemarks/);
  const overflow = await read(JSON.stringify(Object.fromEntries(CACHED_SALE_WITNESS_FIELDS.map(key => [key, '\u0001'.repeat(512)]))));
  assert.equal(overflow, null);
  assert.throws(() => prepareCachedSaleWitness(overflow), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'witness_byte_limit' });
  return { checks: ['actual PostgreSQL distinguishes missing/null/non-object roots and scalar/compound fields',
    'stored JSONB numeric text keeps decimal precision beyond JavaScript Number',
    'SQL bounds UTF-8 scalars and complete escaped witnesses before transfer without retaining private keys'] };
}
