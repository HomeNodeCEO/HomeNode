import 'dotenv/config';
import pg from 'pg';
import { runNeighborhoodGroupIndex } from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const setting=(name,fallback)=>{
  const value=process.env[name];
  if (value===undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`invalid_${name.toLowerCase()}`);
  return Number(value);
};
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,
  connectionTimeoutMillis:5000,statement_timeout:605_000,
  application_name:'homenode-neighborhood-group-index'});
try {
  const result=await runNeighborhoodGroupIndex(pool,{
    batchSize:setting('NEIGHBORHOOD_GROUP_BATCH_SIZE',1000),
    maximumRuntimeMinutes:setting('NEIGHBORHOOD_GROUP_MAX_RUNTIME_MINUTES',90),
  });
  console.log(JSON.stringify(result));
} catch(error) {
  console.error('[neighborhood-group-index] failed',error?.code??error?.name??'error');
  process.exitCode=1;
} finally { await pool.end(); }
