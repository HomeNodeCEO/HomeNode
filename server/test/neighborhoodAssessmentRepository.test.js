import test from "node:test";
import assert from "node:assert/strict";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { createNeighborhoodAssessmentRepository as repository, neighborhoodMemberSetDigest as memberDigest,
  neighborhoodMemberContentDigest as memberContentDigest, prepareNeighborhoodPublication as prepare } from "../src/services/neighborhoodAssessment/assessmentRepository.js";
import { ASSESSMENT_SCOPE as SCOPE, neighborhoodAssessmentFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

// SQL-shape and orchestration tests only. This injected fake is not a PostgreSQL
// parser and cannot establish real lock, constraint, isolation or rollback behavior.
const JOB_ID = "80000000-0000-4000-8000-000000000001";
const OTHER_JOB_ID = "80000000-0000-4000-8000-000000000002";
const TOKEN = "90000000-0000-4000-8000-000000000001";
const CLAIM = { id: JOB_ID, claim_token: TOKEN, attempts: 1 };
const result = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
const scopeValues = Object.values(SCOPE);
const scopeRow = () => ({ case_date: "2024-06-30", snapshot_date: "2024-06-30", effective_date: "2024-06-30" });
function fixture() {
  const assessment = neighborhoodAssessmentFixture();
  const sources = [{ id: "fixture-source", payload: { fixture: "neighborhood-v1" } }];
  const row = (population, unit, id, accounts) => ({ population_id: population, member_unit: unit,
    member_id: id, account_ids: accounts, member_data: { source_refs: ["fixture-source"], synthetic: true } });
  const members = [
    ...["P1", "P2", "P3", "P4"].map(id => row("stock-a", "property", id, [id])),
    row("sales-a", "canonical_transaction", "T1", ["P1"]),
    row("sales-a", "canonical_transaction", "T2", ["P1"]),
    row("sales-a", "canonical_transaction", "T3", ["P2"]),
  ];
  const data = { assessment, members, sources };
  for (const population of assessment.populations) {
    const id = `population-members:${population.id}`;
    const payload = { capture_type: "neighborhood_population_members_v1", population_id: population.id,
      member_unit: population.member_unit, member_content_sha256: memberContentDigest(members.filter(row => row.population_id === population.id)) };
    sources.push({ id, payload });
    assessment.source_snapshots.push({ ...assessment.source_snapshots[0], id, content_sha256: assessmentEvidenceDigest(payload) });
    population.source_refs.push(id);
  }
  return data;
}
function fakePool(handlers = {}) {
  const calls = [];
  let connects = 0, releases = 0;
  const query = async (sql, params = []) => {
    const tag = sql.match(/\/\* neighborhood:([a-z-]+) \*\//)?.[1] ?? sql.trim();
    calls.push({ tag, sql, params: structuredClone(params) });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(tag) || tag.startsWith("SET LOCAL")) return result();
    if (Object.hasOwn(handlers, tag)) {
      return typeof handlers[tag] === "function" ? handlers[tag](params, sql, calls) : handlers[tag];
    }
    if (tag === "scope") return result([scopeRow()]);
    throw new Error(`Unexpected fake SQL tag: ${tag}`);
  };
  return { calls, get connects() { return connects; }, get releases() { return releases; }, query,
    async connect() { connects++; return { query, release() { releases++; } }; } };
}
const tags = pool => pool.calls.map(call => call.tag);
function rolledBack(pool) {
  assert.equal(tags(pool).at(-1), "ROLLBACK");
  assert.equal(tags(pool).includes("COMMIT"), false);
  assert.equal(pool.releases, pool.connects);
}
function sqlFor(pool, tag) { return pool.calls.find(call => call.tag === tag).sql; }
function assertFence(sql) {
  assert.match(sql, /id=\$1 AND claim_token=\$2 AND attempts=\$3 AND status='running' AND lease_expires_at > clock_timestamp\(\)/);
}
function publicationPool(data, overrides = {}) {
  const assessment = buildNeighborhoodAssessment(data.assessment);
  const head = { id: assessment.id, ...SCOPE, next_revision: 3, current_revision: 2,
    requested_job_id: JOB_ID, request_generation: 1 };
  const job = { id: JOB_ID, assessment_id: head.id, input_signature_sha256: assessment.input_signature_sha256,
    effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff, request_generation: 1 };
  const pool = fakePool({ "job-head": result([{ assessment_id: head.id }]), "lock-head": result([head]),
    "publication-fence": result([job]), revision: result([], 1), source: result([], 1), population: result([], 1),
    members: result([], 1), publish: result([], 1), promote: result([], 1), finish: result([], 1), ...overrides });
  return { pool, head, job };
}

test("publication batches by bytes as well as row count without truncating large valid members", async () => {
  const data = fixture();
  for (const row of data.members.filter(row => row.population_id === 'stock-a')) row.member_data.note = 'x'.repeat(400_000);
  const capture = data.sources.find(source => source.id === 'population-members:stock-a');
  capture.payload.member_content_sha256 = memberContentDigest(data.members.filter(row => row.population_id === 'stock-a'));
  data.assessment.source_snapshots.find(source => source.id === capture.id).content_sha256 = assessmentEvidenceDigest(capture.payload);
  const { pool } = publicationPool(data);
  await repository(pool).publish(CLAIM, data.assessment, data.members, data.sources);
  const batches = pool.calls.filter(call => call.tag === 'members').map(call => call.params[2]);
  assert.ok(batches.length > 1);
  assert.ok(batches.every(batch => Buffer.byteLength(batch) <= 1_500_000));
  assert.deepEqual(batches.flatMap(batch => JSON.parse(batch).map(row => row.member_id)).sort(), data.members.map(row => row.member_id).sort());
});

test("SQL object payload requirements fail before opening a transaction", async () => {
  const data = fixture();
  data.sources[0].payload = [];
  assert.throws(() => prepare(data.assessment, data.members, data.sources), /invalid_source_payload/);
  const pool = fakePool();
  const request = { effective_date: '2024-06-30', data_cutoff: '2024-06-30',
    input_signature_sha256: 'a'.repeat(64), payload: [] };
  await assert.rejects(repository(pool).enqueue(SCOPE, request), /invalid_request_payload/);
  await assert.rejects(repository(pool).heartbeat(CLAIM, { checkpoint: [] }), /invalid_checkpoint/);
  assert.equal(pool.connects, 0);
});

test("member digest is exact, deterministic and rejects duplicate/oversized identities", () => {
  const ids = ["P9", "P10", "P1", "é", "z"];
  assert.equal(memberDigest(ids), assessmentEvidenceDigest([...ids].sort()));
  assert.deepEqual(ids, ["P9", "P10", "P1", "é", "z"]);
  assert.equal(memberDigest([]), assessmentEvidenceDigest([]));
  assert.throws(() => memberDigest(["A", "A"]), /duplicate_member/);
  assert.throws(() => memberDigest(["  A"]), /invalid_member_id/);
  assert.throws(() => memberDigest(new Array(100_001)), /member_limit/);
});

test("member content capture binds data and parcel links as well as the ID set", () => {
  const data = fixture();
  const sales = data.members.filter(row => row.population_id === "sales-a");
  const before = memberContentDigest(sales);
  assert.equal(memberContentDigest([...sales].reverse()), before);
  const changed = structuredClone(sales); changed[0].member_data.recorded_price = 750_000;
  assert.notEqual(memberContentDigest(changed), before);
  assert.equal(memberDigest(changed.map(row => row.member_id)), memberDigest(sales.map(row => row.member_id)));
  data.members[4].member_data.recorded_price = 750_000;
  assert.throws(() => prepare(data.assessment, data.members, data.sources), /member_content|member_capture/);
});

test("complete population publication requires its source-bound member capture", () => {
  const data = fixture();
  const id = "population-members:sales-a";
  data.assessment.source_snapshots = data.assessment.source_snapshots.filter(source => source.id !== id);
  data.assessment.populations[1].source_refs = data.assessment.populations[1].source_refs.filter(sourceId => sourceId !== id);
  data.sources = data.sources.filter(source => source.id !== id);
  assert.throws(() => prepare(data.assessment, data.members, data.sources), /member_content|member_capture/);
});

test("publication captures exact member/source sets immutably without mutating caller data", () => {
  const data = fixture(); data.members.reverse();
  const before = canonicalAssessmentJson(data);
  const saved = prepare(data.assessment, data.members, data.sources);
  assert.equal(canonicalAssessmentJson(data), before);
  assert.deepEqual(saved.members.map(item => item.member_id), ["T1", "T2", "T3", "P1", "P2", "P3", "P4"]);
  for (const population of saved.assessment.populations) {
    const members = saved.members.filter(item => item.population_id === population.id);
    assert.equal(population.member_count, members.length);
    assert.equal(population.unique_property_count, new Set(members.flatMap(item => item.account_ids)).size);
    assert.equal(population.property_link_count, members.reduce((sum, item) => sum + item.account_ids.length, 0));
    assert.equal(population.member_set_sha256, memberDigest(members.map(item => item.member_id)));
  }
  assert.equal(saved.sources[0].snapshot.content_sha256, assessmentEvidenceDigest(saved.sources[0].payload));
  data.sources[0].payload.fixture = "changed"; data.members[0].member_data.synthetic = false;
  assert.equal(saved.sources[0].payload.fixture, "neighborhood-v1");
  assert.equal(saved.members[0].member_data.synthetic, true);
  assert.throws(() => { saved.members[0].account_ids.push("invented"); }, TypeError);
});

test("publication rejects mismatched counts, units, duplicate members/accounts and source bytes", () => {
  for (const edit of [
    data => { data.members.pop(); },
    data => { data.members[4].member_id = "different-T1"; },
    data => { data.members[4].member_id = "T2"; },
    data => { data.members[4].account_ids = ["P3"]; },
    data => { data.members[4].account_ids = ["P1", "P1"]; },
    data => { data.members[0].account_ids = ["not-P1"]; },
    data => { data.members[4].population_id = "missing"; },
    data => { data.members[4].member_unit = "property"; },
    data => { data.members[4].member_data.source_refs = []; },
    data => { data.members[4].member_data.source_refs = ["missing-source"]; },
    data => { data.sources[0].payload.fixture = "tampered"; },
    data => { data.sources.push(data.sources[0]); },
    data => { data.sources = []; },
  ]) {
    const data = fixture(); edit(data);
    assert.throws(() => prepare(data.assessment, data.members, data.sources), /neighborhood_/);
  }
});

test("every complete member needs a link; aggregate counts cannot conceal empty or overallocated members", () => {
  for (const unit of ["canonical_transaction", "allocated_property_sale", "listing"]) {
    const data = fixture();
    data.members[4].account_ids = [];
    data.members[5].account_ids = ["P1", "P2"];
    if (unit !== "canonical_transaction") {
      data.assessment.populations[1].member_unit = unit;
      data.members.filter(row => row.population_id === "sales-a").forEach(row => { row.member_unit = unit; });
      data.assessment.statistics = [data.assessment.statistics[0]];
      data.assessment.statistics[0].measurement = unit === "listing" ? "gla" : "allocated_sale_price";
      if (unit === "listing") {
        data.assessment.statistics[0].unit = "ft2";
        data.assessment.populations[1].kind = "listings";
        data.assessment.populations[1].observation_period.date_basis = "status_as_of";
      }
    }
    assert.throws(() => prepare(data.assessment, data.members, data.sources), /member_accounts/);
  }
});

test("member evidence cannot escape the owning population's declared source dependencies", () => {
  const data = fixture();
  const payload = { fixture: "undeclared-member-source" };
  data.assessment.source_snapshots.push({ ...data.assessment.source_snapshots[0], id: "extra", content_sha256: assessmentEvidenceDigest(payload) });
  data.sources.push({ id: "extra", payload });
  data.members[4].member_data.source_refs = ["extra"];
  assert.throws(() => prepare(data.assessment, data.members, data.sources), /member_sources/);
});

test("enqueue reuses one request and refuses same-signature changed payload", async () => {
  const data = fixture();
  const assessment = buildNeighborhoodAssessment(data.assessment);
  const head = { id: assessment.id, request_generation: 0 };
  let stored = null;
  const pool = fakePool({ "ensure-head": result([], 1), "head-for-scope": () => result([head]),
    deduplicate: () => result(stored ? [stored] : []),
    enqueue: values => { stored = { id: values[0], assessment_id: values[1], request_digest_sha256: values[3], request_generation: values[7] }; return result([stored]); },
    "request-pointer": values => { head.request_generation = values[1]; head.requested_job_id = values[2]; return result([], 1); } });
  const request = { effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff,
    input_signature_sha256: assessment.input_signature_sha256, payload: { radius: 3 }, max_attempts: 3 };
  const first = await repository(pool).enqueue(SCOPE, request);
  const second = await repository(pool).enqueue(SCOPE, request);
  assert.equal(first.reused, false); assert.equal(second.reused, true);
  assert.equal(first.job.id, second.job.id);
  assert.equal(pool.calls.filter(call => call.tag === "enqueue").length, 1);
  assert.equal(head.request_generation, 1);
  assert.deepEqual(pool.calls.find(call => call.tag === "scope").params, scopeValues);
  assert.match(sqlFor(pool, "head-for-scope"), /FOR UPDATE/);
  await assert.rejects(repository(pool).enqueue(SCOPE, { ...request, payload: { radius: 4 } }), /request_conflict/);
  assert.equal(tags(pool).at(-1), "ROLLBACK");
  assert.equal(pool.calls.filter(call => call.tag === "enqueue").length, 1);
  assert.equal(pool.releases, 3);
});

test("A to B to A reuses immutable A and records current intent without resetting terminal attempts", async () => {
  for (const status of ["queued", "running", "succeeded", "failed", "cancelled"]) {
    const assessment = buildNeighborhoodAssessment(fixture().assessment);
    const head = { id: assessment.id, request_generation: 0, requested_job_id: null, current_revision: null };
    const jobs = new Map();
    const pool = fakePool({ "ensure-head": result([], 1), "head-for-scope": () => result([head]),
      deduplicate: values => result(jobs.has(values[1]) ? [jobs.get(values[1])] : []),
      enqueue: values => {
        const job = { id: values[0], assessment_id: values[1], input_signature_sha256: values[2], request_digest_sha256: values[3],
          request_generation: values[7], status: "queued", attempts: 0, result_revision: null };
        jobs.set(values[2], job); return result([job]);
      },
      "request-pointer": values => { head.request_generation = values[1]; head.requested_job_id = values[2]; return result([], 1); },
      "reuse-intent": values => {
        head.request_generation = values[1]; head.requested_job_id = values[2];
        if (values[3] !== null) head.current_revision = values[3];
        return result([], 1);
      },
    });
    const repo = repository(pool);
    const requestA = { effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff,
      input_signature_sha256: assessment.input_signature_sha256, payload: { selection: "A" } };
    const requestB = { ...requestA, input_signature_sha256: assessmentEvidenceDigest({ selection: "B" }), payload: { selection: "B" } };
    const a = await repo.enqueue(SCOPE, requestA);
    a.job.status = status; a.job.attempts = 2; a.job.result_revision = status === "succeeded" ? 5 : null;
    const b = await repo.enqueue(SCOPE, requestB);
    assert.notEqual(a.job.id, b.job.id);
    head.current_revision = 6; // A separately published B currently remains visible.
    const reused = await repo.enqueue(SCOPE, requestA);
    assert.equal(reused.reused, true); assert.equal(reused.job.id, a.job.id);
    assert.equal(reused.job.request_generation, 1);
    assert.equal(reused.job.status, status); assert.equal(reused.job.attempts, 2);
    assert.equal(head.request_generation, 3); assert.equal(head.requested_job_id, a.job.id);
    assert.equal(head.current_revision, status === "succeeded" ? 5 : 6);
    assert.equal(pool.calls.filter(call => call.tag === "enqueue").length, 2);
    assert.equal(pool.calls.filter(call => call.tag === "reuse-intent").length, 1);
    assert.match(sqlFor(pool, "reuse-intent"), /current_revision=CASE WHEN \$4::integer IS NOT NULL THEN \$4 ELSE current_revision END/);
  }
});

test("scope/effective-date failures stop enqueue before any data write", async () => {
  const assessment = buildNeighborhoodAssessment(fixture().assessment);
  const request = { effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff,
    input_signature_sha256: assessment.input_signature_sha256, payload: {} };
  for (const row of [null, { ...scopeRow(), snapshot_date: "2024-05-30" },
    { ...scopeRow(), effective_date: "2023-06-30" }, { case_date: null, snapshot_date: null, effective_date: null }]) {
    const pool = fakePool({ scope: result(row ? [row] : []) });
    await assert.rejects(repository(pool).enqueue(SCOPE, request), /scope_mismatch|effective_date_/);
    assert.equal(tags(pool).includes("ensure-head"), false);
    rolledBack(pool);
  }
  const invalid = fakePool();
  await assert.rejects(repository(invalid).enqueue({ ...SCOPE, organization_id: "not-a-uuid" }, request), /invalid_organization_id/);
  assert.equal(invalid.connects, 0);
});

test("claim SQL is bounded, fresh-clock based, skip-locked and issues a new claim token", async () => {
  const pool = fakePool({ exhausted: result([], 0), claim: result([{ ...CLAIM }]) });
  const claimed = await repository(pool).claim({ limit: 4, lease_seconds: 45 });
  assert.equal(claimed.length, 1);
  for (const tag of ["claim", "exhausted"]) {
    assert.match(sqlFor(pool, tag), /LIMIT \$1 FOR UPDATE SKIP LOCKED/);
    assert.match(sqlFor(pool, tag), /clock_timestamp\(\)/);
    assert.doesNotMatch(sqlFor(pool, tag), /\bnow\(\)|CURRENT_TIMESTAMP/i);
  }
  assert.match(sqlFor(pool, "claim"), /attempts<max_attempts/);
  assert.match(sqlFor(pool, "claim"), /claim_token=gen_random_uuid\(\)/);
  assert.match(sqlFor(pool, "claim"), /attempts=attempts\+1/);
  assert.deepEqual(pool.calls.find(call => call.tag === "claim").params, [4, 45]);
  assert.equal(tags(pool).at(-1), "COMMIT");
  for (const options of [{ limit: 0 }, { limit: 11 }, { lease_seconds: 901 }, { lease_seconds: 14 }]) {
    const invalid = fakePool(); await assert.rejects(repository(invalid).claim(options), /invalid_/); assert.equal(invalid.connects, 0);
  }
});

test("heartbeat and failure updates require exact fresh fences and roll back a lost lease", async () => {
  for (const operation of ["heartbeat", "fail"]) {
    const tag = operation === "heartbeat" ? "heartbeat" : "failure";
    const success = fakePool({ [tag]: result([{ id: JOB_ID }], 1) });
    if (operation === "heartbeat") await repository(success).heartbeat(CLAIM, { checkpoint: { cursor: "T2" }, lease_seconds: 60 });
    else await repository(success).fail(CLAIM, "source_missing", { retry_seconds: 25 });
    assertFence(sqlFor(success, tag));
    assert.deepEqual(success.calls.find(call => call.tag === tag).params.slice(0, 3), [JOB_ID, TOKEN, 1]);
    assert.equal(tags(success).at(-1), "COMMIT");
    if (operation === "fail") assert.match(sqlFor(success, tag), /CASE WHEN attempts<max_attempts THEN 'retry' ELSE 'failed' END/);
    const lost = fakePool({ [tag]: result([], 0) });
    await assert.rejects(operation === "heartbeat" ? repository(lost).heartbeat(CLAIM) : repository(lost).fail(CLAIM, "source_missing"), /claim_lost/);
    rolledBack(lost);
  }
});

test("transaction cleanup releases its client even when rollback itself fails", async () => {
  const pool = fakePool({ heartbeat: () => { throw new Error("synthetic storage failure"); } });
  const originalConnect = pool.connect;
  pool.connect = async () => {
    const client = await originalConnect();
    const query = client.query;
    client.query = async (sql, params) => { if (sql === "ROLLBACK") throw new Error("synthetic rollback failure"); return query(sql, params); };
    return client;
  };
  await assert.rejects(repository(pool).heartbeat(CLAIM), /synthetic storage failure/);
  assert.equal(pool.releases, 1);
});

test("stale publication lease fails before any revision/member/source write", async () => {
  const data = fixture();
  const { pool } = publicationPool(data, { "publication-fence": result([], 0) });
  await assert.rejects(repository(pool).publish(CLAIM, data.assessment, data.members, data.sources), /claim_lost/);
  assertFence(sqlFor(pool, "publication-fence"));
  assert.equal(tags(pool).includes("revision"), false);
  rolledBack(pool);
});

test("publication verifies head scope and exact request inputs before writing", async () => {
  for (const change of ["scope", "signature", "cutoff", "date"]) {
    const data = fixture(); const { pool, head, job } = publicationPool(data);
    if (change === "scope") head.organization_id = "10000000-0000-4000-8000-000000000009";
    if (change === "signature") job.input_signature_sha256 = "0".repeat(64);
    if (change === "cutoff") job.data_cutoff = "2024-06-29";
    if (change === "date") job.effective_date = "2024-06-29";
    await assert.rejects(repository(pool).publish(CLAIM, data.assessment, data.members, data.sources), /scope_mismatch|job_input_mismatch/);
    assert.equal(tags(pool).includes("revision"), false);
    rolledBack(pool);
  }
});

test("publication writes captured revision/members atomically and checks the fence again before commit", async () => {
  const data = fixture(); const { pool } = publicationPool(data);
  const saved = await repository(pool).publish(CLAIM, data.assessment, data.members, data.sources);
  assert.equal(saved.promoted, true); assert.equal(saved.assessment.revision, 3);
  const sequence = tags(pool);
  assert.ok(sequence.indexOf("publication-fence") < sequence.indexOf("revision"));
  assert.ok(sequence.indexOf("members") < sequence.indexOf("publish"));
  assert.ok(sequence.indexOf("promote") < sequence.indexOf("finish"));
  assert.equal(sequence.at(-1), "COMMIT");
  assertFence(sqlFor(pool, "finish"));
  const memberInsert = pool.calls.find(call => call.tag === "members");
  assert.equal(JSON.parse(memberInsert.params[2]).length, 7);
  assert.equal(pool.calls.filter(call => call.tag === "population").length, 2);
  const persisted = JSON.parse(pool.calls.find(call => call.tag === "revision").params[4]);
  assert.equal(persisted.evidence_digest_sha256, saved.assessment.evidence_digest_sha256);
  assert.match(sqlFor(pool, "revision"), /'staging'/);
  assert.match(sqlFor(pool, "publish"), /publication_status='staging'/);
  assert.ok(sequence.some(tag => tag === "SET LOCAL statement_timeout = '8s'"));
  assert.ok(sequence.some(tag => tag === "SET LOCAL lock_timeout = '3s'"));
});

test("lost final fence or failed staging promotion issues rollback, never commit", async () => {
  for (const failedTag of ["publish", "promote", "finish"]) {
    const data = fixture(); const { pool } = publicationPool(data, { [failedTag]: result([], 0) });
    await assert.rejects(repository(pool).publish(CLAIM, data.assessment, data.members, data.sources), /publication_conflict|claim_lost/);
    assert.equal(tags(pool).includes("revision"), true);
    rolledBack(pool);
  }
});

test("out-of-order job may publish historical evidence but cannot promote current result", async () => {
  const data = fixture(); const { pool, head } = publicationPool(data);
  head.requested_job_id = OTHER_JOB_ID; head.request_generation = 2;
  const saved = await repository(pool).publish(CLAIM, data.assessment, data.members, data.sources);
  assert.equal(saved.promoted, false);
  const sql = sqlFor(pool, "promote");
  assert.match(sql, /current_revision=CASE WHEN requested_job_id=\$3 THEN \$4 ELSE current_revision END/);
  assert.match(sql, /WHERE id=\$1 AND next_revision=\$4/);
  assert.equal(tags(pool).at(-1), "COMMIT");
});

test("reselected A can promote despite its old immutable job generation", async () => {
  const data = fixture(); const { pool, head, job } = publicationPool(data);
  head.requested_job_id = job.id; head.request_generation = 3; job.request_generation = 1;
  const saved = await repository(pool).publish(CLAIM, data.assessment, data.members, data.sources);
  assert.equal(saved.promoted, true);
  assert.equal(tags(pool).at(-1), "COMMIT");
});

test("retrieval performs scoped SELECTs only and uses bounded code-unit keyset pagination", async () => {
  const pool = fakePool({ current: result([{ assessment: { id: "cached" } }]), "job-status": result([{ id: JOB_ID, status: "queued" }]),
    "member-page": result([{ member_id: "T1" }, { member_id: "T10" }, { member_id: "T2" }]) });
  const repo = repository(pool);
  assert.deepEqual(await repo.getCurrent(SCOPE), { id: "cached" });
  assert.equal((await repo.getJob(SCOPE, JOB_ID)).status, "queued");
  const page = await repo.getMembers(SCOPE, { assessment_id: fixture().assessment.id, revision: 1, population_id: "sales-a", after: "T0", limit: 2 });
  assert.deepEqual(page.members.map(item => item.member_id), ["T1", "T10"]);
  assert.equal(page.next_cursor, "T10");
  for (const call of pool.calls.filter(item => item.sql.includes("/* neighborhood:"))) {
    assert.match(call.sql.replace(/\/\*.*?\*\//s, "").trim(), /^SELECT/i);
    assert.doesNotMatch(call.sql, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b/i);
    assert.deepEqual(call.params.slice(0, 4), scopeValues);
  }
  const memberSql = sqlFor(pool, "member-page");
  assert.match(memberSql, /publication_status='published'/);
  assert.match(memberSql, /m\.member_id COLLATE "C">\$8 COLLATE "C"/);
  assert.match(memberSql, /ORDER BY m\.member_id COLLATE "C" LIMIT \$9/);
  assert.doesNotMatch(memberSql, /OFFSET/i);
  assert.equal(pool.calls.find(call => call.tag === "member-page").params.at(-1), 3);
  assert.doesNotMatch(sqlFor(pool, "job-status").split("FROM")[0], /claim_token|request_payload|checkpoint/);
  assert.equal(pool.releases, 3);
});

test("missing reads remain null/empty without enqueue and invalid pagination never opens a client", async () => {
  const pool = fakePool({ current: result(), "job-status": result(), "member-page": result() });
  const repo = repository(pool);
  assert.equal(await repo.getCurrent(SCOPE), null);
  assert.equal(await repo.getJob(SCOPE, JOB_ID), null);
  const args = { assessment_id: fixture().assessment.id, revision: 1, population_id: "sales-a" };
  assert.deepEqual(await repo.getMembers(SCOPE, args), { members: [], next_cursor: null });
  assert.equal(tags(pool).includes("enqueue"), false);
  for (const edit of [{ limit: 0 }, { limit: 501 }, { revision: 0 }, { after: "bad\nvalue" }]) {
    const invalid = fakePool(); await assert.rejects(repository(invalid).getMembers(SCOPE, { ...args, ...edit }), /invalid_/);
    assert.equal(invalid.connects, 0);
  }
});
