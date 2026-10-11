import assert from 'node:assert/strict';

/** Small native arithmetic/DDL checks ONLY, not source acquisition/authority.
 * The separate full issued owner fixture below must prove the actual indexed
 * rows came from fresh originals, ending rights and atomic real COMMIT. */
export async function runNeighborhoodSelectedNumericIndexV2DatabaseChecks(pool){
  const inputs=['0','0.000000000001','1.25','9007199254740992','9007199254740993',
    '999999999999999999.999999999999','999999999999999999999999999999'];
  const parsed=(await pool.query(`SELECT ordinal::integer,app.neighborhood_selected_numeric_index_v2_decimal(value)::text AS exact
    FROM unnest($1::text[]) WITH ORDINALITY input(value,ordinal) ORDER BY ordinal`,[inputs])).rows;
  assert.deepEqual(parsed.map(r=>r.exact),inputs);
  for(const value of ['', '00','01','1.0','0.0','-1','+1','1e3',' 1','1 ','NaN','Infinity',
    '.1','1.','0.0000000000001','1000000000000000000000000000000']){
    await assert.rejects(pool.query('SELECT app.neighborhood_selected_numeric_index_v2_decimal($1)',[value]),/decimal_invalid/);
  }
  const values=['9007199254740993','0','9007199254740992','0.000000000002','0.000000000001','9007199254740993'],
    ordered=(await pool.query(`SELECT ordinal::integer,app.neighborhood_selected_numeric_index_v2_decimal(value)::text AS exact
      FROM unnest($1::text[]) WITH ORDINALITY input(value,ordinal)
      ORDER BY app.neighborhood_selected_numeric_index_v2_decimal(value),ordinal`,[values])).rows;
  assert.deepEqual(ordered.map(r=>[r.ordinal,r.exact]),[[2,'0'],[5,'0.000000000001'],[4,'0.000000000002'],
    [3,'9007199254740992'],[1,'9007199254740993'],[6,'9007199254740993']]);
  const cell={reported_value_state:'observed',complete_observed_parts:true,recorded_comparison_eligible:true,
    contribution_exact_value:'0',contribution_unit:'reported_sqft',exclusion_reasons:[],source_part_count:1,
    part_counts:{observed:1,missing:0,invalid:0,unsupported:0}},
    read=async(value,metric='reported_site_area')=>(await pool.query(
      'SELECT app.neighborhood_selected_numeric_index_v2_cell($1::jsonb,$2)::text AS exact',[JSON.stringify(value),metric])).rows[0].exact;
  assert.equal(await read(cell),'0','eligible genuine site zero is a number, not missing');
  assert.equal(await read({...cell,contribution_exact_value:'1600',contribution_unit:'year'},'reported_year_built'),'1600');
  assert.equal(await read({...cell,contribution_exact_value:'1.25'},'reported_residential_area'),'1.25');
  for(const state of ['observed','missing','invalid','conflicting','unsupported'])assert.equal(await read({...cell,
    reported_value_state:state,complete_observed_parts:false,recorded_comparison_eligible:false,
    contribution_exact_value:null,contribution_unit:null,exclusion_reasons:['recorded_value_'+state]}),null);
  for(const [value,metric] of [[cell,'reported_market_value'],[cell,'reported_residential_area'],
    [{...cell,contribution_exact_value:'1599',contribution_unit:'year'},'reported_year_built'],
    [{...cell,contribution_exact_value:'1600.1',contribution_unit:'year'},'reported_year_built'],
    [{...cell,contribution_unit:'currency'},'reported_site_area'],[{...cell,complete_observed_parts:false},'reported_site_area'],
    [{...cell,exclusion_reasons:['missing_parts']},'reported_site_area'],[{...cell,reported_value_state:'caller'},'reported_site_area'],
    [{...cell,recorded_comparison_eligible:false},'reported_site_area'],[{...cell,extra:true},'reported_site_area']]){
    await assert.rejects(read(value,metric),/cell_invalid/);
  }
  const definitions=(await pool.query(`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='app' AND tablename='neighborhood_custom_cohort_selected_numeric_index_v2_rows'
      AND indexname IN ('neighborhood_selected_numeric_year_v2_idx','neighborhood_selected_numeric_residential_v2_idx','neighborhood_selected_numeric_site_v2_idx')
    ORDER BY indexname`)).rows;
  assert.equal(definitions.length,3);
  for(const row of definitions){assert.match(row.indexdef,/USING btree \(operation_id, reported_.*?, ordinal\)/);
    assert.match(row.indexdef,/INCLUDE \(account_id\)/);assert.match(row.indexdef,/WHERE \(reported_.*? IS NOT NULL\)/);}
  return {numeric_parser_and_native_ordering_DATA_only:true,greater_than_double_integer_precision:true,
    exact_twelve_fractional_places:true,stable_ties_and_genuine_site_zero:true,partial_native_btree_indexes:3,
    source_authority:false,complete_selected_union:false,statistics:false,licensed_acquisition:false,production_speed:false};
}
