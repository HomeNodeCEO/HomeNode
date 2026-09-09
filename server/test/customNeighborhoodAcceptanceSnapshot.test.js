import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildNeighborhoodAssessment, buildNeighborhoodAttachment } from "../src/services/neighborhoodAssessment/contract.js";
import { buildNeighborhoodApplicationReceipt, neighborhoodMappedManifestDigest,
  prepareNeighborhoodApplicationGroup } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION, prepareCustomNeighborhoodAcceptanceSnapshot,
  reconstructCustomNeighborhoodAcceptanceSnapshot } from "../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

const OPERATION_ID = "abcdef01-0000-4000-8000-000000000001";
const ACTOR_ID = "abcdef02-0000-4000-8000-000000000002";
const clone = value => structuredClone(value);

// Deliberately independent of the production canonicalizer/digest helper.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const digest = value => createHash("sha256").update(canonical(value), "utf8").digest("hex");

test("closed decisions reconstruct the unchanged shared receipt without persisted digest claims", () => {
  const input = fixture({ reused: ["source"] });
  const expected = prepareCustomNeighborhoodAcceptanceSnapshot(input);
  const { receipt: _receipt, ...context } = input;
  const restore = { ...context, acceptedEditorRevision: input.receipt.accepted_editor_revision,
    decision: clone(expected.section_value.decision) };
  assert.deepEqual(reconstructCustomNeighborhoodAcceptanceSnapshot(restore), expected);
  assert.deepEqual(expected.receipt, input.receipt);
  for (const mutate of [
    value => { value.decision.receipt_digest_sha256 = "a".repeat(64); },
    value => { value.decision.reused.boundary = true; },
    value => { value.decision.applied.boundary = false; },
    value => { delete value.decision.applied.boundary; },
    value => { value.decision.applied.unknown = true; },
    value => { value.decision.applied = []; },
    value => { value.decision.applied = {}; value.decision.reused = { boundary: true, median: true, source: true }; },
  ]) {
    const changed = clone(restore); mutate(changed);
    assert.throws(() => reconstructCustomNeighborhoodAcceptanceSnapshot(changed), /decision/);
  }
});

function fixture({ reused = [], workflow = "custom_appraisal", editorRevision = 5 } = {}) {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const group = assessment.application_group;
  const mappedSuggestions = [
    { id: "boundary", target_key: "synthetic:boundary", value: "North Road", dependency_ids: ["source"],
      evidence_refs: ["geographic_neighborhood", "population:stock-a"], application_group_id: group.id },
    { id: "median", target_key: "synthetic:median", value: 330000, dependency_ids: ["boundary", "source"],
      evidence_refs: ["statistic:median-sale-price", "population:sales-a"], application_group_id: group.id },
    { id: "source", target_key: "synthetic:market-source", value: "fixture-source", dependency_ids: [],
      evidence_refs: ["source:fixture-source"], application_group_id: group.id },
  ];
  const attachment = buildNeighborhoodAttachment(assessment, {
    ...neighborhoodTargetFixture(workflow), editor_revision: editorRevision,
    mapped_manifest_sha256: neighborhoodMappedManifestDigest(mappedSuggestions),
  });
  const preflight = {
    attachment, group, suggestions: mappedSuggestions,
    expected_binding_digest: attachment.binding_digest_sha256,
    current_application_identity_sha256: attachment.application_identity_sha256,
    current_editor_revision: attachment.editor_revision,
    selected_ids: mappedSuggestions.map(item => item.id),
    existing_values: mappedSuggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    // Synthetic targets exercise shared representation closure, not a real Custom catalog or save.
    validate_final_group: () => ({ valid: true, issues: [] }),
  };
  let plan = prepareNeighborhoodApplicationGroup(preflight);
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  if (reused.length) {
    preflight.existing_values = mappedSuggestions.map(item => reused.includes(item.id)
      ? { target_key: item.target_key, target_exists: true, populated: true, value: item.value,
        provenance_digest: plan.acceptance_manifest.provenance_digest }
      : { target_key: item.target_key, target_exists: true, populated: false });
    plan = prepareNeighborhoodApplicationGroup(preflight);
    assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  }
  return clone({ operationId: OPERATION_ID, actorUserId: ACTOR_ID, assessment, attachment, mappedSuggestions,
    receipt: buildNeighborhoodApplicationReceipt(plan, attachment.editor_revision + 1) });
}

function resignReceipt(input) {
  const { receipt_digest_sha256: _discarded, ...body } = input.receipt;
  input.receipt.receipt_digest_sha256 = digest(body);
}

function assertDeepFrozen(value) {
  if (value && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(assertDeepFrozen);
  }
}

function assertIndependent(output, input) {
  const inputs = new Set();
  const collect = value => {
    if (value && typeof value === "object") {
      inputs.add(value);
      Object.values(value).forEach(collect);
    }
  };
  collect(input);
  const check = value => {
    if (value && typeof value === "object") {
      assert.ok(!inputs.has(value), "output aliases caller-owned data");
      Object.values(value).forEach(check);
    }
  };
  check(output);
}

for (const reused of [[], ["source"], ["boundary", "source"]]) {
  test(`complete coherent group produces exact closed snapshot (${reused.length} reused)`, () => {
    const input = fixture({ reused });
    const before = clone(input);
    const result = prepareCustomNeighborhoodAcceptanceSnapshot(input);
    const section = {
      schema_version: 1, operation_id: OPERATION_ID, actor_user_id: ACTOR_ID,
      attachment_id: input.attachment.attachment_id, attachment_revision: input.attachment.attachment_revision,
      application_identity_sha256: input.attachment.application_identity_sha256,
      accepted_editor_revision: input.receipt.accepted_editor_revision,
      decision: { applied: Object.fromEntries(input.receipt.acceptance_manifest.applied.map(item => [item.id, true])),
        reused: Object.fromEntries(input.receipt.acceptance_manifest.reused.map(item => [item.id, true])) },
      mapped_values: Object.fromEntries(input.mappedSuggestions.map(({ id, target_key, value }) => [id, { target_key, value }])),
    };
    assert.equal(CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION, "neighborhood_assessment");
    assert.deepEqual(result, { section_key: "neighborhood_assessment", section_value: section,
      section_value_sha256: digest(section), receipt: input.receipt });
    assert.deepEqual(result.receipt.acceptance_manifest.reused.map(item => item.id).sort(), reused.slice().sort());
    assert.equal(result.receipt.acceptance_manifest.applied.length, 3 - reused.length);
    assert.equal(Object.hasOwn(result.section_value, "receipt"), false);
    assert.deepEqual(input, before, "preparation must not mutate the caller input");
    assertDeepFrozen(result);
    assertIndependent(result, input);
    const expectedSection = clone(result.section_value);
    assert.throws(() => { result.section_value.mapped_values.boundary.value = "changed"; }, TypeError);
    input.receipt.acceptance_manifest.applied[0].value = "caller changed";
    input.mappedSuggestions[0].value = "caller changed";
    assert.deepEqual(result.section_value, expectedSection);
    assert.equal(result.section_value_sha256, digest(result.section_value));
  });
}

test("suggestion ordering and object key insertion order do not change snapshot identity", () => {
  const input = fixture();
  const expected = prepareCustomNeighborhoodAcceptanceSnapshot(input);
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
  const reordered = reverseKeys(input);
  reordered.mappedSuggestions.reverse();
  assert.deepEqual(prepareCustomNeighborhoodAcceptanceSnapshot(reordered), expected);
});

test("actor and operation UUIDs normalize case and each participates in section identity", () => {
  const input = fixture();
  const initial = prepareCustomNeighborhoodAcceptanceSnapshot(input);
  assert.deepEqual(prepareCustomNeighborhoodAcceptanceSnapshot({ ...input,
    actorUserId: ACTOR_ID.toUpperCase(), operationId: OPERATION_ID.toUpperCase() }), initial);
  for (const key of ["actorUserId", "operationId"]) {
    const result = prepareCustomNeighborhoodAcceptanceSnapshot({ ...input, [key]: "abcdef03-0000-4000-8000-000000000003" });
    assert.notEqual(result.section_value_sha256, initial.section_value_sha256);
    assert.equal(result.section_value[key === "actorUserId" ? "actor_user_id" : "operation_id"], "abcdef03-0000-4000-8000-000000000003");
  }
});

for (const key of ["actorUserId", "operationId"]) {
  for (const value of [null, "", "not-a-uuid", "00000000-0000-0000-0000-000000000000", 1, {}]) {
    test(`rejects invalid ${key}: ${JSON.stringify(value)}`, () => {
      const input = fixture();
      input[key] = value;
      assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(input), TypeError);
    });
  }
}

test("a coherent UAD group cannot become a Custom accepted section", () => {
  assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(fixture({ workflow: "uad_3_6" })),
    { code: "custom_neighborhood_acceptance_custom_target_required" });
});

const mutations = {
  "changed assessment statistic": input => { input.assessment.statistics[0].value = 999999; },
  "changed attachment revision": input => { input.attachment.attachment_revision += 1; },
  "changed attachment editor revision": input => { input.attachment.editor_revision += 1; },
  "changed attachment binding": input => { input.attachment.binding_digest_sha256 = "0".repeat(64); },
  "changed mapped value": input => { input.mappedSuggestions[0].value = "South Road"; },
  "changed mapped target": input => { input.mappedSuggestions[0].target_key = "synthetic:other"; },
  "changed mapped dependencies": input => { input.mappedSuggestions[1].dependency_ids = []; },
  "changed mapped evidence": input => { input.mappedSuggestions[0].evidence_refs = []; },
  "wrong application group": input => { input.mappedSuggestions[0].application_group_id = "other"; },
  "missing mapped member": input => { input.mappedSuggestions.pop(); },
  "extra mapped member": input => { input.mappedSuggestions.push({ ...input.mappedSuggestions[0], id: "extra", target_key: "synthetic:extra" }); },
  "duplicate mapped member": input => { input.mappedSuggestions.push(clone(input.mappedSuggestions[0])); },
  "empty mapped group": input => { input.mappedSuggestions = []; },
  "null mapped member": input => { input.mappedSuggestions[0] = null; },
  "missing mapped id": input => { delete input.mappedSuggestions[0].id; },
  "changed receipt digest": input => { input.receipt.receipt_digest_sha256 = "0".repeat(64); },
  "changed receipt revision without new digest": input => { input.receipt.accepted_editor_revision += 1; },
  "null receipt": input => { input.receipt = null; },
  "missing acceptance manifest": input => { delete input.receipt.acceptance_manifest; },
  "invalid receipt partition type": input => { input.receipt.acceptance_manifest.reused = {}; },
  "unknown input field": input => { input.extra = true; },
  "unknown assessment field": input => { input.assessment.extra = true; },
  "unknown attachment field": input => { input.attachment.extra = true; },
  "unknown suggestion field": input => { input.mappedSuggestions[0].extra = true; },
  "unknown receipt field": input => { input.receipt.extra = true; resignReceipt(input); },
  "unknown manifest field": input => { input.receipt.acceptance_manifest.extra = true; resignReceipt(input); },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(input), TypeError);
  });
}

for (const revision of [4, 5, 7, -1, 5.5, "6", null, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects stale, nonadvancing or malformed accepted revision ${revision} even with recomputed receipt digest`, () => {
    const input = fixture();
    input.receipt.accepted_editor_revision = revision;
    resignReceipt(input);
    assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(input), TypeError);
  });
}

test("Custom accepted revisions cover zero-based first save and the PostgreSQL integer ceiling", () => {
  for (const editorRevision of [0, 2_147_483_646]) {
    const input = fixture({ editorRevision });
    const saved = prepareCustomNeighborhoodAcceptanceSnapshot(input);
    assert.equal(saved.section_value.accepted_editor_revision, editorRevision + 1);
  }
  const exhausted = fixture({ editorRevision: 2_147_483_647 });
  assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(exhausted),
    error => error.code === "custom_neighborhood_acceptance_invalid_accepted_revision");
});

const partitionForgeries = {
  "duplicate applied member": manifest => { manifest.applied.push(clone(manifest.applied[0])); },
  "member in both partitions": manifest => { manifest.reused.push(clone(manifest.applied[0])); },
  "missing partition member": manifest => { manifest.applied.pop(); },
  "extra reused member": manifest => { manifest.reused.push({ id: "extra", target_key: "synthetic:extra", value: 1 }); },
  "forged reused value": manifest => { manifest.reused[0].value = "forged"; },
  "forged provenance": manifest => { manifest.provenance_digest = "0".repeat(64); },
  "unknown partition member field": manifest => { manifest.applied[0].extra = true; },
};
for (const [name, forge] of Object.entries(partitionForgeries)) {
  test(`rejects receipt-partition forgery: ${name}, despite recomputed receipt digest`, () => {
    const input = fixture({ reused: ["source"] });
    forge(input.receipt.acceptance_manifest);
    resignReceipt(input);
    assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(input), TypeError);
  });
}

for (const value of [null, undefined, [], true, 42, "input"]) {
  test(`rejects non-object input ${String(value)}`, () => {
    assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(value), TypeError);
  });
}

const invalidJsonValues = {
  undefined: () => undefined, nan: () => NaN, infinity: () => Infinity, bigint: () => 1n,
  symbol: () => Symbol("x"), function: () => () => 1, date: () => new Date(0), map: () => new Map(),
  circular: () => { const value = {}; value.self = value; return value; },
  "sparse array": () => new Array(2),
  "oversized UTF-8 string": () => "é".repeat(750001),
  "excessive nesting": () => { let value = "leaf"; for (let i = 0; i < 45; i++) value = { next: value }; return value; },
  "JSONB NUL string": () => "bad\u0000text",
  "JSONB NUL key": () => ({ ["bad\u0000key"]: "text" }),
  "JSONB lone high surrogate": () => "\ud800",
  "JSONB lone low surrogate": () => "\udc00",
};
for (const [name, makeValue] of Object.entries(invalidJsonValues)) {
  test(`rejects malformed, oversized or unrepresentable JSON: ${name}`, () => {
    const input = fixture();
    input.mappedSuggestions[0].value = makeValue();
    assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(input), TypeError);
  });
}

test("rejects more than 1000 mapped suggestions before saving a representation", () => {
  const input = fixture();
  input.mappedSuggestions = Array.from({ length: 1001 }, (_, index) => ({ ...input.mappedSuggestions[0],
    id: `member-${index}`, target_key: `synthetic:${index}` }));
  assert.throws(() => prepareCustomNeighborhoodAcceptanceSnapshot(input),
    { code: "custom_neighborhood_acceptance_invalid_manifest" });
});
