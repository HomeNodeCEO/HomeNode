import { deflateRawSync } from 'node:zlib';
import { encodeCohortDiagnosticFieldTuplesV2 } from './cohortDiagnosticFieldTuplesV2.js';

/** Bounded lossless presentation ONLY, never original/selection authority.
 * The existing closed JSON/node/depth/shape/string/2.1MB admission runs first.
 * Compression touches only its owned frozen JSON, not caller accessors. Every
 * byte expands to the complete V2 diagnostic, including exact numeric strings,
 * native IDs, observations, markers and array positions. No original text is
 * introduced. The owner still checks its unchanged total16KB response cap.
 * A future decoder must enforce BOTH the fixed maximum and declared length;
 * this dormant writer neither activates a consumer nor admits decoder input.
 */
export function encodeCohortDiagnosticCompressedJsonV1(value){
  const owned=Buffer.from(JSON.stringify(encodeCohortDiagnosticFieldTuplesV2(value)),'utf8');
  if(owned.length>2100000)throw new TypeError('cohort_diagnostic_compressed_json_v1_byte_limit');
  const compressed=deflateRawSync(owned,{level:6,maxOutputLength:2100000}),
    result=Object.freeze({format:'cohort_diagnostic_compressed_json_v1',encoding:'deflate_raw_base64',
      uncompressed_utf8_bytes:owned.length,data:compressed.toString('base64')});
  if(Buffer.byteLength(JSON.stringify(result))>2100000)throw new TypeError('cohort_diagnostic_compressed_json_v1_byte_limit');
  return result;
}
