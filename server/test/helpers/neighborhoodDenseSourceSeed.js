import assert from 'node:assert/strict';

/** Original dense native SQL seed, extracted without query/parameter changes.
 * Test-only: the caller owns a freshly migrated, independently verified loopback
 * database and a bounded transaction. No connection, grant, capture, commit,
 * cleanup or source mutation beyond these explicitly synthetic fixture rows.
 */
export async function seedNeighborhoodDenseSource(client, {
  org, actor, caseId, snapshotId, reportId, run, operation, account,
  parcelCount, accountCount, effectiveDate, geometry, interpretation = null,
}) {
  assert.equal(typeof client?.query, 'function');
  assert.equal(account, 'DENSE-000000');
  assert.equal(accountCount, 38_106); assert.equal(parcelCount, 38_347);
        await client.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic dense area','Synthetic dense area')", [org]);
        await client.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic actor')", [actor, `${actor}@example.test`]);
        await client.query(`INSERT INTO core.accounts(account_id,county,address,city,subdivision)
          SELECT 'DENSE-'||lpad(n::text,6,'0'),'Dallas','Synthetic address '||n,'Synthetic','Synthetic Plat '||(n%887)
          FROM generate_series(0,$1::int-1) n`, [accountCount]);
        await client.query('INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,$4)', [caseId, org, account, effectiveDate]);
        const location = { account_id: account, latitude: 32.8, longitude: -96.7, source: 'dcad_parcel_query', precision: 'parcel_centroid',
          status: 'matched', confidence: 'high', review_required: false, review_reason: null, match_method: 'parcel_id', source_parcel_id: account,
          feature_count: 1, metadata: { address_agreement: true }, geocoded_at: '2020-01-01T00:00:00.000Z', source_updated_at: null };
        await client.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
          VALUES($1,$2,1,$3,$4::jsonb)`, [snapshotId, caseId, effectiveDate, JSON.stringify({ custom_property_snapshot: {
          account: { account_id: account }, improvement: { living_area_sqft: 2000 }, location } })]);
        const assignment = (await client.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
          VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [org, account, `DENSE-${operation}`, actor])).rows[0].id;
        await client.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
          VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [reportId, org, account, `DENSE-${operation}`, assignment, caseId, snapshotId]);
        await client.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)', [assignment, `dense-${operation}`]);
        const result = { scope: { organization_id: org, report_file_id: reportId, assignment_file_id: assignment, account_id: account } };
        await client.query("INSERT INTO gis.source_sync_runs(id,source_key,mode,status,started_at,completed_at) VALUES($1,'dcad_parcels','full','complete',now()-interval '1 second',now())", [run]);
        await client.query("INSERT INTO gis.source_sync_state(source_key,status,row_count,last_run_id,last_success_at) VALUES('dcad_parcels','current',$1,$2,now())", [parcelCount, run]);
        await client.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,residential_year_built,residential_area_sqft,parcel_area_sqft,current_market_value,
          land_use_category,classification_confidence,class_code,class_description,use_description,structure_type,built_up,source_record_hash,sync_run_id,synced_at,geom)
          SELECT n+1,'DENSE-'||lpad((n%$2::int)::text,6,'0'),1950+n%60,1200+n%1500,6000+n%1000,250000+n,
            'one_unit','high','1','SINGLE FAMILY RESIDENCES',repeat('Synthetic retained source. ',3),'Synthetic literal',true,repeat('a',64),$3,now(),
            ST_Multi(ST_Translate(ST_GeomFromText($4,4326),(n%200)*0.0001,(n/200)*0.0001))
          FROM generate_series(0,$1::int-1) n`, [parcelCount, accountCount, run, geometry]);
        await client.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type,source_record_hash,close_date,current_price,loaded_at)
          SELECT n+1,'DENSE-'||lpad(n::text,6,'0'),'closed_sale',repeat('b',64),'2024-03-01',250000+n,now()
          FROM generate_series(0,$1::int-1) n WHERE n%37=0`, [accountCount]);
        if (interpretation) {
          const { denseWitness2FixtureCases } = await import('./customCohortDenseReportedChecks.js');
          const cases = denseWitness2FixtureCases();
          // All 1,030 sources participate (103 of each fixed case). These are
          // literal synthetic payloads, not an NTREIS dictionary or grant.
          // Surviving typed values deliberately disagree with the witnesses.
          await client.query(`UPDATE core.sales_source_records SET
            raw_payload=$1::jsonb -> (((id-1)/37)%10)::int,
            source_name='Synthetic combined witness capacity',source_filename='dense-witness2-fixture.csv',
            source_sha256=repeat('c',64),source_row_number=((id-1)/37+2)::int,
            mls_status='Active',living_area=9999,lot_size_area=8888,year_built=1980,days_on_market=99`,
          [JSON.stringify(cases.map(item => item.raw))]);
        }
        await client.query(`INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price,source,loaded_at)
          SELECT id,id,primary_account_id,close_date,current_price,'Synthetic dense',now() FROM core.sales_source_records`);
        await client.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved,loaded_at)
          SELECT id,id,1,1,primary_account_id,true,now() FROM core.sales_source_records`);
  return result;
}
