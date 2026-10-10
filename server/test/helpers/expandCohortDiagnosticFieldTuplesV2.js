import assert from 'node:assert/strict';

/** Test-only expansion, not source/selection authority or a production reader. */
export function expandCohortDiagnosticFieldTuplesV2(raw){
  assert.equal(raw.format,'cohort_diagnostic_field_tuples_v2');
  assert.deepEqual(Object.keys(raw),['format','field_tables','string_table','value']);
  const visit=v=>{
    if(!Array.isArray(v))return v;
    const [index,...values]=v;
    if(index===-2){assert.equal(values.length,1);assert.ok(Number.isInteger(values[0])&&values[0]>=0&&values[0]<raw.string_table.length);
      return raw.string_table[values[0]];}
    if(index===-1)return values.map(visit);
    assert.ok(Number.isInteger(index)&&index>=0&&index<raw.field_tables.length);
    const keys=raw.field_tables[index];assert.equal(keys.length,values.length);
    return Object.fromEntries(keys.map((k,i)=>[k,visit(values[i])]));
  };
  return visit(raw.value);
}
