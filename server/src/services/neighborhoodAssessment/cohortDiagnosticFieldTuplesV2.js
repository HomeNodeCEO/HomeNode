import { encodeCohortDiagnosticFieldTuplesV1 } from './cohortDiagnosticFieldTuplesV1.js';

/** Lossless JSON presentation ONLY, never source or semantic authority.
 * V1's closed-input/byte/node/depth/shape checks run before either traversal
 * below touches its owned frozen result. V2 additionally interns repeated
 * scalar strings, never hashes or drops them. [-2,index] is a string reference;
 * original arrays still start with -1 and objects with a nonnegative shape.
 * V1 and every separate source response retain their original formats.
 */
export function encodeCohortDiagnosticFieldTuplesV2(value){
  const base=encodeCohortDiagnosticFieldTuplesV1(value),counts=new Map(),indices=new Map(),strings=[];
  const count=v=>{if(typeof v==='string'&&v.length>=16)counts.set(v,(counts.get(v)??0)+1);
    else if(Array.isArray(v))v.forEach(count);};
  count(base.value);
  const visit=v=>{
    if(typeof v==='string'&&(counts.get(v)??0)>1){
      let index=indices.get(v);
      if(index===undefined&&strings.length<4096){index=strings.length;strings.push(v);indices.set(v,index);}
      if(index!==undefined)return Object.freeze([-2,index]);
    }
    return Array.isArray(v)?Object.freeze(v.map(visit)):v;
  };
  const encoded=visit(base.value),packed=Object.freeze({format:'cohort_diagnostic_field_tuples_v2',
    field_tables:base.field_tables,string_table:Object.freeze(strings),value:encoded});
  if(Buffer.byteLength(JSON.stringify(packed))>2100000)throw new TypeError('cohort_diagnostic_field_tuples_v2_byte_limit');
  return packed;
}
