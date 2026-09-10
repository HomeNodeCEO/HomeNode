import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { reportedObservationAssessmentFixture } from './fixtures/reportedObservationAssessmentFixture.js';
import { buildNeighborhoodAssessment, buildNeighborhoodAttachment } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodPublication } from '../src/services/neighborhoodAssessment/assessmentRepository.js';

const previous = (await readFile(new URL('../migrations/20261010_neighborhood_assessment_persistence.sql', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const sql = await readFile(new URL('../migrations/20261017_neighborhood_reported_observations.sql', import.meta.url), 'utf8');
const body = (text, name) => {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION app.${name}(`);
  assert.ok(start >= 0); return text.slice(start, text.indexOf('END $$;', start) + 7);
};

test('v2 migration keeps original released migration bytes and registration order', async () => {
  assert.equal(createHash('sha256').update(previous).digest('hex'), '8b3a35e6690a02be308928e2376aa8fb47f51b5ead7fe4b8e629d8bd5e6ce2b6');
  const registry = await readFile(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.equal(registry.match(/"20261017_neighborhood_reported_observations.sql"/g)?.length, 1);
  assert.ok(registry.indexOf('20261017_neighborhood_reported_observations.sql') > registry.indexOf('20261016_assignment_sales_csv_reviews.sql'));
});

test('additive SQL changes no table layout, indexes, triggers, source data or authority', () => {
  assert.doesNotMatch(sql, /CREATE TABLE|CREATE INDEX|CREATE TRIGGER|DROP TRIGGER|ADD COLUMN|SECURITY DEFINER|CREATE EXTENSION/i);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK);/m);
  assert.doesNotMatch(sql, /UPDATE\s+(core\.|gis\.|app_auth\.)|DELETE\s+FROM|TRUNCATE|DROP TABLE/i);
  const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION app\.([a-z_]+)/g)].map(value => value[1]);
  assert.deepEqual(functions, ['neighborhood_observation_count', 'neighborhood_valid_member_accounts',
    'neighborhood_guard_revision_child', 'neighborhood_guard_revision', 'neighborhood_guard_attachment']);
});

test('only changed-column constraints are wrapped using exact original catalog predicates', () => {
  assert.match(sql, /pg_get_expr\(c\.conbin,c\.conrelid\)/);
  assert.match(sql, /a\.attnum=ANY\(c\.conkey\)/);
  assert.match(sql, /a\.attname IN \('member_unit','unique_property_count','property_link_count'\)/);
  assert.match(sql, /affected_count <> 11/);
  assert.match(sql, /member_unit IN \(''account'',''source_record''\) OR \(%s\)/);
  assert.match(sql, /IF NOT EXISTS[^]*conname='neighborhood_observation_population_v2_check'/);
  assert.equal(sql.match(/ADD CONSTRAINT neighborhood_observation_population_v2_check/g)?.length, 1);
});

test('v2 population CHECK enforces null property columns, exact account units and safe counters', () => {
  for (const value of ["unique_property_count IS NULL AND property_link_count IS NULL",
    "NOT (population ?| ARRAY['unique_property_count','property_link_count'])",
    "population->>'member_unit' IS NOT DISTINCT FROM member_unit", "population->>'kind'='account_observations'",
    "population->>'kind'='source_record_observations'", "population->>'provider_coverage'='not_established'",
    "population->>'completeness_basis'='complete_retained_roster'", "least(1000::numeric*member_count,250000::numeric)", '9007199254740991']) {
    assert.ok(sql.includes(value), value);
  }
  assert.match(sql, /app\.neighborhood_observation_count\(population->'unique_account_count'\)/);
  assert.match(sql, /app\.neighborhood_observation_count\(population->'account_link_count'\)/);
  assert.match(sql, /\) IS TRUE\s+\);/);
});

test('child guard preserves source visibility/immutability and reads member-only fields in a member-only block', () => {
  const child = body(sql, 'neighborhood_guard_revision_child');
  assert.match(child, /parent_assessment->'contract_version' = '2'::jsonb/);
  assert.match(child, /NEW\.member_unit IN \('account', 'source_record'\)/);
  assert.match(child, /IF TG_TABLE_NAME = 'neighborhood_assessment_members' THEN\s+IF NEW\.member_unit = 'account' AND NEW\.account_ids IS DISTINCT FROM ARRAY\[NEW\.member_id\]/);
  for (const fragment of ['neighborhood_child_revision_immutable', 'neighborhood_published_child_immutable',
    'neighborhood_private_source_scope_mismatch', "snapshot_scope := NEW.source_snapshot->'scope'", 'FOR SHARE']) {
    assert.ok(child.includes(fragment));
  }
  const normalized = child.replace(' parent_assessment jsonb;', '')
    .replaceAll('SELECT publication_status, assessment INTO parent_status, parent_assessment', 'SELECT publication_status INTO parent_status')
    .replace(/  -- V2-only observation units[^]*?(?=  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME = 'neighborhood_assessment_sources')/, '');
  assert.equal(normalized, body(previous, 'neighborhood_guard_revision_child'));
});

test('publication guard preserves every original v1 check and adds exact v2 reconciliation', () => {
  const guard = body(sql, 'neighborhood_guard_revision');
  assert.match(guard, /methodology,configuration,profile_id.*custom-reported-observations-v2/);
  assert.match(guard, /population_row\.population->>'unique_account_count'\)::bigint IS DISTINCT FROM properties/);
  assert.match(guard, /population_row\.population->>'account_link_count'\)::bigint IS DISTINCT FROM links/);
  const normalized = guard.replace(/  IF \(NEW\.assessment->'contract_version' IN[^]*?(?=  SELECT \* INTO STRICT head)/, '')
    .replace(/    IF NEW\.assessment->'contract_version' = '2'::jsonb THEN[^]*?    END IF;\n(?=  END LOOP;)/, '');
  assert.equal(normalized, body(previous, 'neighborhood_guard_revision'));
});

test('attachment retains all old target/scope/manifest/anchor logic and adds referenced-assessment Custom-only gate', () => {
  const guard = body(sql, 'neighborhood_guard_attachment');
  assert.match(guard, /revision_row\.assessment->'contract_version' = '2'::jsonb AND NEW\.workflow_type <> 'custom_appraisal'/);
  const normalized = guard.replace(/  IF revision_row\.assessment->'contract_version' = '2'::jsonb[^]*?  END IF;\n/, '');
  assert.equal(normalized, body(previous, 'neighborhood_guard_attachment'));
});

test('actual new fixture prepares v2 publication and Custom attachment without reusing v1 identities/units', () => {
  const fixture = reportedObservationAssessmentFixture();
  const assessment = buildNeighborhoodAssessment(fixture.input);
  const prepared = prepareNeighborhoodPublication(assessment, fixture.members, fixture.sources);
  assert.equal(assessment.contract_version, 2); assert.equal(assessment.application_group.status, 'ready');
  assert.equal(prepared.members.length, 3);
  assert.deepEqual(prepared.members.filter(value => value.member_unit === 'source_record')[0].account_ids,
    ['SYNTHETIC-P1', 'SYNTHETIC-P2']);
  assert.equal(buildNeighborhoodAttachment(assessment, fixture.target).workflow_type, 'custom_appraisal');
  assert.throws(() => buildNeighborhoodAttachment(assessment, { ...fixture.target, workflow_type: 'uad_3_6' }), /custom_only/);
});

test('native helper and wrapper are import-safe and preserve ordinary disposable database guards', async () => {
  const helper = await import('./helpers/neighborhoodReportedObservationDatabaseChecks.js');
  assert.equal(typeof helper.checkReportedObservationDatabase, 'function');
  const wrapper = await readFile(new URL('./neighborhoodPersistence.integration.test.js', import.meta.url), 'utf8');
  assert.match(wrapper, /const target = await prepareNeighborhoodCiDatabase\(\)/);
  assert.match(wrapper, /databaseName: target\.databaseName/);
  assert.match(wrapper, /await pool\.query\(sql\); await pool\.query\(sql\)/);
  assert.match(wrapper, /await pool\.query\(observationSql\); await pool\.query\(observationSql\)/);
});
