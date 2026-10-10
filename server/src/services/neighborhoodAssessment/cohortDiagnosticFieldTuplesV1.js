import { isProxy } from 'node:util/types';

const fail=()=>{throw new TypeError('cohort_diagnostic_field_tuples_v1_invalid_data');};
const MAX_BYTES=2100000,MAX_NODES=100000,MAX_DEPTH=48,MAX_TABLES=4096;
/** Lossless JSON presentation ONLY, not source/selection/statistics authority.
 * Object keys occur once per exact ordered shape. Object tuples start with a
 * nonnegative field-table index; original arrays start with -1. Scalar JSON
 * values, exact numeric strings, native IDs and every observation stay intact.
 * Actual owners may use this ONLY AFTER full original/ENTIRE cache replay.
 */
export function encodeCohortDiagnosticFieldTuplesV1(value){
  const tables=[],indices=new Map(),active=new Set();let nodes=0,sourceBytes=0;
  const charge=n=>{sourceBytes+=n;if(sourceBytes>MAX_BYTES)fail();};
  const visit=(v,depth)=>{
    if(++nodes>MAX_NODES||depth>MAX_DEPTH)fail();
    if(v===null||typeof v==='boolean'){charge(5);return v;}
    if(typeof v==='string'){if(!v.isWellFormed())fail();charge(Buffer.byteLength(JSON.stringify(v)));return v;}
    if(typeof v==='number'){if(!Number.isFinite(v))fail();charge(32);return v;}
    if(!v||typeof v!=='object'||isProxy(v)||active.has(v))fail();
    active.add(v);charge(2);
    const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);let result;
    if(Array.isArray(v)){
      if(v.length>MAX_NODES||names.length!==v.length+1||!Object.hasOwn(ds,'length'))fail();
      result=[-1];for(let i=0;i<v.length;i++){
        const d=ds[String(i)];if(!d?.enumerable||!Object.hasOwn(d,'value'))fail();
        charge(1);result.push(visit(d.value,depth+1));
      }
    }else{
      if(Object.getPrototypeOf(v)!==Object.prototype||names.length>512
        ||!names.every(k=>typeof k==='string'&&k.isWellFormed()&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))fail();
      const key=JSON.stringify(names);let index=indices.get(key);
      if(index===undefined){if(tables.length>=MAX_TABLES)fail();index=tables.length;
        tables.push(Object.freeze(names));indices.set(key,index);}
      result=[index];for(const k of names){charge(Buffer.byteLength(JSON.stringify(k))+2);result.push(visit(ds[k].value,depth+1));}
    }
    active.delete(v);return Object.freeze(result);
  };
  const encoded=visit(value,0),packed=Object.freeze({format:'cohort_diagnostic_field_tuples_v1',field_tables:Object.freeze(tables),value:encoded});
  if(Buffer.byteLength(JSON.stringify(packed))>MAX_BYTES)fail();return packed;
}
