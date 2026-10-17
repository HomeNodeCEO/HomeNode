import assert from "node:assert/strict";
import test from "node:test";

import { ensureAccountQualitySchema, resolveCanonicalAccountId } from "../src/services/accountQuality.js";

test('ready account-quality schema uses one fresh catalog read without requesting DDL locks', async () => {
  const calls = [];
  const pool = { async query(sql) { calls.push(sql); return { rows: [{ ready: true }] }; } };
  await ensureAccountQualitySchema(pool);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /account-quality:schema-ready/);
  assert.doesNotMatch(calls[0], /\b(?:ALTER|CREATE|UPDATE|DELETE|INSERT|LOCK)\b/);
  await ensureAccountQualitySchema(pool);
  assert.equal(calls.length, 2, 'readiness is never cached across startup attempts');
});

test('missing schema retains existing DDL and verifies the resulting catalog before readiness', async () => {
  const calls = [];
  const pool = { async query(sql) {
    calls.push(sql);
    return { rows: sql.includes('account-quality:schema-ready') ? [{ ready: calls.length > 1 }] : [] };
  } };
  await ensureAccountQualitySchema(pool);
  assert.equal(calls.length, 3);
  assert.match(calls[1], /ALTER TABLE core\.accounts[\s\S]*CREATE TABLE IF NOT EXISTS app\.dcad_account_reconciliations/);
  assert.match(calls[1], /CREATE INDEX IF NOT EXISTS accounts_canonical_account_idx/);
  assert.equal(calls[0], calls[2]);
});

test('unrepaired catalog drift cannot mark required account-quality initialization ready', async () => {
  const calls = [];
  await assert.rejects(ensureAccountQualitySchema({ async query(sql) {
    calls.push(sql); return { rows: sql.includes('account-quality:schema-ready') ? [{ ready: false }] : [] };
  } }), /account_quality_schema_unavailable/);
  assert.equal(calls.length, 3);
});

test('probe or DDL failures propagate without bypass, blind retry, or widened deadlines', async () => {
  for (const response of [{ rows: [] }, { rows: [{ ready: null }] }, { rows: [{ ready: 'true' }] }]) {
    let calls = 0;
    await assert.rejects(ensureAccountQualitySchema({ async query() { calls++; return response; } }), /probe_invalid/);
    assert.equal(calls, 1);
  }
  const probeFailure = new Error('catalog unavailable');
  await assert.rejects(ensureAccountQualitySchema({ async query() { throw probeFailure; } }), error => error === probeFailure);
  const ddlFailure = Object.assign(new Error('lock timeout'), { code: '55P03' });
  let calls = 0;
  await assert.rejects(ensureAccountQualitySchema({ async query() {
    if (++calls === 1) return { rows: [{ ready: false }] };
    throw ddlFailure;
  } }), error => error === ddlFailure);
  assert.equal(calls, 2);
});


test("resolveCanonicalAccountId follows a legacy alias", async () => {
  const aliases = new Map([
    ["28208500000000000", "28208500120070000"],
    ["28208500120070000", null],
  ]);
  const pool = {
    async query(_sql, params) {
      return { rows: [{ canonical_account_id: aliases.get(params[0]) || null }] };
    },
  };

  assert.equal(
    await resolveCanonicalAccountId(pool, "28208500000000000"),
    "28208500120070000",
  );
});

test("resolveCanonicalAccountId stops safely on an alias cycle", async () => {
  const aliases = new Map([
    ["AAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBB"],
    ["BBBBBBBBBBBBBBBBB", "AAAAAAAAAAAAAAAAA"],
  ]);
  const pool = {
    async query(_sql, params) {
      return { rows: [{ canonical_account_id: aliases.get(params[0]) || null }] };
    },
  };

  assert.equal(
    await resolveCanonicalAccountId(pool, "AAAAAAAAAAAAAAAAA"),
    "AAAAAAAAAAAAAAAAA",
  );
});
