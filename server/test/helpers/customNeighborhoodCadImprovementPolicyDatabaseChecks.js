import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomNeighborhoodCadImprovementSourcePolicy as create, describeNeighborhoodCadImprovementPurpose as describe,
  CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY as KEY, CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_PURPOSE as SCOPE,
  CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_DATASET as DATASET } from '../../src/security/customNeighborhoodCadImprovementSourcePolicy.js';

/** Only an IDLE client from the independently verified disposable native child.
 * Synthetic owner metadata is always rolled back; this is NOT source licensing,
 * assignment authorization, cache consumer admission or production provisioning. */
export async function runCustomNeighborhoodCadImprovementPolicyDatabaseChecks(client) {
  const org=randomUUID(),profile={datasetRevision:'synthetic-CAD-native',providerRevisions:[{provider_id:'synthetic',revision:'fixture-only'}]};
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','2000ms',true)");
    const times=(await client.query(`WITH clock AS (SELECT clock_timestamp() AS t)
      SELECT to_char((t-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS past,
        to_char((t+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS future,
        to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD') AS effective_date FROM clock`)).rows[0];
    const config={policy_version:1,organization_id:org,grant_id:'synthetic-only-CAD-grant',purpose_version:1,purpose_scope:SCOPE,
      dataset:{id:DATASET,revision:profile.datasetRevision,coverage:'entire_integrated_source_mix_including_prior_merged_values',provider_revisions:profile.providerRevisions},
      rights_basis:{owner_id:'synthetic',basis_reference:'synthetic-fixture-NOT-production-license',approved_by:'synthetic',approved_at:times.past},
      valid_from:times.past,expires_at:times.future,revoked_at:null,retention:'immutable_originals_without_automated_deletion',
      exposures:{none:true,report_observation_summary:false,report_observation_members:false,report_observation_catalog:false}};
    const sentinel='synthetic-unrelated-metadata-never-transferred';
    await client.query(`INSERT INTO app_auth.organizations(id,legal_name,display_name,metadata)
      VALUES($1,'Synthetic CAD rights','Synthetic CAD rights',$2::jsonb)`,[org,JSON.stringify({[KEY]:config,unrelated:{sentinel,padding:'x'.repeat(18000)}})]);
    const before=(await client.query('SELECT metadata,updated_at::text FROM app_auth.organizations WHERE id=$1',[org])).rows[0];
    let policyReads=0;
    const bounded={async query(sql,params){assert.match(sql,/custom-neighborhood-cad-improvement-source-policy:organization/);
      assert.deepEqual(params,[org,KEY,16384]);const result=await client.query(sql,params);policyReads++;
      assert.equal(JSON.stringify(result.rows).includes(sentinel),false);return result;}};
    const policy=create(profile),context={scope:{organization_id:org},target:{workflow_type:'custom_appraisal'},effective_date:times.effective_date};
    const auth={userId:randomUUID()},purpose=describe({selection_sha256:'a'.repeat(64),generation_id:randomUUID()});
    const check=(exposure='none')=>policy(bounded,auth,context,purpose,{retention:true,exposure});
    const allowed=await check();assert.equal(allowed.allowed,true);
    assert.match(allowed.policy_revision,/^custom-neighborhood-cad-improvement-source-rights-v1:sha256:[a-f0-9]{64}$/);
    assert.deepEqual((await client.query('SELECT metadata,updated_at::text FROM app_auth.organizations WHERE id=$1',[org])).rows[0],before);
    assert.deepEqual(await check('report_observation_members'),{allowed:false});
    const save=async value=>{assert.equal((await client.query('UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,ARRAY[$2::text],$3::jsonb) WHERE id=$1',
      [org,KEY,JSON.stringify(value)])).rowCount,1);};
    await save({...config,expires_at:times.past});assert.deepEqual(await check(),{allowed:false});
    await save({...config,revoked_at:times.past});assert.deepEqual(await check(),{allowed:false});
    await save({...config,rights_basis:{...config.rights_basis,basis_reference:'revised-synthetic-only'}});
    assert.notEqual((await check()).policy_revision,allowed.policy_revision);
    const wrong=structuredClone(config);wrong.purpose_scope.source_projection.fields.primary.pop();
    await save(wrong);assert.deepEqual(await check(),{allowed:false});
    await save({...config,oversized:'x'.repeat(17000)});assert.deepEqual(await check(),{allowed:false});
    await client.query('UPDATE app_auth.organizations SET metadata=metadata-$2::text WHERE id=$1',[org,KEY]);assert.deepEqual(await check(),{allowed:false});
    console.log('[native-CAD-improvement-source-policy]',{policy_reads:policyReads,unrelated_metadata_transferred:false,
      grant_mutation_by_policy:false,wall_clock_expiry_and_revocation_refused:true,exact_projection_required:true,
      source_acquisition:false,assignment_authorization:false,production_grant:false,production_latency:false});
  } finally {await client.query('ROLLBACK');}
  assert.equal((await client.query('SELECT count(*)::int AS n FROM app_auth.organizations WHERE id=$1',[org])).rows[0].n,0);
}
