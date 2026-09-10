import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../migrations/20261016_assignment_sales_csv_reviews.sql', import.meta.url), 'utf8');
test('new review migration pins exact immutable parent/projection tuple and rejects JSON subset identity', () => {
  assert.match(sql, /UNIQUE \(batch_id, review_id, revision\)/);
  assert.match(sql, /FOREIGN KEY \(batch_id, review_id, revision\)/);
  assert.match(sql, /decision->'source_row_number'\) IS NOT DISTINCT FROM to_jsonb\(source_row_number\)/);
  assert.match(sql, /decision->'receipt_id'\) IS NOT DISTINCT FROM to_jsonb\(receipt_id::text\)/);
  assert.match(sql, /WHERE d\.value=NEW\.decision/); assert.doesNotMatch(sql, /@>/);
});
test('new append guard requires exact revision and bounded, aligned versioned row payloads', () => {
  assert.match(sql, /FOR UPDATE/); assert.match(sql, /ORDER BY revision DESC LIMIT 1/);
  assert.match(sql, /last_revision = 2147483647/);
  assert.match(sql, /NEW\.revision IS DISTINCT FROM coalesce\(last_revision, 0\) \+ 1/);
  assert.match(sql, /expected_revision'\) IS NOT DISTINCT FROM to_jsonb\(revision - 1\)/);
  assert.match(sql, /command_value->'review_version'\) IS DISTINCT FROM '1'::jsonb/);
  assert.match(sql, /jsonb_typeof\(decisions\) IS DISTINCT FROM 'array'/);
  assert.match(sql, /jsonb_array_length\(decisions\) > 100/);
  assert.match(sql, /jsonb_array_length\(payload_decisions\) <> jsonb_array_length\(decisions\)/);
  assert.match(sql, /payload_decision - ARRAY\['record_data','match_evidence'\]::text\[\]\) IS DISTINCT FROM decision_value/);
  assert.match(sql, /stored_record IS DISTINCT FROM \(payload_decision->'record_data'\)/);
});
test('new integrity migration leaves authorization, source interpretation and matching facts to the owner', () => {
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/g);
  assert.match(sql, /source_sha256|payload_sha256/);
  assert.doesNotMatch(sql, /INSERT INTO core\.|UPDATE core\.|DELETE FROM|CREATE ROLE|GRANT |SECURITY DEFINER|assignment_files.*UPDATE/i);
  assert.match(sql, /matching_status'\) IS DISTINCT FROM '"reviewed_separately"'/);
  assert.match(sql, /analysis_status'\) IS DISTINCT FROM '"not_evaluated"'/);
});
