import assert from 'node:assert/strict';

/** Test-only JSON presentation expansion. No source or selection authority. */
export function expandCohortDiagnosticFieldTuplesV1(raw){
  assert.equal(raw.format,'cohort_diagnostic_field_tuples_v1');
  assert.deepEqual(Object.keys(raw),['format','field_tables','value']);
  const visit=v=>{
    if(!Array.isArray(v))return v;
    const [index,...values]=v;
    if(index===-1)return values.map(visit);
    assert.ok(Number.isInteger(index)&&index>=0&&index<raw.field_tables.length);
    const keys=raw.field_tables[index];assert.equal(keys.length,values.length);
    return Object.fromEntries(keys.map((k,i)=>[k,visit(values[i])]));
  };
  return visit(raw.value);
}
