import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_MAX_BYTES,
  createCustomNeighborhoodConfiguration,
  createCustomNeighborhoodApplicationRouter,
} from '../src/application/customNeighborhoodComposition.js';

// Synthetic configuration identifies a test source mix, never a provider grant.
const PROFILE = { datasetRevision: 'synthetic-dataset-1',
  providerRevisions: [{ provider_id: 'synthetic-provider', revision: 'synthetic-revision-1' }] };
const enabled = encoded => ({ CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED: 'true',
  CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_JSON: encoded });
const invalid = error => error instanceof TypeError
  && error.message === 'custom_neighborhood_configuration_invalid'
  && error.code === 'CUSTOM_NEIGHBORHOOD_CONFIGURATION_INVALID'
  && !Object.hasOwn(error, 'cause');

for (const flag of [undefined, null, '', 'false', '0', 'off', 'not-a-flag']) {
  test(`disabled flag ${String(flag)} ignores unused profile and pool`, () => {
    const environment = { CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED: flag,
      get CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_JSON() { throw new Error('must_not_read_unused_profile'); } };
    const configuration = createCustomNeighborhoodConfiguration(environment);
    assert.deepEqual(configuration, { enabled: false, sourceProfile: null });
    assert.ok(Object.isFrozen(configuration));
    const pool = { get connect() { throw new Error('must_not_touch_disabled_pool'); } };
    assert.equal(typeof createCustomNeighborhoodApplicationRouter({ pool, configuration }), 'function');
  });
}

for (const flag of ['true', ' TRUE ', '1', 'yes', 'on']) {
  test(`enabled flag ${flag} reuses environmentFlag semantics and freezes parsed profile`, () => {
    const environment = { ...enabled(JSON.stringify(PROFILE)), CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED: flag };
    const configuration = createCustomNeighborhoodConfiguration(environment);
    assert.deepEqual(configuration, { enabled: true, sourceProfile: PROFILE });
    assert.ok(Object.isFrozen(configuration)); assert.ok(Object.isFrozen(configuration.sourceProfile));
    assert.ok(Object.isFrozen(configuration.sourceProfile.providerRevisions));
    assert.ok(Object.isFrozen(configuration.sourceProfile.providerRevisions[0]));
    environment.CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_JSON = '{}';
    assert.deepEqual(configuration.sourceProfile, PROFILE);
    const pool = { connect() { throw new Error('constructor_must_not_connect'); } };
    assert.equal(typeof createCustomNeighborhoodApplicationRouter({ pool, configuration }), 'function');
  });
}

for (const encoded of [undefined, null, '', ' ', '{private-source-secret', 'null', '[]', '{}',
  JSON.stringify({ ...PROFILE, allowed: true }),
  JSON.stringify({ ...PROFILE, providerRevisions: [] }),
  JSON.stringify({ ...PROFILE, providerRevisions: [...PROFILE.providerRevisions, ...PROFILE.providerRevisions] }),
  JSON.stringify({ ...PROFILE, providerRevisions: [{ ...PROFILE.providerRevisions[0], allowed: true }] }),
  JSON.stringify({ ...PROFILE, datasetRevision: ' whitespace ' }),
  JSON.stringify({ ...PROFILE, datasetRevision: 'private\nrevision' }),
  JSON.stringify({ ...PROFILE, datasetRevision: 'a'.repeat(201) }),
]) test(`invalid enabled profile ${String(encoded).slice(0, 35)} fails with a fixed startup error`, () => {
  assert.throws(() => createCustomNeighborhoodConfiguration(enabled(encoded)), invalid);
});

test('profile bound is exact UTF-8 bytes and enforced before JSON parsing', () => {
  const json = JSON.stringify(PROFILE), limit = CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_MAX_BYTES;
  const exact = json + ' '.repeat(limit - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(exact), 16_384);
  assert.equal(createCustomNeighborhoodConfiguration(enabled(exact)).enabled, true);
  assert.throws(() => createCustomNeighborhoodConfiguration(enabled(`${exact} `)), invalid);
  const multibyte = JSON.stringify({ datasetRevision: 'synthetic', providerRevisions: Array.from({ length: 32 },
    (_, index) => ({ provider_id: `${'界'.repeat(190)}${index}`, revision: '界'.repeat(190) })) });
  assert.ok(multibyte.length < limit); assert.ok(Buffer.byteLength(multibyte) > limit);
  assert.throws(() => createCustomNeighborhoodConfiguration(enabled(multibyte)), invalid);
});

test('direct application factory cannot turn malformed configuration into an enabled router', () => {
  for (const configuration of [undefined, null, {}, { enabled: 'true', sourceProfile: PROFILE },
    { enabled: false, sourceProfile: PROFILE }, { enabled: true, sourceProfile: {} }]) {
    assert.throws(() => createCustomNeighborhoodApplicationRouter({ configuration }), invalid);
  }
  assert.throws(() => createCustomNeighborhoodConfiguration(null), invalid);
});

test('entrypoint validates once before pool/resources and mounts once after boundary and workfiles', async () => {
  const source = await readFile(new URL('../src/oldServer.js', import.meta.url), 'utf8');
  const configuration = source.indexOf('const customNeighborhoodConfiguration = createCustomNeighborhoodConfiguration(process.env);');
  const mount = source.indexOf('app.use(createCustomNeighborhoodApplicationRouter({ pool, configuration: customNeighborhoodConfiguration }));');
  assert.ok(configuration > 0 && configuration < source.indexOf('const app = express();'));
  assert.ok(configuration < source.indexOf('new pg.Pool('));
  assert.ok(configuration < source.indexOf('createApplicationStartupResources({'));
  assert.ok(mount > source.indexOf('mountApplicationRouteBoundary(app,'));
  assert.ok(mount > source.indexOf('app.use(createAssignmentWorkfileReadRouter('));
  assert.ok(mount > source.indexOf('app.use(createAssignmentWorkfileMutationRouter('));
  assert.ok(mount < source.indexOf('app.use(createGeographyOperationsRouter('));
  assert.equal(source.match(/createCustomNeighborhoodConfiguration\(process\.env\)/g)?.length, 1);
  assert.equal(source.match(/app\.use\(createCustomNeighborhoodApplicationRouter\(/g)?.length, 1);
  assert.match(source, /jsonBodyParser: express\.json\(\{ limit: "1mb" \}\)/);
  assert.match(source, /webSessionAuthenticator: createWebSessionAuthenticator\(\{ pool \}\)/);
});

test('committed environment template documents disabled/empty configuration without inventing rights', async () => {
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(template, /^# CUSTOM_NEIGHBORHOOD_WORKSPACE_ENABLED=false$/m);
  assert.match(template, /^# CUSTOM_NEIGHBORHOOD_SOURCE_PROFILE_JSON=$/m);
  assert.doesNotMatch(template, /^CUSTOM_NEIGHBORHOOD_/m);
  assert.match(template, /this flag\/profile never grants those rights/);
});
