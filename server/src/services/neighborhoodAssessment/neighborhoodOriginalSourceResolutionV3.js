import { isProxy } from 'node:util/types';
import { assessmentDate, canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodTransactionRetainedPeriodV1 } from './neighborhoodTransactionTemporalV1.js';

const KINDS=['source_records','sales','sale_links'],FIELDS=['reported_close_price','reported_current_price',
  'reported_living_area','reported_site_area','reported_year_built','reported_days_on_market'];
const fail=r=>{throw new TypeError(`neighborhood_original_source_resolution_v3_${r}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function snapshot(value,check){
  let nodes=0,bytes=0;
  const visit=(v,depth)=>{
    check();if(++nodes>100000||depth>16)fail('input_limit');
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(bytes>2100000||!v.isWellFormed())fail('input_limit');return v;}
    if(typeof v==='number'){if(!Number.isSafeInteger(v)||Object.is(v,-0))fail('invalid_input');return v;}
    if(!v||isProxy(v))fail('invalid_input');
    const array=Array.isArray(v),prototype=Object.getPrototypeOf(v);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype)fail('invalid_input');
    const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d);
    if(array){
      if(v.length>250||keys.length!==v.length+1)fail('input_limit');
      const out=[];for(let i=0;i<v.length;i++){
        const item=d[String(i)];if(!item?.enumerable||!Object.hasOwn(item,'value'))fail('invalid_input');out.push(visit(item.value,depth+1));
      }return out;
    }
    if(keys.some(k=>typeof k!=='string'||!d[k].enumerable||!Object.hasOwn(d[k],'value')))fail('invalid_input');
    return Object.fromEntries(keys.map(k=>[k,visit(d[k].value,depth+1)]));
  };
  const out=visit(value,0);if(Buffer.byteLength(json(out))>2100000)fail('input_limit');return out;
}
function id(v){if(typeof v!=='string'||!/^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)fail('invalid_identity');return v;}
function account(v){if(v!==null&&(typeof v!=='string'||!v||Buffer.byteLength(v)>64||v.trim()!==v||/[\u0000-\u001f\u007f]/.test(v)))fail('invalid_identity');return v;}
function date(value){
  const c=data(value,['state','exact_value','reason']);
  if(!['observed','missing','invalid','unsupported'].includes(c.state))fail('invalid_date');
  if(c.state==='observed'){if(c.reason!==null||assessmentDate(c.exact_value)!==c.exact_value)fail('invalid_date');}
  else if(c.exact_value!==null||typeof c.reason!=='string'||!c.reason)fail('invalid_date');
  return c;
}
function cell(value,effective){
  const c=data(value,['state','exact_value','unit','reason']);
  if(!['observed','missing','invalid','conflicting','unsupported'].includes(c.state)
    ||c.exact_value!==null&&(typeof c.exact_value!=='string'||c.exact_value.length>31
      ||!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(c.exact_value)||c.exact_value.replace('.','').length>30||(c.exact_value.split('.')[1]?.length??0)>12)
    ||(c.state==='observed'?c.exact_value===null||typeof c.unit!=='string'||!c.unit||c.reason!==null
      :c.unit!==null||typeof c.reason!=='string'||!c.reason)
    ||['missing','invalid'].includes(c.state)&&c.exact_value!==null
    ||c.unit==='year'&&(!/^[1-9][0-9]{3}$/.test(c.exact_value)||c.exact_value>effective.slice(0,4)))fail('invalid_cell');
  return c;
}
function disposition(c,period){return c.state==='observed'
  ?{state:c.exact_value>=period.start_date&&c.exact_value<=period.end_date?'in_period':'outside_period',exact_date:c.exact_value}
  :{state:c.state,exact_date:null};}
function quarter(c){return c.state==='observed'?`${c.exact_value.slice(0,4)}-Q${Math.floor((Number(c.exact_value.slice(5,7))-1)/3)+1}`:null;}
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

/** DATA interpretation only. The actual completed-index source owner supplies
 * THIS whole original-reconciled package and independent native membership,
 * then repeats ALL ending fences before delivery. No callback/receipt/hash or
 * returned identity/count is a source grant, economic equivalence or eligibility.
 * In particular selected source/link accounts never override a sale's outside
 * account, infer price allocation or inherit another row's date/currency/area. */
function resolve(args,nextSource){
  if(args.length!==3||typeof args[2]!=='function')fail('invalid_input');const check=args[2];
  const input=snapshot({packet:args[0],membership:args[1]},check),
    p=data(input.packet,['package_version','kind','native_key','counts','rows','retained_effective_date','retained_observation_period',
      'associations','authority','transaction_eligibility','source_acquisition','report_update']),
    m=data(input.membership,['subject_account_id','subject_selected_union_member','associations','coverage','economic_property_membership','global_selected_native_deduplication']);
  if(p.package_version!==1||!['source_record','legacy_sale'].includes(p.kind)||p.authority!=='not_established'
    ||p.transaction_eligibility!=='not_established'||p.source_acquisition!=='not_established'||p.report_update!=='none'
    ||!Array.isArray(p.rows)||p.rows.length<1||!Array.isArray(m.associations)||m.associations.length>250)fail('invalid_package');
  if(typeof m.subject_account_id!=='string'||!m.subject_account_id||m.subject_account_id.length>64
    ||!m.subject_account_id.isWellFormed()||m.subject_account_id.trim()!==m.subject_account_id
    ||/[\u0000-\u001f\u007f]/.test(m.subject_account_id)||typeof m.subject_selected_union_member!=='boolean'
    ||m.coverage!==(nextSource?'whole_native_packages_for_next_registered_source_first_seen_account_only'
      :'whole_native_packages_for_first_registered_source_first_seen_account_only')
    ||m.economic_property_membership!=='not_established'||m.global_selected_native_deduplication!==false)fail('invalid_membership');
  id(p.native_key);const effective=assessmentDate(p.retained_effective_date),period=prepareNeighborhoodTransactionRetainedPeriodV1(p.retained_observation_period,effective),
    counts=data(p.counts,KINDS),native=new Map(),observed=Object.fromEntries(KINDS.map(k=>[k,0]));
  if(KINDS.some(k=>typeof counts[k]!=='string'||!/^(0|[1-9][0-9]{0,2})$/.test(counts[k])||BigInt(counts[k])>250n))fail('invalid_counts');
  for(const value of m.associations){
    const a=data(value,['kind','row_key','account_id','source_record_id','stock_member','selected_union_member']);
    if(!KINDS.includes(a.kind))fail('invalid_membership');id(a.row_key);account(a.account_id);if(a.source_record_id!==null)id(a.source_record_id);
    if(a.account_id===null?a.stock_member!==null||a.selected_union_member!==null
      :typeof a.stock_member!=='boolean'||typeof a.selected_union_member!=='boolean'||a.selected_union_member&&!a.stock_member)fail('invalid_membership');
    if(a.account_id===m.subject_account_id&&a.selected_union_member!==m.subject_selected_union_member)fail('invalid_membership');
    if(p.kind==='source_record'?a.source_record_id!==p.native_key:a.kind!=='sales'||a.source_record_id!==null||a.row_key!==p.native_key)continue;
    const key=`${a.kind}:${a.row_key}`;if(native.has(key))fail('invalid_membership');native.set(key,a);
  }
  const memberships=new Map(),selected=new Set(),stock=new Set(),outside=new Set(),sales=[],dates=[];
  let missing=0,resolvedLinks=0,unresolvedLinks=0;
  let source=null;
  for(const value of p.rows){
    check();const e=data(value,['stock_member','projection']),r=e.projection,a=native.get(`${r.kind}:${r.row_key}`);
    if(!a||!KINDS.includes(r.kind)||r.account_id!==a.account_id||r.source_record_id!==a.source_record_id||e.stock_member!==a.stock_member
      ||r.projection_version!==1||r.authority!=='not_established'||r.report_update!=='none'
      ||r.retained_effective_date!==effective||!same(r.retained_observation_period,period))fail('package_membership_mismatch');
    id(r.row_key);native.delete(`${r.kind}:${r.row_key}`);observed[r.kind]++;
    if(r.account_id===null)missing++;
    else{
      const membership=a.selected_union_member?'selected':a.stock_member?'stock_unselected':'outside_stock';
      if(memberships.has(r.account_id)&&memberships.get(r.account_id)!==membership)fail('invalid_membership');
      memberships.set(r.account_id,membership);(membership==='selected'?selected:membership==='stock_unselected'?stock:outside).add(r.account_id);
    }
    if(r.kind==='sale_links'){
      const flag=r.markers.is_resolved;
      if(r.account_id!==null&&flag.state==='scalar'&&flag.json_type==='boolean'&&flag.value_text==='true')resolvedLinks++;
      else unresolvedLinks++;
      continue;
    }
    const field=r.kind==='source_records'?'close_date':'closing_date',d=date(r.normalized.dates[field]),actual=disposition(d,period),reported=r.normalized.period_disposition;
    if(r.normalized.period_date_field!==field||reported.state!==actual.state||reported.exact_date!==actual.exact_date)fail('invalid_date');
    dates.push(d);
    if(r.kind==='source_records'){if(source!==null||r.row_key!==p.native_key)fail('invalid_package');source=r;}
    else sales.push({native_sale_key:r.row_key,account_id:r.account_id,membership:r.account_id===null?'unresolved':memberships.get(r.account_id),
      closing_date:d,recorded_price:cell(r.normalized.observations.recorded_sale_price,effective)});
  }
  if(native.size!==0||KINDS.some(k=>observed[k]!==Number(counts[k]))||selected.size===0
    ||(p.kind==='source_record'?source===null:source!==null||sales.length!==1||observed.sale_links!==0))fail('incomplete_package');
  const associations=data(p.associations,['native_sale_state','reported_resolved_link_count','unresolved_link_count','stock_account_count',
    'outside_account_count','missing_account_row_count','native_row_coverage','provider_parcel_membership','economic_transaction_equivalence','price_allocation']);
  if(associations.native_sale_state!==(sales.length===0?'absent':sales.length===1?'unique_native_id':'multiple_native_ids_unresolved')
    ||associations.reported_resolved_link_count!==resolvedLinks||associations.unresolved_link_count!==unresolvedLinks
    ||associations.stock_account_count!==selected.size+stock.size||associations.outside_account_count!==outside.size
    ||associations.missing_account_row_count!==missing||associations.native_row_coverage!=='complete_for_this_package_only'
    ||['provider_parcel_membership','economic_transaction_equivalence','price_allocation'].some(k=>associations[k]!=='not_established'))fail('package_association_mismatch');
  const distinct=new Set(dates.filter(d=>d.state==='observed').map(d=>d.exact_value)),allDates=dates.every(d=>d.state==='observed'),
    closing=distinct.size>1?{state:'conflicting',exact_value:null,reason:'native_closing_dates_disagree'}
      :sales.length!==1?{state:'unresolved',exact_value:null,reason:sales.length===0?'no_native_sale':'multiple_native_sale_ids'}
        :!allDates?{state:'incomplete',exact_value:null,reason:'native_closing_date_unavailable'}
          :{state:'observed',exact_value:[...distinct][0],reason:null};
  let reported=null;
  if(source!==null){
    const w=source.same_payload_reported_sale;if(!w||!['closed','nonclosed','unknown','conflicting'].includes(w.record_type?.state))fail('invalid_reported_record');
    const d=date(w.close_date),actual=disposition(d,period);
    if(w.period_disposition.state!==actual.state||w.period_disposition.exact_date!==actual.exact_date)fail('invalid_date');
    const fields=data(w.observations,FIELDS);
    reported={record_type:w.record_type.state,closed_record_disposition:w.closed_record_disposition,closing_date:d,
      period_disposition:actual,calendar_quarter:quarter(d),observations:Object.fromEntries(FIELDS.map(k=>[k,cell(fields[k],effective)])),
      normalized_date_comparison:closing.state==='observed'&&d.state==='observed'
        ?closing.exact_value===d.exact_value?'agree':'conflicting':'incomplete'};
  }
  const result={resolution_version:3,kind:p.kind,native_key:p.native_key,retained_effective_date:effective,retained_observation_period:period,
    basis:'complete_native_package_original_associations_and_reported_observations_only',
    membership:{native_account_count:memberships.size,selected_account_count:selected.size,unselected_stock_account_count:stock.size,
      outside_stock_account_count:outside.size,unresolved_account_row_count:missing,
      reported_resolved_link_count:resolvedLinks,unresolved_link_count:unresolvedLinks,
      native_account_state:missing||unresolvedLinks?'unresolved_associations':memberships.size>1?'multiple_native_accounts':'single_native_account',
      provider_parcel_membership:'not_established',economic_property_membership:'not_established'},
    native_sale_state:sales.length===0?'absent':sales.length===1?'unique_native_id':'multiple_native_ids_unresolved',
    unique_native_sale:sales.length===1?sales[0]:null,native_closing_date:closing,
    native_period_disposition:disposition(closing,period),native_calendar_quarter:quarter(closing),same_payload_reported:reported,
    economic_transaction_equivalence:'not_established',economic_transaction_eligibility:'not_established',price_allocation:'not_established',
    at_sale_GLA:'not_established',cross_source_deduplication:false,complete_selected_union:false,quarter_statistics:'not_established',
    authority:'not_established',report_update:'none'};
  check();if(Buffer.byteLength(json(result))>8192)fail('output_limit');return freeze(result);
}

// Separate closed DATA interpretations; neither export establishes native
// origin, source rights or progress. The actual owner supplies whole originals.
export function resolveNeighborhoodOriginalSourceResolutionV3(...args){return resolve(args,false);}
export function resolveNeighborhoodNextOriginalSourceResolutionV3(...args){return resolve(args,true);}
