import { randomUUID } from 'node:crypto';

// This is a prepared lookup, not appraisal evidence. The entire generation is
// built under one repeatable-read snapshot and published with one pointer.
// Readers must use the active pointer and the original source authorization.
const LOCK_KEY = 3_603_600_824;
const LABEL = value => `NULLIF(lower(btrim(regexp_replace(coalesce(${value}, ''), '[[:space:]]+', ' ', 'g'))), '')`;
const PARCEL_BATCH = `WITH batch AS MATERIALIZED (
  SELECT parcel.object_id, parcel.account_id, parcel.subdivision_name,
    parcel.residential_area_sqft, parcel.residential_year_built,
    parcel.parcel_area_sqft, parcel.current_market_value,
    parcel.source_record_hash, parcel.source_updated_at,
    account.county, account.city, account.subdivision
  FROM gis.dcad_parcels parcel
  LEFT JOIN core.accounts account ON account.account_id=parcel.account_id
  WHERE parcel.object_id>$2::bigint
  ORDER BY parcel.object_id LIMIT $3::integer
), named AS (
  SELECT batch.*, ${LABEL('county')} AS county_key, ${LABEL('city')} AS city_key,
    ${LABEL('subdivision')} AS account_label_key,
    ${LABEL('subdivision_name')} AS parcel_label_key
  FROM batch
), batch_accounts AS MATERIALIZED (
  SELECT DISTINCT account_id FROM named WHERE account_id IS NOT NULL
), secondary AS (
  SELECT improvement.account_id,
    sum(improvement.sec_imp_sqft) FILTER (WHERE upper(btrim(improvement.sec_imp_type))
      IN ('ATTACHED GARAGE','DETACHED GARAGE','ENCLOSED GARAGE')
      AND improvement.sec_imp_sqft>0) AS garage_area_sqft,
    sum(improvement.sec_imp_sqft) FILTER (WHERE upper(btrim(improvement.sec_imp_type))
      IN ('OUTBUILDING','STORAGE BUILDING','STORAGE SPACE','DETACHED QUARTERS',
          'CABANA','BARN','GREENHOUSE') AND improvement.sec_imp_sqft>0) AS outbuilding_area_sqft,
    bool_or(upper(btrim(improvement.sec_imp_type))='POOL') AS recorded_pool
  FROM batch_accounts account
  JOIN core.secondary_improvements improvement ON improvement.account_id=account.account_id
  GROUP BY improvement.account_id
), copied AS (
  INSERT INTO app.neighborhood_group_parcel_facts
    (generation_id,object_id,account_id,county_key,city_key,subdivision_key,
     recorded_subdivision,label_conflict,living_area_sqft,year_built,
     site_area_sqft,current_market_value,bedroom_count,bath_count,
     garage_area_sqft,outbuilding_area_sqft,pool,source_record_hash,source_updated_at)
  SELECT $1::uuid,named.object_id,named.account_id,named.county_key,named.city_key,
    CASE WHEN named.account_label_key IS NOT NULL AND named.parcel_label_key IS NOT NULL
      AND named.account_label_key<>named.parcel_label_key THEN NULL
      ELSE coalesce(named.account_label_key,named.parcel_label_key) END,
    CASE WHEN named.account_label_key IS NOT NULL THEN named.subdivision ELSE named.subdivision_name END,
    named.account_label_key IS NOT NULL AND named.parcel_label_key IS NOT NULL
      AND named.account_label_key<>named.parcel_label_key,
    CASE WHEN named.residential_area_sqft>0 THEN named.residential_area_sqft END,
    CASE WHEN named.residential_year_built BETWEEN 1000 AND 2100 THEN named.residential_year_built END,
    CASE WHEN named.parcel_area_sqft>0 THEN named.parcel_area_sqft END,
    CASE WHEN named.current_market_value>0 THEN named.current_market_value END,
    CASE WHEN primary_improvement.bedroom_count BETWEEN 0 AND 30
      THEN primary_improvement.bedroom_count END,
    CASE WHEN primary_improvement.bath_count BETWEEN 0 AND 30
      THEN primary_improvement.bath_count END,
    CASE WHEN secondary.garage_area_sqft BETWEEN 1 AND 100000
      THEN secondary.garage_area_sqft END,
    CASE WHEN secondary.outbuilding_area_sqft BETWEEN 1 AND 100000
      THEN secondary.outbuilding_area_sqft END,
    CASE WHEN primary_improvement.pool IS TRUE OR secondary.recorded_pool IS TRUE THEN true
      WHEN primary_improvement.pool IS FALSE THEN false ELSE NULL END,
    named.source_record_hash,named.source_updated_at
  FROM named
  LEFT JOIN core.primary_improvements primary_improvement
    ON primary_improvement.account_id=named.account_id
  LEFT JOIN secondary ON secondary.account_id=named.account_id
  WHERE named.account_id IS NOT NULL
  RETURNING object_id
)
SELECT coalesce((SELECT max(object_id) FROM batch),$2::bigint)::text AS cursor,
  (SELECT count(*) FROM batch)::integer AS scanned,
  (SELECT count(*) FROM copied)::integer AS copied`;

const SALE_BATCH = `WITH batch AS MATERIALIZED (
  SELECT sale.id,sale.account_id,sale.closing_date,sale.sale_price,
    sale.days_on_market,sale.source_record_id
  FROM core.sales sale WHERE sale.id>$2::bigint
  ORDER BY sale.id LIMIT $3::integer
), grouped AS (
  SELECT batch.*, linked.county_key,linked.city_key,linked.subdivision_key
  FROM batch LEFT JOIN LATERAL (
    SELECT min(fact.county_key) AS county_key,min(fact.city_key) AS city_key,
      min(fact.subdivision_key) AS subdivision_key
    FROM app.neighborhood_group_parcel_facts fact
    WHERE fact.generation_id=$1::uuid AND fact.account_id=batch.account_id
    HAVING count(*)>0 AND count(DISTINCT (fact.county_key,fact.city_key,fact.subdivision_key))=1
      AND bool_and(fact.county_key IS NOT NULL AND fact.city_key IS NOT NULL
        AND fact.subdivision_key IS NOT NULL AND NOT fact.label_conflict)
  ) linked ON true
), copied AS (
  INSERT INTO app.neighborhood_group_sale_facts
    (generation_id,sale_id,account_id,county_key,city_key,subdivision_key,
     closing_date,sale_price,days_on_market,source_record_id)
  SELECT $1::uuid,id,account_id,county_key,city_key,subdivision_key,
    closing_date,CASE WHEN sale_price>0 THEN sale_price END,
    CASE WHEN days_on_market>=0 THEN days_on_market END,source_record_id
  FROM grouped WHERE account_id IS NOT NULL
  RETURNING sale_id
)
SELECT coalesce((SELECT max(id) FROM batch),$2::bigint)::text AS cursor,
  (SELECT count(*) FROM batch)::integer AS scanned,
  (SELECT count(*) FROM copied)::integer AS copied`;

const BUILD_SUMMARY = `INSERT INTO app.neighborhood_group_summary
  (generation_id,county_key,city_key,subdivision_key,parcel_count,account_count,
   living_area_count,median_living_area_sqft,year_built_count,median_year_built,
   site_area_count,median_site_area_sqft,market_value_count,median_current_market_value,
   bedroom_count,median_bedroom_count,bath_count,median_bath_count,
   garage_area_count,median_garage_area_sqft,outbuilding_area_count,median_outbuilding_area_sqft,
   pool_observed_count,pool_present_count)
SELECT $1::uuid,county_key,city_key,subdivision_key,count(*),count(DISTINCT account_id),
  count(living_area_sqft),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area_sqft::double precision),
  count(year_built),percentile_cont(0.5) WITHIN GROUP (ORDER BY year_built),
  count(site_area_sqft),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY site_area_sqft::double precision),
  count(current_market_value),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY current_market_value::double precision),
  count(bedroom_count),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY bedroom_count::double precision),
  count(bath_count),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY bath_count::double precision),
  count(garage_area_sqft),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY garage_area_sqft::double precision),
  count(outbuilding_area_sqft),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY outbuilding_area_sqft::double precision),
  count(pool),count(*) FILTER (WHERE pool IS TRUE)
FROM app.neighborhood_group_parcel_facts
WHERE generation_id=$1::uuid AND county_key IS NOT NULL AND city_key IS NOT NULL
  AND subdivision_key IS NOT NULL AND NOT label_conflict
GROUP BY county_key,city_key,subdivision_key`;

const BUILD_SALES = `WITH grouped AS (
  SELECT county_key,city_key,subdivision_key,count(*) AS sale_count,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY sale_price::double precision) AS median_sale_price,
    min(closing_date) AS first_sale_date,max(closing_date) AS last_sale_date
  FROM app.neighborhood_group_sale_facts
  WHERE generation_id=$1::uuid AND county_key IS NOT NULL AND city_key IS NOT NULL
    AND subdivision_key IS NOT NULL AND sale_price IS NOT NULL AND closing_date IS NOT NULL
  GROUP BY county_key,city_key,subdivision_key
)
UPDATE app.neighborhood_group_summary summary
SET sale_count=grouped.sale_count,median_sale_price=grouped.median_sale_price,
  first_sale_date=grouped.first_sale_date,last_sale_date=grouped.last_sale_date
FROM grouped WHERE summary.generation_id=$1::uuid AND summary.county_key=grouped.county_key
  AND summary.city_key=grouped.city_key AND summary.subdivision_key=grouped.subdivision_key`;

const PUBLISH = `UPDATE app.neighborhood_group_generations SET status='complete',
  completed_at=now(),parcel_count=$2::bigint,sale_count=$3::bigint,
  group_count=(SELECT count(*) FROM app.neighborhood_group_summary WHERE generation_id=$1::uuid)
WHERE generation_id=$1::uuid AND status='building'`;

const READ_SUMMARY = `SELECT summary.*,generation.source_observed_at,generation.completed_at,
  active.published_at
FROM app.neighborhood_group_active active
JOIN app.neighborhood_group_generations generation
  ON generation.generation_id=active.generation_id AND generation.status='complete'
JOIN app.neighborhood_group_summary summary ON summary.generation_id=active.generation_id
WHERE active.id=true AND summary.county_key=$1 AND summary.city_key=$2
  AND summary.subdivision_key=$3`;

const OLD_GENERATION = `SELECT generation_id FROM app.neighborhood_group_generations
  WHERE generation_id<>(SELECT generation_id FROM app.neighborhood_group_active WHERE id=true)
    AND status='complete'
  ORDER BY completed_at DESC OFFSET 1 LIMIT 1`;
const PRUNE_FACTS = table => `WITH old AS (
  SELECT ctid FROM app.${table} WHERE generation_id=$1::uuid LIMIT $2::integer
), removed AS (
  DELETE FROM app.${table} WHERE ctid IN (SELECT ctid FROM old) RETURNING 1
) SELECT count(*)::integer AS removed FROM removed`;
const PRUNE_PARCELS=PRUNE_FACTS('neighborhood_group_parcel_facts');
const PRUNE_SALES=PRUNE_FACTS('neighborhood_group_sale_facts');

async function pruneObsoleteGeneration(client,batchSize,deadline) {
  const old=(await client.query(OLD_GENERATION)).rows?.[0]?.generation_id;
  if (!old) return {status:'none'};
  for (const sql of [PRUNE_PARCELS,PRUNE_SALES]) for (;;) {
    if (Date.now()>deadline) return {status:'deferred',generationId:old};
    const count=(await client.query({text:sql,values:[old,batchSize],query_timeout:120_000})).rows?.[0]?.removed;
    if (!Number.isSafeInteger(count) || count<0 || count>batchSize) throw new Error('neighborhood_group_index_prune_invalid');
    if (count<batchSize) break;
  }
  await client.query('DELETE FROM app.neighborhood_group_summary WHERE generation_id=$1::uuid',[old]);
  await client.query('DELETE FROM app.neighborhood_group_generations WHERE generation_id=$1::uuid',[old]);
  return {status:'pruned',generationId:old};
}

function positiveInteger(value, max, name) {
  if (!Number.isSafeInteger(value) || value<1 || value>max) throw new TypeError(`invalid_neighborhood_group_index:${name}`);
  return value;
}

async function copyBatches(client, sql, generationId, batchSize, deadline) {
  let cursor='-9223372036854775808', copied=0, scanned=0;
  for (;;) {
    if (Date.now()>deadline) throw Object.assign(new Error('neighborhood_group_index_runtime_limit'),{code:'RUNTIME_LIMIT'});
    const result=await client.query({text:sql,values:[generationId,cursor,batchSize],query_timeout:120_000});
    const row=result.rows?.[0];
    if (!row || !/^-?\d+$/.test(row.cursor) || !Number.isSafeInteger(row.scanned)
      || !Number.isSafeInteger(row.copied) || row.scanned<0 || row.scanned>batchSize
      || row.copied<0 || row.copied>row.scanned || BigInt(row.cursor)<BigInt(cursor))
      throw new Error('neighborhood_group_index_batch_invalid');
    scanned+=row.scanned; copied+=row.copied;
    if (row.scanned===0) break;
    if (BigInt(row.cursor)===BigInt(cursor)) throw new Error('neighborhood_group_index_cursor_stalled');
    cursor=row.cursor;
  }
  return {scanned,copied};
}

/** Run only in a separate scheduled worker. No HTTP path calls this writer.
 * A repeatable-read transaction provides a coherent CAD/sales source snapshot;
 * the active generation changes atomically only when both facts and summaries
 * finish. Failure rolls back the candidate and leaves the previous index live.
 */
export async function runNeighborhoodGroupIndex(pool,{batchSize=1000,maximumRuntimeMinutes=90,logger=console}={}) {
  positiveInteger(batchSize,5000,'batch_size');
  positiveInteger(maximumRuntimeMinutes,180,'maximum_runtime_minutes');
  if (!pool || typeof pool.connect!=='function') throw new TypeError('neighborhood_group_index_pool_required');
  const client=await pool.connect();
  let locked=false,transaction=false;
  const generationId=randomUUID(),deadline=Date.now()+maximumRuntimeMinutes*60_000;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked',[LOCK_KEY])).rows?.[0]?.locked===true;
    if (!locked) return {status:'already_running'};
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); transaction=true;
    await client.query("INSERT INTO app.neighborhood_group_generations (generation_id,status) VALUES ($1::uuid,'building')",[generationId]);
    const parcels=await copyBatches(client,PARCEL_BATCH,generationId,batchSize,deadline);
    logger.info?.(`[neighborhood-group-index] parcel_rows=${parcels.copied}`);
    const sales=await copyBatches(client,SALE_BATCH,generationId,batchSize,deadline);
    if (Date.now()>deadline) throw Object.assign(new Error('neighborhood_group_index_runtime_limit'),{code:'RUNTIME_LIMIT'});
    await client.query({text:BUILD_SUMMARY,values:[generationId],query_timeout:120_000});
    await client.query({text:BUILD_SALES,values:[generationId],query_timeout:120_000});
    const published=await client.query(PUBLISH,[generationId,parcels.copied,sales.copied]);
    if (published.rowCount!==1) throw new Error('neighborhood_group_index_publish_invalid');
    await client.query(`INSERT INTO app.neighborhood_group_active (id,generation_id,published_at)
      VALUES (true,$1::uuid,now()) ON CONFLICT (id) DO UPDATE SET
      generation_id=excluded.generation_id,published_at=excluded.published_at`,[generationId]);
    await client.query('COMMIT');transaction=false;
    // Cleanup is intentionally outside the publication transaction. A crash
    // cannot roll back the new active generation, and the next run can resume.
    try { await pruneObsoleteGeneration(client,batchSize,deadline); }
    catch(error) { logger.warn?.(`[neighborhood-group-index] cleanup_deferred=${error?.code??'error'}`); }
    return {status:'complete',generationId,parcels:parcels.copied,sales:sales.copied};
  } catch(error) {
    if (transaction) await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)',[LOCK_KEY]).catch(()=>{});
    client.release();
  }
}

/** Descriptive fast lookup only; this must not be used as report evidence. */
export async function getPreparedNeighborhoodGroupSummary(pool,{county,city,subdivision}) {
  const key=value=>typeof value==='string' ? value.trim().replace(/\s+/gu,' ').toLowerCase() : '';
  const values=[key(county),key(city),key(subdivision)];
  if (values.some(value=>!value || value.length>512)) throw new TypeError('invalid_neighborhood_group_lookup');
  const result=await pool.query(READ_SUMMARY,values);
  return result.rows?.[0] ?? null;
}

export const NEIGHBORHOOD_GROUP_INDEX_SQL=Object.freeze({parcelBatch:PARCEL_BATCH,saleBatch:SALE_BATCH,
  buildSummary:BUILD_SUMMARY,buildSales:BUILD_SALES,readSummary:READ_SUMMARY});
