import assert from 'node:assert/strict';
import { CACHED_SALE_WITNESS_SQL, CACHED_SALE_WITNESS_FIELDS, prepareCachedSaleWitness }
  from '../../src/services/neighborhoodAssessment/cachedSaleWitness.js';
import { CACHED_SALE_WITNESS_V2_VERSION, CACHED_SALE_WITNESS_V2_SQL, CACHED_SALE_WITNESS_V2_FIELDS,
  prepareCachedSaleWitnessV2 } from '../../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';

// Synthetic literal SELECTs on the caller's already verified native test
// connection only. No source tables, privileges, provider/user data, writes or
// database lifecycle; both expressions use their actual exported fixed SQL.
export async function runCachedSaleWitnessV2DatabaseChecks(client) {
  const read = async payload => (await client.query(`SELECT ${CACHED_SALE_WITNESS_SQL} AS legacy,
    ${CACHED_SALE_WITNESS_V2_SQL} AS witness FROM (SELECT $1::jsonb AS raw_payload) src`, [payload])).rows[0];
  const compareLegacy = raw => {
    const result = prepareCachedSaleWitnessV2(raw.witness), legacy = prepareCachedSaleWitness(raw.legacy);
    assert.equal(result.witness_version, CACHED_SALE_WITNESS_V2_VERSION);
    assert.equal(legacy.witness_version, 1);
    assert.equal(result.root_state, legacy.root_state); assert.equal(result.root_json_type, legacy.root_json_type);
    assert.deepEqual(Object.keys(result.fields), CACHED_SALE_WITNESS_V2_FIELDS);
    assert.deepEqual(Object.keys(legacy.fields), CACHED_SALE_WITNESS_FIELDS);
    for (const key of CACHED_SALE_WITNESS_FIELDS) assert.deepEqual(result.fields[key], legacy.fields[key]);
    return result;
  };
  const aliases = ['PriceCurrency', 'CurrentPriceCurrency', 'ClosePriceCurrency'];
  for (const [payload, state, type] of [[null, 'sql_null', null], ['null', 'json_null', 'null'],
    ['[]', 'non_object', 'array'], ['"text"', 'non_object', 'string'], ['42', 'non_object', 'number'],
    ['false', 'non_object', 'boolean'], ['{}', 'object', 'object']]) {
    const witness = compareLegacy(await read(payload));
    assert.equal(witness.root_state, state); assert.equal(witness.root_json_type, type);
    for (const alias of aliases) assert.equal(witness.fields[alias].state, state === 'object' ? 'absent' : 'payload_unavailable');
  }
  const conflicting = compareLegacy(await read('{"Currency":"USD","PriceCurrency":"CAD","CurrentPriceCurrency":"eur","ClosePriceCurrency":" JPY ","ClosePrice":9007199254740993.123456789012,"CurrentPrice":"100.00","LivingArea":1850.1250,"LivingAreaUnits":"unknown","CloseDate":"2026-09-12","MlsStatus":"Closed","StandardStatus":"Active"}'));
  for (const [key, text] of Object.entries({ Currency: 'USD', PriceCurrency: 'CAD', CurrentPriceCurrency: 'eur', ClosePriceCurrency: ' JPY ',
    ClosePrice: '9007199254740993.123456789012', CurrentPrice: '100.00', LivingArea: '1850.1250', LivingAreaUnits: 'unknown',
    CloseDate: '2026-09-12', MlsStatus: 'Closed', StandardStatus: 'Active' })) {
    assert.equal(conflicting.fields[key].value_text, text);
    assert.equal(conflicting.fields[key].utf8_bytes, Buffer.byteLength(text));
  }
  assert.equal(conflicting.fields.ClosePrice.json_type, 'number');
  assert.equal(conflicting.fields.CurrentPrice.json_type, 'string');
  for (const alias of aliases) {
    for (const [value, expected] of [[null, 'json_null'], ['', 'scalar'], ['  ', 'scalar'], [false, 'scalar'],
      [0, 'scalar'], [[], 'non_scalar'], [{ private: 'must not transfer' }, 'non_scalar']]) {
      const witness = compareLegacy(await read(JSON.stringify({ [alias]: value })));
      const entry = witness.fields[alias]; assert.equal(entry.state, expected);
      if (expected === 'scalar') assert.equal(entry.value_text, String(value));
      else { assert.equal(entry.value_text, null); assert.equal(entry.utf8_bytes, null); }
      for (const other of aliases.filter(key => key !== alias)) assert.equal(witness.fields[other].state, 'absent');
    }
    const precise = compareLegacy(await read(`{"${alias}":9007199254740993.0100}`)).fields[alias];
    assert.equal(precise.value_text, '9007199254740993.0100'); assert.equal(precise.json_type, 'number');
    for (const text of ['a'.repeat(512), 'é'.repeat(256), '💵'.repeat(128)]) {
      const entry = compareLegacy(await read(JSON.stringify({ [alias]: text }))).fields[alias];
      assert.equal(entry.state, 'scalar'); assert.equal(entry.value_text, text); assert.equal(entry.utf8_bytes, 512);
      const oversize = compareLegacy(await read(JSON.stringify({ [alias]: `${text}a` }))).fields[alias];
      assert.deepEqual(oversize, { state: 'oversize', json_type: 'string', value_text: null, utf8_bytes: 513 });
    }
    const literal = '<b>é💵</b>\n\t e\u0301';
    assert.equal(compareLegacy(await read(JSON.stringify({ [alias]: literal }))).fields[alias].value_text, literal);
  }
  const privatePayload = { PriceCurrency: ' CAD ', ClosePriceCurrency: '', PrivateRemarks: 'PRIVATE'.repeat(20_000),
    OwnerEmail: 'secret@example.invalid', BuyerPhone: 'private', pricecurrency: 'lowercase unknown' };
  const compact = compareLegacy(await read(JSON.stringify(privatePayload)));
  assert.equal(compact.fields.PriceCurrency.value_text, ' CAD '); assert.equal(compact.fields.ClosePriceCurrency.value_text, '');
  assert.equal(compact.fields.Currency.state, 'absent'); assert.equal(compact.fields.ClosePrice.state, 'absent');
  assert.doesNotMatch(JSON.stringify(compact), /PRIVATE|secret|BuyerPhone|OwnerEmail|PrivateRemarks|lowercase unknown/);
  const additionalFieldsOverflow = await read(JSON.stringify(Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(key => [key, '\u0001'.repeat(120)]))));
  assert.notEqual(additionalFieldsOverflow.legacy, null, 'the unchanged V1 whitelist still fits this synthetic escaped witness');
  prepareCachedSaleWitness(additionalFieldsOverflow.legacy);
  assert.equal(additionalFieldsOverflow.witness, null, 'extra aliases cannot bypass or enlarge the unchanged whole-witness cap');
  assert.throws(() => prepareCachedSaleWitnessV2(additionalFieldsOverflow.witness), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'witness_byte_limit' });
  const overflow = await read(JSON.stringify(Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(key => [key, '\u0001'.repeat(512)]))));
  assert.equal(overflow.witness, null); assert.equal(overflow.legacy, null);
  return { checks: ['actual V2 SQL preserves independent currency aliases and every unavailable/scalar state with V1 field parity',
    'stored JSONB numeric precision, Unicode and exact 512-byte scalar boundaries remain literal',
    'fixed whitelist excludes private/unknown payload fields; additional aliases still refuse whole-witness overflow'] };
}
