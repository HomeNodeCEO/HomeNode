import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { expandCohortDiagnosticFieldTuplesV2 } from './expandCohortDiagnosticFieldTuplesV2.js';

/** Test-only exact bounded expansion, never source/selection authority. */
export function expandCohortDiagnosticCompressedJsonV1(raw){
  assert.equal(raw.format,'cohort_diagnostic_compressed_json_v1');
  assert.deepEqual(Object.keys(raw),['format','encoding','uncompressed_utf8_bytes','data']);
  assert.equal(raw.encoding,'deflate_raw_base64');
  assert.ok(Number.isInteger(raw.uncompressed_utf8_bytes)&&raw.uncompressed_utf8_bytes>0&&raw.uncompressed_utf8_bytes<=2100000);
  assert.equal(typeof raw.data,'string');assert.ok(raw.data.length<=2800000&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data));
  const bytes=Buffer.from(raw.data,'base64');assert.equal(bytes.toString('base64'),raw.data);
  const expanded=inflateRawSync(bytes,{maxOutputLength:raw.uncompressed_utf8_bytes});
  assert.equal(expanded.length,raw.uncompressed_utf8_bytes);
  const text=new TextDecoder('utf-8',{fatal:true}).decode(expanded);
  return expandCohortDiagnosticFieldTuplesV2(JSON.parse(text));
}
