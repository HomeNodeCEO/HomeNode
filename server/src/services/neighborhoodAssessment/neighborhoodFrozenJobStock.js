import { types } from 'node:util';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { createCustomCohortCaptureJobRepository, prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { createNeighborhoodFrozenSpatialPages, readNeighborhoodFrozenSourceHeader,
  neighborhoodFrozenSpatialDefinition } from './neighborhoodFrozenSpatialPages.js';

function fail(reason) { throw new TypeError(`neighborhood_frozen_job_stock_${reason}`); }
function data(value,keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value)!==Object.prototype
    || Reflect.ownKeys(value).length!==keys.length || !keys.every(key=>{
      const d=Object.getOwnPropertyDescriptor(value,key);return d?.enumerable && Object.hasOwn(d,'value');
    })) fail('invalid_input');
  return Object.fromEntries(keys.map(key=>[key,value[key]]));
}
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
const one=result=>{if(result?.rowCount!==1 || result.rows?.length!==1) fail('unavailable');return result.rows[0];};
const count=value=>typeof value==='string' && /^(?:0|[1-9][0-9]{0,6})$/.test(value) && Number(value)<=2_000_000;
const READ=`/* neighborhood-frozen-job-stock:read */ SELECT status,definition,definition_sha256,
  source_original_sha256,subject_intent_sha256,subject_intent_utf8_bytes::text,
  parcel_count::text,account_count::text,unassociated_parcel_count::text,unlocatable_global_parcels::text
  FROM app.neighborhood_custom_cohort_job_stocks
  WHERE operation_id=$1::uuid AND generation_id=$2::uuid AND organization_id=$3::uuid
    AND report_file_id=$4::uuid AND assignment_file_id=$5::bigint AND account_id=$6 AND actor_user_id=$7::uuid
  FOR SHARE NOWAIT`;

/** SQL stock primitive used ONLY by the current-authorized coordinator stage.
 * Its immutable identities reference the exact retained parcel originals,
 * including unassociated stock parcels; these are not the broader account-part
 * source closure. Current actor/assignment/subject/CAD rights belong to that
 * owner, not to this descriptor. No dense roster crosses the Node boundary.
 * Caller owns the transaction and rollback, and bounds every query.
 */
export function createNeighborhoodFrozenJobStock(client,rawOptions) {
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  const claim=prepareCustomCohortCaptureJobClaim(data(options.claim,['operation_id','claim_token','attempts']));
  const scope=Object.freeze(data(options.scope,['organization_id','report_file_id','assignment_file_id','account_id']));
  const subjectIntent=Object.freeze(data(options.subjectIntent,['content_sha256','canonical_utf8_bytes']));
  if (typeof subjectIntent.content_sha256!=='string' || !/^[a-f0-9]{64}$/.test(subjectIntent.content_sha256)
    || typeof subjectIntent.canonical_utf8_bytes!=='string' || !/^[1-9][0-9]{0,6}$/.test(subjectIntent.canonical_utf8_bytes)
    || Number(subjectIntent.canonical_utf8_bytes)>1_500_000 || typeof options.checkBudget!=='function') fail('invalid_input');
  // Validate/detach before the first await, without trusting an input point as
  // current subject authority. The actual owner supplies its original point.
  const admitted=neighborhoodFrozenSpatialDefinition(claim,'00000000-0000-4000-8000-000000000000',options.geometryInput,options.discovery);
  const actorUserId=options.actorUserId, check=options.checkBudget;
  const jobs=createCustomCohortCaptureJobRepository(client),jobOptions={scope,actorUserId};
  let busy=false;
  async function execute(preparing) {
    check();if(busy) fail('concurrent_operation');busy=true;
    try {
      const pin=await jobs.readPreparedGeneration(claim,jobOptions);if(!pin) fail('pin_unavailable');
      const original=await readNeighborhoodFrozenSourceHeader(client,pin.generation_id);
      const definition=neighborhoodFrozenSpatialDefinition(claim,pin.generation_id,admitted.geometry_input,admitted.discovery);
      const definitionHash=assessmentEvidenceDigest(definition),sourceHash=assessmentEvidenceDigest(original);
      const values=[claim.operation_id,pin.generation_id,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,actorUserId];
      const decode=row=>{
        if(row.status!=='complete' || !same(row.definition,definition) || row.definition_sha256!==definitionHash
          || row.source_original_sha256!==sourceHash || row.subject_intent_sha256!==subjectIntent.content_sha256
          || row.subject_intent_utf8_bytes!==subjectIntent.canonical_utf8_bytes
          || !['parcel_count','account_count','unassociated_parcel_count','unlocatable_global_parcels'].every(key=>count(row[key]))
          || row.account_count==='0' || Number(row.account_count)>Number(row.parcel_count)-Number(row.unassociated_parcel_count)
          || Number(row.unassociated_parcel_count)>Number(row.parcel_count)
          || Number(row.parcel_count)>Number(original.layer_counts.parcels.row_count)
          || Number(row.unlocatable_global_parcels)>Number(original.layer_counts.parcels.row_count)) fail('conflict');
        return Object.freeze({stock_version:1,operation_id:claim.operation_id,generation_id:pin.generation_id,
          definition_sha256:definitionHash,source_original_sha256:sourceHash,subject_intent:subjectIntent,
          definition,original,population:Object.freeze({parcel_count:row.parcel_count,account_count:row.account_count,
            unassociated_parcel_count:row.unassociated_parcel_count,unlocatable_global_parcels:row.unlocatable_global_parcels,
            invalid_geometries:'0',subject_included:true}),authority:'not_established',coverage:'exact_original_stock_only'});
      };
      let result=await client.query(READ,values);check();
      if(result?.rowCount===0 && result.rows?.length===0 && preparing) {
        const first=await createNeighborhoodFrozenSpatialPages(client,{claim,scope,actorUserId,
          geometryInput:admitted.geometry_input,discovery:admitted.discovery,checkBudget:check})
          .page({kind:'parcels',cursor:'',rowLimit:1});
        if(!first.population.subject_included || first.definition_sha256!==definitionHash || !same(first.original,original)) fail('subject_outside_stock');
        const population=first.population;
        await client.query(`/* neighborhood-frozen-job-stock:begin */ INSERT INTO app.neighborhood_custom_cohort_job_stocks
          (operation_id,generation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,
           subject_intent_sha256,subject_intent_utf8_bytes,definition_sha256,definition,source_original_sha256,unlocatable_global_parcels)
          VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6,$7::uuid,$8,$9::bigint,$10,$11::jsonb,$12,$13::bigint)`,
        [...values,subjectIntent.content_sha256,subjectIntent.canonical_utf8_bytes,definitionHash,
          canonicalAssessmentJson(definition),sourceHash,population.unlocatable_global_parcels]);
        check();
        // The only expensive spatial predicate. Later pages use the stock PK
        // and account index; geometry/land-use originals remain pinned in SQL.
        await client.query(`/* neighborhood-frozen-job-stock:parcels */ INSERT INTO app.neighborhood_custom_cohort_stock_parcels
          (operation_id,generation_id,object_id,account_id)
          SELECT $1::uuid,generation_id,row_key::bigint,account_id FROM app.neighborhood_frozen_source_rows
          WHERE generation_id=$2::uuid AND kind='parcels' AND geom IS NOT NULL
            AND ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint($3::double precision,$4::double precision),4326)::geography,
              $5::double precision,true)`,[claim.operation_id,pin.generation_id,...definition.geometry_input.coordinates,definition.discovery.radius_metres]);
        check();
        await client.query(`/* neighborhood-frozen-job-stock:accounts */ INSERT INTO app.neighborhood_custom_cohort_stock_accounts
          (operation_id,account_id,parcel_count) SELECT operation_id,account_id,count(*)
          FROM app.neighborhood_custom_cohort_stock_parcels WHERE operation_id=$1::uuid AND account_id IS NOT NULL
          GROUP BY operation_id,account_id`,[claim.operation_id]);
        check();
        one(await client.query(`/* neighborhood-frozen-job-stock:complete */ WITH parcels AS (
          SELECT count(*)::bigint AS total,count(*) FILTER(WHERE account_id IS NULL)::bigint AS unassociated,
            coalesce(bool_or(account_id=$6),false) AS subject_included
          FROM app.neighborhood_custom_cohort_stock_parcels WHERE operation_id=$1::uuid
        ), accounts AS (SELECT count(*)::bigint AS total,coalesce(sum(parcel_count),0)::bigint AS parcels
          FROM app.neighborhood_custom_cohort_stock_accounts WHERE operation_id=$1::uuid)
        UPDATE app.neighborhood_custom_cohort_job_stocks stock
          SET status='complete',completed_at=clock_timestamp(),parcel_count=parcels.total,
            account_count=accounts.total,unassociated_parcel_count=parcels.unassociated
          FROM parcels,accounts WHERE stock.operation_id=$1::uuid AND stock.status='building'
            AND parcels.total=$2::bigint AND accounts.total=$3::bigint AND parcels.unassociated=$4::bigint
            AND accounts.parcels=parcels.total-parcels.unassociated AND parcels.subject_included=true
            AND stock.unlocatable_global_parcels=$5::bigint RETURNING stock.operation_id::text`,
        [claim.operation_id,population.parcel_count,population.account_count,population.unassociated_parcel_count,
          population.unlocatable_global_parcels,scope.account_id]));
        result=await client.query(READ,values);check();
      }
      const stock=decode(one(result));
      if(!same(await readNeighborhoodFrozenSourceHeader(client,pin.generation_id),original)
        || !same(await jobs.readPreparedGeneration(claim,jobOptions),pin)) fail('source_changed');
      check();return stock;
    }finally{busy=false;}
  }
  return Object.freeze({prepare:()=>execute(true),read:()=>execute(false)});
}
