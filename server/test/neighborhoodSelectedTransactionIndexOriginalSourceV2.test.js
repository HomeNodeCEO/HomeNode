import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as plans from '../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

const SQL=plans.NEIGHBORHOOD_NEXT_SELECTED_TRANSACTION_INDEX_ORIGINAL_PACKAGE_V2_SQL,
  source=name=>readFileSync(new URL(`../src/services/neighborhoodAssessment/${name}.js`,import.meta.url),'utf8');

test('all twelve previous original SQL constants stay byte-identical, including strict FIRST and semantic NEXT',()=>{
  const expected={
    NEIGHBORHOOD_FIRST_COMPLETED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL:'7d3512ac3a4c932d3cb2d6ec13e28a6e89f435cec9d85dc1ede0d0d3acda2ec2',
    NEIGHBORHOOD_FIRST_COMPLETED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL:'789da3ef0fe563c1650eb6c0b06f8f61ea7025df5c52aa0187209fb7d8854d8b',
    NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL:'079ce364f459f67e3f01576f7464d01c399db0e64b29741ed1e9b4de47b716e7',
    NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL:'ebd4a370a12d9e7063a32d3c66cb972fcabf9b18fb47aa1e6df45cba815b29af',
    NEIGHBORHOOD_FIRST_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL:'aa6e92b9f0fd52f6295b0531b4a02155928c9cc337a1f9476eb62f753a8cdddb',
    NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL:'6d2d2c9117cc625801fca8f9e825ef215fd0a7f027180ef74a6d0f6ae24e687e',
    NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL:'1f7aefc19d787df06f9e2d6246567f4434c7eff50f1387da643d50b9d0812215',
    NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL:'483accdbfe2b3dee28917a49462c00af0a89f0acab9eb60966b1ab6665757015',
    NEIGHBORHOOD_NEXT_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL:'99c8ee055d12c660ca80f1f484a29dba1988a518ac99fe19c06c5e375ec4c336',
    NEIGHBORHOOD_NEXT_SELECTED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL:'428556e8793f6de48cdc5d8a9e080dd420d544dac2a5149fd867c3e3f5386b75',
    NEIGHBORHOOD_NEXT_SELECTED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL:'3abdca68742b24b75321ca88e7fd979ed6b9afa7c0636dc8f121adcf1c60a7b3',
    NEIGHBORHOOD_NEXT_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL:'ac0740fb66f30a6c3b8496f35e2816b5ec13a73b0d5ff76c61a1534a00695894',
  };
  assert.equal(Object.keys(plans).length,15);
  for(const [key,sha] of Object.entries(expected))assert.equal(createHash('sha256').update(plans[key]).digest('hex'),sha,key);
});

test('separate original plan takes the native index NEXT account and exact member references, never a semantic or caller cursor',()=>{
  for(const text of ['neighborhood-next-selected-transaction-index-original-package-v2','transaction_index_context AS MATERIALIZED',
    'SELECT DISTINCT k.generation_id,k.account_id,k.ordinal,k.partition_ordinal',
    'neighborhood_selected_transaction_index_v2_next_keys(job.operation_id,job.organization_id)',
    'job.operation_id=$1::uuid AND k.generation_id=$2::uuid',
    'index_next.account_id=r.account_id AND index_next.ordinal=r.ordinal',
    'index_next.partition_ordinal=r.partition_ordinal AND index_next.entry_reference=r.entry_reference',
    'index_next.metric_row_reference=r.metric_row_reference AND index_next.contribution_row_reference=r.row_reference',
    'r.ordinal=index_next.ordinal AND $4::text=',
    'neighborhood_selected_transaction_index_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)',
    'semantic.numeric_reference=numeric_population.receipt_reference',
    "semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'"])assert.ok(SQL.includes(text),text);
  assert.doesNotMatch(SQL,/r.ordinal=1 AND|coalesce\(semantic.sequence|\$12|INSERT|UPDATE|DELETE|TRUNCATE|jsonb_agg|array_agg|::float|::real/);
});

test('native context gates the subject too; absent/mismatched context cannot masquerade as fresh EMPTY',()=>{
  for(const text of ['AND EXISTS(SELECT 1 FROM transaction_index_context)',
    '(SELECT count(*)=1 FROM transaction_index_context) AS transaction_index_context_present',
    '(SELECT account_id FROM transaction_index_context) AS transaction_index_account_id',
    'AS subject_selected_union_member',"'selected_union_member',CASE WHEN o.account_id IS NULL THEN NULL ELSE EXISTS(",
    "'stock_member',CASE WHEN o.account_id IS NULL"])assert.ok(SQL.includes(text),text);
  const cells=source('neighborhoodSharedStockOriginalCellsV2'),context=cells.indexOf("fail('transaction_index_context_missing')"),
    member=cells.indexOf("fail('transaction_index_account_mismatch')",context),parse=cells.indexOf('encoded=JSON.parse(result.page_json)',member);
  assert.ok(context>0&&member>context&&parse>member);
});

test('complete stock CAD subject and transaction originals keep the same aggregate caps before any payload encoding; registered sources are not filtered',()=>{
  const sizes=SQL.indexOf('raw_sizes AS MATERIALIZED'),gate=SQL.indexOf('raw_gate AS MATERIALIZED'),
    members=SQL.indexOf('members AS MATERIALIZED'),raw=SQL.slice(sizes,gate),encoded=SQL.slice(members);
  assert.ok(sizes>0&&gate>sizes&&members>gate);
  assert.doesNotMatch(raw,/jsonb_build_object|string_agg|array_agg| AS encoded/);
  assert.equal((raw.match(/octet_length\(o\.payload::text\)/g)??[]).length,3);
  assert.equal((raw.match(/SELECT coalesce\(sum\(n\),0\) FROM all_totals/g)??[]).length,3);
  assert.equal((encoded.match(/AND NOT \(SELECT oversize FROM raw_gate\) OFFSET 0/g)??[]).length,3);
  assert.equal((SQL.match(/OFFSET 0/g)??[]).length,(plans.NEIGHBORHOOD_FIRST_COMPLETED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL.match(/OFFSET 0/g)??[]).length);
  for(const text of ['ORDER BY o.row_key COLLATE "C" LIMIT ($5::integer+1)',
    'o.source_record_id=p.package_key::bigint','o.source_record_id IS NULL AND o.row_key=p.package_key',
    'sum(original_bytes::bigint+coalesce(typed_bytes,0)+1)','sum(2::bigint*coalesce(typed_bytes,0)+1024)'])assert.ok(SQL.includes(text),text);
  assert.doesNotMatch(SQL,/selected_transaction_source_v2_keys|selected_transaction_legacy_v2_keys|first_selected_ordinal|closing_date[\s]*[<>=]|sale_price[\s]*[<>=]/);
});

test('new child retains full original replay and both ending cache fences, shares single-use budget, and admits no caller ordinal or callback',()=>{
  const cells=source('neighborhoodSharedStockOriginalCellsV2'),start=cells.indexOf('async subjectAndNextSelectedTransactionIndexAccountPackage'),
    method=cells.slice(start,cells.indexOf('\n    },',start)),replay=cells.indexOf('reconcileNeighborhoodOriginalTransactionPackageV2('),
    output=cells.indexOf('selected_transaction_membership:selectedTransactionMembership',replay),
    finish=cells.indexOf('await context.finish();if(cadContext)await cadContext.finish()',output);
  assert.ok(start>0&&replay>0&&output>replay&&finish>output);
  for(const text of ["if(args.length!==2)fail('invalid_input')",'prepareNeighborhoodTransactionRetainedPeriodV1(args[1],effective)',
    "subjectAndNextPackage({cursor:''}"])assert.ok(method.includes(text),text);
  assert.doesNotMatch(method,/ordinal:|rowLimit:|callback|cursor:args|native_packages|receipt_reference/);
  for(const text of ['whole_native_packages_for_native_next_selected_account_only',"economic_property_membership:'not_established'",
    'global_selected_native_deduplication:false','nextSelectedMemberships.has(row.account_id)',
    'row.selected_union_member!==result.subject_selected_union_member','if(used)fail(\'single_use\')',
    'Buffer.byteLength(JSON.stringify(output))>L.output_utf8_bytes'])assert.ok(cells.includes(text),text);
});

test('source child connects only inactive original NEXT owners; owner migration unregistered and installed COMMIT refusals unchanged',()=>{
  const capture=source('customCohortContextCapture'),registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8'),
    installed=readFileSync(new URL('../migrations/20261205_custom_cohort_selected_transaction_index_v2.sql',import.meta.url),'utf8');
  assert.match(capture,/readingSelectedTransactionIndex\?'subjectAndNextSelectedTransactionIndexAccountPackage'/);
  assert.match(capture,/:createCustomCohortSelectedTransactionIndexV2Repository/);
  const atomic=capture.indexOf('if(progressingSelectedTransactionIndex){'),readOnly=capture.indexOf('if(readingSelectedTransactionSource){',atomic);
  assert.equal((capture.match(/selectedTransactionIndexStore\.advance\(/g)||[]).length,1);
  assert.ok(capture.indexOf('selectedTransactionIndexStore.advance(',atomic)<readOnly);
  assert.doesNotMatch(capture.slice(readOnly,capture.indexOf('if(progressingSelectedSemantic){',readOnly)),/selectedTransactionIndexStore\.advance\(/);
  assert.ok(!registry.includes('20261206_custom_cohort_selected_transaction_index_owner_v2.sql'));
  assert.ok(installed.includes('owner_unintegrated'));
});
