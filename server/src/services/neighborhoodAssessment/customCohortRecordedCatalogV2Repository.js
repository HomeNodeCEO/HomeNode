import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const BINDINGS=['source_reference','root_reference','graph_reference','geographic_reference','identity_reference',
  'stock_reference','traversal_reference','profile_reference','partition_reference'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL`;
const fail=r=>{throw new TypeError(`custom_cohort_recorded_catalog_v2_${r}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function ref(v){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>16000)fail('invalid_reference');return p;}
function anchorOf(v){if(v===null)return null;const a=data(v,[...BINDINGS,'receipt_reference','sequence']);
  if(!Number.isInteger(a.sequence)||a.sequence<1||a.sequence>2000001)fail('corrupt');
  return Object.freeze({...Object.fromEntries([...BINDINGS,'receipt_reference'].map(k=>[k,ref(a[k])])),sequence:a.sequence});}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}
function groupId(v){if(typeof v!=='string'||!/^(?:recorded-cad:[a-f0-9]{64}|discovery:unassigned)$/.test(v))fail('invalid_group');return v;}
function normalized(v){return typeof v==='string'&&v.length>0&&v.isWellFormed()&&Buffer.byteLength(v)<=512
  &&v===v.trim().replace(/\s+/gu,' ').toLowerCase()&&!/[\u0000-\u0008\u000e-\u001f\u007f]/.test(v);}
/** Storage only, not original/current-rights authority. No full account roster
 * or caller continuation. The actual owner must replay ONE whole original and
 * ENTIRE immutable partition entry, then fence both ends in the SAME bounded TX. */
export function createCustomCohortRecordedCatalogV2Repository(raw){
  const o=data(raw,['client','claim','scope','actorUserId',...BINDINGS]),{client,actorUserId}=o,
    claim=prepareCustomCohortCaptureJobClaim(o.claim),scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const bound=Object.fromEntries(BINDINGS.map(k=>[k,ref(o[k])])),values=[claim.operation_id,claim.claim_token,claim.attempts,
    scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,actorUserId];
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-recorded-catalog-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const read=async()=>{const row=one(await client.query(`/* custom-cohort-recorded-catalog-v2:anchor-read */
    SELECT head.source_reference,head.root_reference,head.graph_reference,head.geographic_reference,head.identity_reference,
      head.stock_reference,head.traversal_reference,head.profile_reference,head.partition_reference,head.receipt_reference,head.sequence
    FROM app.neighborhood_custom_cohort_capture_jobs job LEFT JOIN app.neighborhood_custom_cohort_recorded_catalog_v2_heads head
      ON head.operation_id=job.operation_id WHERE ${FENCE}`,values));
    if([...BINDINGS,'receipt_reference','sequence'].every(k=>row[k]===null))return null;
    const a=anchorOf(row);if(!BINDINGS.every(k=>same(a[k],bound[k])))fail('binding_changed');return a;};
  const counts=async()=>{const row=one(await client.query(`/* custom-cohort-recorded-catalog-v2:counts */
    SELECT coalesce(sum(g.member_count) FILTER(WHERE g.group_id<>'discovery:unassigned'),0)::integer AS assigned_accounts,
      coalesce(sum(g.member_count) FILTER(WHERE g.group_id='discovery:unassigned'),0)::integer AS unassigned_accounts,
      count(g.group_id) FILTER(WHERE g.group_id<>'discovery:unassigned')::integer AS assigned_groups
    FROM app.neighborhood_custom_cohort_capture_jobs job LEFT JOIN app.neighborhood_custom_cohort_recorded_catalog_v2_groups g
      ON g.operation_id=job.operation_id AND g.organization_id=job.organization_id WHERE ${FENCE} GROUP BY job.operation_id`,values));
    const c=data(row,['assigned_accounts','unassigned_accounts','assigned_groups']);
    if(!Object.values(c).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000)||c.assigned_accounts+c.unassigned_accounts>2000000
      ||c.assigned_groups>2048||c.assigned_groups>c.assigned_accounts)fail('corrupt');return Object.freeze(c);};
  // ONE PK-scoped storage row, not complete catalog semantics or membership.
  // Only the actual owner supplies the ID derived from its whole original
  // packet, compares BOTH normalized literals and rechecks this row at exit.
  const readGroup=async rawGroup=>{const key=groupId(data(rawGroup,['group_id']).group_id),
    row=data(one(await client.query(`/* custom-cohort-recorded-catalog-v2:group-read */
      SELECT g.group_id,g.normalized_county,g.normalized_label,g.member_count,g.last_ordinal
      FROM app.neighborhood_custom_cohort_capture_jobs job LEFT JOIN app.neighborhood_custom_cohort_recorded_catalog_v2_groups g
        ON g.operation_id=job.operation_id AND g.organization_id=job.organization_id AND g.group_id=$9
      WHERE ${FENCE}`,[...values,key])),['group_id','normalized_county','normalized_label','member_count','last_ordinal']);
    if(Object.values(row).every(v=>v===null))return null;
    if(row.group_id!==key||!Number.isInteger(row.member_count)||row.member_count<1||row.member_count>2000000
      ||!Number.isInteger(row.last_ordinal)||row.last_ordinal<row.member_count||row.last_ordinal>2000000
      ||(key==='discovery:unassigned'?row.normalized_county!==null||row.normalized_label!==null
        :![row.normalized_county,row.normalized_label].every(normalized)))fail('corrupt');
    return Object.freeze(row);};
  return Object.freeze({read,counts,readGroup,async contribute(rawExpected,rawEntry){
    const expected=anchorOf(rawExpected),e=data(rawEntry,['account_id','ordinal','group_id','normalized_county','normalized_label']);
    if(!Number.isInteger(e.ordinal)||e.ordinal!==(expected?.sequence??0)+1
      ||typeof e.account_id!=='string'||!e.account_id||e.account_id.length>64||!e.account_id.isWellFormed()
      ||e.account_id.trim()!==e.account_id||/[\u0000-\u001f\u007f]/.test(e.account_id)
      ||typeof e.group_id!=='string'||!(/^(?:recorded-cad:[a-f0-9]{64}|discovery:unassigned)$/.test(e.group_id))
      ||(e.group_id==='discovery:unassigned'?e.normalized_county!==null||e.normalized_label!==null
        :![e.normalized_county,e.normalized_label].every(normalized)))fail('invalid_entry');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');if(!same(await read(),expected))fail('conflict');
    const r=one(await client.query(`/* custom-cohort-recorded-catalog-v2:contribute */
      INSERT INTO app.neighborhood_custom_cohort_recorded_catalog_v2_groups
        (operation_id,organization_id,group_id,normalized_county,normalized_label,member_count,last_ordinal)
      SELECT job.operation_id,job.organization_id,$9,$10,$11,1,$12::integer
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=job.operation_id
        AND entry.organization_id=job.organization_id AND entry.account_id=$13 AND entry.ordinal=$12::integer
        AND coalesce(entry.assigned_group_id,'discovery:unassigned')=$9
      WHERE ${FENCE} ON CONFLICT(operation_id,group_id) DO UPDATE
        SET member_count=neighborhood_custom_cohort_recorded_catalog_v2_groups.member_count+1,last_ordinal=EXCLUDED.last_ordinal
      WHERE neighborhood_custom_cohort_recorded_catalog_v2_groups.normalized_county IS NOT DISTINCT FROM EXCLUDED.normalized_county
        AND neighborhood_custom_cohort_recorded_catalog_v2_groups.normalized_label IS NOT DISTINCT FROM EXCLUDED.normalized_label
      RETURNING last_ordinal`,[...values,e.group_id,e.normalized_county,e.normalized_label,e.ordinal,e.account_id]));
    if(r.last_ordinal!==e.ordinal)fail('corrupt');if(await tx()!==started)fail('caller_transaction_required');return counts();
  },async advance(rawExpected,rawReceipt){
    const expected=anchorOf(rawExpected),receipt=ref(rawReceipt),sequence=(expected?.sequence??0)+1;
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');if(!same(await read(),expected))fail('conflict');
    const b=BINDINGS.map(k=>json(bound[k])),r=expected===null?await client.query(`/* custom-cohort-recorded-catalog-v2:anchor-insert */
      INSERT INTO app.neighborhood_custom_cohort_recorded_catalog_v2_heads
        (operation_id,organization_id,${BINDINGS.join(',')},receipt_reference,sequence)
      SELECT job.operation_id,job.organization_id,${BINDINGS.map((_,i)=>`$${9+i}::jsonb`).join(',')},$18::jsonb,1
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} ON CONFLICT(operation_id) DO NOTHING RETURNING sequence`,[...values,...b,json(receipt)])
      :await client.query(`/* custom-cohort-recorded-catalog-v2:anchor-advance */
        UPDATE app.neighborhood_custom_cohort_recorded_catalog_v2_heads head SET receipt_reference=$9::jsonb,sequence=$10::integer
        FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} AND head.operation_id=job.operation_id
          AND head.organization_id=job.organization_id AND head.receipt_reference=$11::jsonb AND head.sequence=$12::integer
          AND ${BINDINGS.map((k,i)=>`head.${k}=$${13+i}::jsonb`).join(' AND ')} RETURNING head.sequence`,
      [...values,json(receipt),sequence,json(expected.receipt_reference),expected.sequence,...b]);
    if(one(r).sequence!==sequence)fail('corrupt');const stored=await read();
    if(!same(stored,{...bound,receipt_reference:receipt,sequence})||await tx()!==started)fail('corrupt');return stored;
  }});
}
