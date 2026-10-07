import { types } from 'node:util';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';

const FORMAT='frozen_job_stock_original_progress_v1',PAGE_ROWS=250,MAX_ROWS=2_000_000;
function fail(reason){throw new TypeError(`neighborhood_frozen_stock_originals_${reason}`);}
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))
    fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=MAX_ROWS;
function progressOf(raw){
  if(raw===null)return null;
  const p=data(raw,['format','stock_sha256','after_object_id','verified_parcels','verified_unassociated','done']);
  if(p.format!==FORMAT||typeof p.stock_sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.stock_sha256)
    ||!integer(p.verified_parcels)||!integer(p.verified_unassociated)||p.verified_unassociated>p.verified_parcels
    ||typeof p.done!=='boolean'||p.after_object_id!==null&&(typeof p.after_object_id!=='string'
      ||!/^(?:0|[1-9][0-9]{0,18})$/.test(p.after_object_id)||BigInt(p.after_object_id)>9223372036854775807n)
    ||(p.after_object_id===null)!==(p.verified_parcels===0))fail('invalid_progress');
  return Object.freeze(p);
}
function one(result){if(result?.rowCount!==1||result.rows?.length!==1)fail('invalid_result');return result.rows[0];}

// The exact stock PK, not selected-account source parts, is the sole roster.
// Only one constant-size aggregate crosses into Node. Invalid EWKB refuses the
// transaction; CASE prevents absent/non-string/non-hex values being decoded.
// Polygon originals are legitimately normalized to MultiPolygon in the retained
// spatial column, so compare normalized EWKB, not the two different raw strings.
export const NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL=`/* neighborhood-frozen-stock-originals:page */
  WITH candidates AS MATERIALIZED (
    SELECT stock.object_id,stock.account_id,original.row_key,original.account_id AS original_account_id,
      original.source_record_id,original.payload,original.geom
    FROM app.neighborhood_custom_cohort_stock_parcels stock
    LEFT JOIN app.neighborhood_frozen_source_rows original ON original.generation_id=stock.generation_id
      AND original.kind=stock.kind AND original.row_key=stock.row_key
    WHERE stock.generation_id=$1::uuid AND stock.operation_id=$2::uuid
      AND ($3::text='' OR stock.object_id>NULLIF($3,'')::bigint)
    ORDER BY stock.object_id LIMIT 250
  ), sized AS (
    SELECT *,sum(coalesce(octet_length(payload::text),0)+coalesce(ST_MemSize(geom),0)+512)
      OVER(ORDER BY object_id) AS prefix_bytes FROM candidates
  ), admitted AS MATERIALIZED (SELECT * FROM sized WHERE prefix_bytes<=8000000), checked AS MATERIALIZED (
    SELECT object_id,account_id,CASE WHEN row_key=object_id::text AND source_record_id IS NULL
      AND account_id IS NOT DISTINCT FROM original_account_id
      AND (account_id IS NULL OR (length(account_id) BETWEEN 1 AND 64
        AND account_id !~ '^[[:space:]]|[[:space:]]$|[[:cntrl:]]'))
      AND jsonb_typeof(payload)='object' AND jsonb_typeof(payload->'object_id')='string'
      AND payload->>'object_id'=object_id::text AND payload ? 'account_id'
      AND jsonb_typeof(payload->'account_id') IN ('string','null')
      AND payload->>'account_id' IS NOT DISTINCT FROM original_account_id
      AND geom IS NOT NULL AND ST_SRID(geom)=4326 AND ST_GeometryType(geom)='ST_MultiPolygon'
      AND NOT ST_IsEmpty(geom) AND ST_IsValid(geom)
      AND jsonb_typeof(payload->'stored_geometry_ewkb')='string'
      AND length(payload->>'stored_geometry_ewkb') BETWEEN 18 AND 1000000
      AND length(payload->>'stored_geometry_ewkb')%2=0
      AND payload->>'stored_geometry_ewkb' ~ '^[0-9a-fA-F]+$'
      THEN ST_AsEWKB(ST_Multi(ST_GeomFromEWKB(decode(payload->>'stored_geometry_ewkb','hex'))))
        =ST_AsEWKB(geom) ELSE false END AS valid FROM admitted
  ) SELECT count(*)::integer AS page_count,count(*) FILTER(WHERE account_id IS NULL)::integer AS unassociated_count,
    count(*) FILTER(WHERE valid IS NOT TRUE)::integer AS invalid_count,max(object_id)::text AS last_object_id,
    (SELECT count(*)::integer FROM candidates) AS candidate_count FROM checked`;

// Run once at the exact end: independently reconcile each retained account's
// own parcel count with the geographic stock, without widening the account set.
export const NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL=`/* neighborhood-frozen-stock-originals:totals */
  WITH actual AS MATERIALIZED (
    SELECT account_id,count(*)::bigint AS parcels FROM app.neighborhood_custom_cohort_stock_parcels
    WHERE operation_id=$2::uuid AND generation_id=$1::uuid GROUP BY account_id
  ), associated AS (SELECT * FROM actual WHERE account_id IS NOT NULL), recorded AS (
    SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts WHERE operation_id=$2::uuid
  ), compared AS (
    SELECT actual.account_id AS actual_id,recorded.account_id AS recorded_id,actual.parcels,recorded.parcel_count
    FROM associated actual FULL JOIN recorded USING(account_id)
  ) SELECT coalesce((SELECT sum(parcels) FROM actual),0)::text AS parcel_count,
    coalesce((SELECT parcels FROM actual WHERE account_id IS NULL),0)::text AS unassociated_parcel_count,
    (SELECT count(*) FROM associated)::text AS account_count,
    (SELECT count(*) FROM compared WHERE actual_id IS NULL OR recorded_id IS NULL OR parcels<>parcel_count)::text AS invalid_accounts`;

/** ONE independently verified geographic-original step, under the real owner's
 * current actor/assignment/subject/source-purpose transaction. Load progress
 * only from its fenced checkpoint; this primitive confers no grant/receipt.
 * Reopens every original via the immutable stock FK, including NULL-account
 * geometry excluded from the broader source-account graph. No ST_DWithin,
 * mutable fallback, dense geometry transfer, numeric interpretation or Apply.
 */
export function createNeighborhoodFrozenJobStockOriginals(client,rawOptions){
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  if(typeof options.checkBudget!=='function')fail('invalid_input');
  const stockStore=createNeighborhoodFrozenJobStock(client,options),check=options.checkBudget;
  let busy=false;
  return Object.freeze({async step(rawProgress){
    const saved=progressOf(rawProgress);check();if(busy)fail('concurrent_operation');busy=true;
    try{
      const stock=await stockStore.read();check();const digest=assessmentEvidenceDigest(stock);
      const progress=saved??{format:FORMAT,stock_sha256:digest,after_object_id:null,verified_parcels:0,verified_unassociated:0,done:false};
      const total=Number(stock.population.parcel_count),unassociated=Number(stock.population.unassociated_parcel_count);
      if(progress.stock_sha256!==digest||progress.verified_parcels>total||progress.verified_unassociated>unassociated
        ||progress.done&&(progress.verified_parcels!==total||progress.verified_unassociated!==unassociated))fail('stock_changed');
      if(progress.done)return Object.freeze({status:'stock_original_progress',authority:'not_established',
        coverage:'geographic_originals_only',progress:saved,advanced:false,all_parcels_verified:true});
      const row=one(await client.query({text:NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,
        values:[stock.generation_id,stock.operation_id,progress.after_object_id??''],query_timeout:5000}));check();
      if(!Number.isInteger(row.page_count)||row.page_count<0||row.page_count>PAGE_ROWS
        ||!Number.isInteger(row.candidate_count)||row.candidate_count<row.page_count||row.candidate_count>PAGE_ROWS
        ||!Number.isInteger(row.unassociated_count)||row.unassociated_count<0||row.unassociated_count>row.page_count
        ||!Number.isInteger(row.invalid_count)||row.invalid_count<0||row.invalid_count>row.page_count
        ||row.invalid_count!==0||(row.page_count===0)!==(row.last_object_id===null)
        ||row.page_count===0&&row.candidate_count!==0)fail('original_mismatch');
      const next=progressOf({...progress,after_object_id:row.last_object_id??progress.after_object_id,
        verified_parcels:progress.verified_parcels+row.page_count,
        verified_unassociated:progress.verified_unassociated+row.unassociated_count,
        done:row.candidate_count<PAGE_ROWS&&row.page_count===row.candidate_count});
      if(row.last_object_id!==null&&progress.after_object_id!==null&&BigInt(row.last_object_id)<=BigInt(progress.after_object_id))fail('invalid_progress');
      if(next.verified_parcels>total||next.verified_unassociated>unassociated)fail('stock_count_mismatch');
      if(next.done){
        if(next.verified_parcels!==total||next.verified_unassociated!==unassociated)fail('stock_count_mismatch');
        const totals=one(await client.query({text:NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL,
          values:[stock.generation_id,stock.operation_id],query_timeout:5000}));check();
        if(totals.parcel_count!==stock.population.parcel_count||totals.account_count!==stock.population.account_count
          ||totals.unassociated_parcel_count!==stock.population.unassociated_parcel_count||totals.invalid_accounts!=='0')fail('stock_count_mismatch');
      }
      if(!same(await stockStore.read(),stock))fail('stock_changed');check();
      return Object.freeze({status:'stock_original_progress',authority:'not_established',coverage:'geographic_originals_only',
        progress:next,advanced:true,all_parcels_verified:next.done});
    }finally{busy=false;}
  }});
}
