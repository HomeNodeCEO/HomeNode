import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from './fixtures/neighborhoodCachedSourceSchemaFixture.js';
import { runNeighborhoodGroupIndex,getPreparedNeighborhoodGroupSummary }
  from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';

test('isolated PostgreSQL: publishes indexed city/subdivision facts and preserves exact sale dates',{
  skip:!process.env.DATABASE_URL,timeout:360_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try {
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    // The isolated UAD fixture has bedroom/bath and secondary rows but omits
    // the DCAD pool column. Add it only inside this throwaway child database.
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query(`INSERT INTO core.accounts(account_id,county,city,subdivision) VALUES
      ('INDEX-A','Dallas','Garland','Monica Park 4'),
      ('INDEX-B','Dallas','Garland',' MONICA  PARK 4 '),
      ('INDEX-C','Dallas','Garland','Another Park')`);
    await pool.query(`INSERT INTO gis.dcad_parcels
      (object_id,account_id,subdivision_name,residential_area_sqft,residential_year_built,
       parcel_area_sqft,current_market_value,source_record_hash,source_updated_at)
      VALUES (1,'INDEX-A','Monica Park 4',1000,1960,8000,100000,'a',now()),
             (2,'INDEX-B','Monica Park 4',2000,1970,9000,200000,'b',now()),
             (3,'INDEX-C','Wrong Park',3000,1980,10000,300000,'c',now())`);
    await pool.query(`INSERT INTO core.sales(id,account_id,closing_date,sale_price,days_on_market)
      VALUES (10,'INDEX-A','2024-01-01',100000,30),
             (11,'INDEX-B','2025-01-01',300000,45),
             (12,'INDEX-C','2025-01-01',500000,10)`);
    await pool.query(`INSERT INTO core.primary_improvements(account_id,bedroom_count,bath_count,pool)
      VALUES ('INDEX-A',3,2,true),('INDEX-B',4,NULL,NULL),('INDEX-C',NULL,NULL,false)`);
    await pool.query(`INSERT INTO core.secondary_improvements(id,account_id,sec_imp_type,sec_imp_sqft)
      VALUES (1,'INDEX-A','ATTACHED GARAGE',400),(2,'INDEX-B','DETACHED GARAGE',500),
             (3,'INDEX-A','STORAGE BUILDING',100),(4,'INDEX-C','POOL',250)`);
    const first=await runNeighborhoodGroupIndex(pool,{batchSize:1,logger:{info(){}}});
    assert.equal(first.status,'complete');
    assert.equal(first.parcels,3);
    assert.equal(first.sales,3);
    const summary=await getPreparedNeighborhoodGroupSummary(pool,{county:'Dallas',city:'Garland',subdivision:'Monica Park 4'});
    assert.equal(summary.parcel_count,'2');
    assert.equal(summary.account_count,'2');
    assert.equal(summary.median_living_area_sqft,1500);
    assert.equal(summary.bedroom_count,'2');
    assert.equal(summary.median_bedroom_count,3.5);
    assert.equal(summary.bath_count,'1');
    assert.equal(summary.median_bath_count,2);
    assert.equal(summary.median_garage_area_sqft,450);
    assert.equal(summary.outbuilding_area_count,'1');
    assert.equal(summary.median_outbuilding_area_sqft,100);
    assert.equal(summary.pool_observed_count,'1');
    assert.equal(summary.pool_present_count,'1');
    assert.equal(summary.sale_count,'2');
    assert.equal(summary.median_sale_price,200000);
    const dates=(await pool.query(`SELECT closing_date::text FROM app.neighborhood_group_sale_facts
      WHERE generation_id=$1 AND subdivision_key='monica park 4' ORDER BY closing_date`,[first.generationId])).rows;
    assert.deepEqual(dates.map(row=>row.closing_date),['2024-01-01','2025-01-01']);
    assert.equal((await pool.query(`SELECT label_conflict,subdivision_key FROM app.neighborhood_group_parcel_facts
      WHERE generation_id=$1 AND object_id=3`,[first.generationId])).rows[0].label_conflict,true);
    const physical=(await pool.query(`SELECT object_id,pool,garage_area_sqft,outbuilding_area_sqft
      FROM app.neighborhood_group_parcel_facts WHERE generation_id=$1 ORDER BY object_id`,
      [first.generationId])).rows;
    assert.equal(physical[1].pool,null);
    assert.equal(physical[1].outbuilding_area_sqft,null);
    assert.equal(physical[2].pool,true);
    await pool.query('UPDATE gis.dcad_parcels SET residential_area_sqft=4000 WHERE object_id=2');
    const second=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    assert.equal(second.status,'complete');
    assert.equal((await getPreparedNeighborhoodGroupSummary(pool,{county:'Dallas',city:'Garland',subdivision:'Monica Park 4'})).median_living_area_sqft,2500);
    assert.notEqual(first.generationId,second.generationId);
  } finally { await pool.end(); }
});
