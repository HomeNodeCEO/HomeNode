import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareCohortDecisionCommandV1 as prepare,
  COHORT_DECISION_COMMAND_VERSION,
  COHORT_DECISION_COMMAND_LIMITS,
} from "../src/services/neighborhoodAssessment/cohortDecisionCommand.js";
import { canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { assertNeighborhoodJsonbStorage } from "../src/services/neighborhoodAssessment/jsonbStorage.js";
import {
  COHORT_CLAIM_KINDS, COHORT_UNKNOWN_REASONS, cloneCohortFixture as clone,
  cohortCommandFixture as fixture, cohortDecisionRef, cohortEvidenceRef,
  cohortDigest, cohortUuid, cohortCommandAtBytes,
} from "./fixtures/neighborhoodCohortDecisionCommandFixture.js";

const json = JSON.stringify;
const invoke = command => prepare(json(command));
const invalid = (command, reason = "invalid_value") => assert.deepEqual(invoke(command), { status: "invalid", reason });
const limited = (command, reason) => assert.deepEqual(invoke(command), { status: "limit_exceeded", reason });
function frozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) frozen(child);
}
function measuredTree(value) {
  let nodes = 0, depth = 0;
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, current] = pending.pop();
    nodes++; depth = Math.max(depth, current);
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) pending.push([child, current + 1]);
    }
  }
  return { nodes, depth };
}
function valid(command) {
  const result = invoke(command);
  assert.deepEqual(Object.keys(result).sort(), ["authority", "command", "grammar_version", "status", "validation_scope"]);
  assert.equal(result.status, "syntax_valid");
  assert.equal(result.grammar_version, 1);
  assert.equal(result.validation_scope, "structure_only");
  assert.equal(result.authority, "not_established");
  frozen(result);
  assert.ok(assertNeighborhoodJsonbStorage(result) < 2_000_000);
  assert.ok(Buffer.byteLength(json(result)) <= 65_536);
  const outputTree = measuredTree(result);
  assert.ok(outputTree.nodes <= 10_032);
  assert.ok(outputTree.depth <= 17);
  return result;
}
const edit = (kind, change) => { const value = fixture(kind); change(value); return value; };
const support = value => value.claim.value.temporal_support;

test("informational version and hard limits match the closed contract", () => {
  assert.equal(COHORT_DECISION_COMMAND_VERSION, 1);
  assert.deepEqual(COHORT_DECISION_COMMAND_LIMITS, {
    input_bytes: 64000, input_nodes: 10000, input_depth: 16,
    evidence_references: 64, decision_references: 64, list_items: 64,
    rationale_bytes: 2000, output_bytes: 65536, output_nodes: 10032,
    output_depth: 17, opaque_bytes: 200, decimal_bytes: 200,
    timestamp_fraction_digits: 9,
  });
  frozen(COHORT_DECISION_COMMAND_LIMITS);
});
for (const kind of COHORT_CLAIM_KINDS) {
  test(`known ${kind} preserves complete command without authority`, () => {
    const command = fixture(kind);
    assert.equal(canonicalAssessmentJson(valid(command).command), canonicalAssessmentJson(command));
  });
  for (const reason of COHORT_UNKNOWN_REASONS) {
    test(`unknown ${kind}/${reason} retains qualifier and explicit null`, () => {
      const command = fixture(kind, { unknownReason: reason });
      const result = valid(command);
      assert.deepEqual(result.command.claim.qualifier, command.claim.qualifier);
      assert.equal(result.command.claim.value, null);
      assert.equal(result.command.claim.unknown_reason, reason);
      assert.equal(canonicalAssessmentJson(result.command), canonicalAssessmentJson(command));
    });
  }
}
for (const [kind, key] of [["sale_completion", "completed"], ["completed_home_at_closing", "completed_home"], ["material_condition", "present"]]) {
  for (const boolean of [false, true]) test(`${kind} preserves boolean ${boolean}`, () => {
    const command = edit(kind, c => { c.claim.value[key] = boolean; });
    assert.equal(valid(command).command.claim.value[key], boolean);
  });
  for (const value of [0, 1, "false", null]) test(`${kind} refuses boolean coercion ${json(value)}`, () => invalid(edit(kind, c => { c.claim.value[key] = value; })));
}

test("UAD target and UUID case normalization preserve opaque identity", () => {
  const command = fixture("study_fitness_review", { workflow: "uad_3_6" });
  command.operation_id = command.operation_id.toUpperCase();
  command.target_ref.report_file_id = command.target_ref.report_file_id.toUpperCase();
  command.target_ref.workflow_target_id = command.target_ref.workflow_target_id.toUpperCase();
  command.expected_context.context_id = command.expected_context.context_id.toUpperCase();
  command.study_ref.study_id = command.study_ref.study_id.toUpperCase();
  command.expected_predecessor.decision_id = command.expected_predecessor.decision_id.toUpperCase();
  command.claim.value.required_fact_refs[0].decision_id = command.claim.decision_refs[0].decision_id.toUpperCase();
  command.evidence_refs[0].capture_id = "CAPTURE:É:e\u0301";
  const result = valid(command).command;
  assert.equal(result.operation_id, command.operation_id.toLowerCase());
  assert.equal(result.target_ref.report_file_id, command.target_ref.report_file_id.toLowerCase());
  assert.equal(result.target_ref.workflow_target_id, command.target_ref.workflow_target_id.toLowerCase());
  assert.equal(result.expected_context.context_id, command.expected_context.context_id.toLowerCase());
  assert.equal(result.study_ref.study_id, command.study_ref.study_id.toLowerCase());
  assert.equal(result.expected_predecessor.decision_id, command.expected_predecessor.decision_id.toLowerCase());
  assert.equal(result.claim.value.required_fact_refs[0].decision_id, command.claim.decision_refs[0].decision_id);
  assert.equal(result.evidence_refs[0].capture_id, "CAPTURE:É:e\u0301");
});
for (const uuid of ["00000000-0000-0000-0000-000000000000", "a1000000-0000-9000-8000-000000000001", "a1000000-0000-4000-7000-000000000001", ` ${cohortUuid(1)}`, 1, null]) {
  test(`invalid UUID ${json(uuid)} is not coerced`, () => invalid(edit("sale_completion", c => { c.operation_id = uuid; })));
}
for (const version of [1, 8]) test(`shared UUID version ${version} admitted`, () => valid(edit("sale_completion", c => { c.operation_id = `a1000000-0000-${version}000-8000-000000000001`; })));
for (const [workflow, target] of [["custom_appraisal", cohortUuid(1)], ["uad_3_6", "123"], ["custom_appraisal", "0"]]) {
  test(`workflow target grammar ${workflow}/${target}`, () => invalid(edit("sale_completion", c => { c.target_ref.workflow_type = workflow; c.target_ref.workflow_target_id = target; })));
}
for (const value of ["9223372036854775808", "01", "+1", "-1", "1.0", "1e2", 1, null]) {
  test(`generation refuses non-IntText ${json(value)}`, () => invalid(edit("sale_completion", c => { c.expected_generation = value; })));
}
for (const value of ["0", "9223372036854775807"]) test(`exact generation ${value}`, () => assert.equal(valid(edit("sale_completion", c => { c.expected_generation = value; })).command.expected_generation, value));
for (const key of ["expected_context", "study_ref"]) test(`${key} revision must be positive`, () => invalid(edit("sale_completion", c => { c[key][key === "study_ref" ? "definition_revision" : "context_revision"] = "0"; })));

for (const decimal of ["1", "0.0000000000000000001", "1.2300", "9007199254740993.123456789123456789", "9".repeat(200)]) {
  test(`lossless positive decimal ${decimal.slice(0, 30)}`, () => assert.equal(valid(edit("recorded_consideration", c => { c.claim.value.amount_decimal = decimal; })).command.claim.value.amount_decimal, decimal));
}
for (const decimal of ["0", "0.000", "00.1", ".1", "1.", "+1", "-1", "1e3", "1,000", " 1", "NaN", 1.23, "9".repeat(201)]) {
  test(`invalid decimal ${json(decimal).slice(0, 30)}`, () => invalid(edit("recorded_consideration", c => { c.claim.value.amount_decimal = decimal; })));
}
test("currency and housing codes are syntax only; decimal scale changes retained identity", () => {
  assert.equal(valid(fixture("recorded_consideration")).command.claim.value.currency, "ZZZ");
  assert.equal(valid(fixture("housing_at_date")).command.claim.value.housing_code, "uninstalled:code");
  const first = edit("recorded_consideration", c => { c.claim.value.amount_decimal = "1.2300"; });
  const second = edit("recorded_consideration", c => { c.claim.value.amount_decimal = "1.23"; });
  assert.notEqual(canonicalAssessmentJson(valid(first).command), canonicalAssessmentJson(valid(second).command));
});
for (const currency of ["usd", "US", "USDD", "123", 840]) test(`invalid currency syntax ${currency}`, () => invalid(edit("recorded_consideration", c => { c.claim.value.currency = currency; })));

for (const date of ["2023-02-29", "2024-02-30", "2024-13-01", "2024-2-01", "2024-02-29T00:00:00Z", " 2024-02-29", null]) test(`invalid closing calendar ${date}`, () => invalid(edit("closing_date", c => { c.claim.value.date = date; })));
test("temporal nulls and reconstruction clocks retain distinct meanings", () => {
  const command = fixture("housing_at_date");
  const result = valid(command).command.claim.value.temporal_support;
  assert.deepEqual(result, command.claim.value.temporal_support);
  for (const field of ["valid_from", "valid_through", "observed_at", "captured_at", "available_at"]) support(command)[field] = null;
  assert.deepEqual(valid(command).command.claim.value.temporal_support, support(command));
});
for (const basis of ["contemporaneous", "reconstructed", "current_only"]) test(`temporal basis ${basis} is structural only`, () => valid(edit("housing_at_date", c => { support(c).basis = basis; })));
for (const instant of ["2024-02-29T00:00:00Z", "2024-02-29T23:59:59.1Z", "2024-02-29T12:13:14.120000000Z"]) test(`instant preserves precision ${instant}`, () => assert.equal(valid(edit("housing_at_date", c => { support(c).available_at = instant; })).command.claim.value.temporal_support.available_at, instant));
for (const instant of ["2024-02-30T00:00:00Z", "2024-02-29T24:00:00Z", "2024-02-29T23:60:00Z", "2024-02-29T23:59:60Z", "2024-02-29T00:00:00.1234567890Z", "2024-02-29T00:00:00+00:00", "2024-02-29T00:00:00z", "2024-02-29T00:00:00.Z", 1]) test(`invalid instant ${instant}`, () => invalid(edit("housing_at_date", c => { support(c).observed_at = instant; })));
test("reversed finite temporal dates refused; missing bound not invented", () => {
  invalid(edit("housing_at_date", c => { support(c).valid_from = "2024-03-01"; }));
  valid(edit("housing_at_date", c => { support(c).valid_from = null; support(c).valid_through = "2020-01-01"; }));
});
for (const kind of COHORT_CLAIM_KINDS) test(`${kind} wrong subject rejected even when unknown`, () => {
  const command = fixture(kind, { unknownReason: "missing_evidence" });
  command.subject_ref.kind = kind === "housing_at_date" ? "capture_candidate" : "stock_member";
  invalid(command, "subject_claim_mismatch");
});
for (const [kind, field] of [["housing_at_date", "evaluated_on"], ["material_condition", "condition_code"]]) test(`${kind} exact qualifier relation`, () => {
  const command = fixture(kind);
  command.claim.value[field] = field === "evaluated_on" ? "2024-02-28" : "other";
  invalid(command, "qualifier_value_mismatch");
  command.claim.state = "unknown"; command.claim.value = null; command.claim.unknown_reason = "missing_evidence";
  assert.deepEqual(valid(command).command.claim.qualifier, fixture(kind).claim.qualifier);
});

test("membership preserves separate source routes, null mappings and account identity", () => {
  const result = valid(fixture("economic_property_membership")).command;
  assert.equal(result.claim.value.interest_members.length, 2);
  assert.equal(result.claim.value.interest_members[0].cad_link, null);
  assert.equal(result.claim.value.interest_members[1].cad_link.account_id, "000123");
});
for (const [kind, key] of [["recorded_consideration", "interest_scope_refs"], ["economic_property_membership", "interest_members"], ["transaction_equivalence", "candidate_keys"]]) test(`${kind} required list minimum`, () => invalid(edit(kind, c => { c.claim.value[key] = []; })));
test("empty known evidence lists are structural admission, not source sufficiency", () => {
  const command = fixture(); command.evidence_refs = []; command.claim.value.event_evidence_refs = [];
  assert.equal(valid(command).authority, "not_established");
});
test("equivalence must contain exact subject and cannot duplicate candidates", () => {
  invalid(edit("transaction_equivalence", c => { c.claim.value.candidate_keys = ["other"]; }), "subject_claim_mismatch");
  invalid(edit("transaction_equivalence", c => { c.claim.value.candidate_keys.push(c.subject_ref.key); }), "duplicate_reference");
});

for (const [kind, mutate] of [
  ["sale_completion", c => { c.claim.value.event_evidence_refs[0] = cohortEvidenceRef(3); }],
  ["recorded_consideration", c => { c.claim.value.interest_scope_refs[0].source_ref = cohortEvidenceRef(3); }],
  ["economic_property_membership", c => { c.claim.value.interest_members[1].cad_link.mapping_evidence_ref = cohortEvidenceRef(3); }],
  ["economic_property_membership", c => { c.claim.value.completeness_evidence_refs[0] = cohortEvidenceRef(3); }],
  ["transaction_equivalence", c => { c.claim.value.equivalence_evidence_refs[0] = cohortEvidenceRef(3); }],
  ["housing_at_date", c => { support(c).evidence_refs[0] = cohortEvidenceRef(3); }],
  ["material_condition", c => { c.claim.value.condition_evidence_refs[0] = cohortEvidenceRef(3); }],
]) test(`${kind} nested evidence route must close exactly`, () => invalid(edit(kind, mutate), "unclosed_reference"));
for (const field of ["manifest_sha256", "chunk_sha256", "record_content_sha256"]) test(`source route conflict ${field}`, () => {
  const command = fixture(); const ref = clone(command.evidence_refs[0]); ref[field] = cohortDigest("conflict");
  command.evidence_refs.push(ref); invalid(command, "reference_conflict");
});
test("root and role evidence duplicate checks do not erase repeated roles", () => {
  invalid(edit("sale_completion", c => { c.evidence_refs.push(clone(c.evidence_refs[0])); }), "duplicate_reference");
  invalid(edit("sale_completion", c => { c.claim.value.event_evidence_refs.push(clone(c.evidence_refs[0])); }), "duplicate_reference");
  valid(fixture("economic_property_membership"));
  invalid(edit("recorded_consideration", c => { c.claim.value.interest_scope_refs.push(clone(c.claim.value.interest_scope_refs[0])); }), "duplicate_reference");
});
test("case-only opaque route does not acquire closure", () => invalid(edit("sale_completion", c => { c.claim.value.event_evidence_refs[0].capture_id = c.evidence_refs[0].capture_id.toUpperCase(); }), "unclosed_reference"));
for (const list of ["required_fact_refs", "condition_review_refs"]) test(`decision closure for ${list}`, () => invalid(edit("study_fitness_review", c => { c.claim.value[list] = [cohortDecisionRef(99)]; }), "unclosed_reference"));
test("UUID case duplicates/conflicts cannot evade predecessor and role checks", () => {
  const duplicate = fixture("study_fitness_review");
  duplicate.claim.decision_refs.push({ ...duplicate.claim.decision_refs[0], decision_id: duplicate.claim.decision_refs[0].decision_id.toUpperCase() });
  invalid(duplicate, "duplicate_reference");
  const conflict = fixture("study_fitness_review");
  conflict.expected_predecessor = { decision_id: conflict.claim.decision_refs[0].decision_id.toUpperCase(), decision_sha256: cohortDigest("wrong-decision") };
  invalid(conflict, "reference_conflict");
  const matching = fixture("study_fitness_review");
  matching.expected_predecessor = clone(matching.claim.decision_refs[0]);
  valid(matching);
});
test("all evidence reference occurrences are charged before identity union", () => {
  const command = fixture(); command.expected_predecessor = null;
  command.evidence_refs = Array.from({ length: 32 }, (_, i) => cohortEvidenceRef(i + 1));
  command.claim.value.event_evidence_refs = clone(command.evidence_refs);
  valid(command);
  command.evidence_refs.push(cohortEvidenceRef(33)); limited(command, "reference_limit");
});
// The counts below come from the fixture's explicitly specified role shapes,
// not the implementation's walker: membership has two source refs, one CAD
// mapping ref and two completeness refs; each other kind here has one role ref.
for (const [kind, nestedCount] of [
  ["sale_completion", 1], ["closing_date", 1], ["recorded_consideration", 1],
  ["economic_property_membership", 5], ["transaction_equivalence", 1],
  ["housing_at_date", 1], ["completed_home_at_closing", 1], ["material_condition", 1],
]) test(`${kind} exact 64/65 occurrences include every retained role position`, () => {
  const command = fixture(kind);
  let next = 10;
  while (command.evidence_refs.length < 64 - nestedCount) command.evidence_refs.push(cohortEvidenceRef(next++));
  valid(command);
  command.evidence_refs.push(cohortEvidenceRef(next));
  limited(command, "reference_limit");
});
test("duplicate references cannot be unioned before the occurrence cap", () => {
  const command = fixture();
  command.evidence_refs = Array.from({ length: 64 }, () => clone(command.evidence_refs[0]));
  // 64 root + one event role exceeds the cap before duplicate classification.
  limited(command, "reference_limit");
});
test("decision occurrences include predecessor and every role", () => {
  const command = fixture("study_fitness_review");
  command.claim.decision_refs = Array.from({ length: 21 }, (_, i) => cohortDecisionRef(100 + i));
  command.claim.value.required_fact_refs = clone(command.claim.decision_refs);
  command.claim.value.condition_review_refs = clone(command.claim.decision_refs);
  valid(command); // 21 * 3 + predecessor = 64.
  command.claim.decision_refs.push(cohortDecisionRef(200)); limited(command, "reference_limit");
});
test("candidate list at 64 and 65 is independently bounded", () => {
  const command = fixture("transaction_equivalence");
  command.claim.value.candidate_keys = [command.subject_ref.key, ...Array.from({ length: 63 }, (_, i) => `candidate:${i + 10}`)];
  valid(command); command.claim.value.candidate_keys.push("candidate:over"); limited(command, "list_limit");
});

test("array order retained while object-key order canonicalizes equivalently", () => {
  const command = fixture("economic_property_membership");
  const reverseKeys = Object.fromEntries(Object.entries(command).reverse());
  assert.equal(canonicalAssessmentJson(valid(command).command), canonicalAssessmentJson(valid(reverseKeys).command));
  const reverseArray = clone(command); reverseArray.evidence_refs.reverse();
  assert.notEqual(canonicalAssessmentJson(valid(command).command), canonicalAssessmentJson(valid(reverseArray).command));
});
test("opaque bytes 200/201 and normalization distinctions", () => {
  const command = fixture(); command.subject_ref.key = "é".repeat(100);
  assert.equal(valid(command).command.subject_ref.key, command.subject_ref.key);
  command.subject_ref.key += "x"; invalid(command);
  for (const key of ["  ", "01", "e\u0301", "é", "A", "a"]) {
    command.subject_ref.key = key; assert.equal(valid(command).command.subject_ref.key, key);
  }
});
test("rationale exact UTF-8 bound preserves whitespace and escapes", () => {
  const command = fixture(); command.rationale = "é".repeat(998) + "\n\"\\x";
  assert.equal(Buffer.byteLength(command.rationale), 2000); valid(command);
  command.rationale += "x"; limited(command, "rationale_limit");
  command.rationale = " \n\t "; invalid(command);
});
test("closed valid input at 64000 bytes and one byte over refuses atomically", () => {
  const command = cohortCommandAtBytes(64000);
  assert.equal(Buffer.byteLength(json(command)), 64000);
  const result = valid(command);
  assert.ok(Buffer.byteLength(json(result)) > 64000);
  assert.ok(Buffer.byteLength(json(result)) <= 65536);
  const wrapper = { status: "syntax_valid", grammar_version: 1,
    validation_scope: "structure_only", authority: "not_established", command: null };
  const framingBytes = Buffer.byteLength(json(wrapper)) - 4;
  assert.equal(Buffer.byteLength(json(result)), 64000 + framingBytes);
  assert.equal(measuredTree(result).nodes, measuredTree(result.command).nodes + 5);
  assert.equal(measuredTree(result).depth, measuredTree(result.command).depth + 1);
  command.rationale += "x"; assert.equal(Buffer.byteLength(json(command)), 64001);
  limited(command, "input_bytes");
});
for (const value of ["A".repeat(64), "0".repeat(63), "sha256:" + "0".repeat(64), 123]) {
  test(`SHA256 has exact lowercase syntax ${String(value).slice(0, 16)}`, () => invalid(edit("sale_completion", c => { c.expected_context.context_sha256 = value; })));
}
for (const kind of COHORT_CLAIM_KINDS) test(`${kind} unknown retains a closed qualifier shape`, () => {
  const command = fixture(kind, { unknownReason: "missing_evidence" });
  command.claim.qualifier.saved_effective_date = "2024-02-29";
  invalid(command, "invalid_shape");
});
test("future node limit is admitted before version dispatch", () => {
  // Root + version + payload array + 9997 values = 10000 nodes.
  const future = { version: 2, payload: Array(9997).fill(null) };
  assert.deepEqual(invoke(future), { status: "unsupported", reason: "unsupported_version" });
  future.payload.push(null); limited(future, "input_nodes");
});
test("future depth boundary precedes dispatch without recursive stringify admission", () => {
  const nest = depth => { let value = null; for (let i = 0; i < depth; i++) value = [value]; return value; };
  assert.deepEqual(invoke({ version: 2, payload: nest(15) }), { status: "unsupported", reason: "unsupported_version" });
  limited({ version: 2, payload: nest(16) }, "input_depth");
});
test("future input bytes bounded and invalid future values do not bypass generic admission", () => {
  const prefix = json({ version: 2, payload: "" });
  const value = { version: 2, payload: "x".repeat(64000 - Buffer.byteLength(prefix)) };
  assert.equal(Buffer.byteLength(json(value)), 64000);
  assert.deepEqual(invoke(value), { status: "unsupported", reason: "unsupported_version" });
  value.payload += "x"; limited(value, "input_bytes");
  assert.deepEqual(prepare('{"version":2,"payload":1e999}'), { status: "invalid", reason: "invalid_value" });
});
for (const version of [undefined, null, "1", 0, -1, 1.5, 9007199254740992]) test(`invalid version ${version}`, () => invalid(edit("sale_completion", c => { if (version === undefined) delete c.version; else c.version = version; }), "invalid_shape"));
for (const input of [null, true, 1, [], {}, new String("{}")]) test(`nonprimitive input ${typeof input} rejected before coercion`, () => assert.deepEqual(prepare(input), { status: "invalid", reason: "invalid_input_type" }));
test("hostile object, proxy and boxed string never execute caller hooks", () => {
  let reads = 0;
  const trap = () => { reads++; throw new Error("caller secret"); };
  const value = { get version() { return trap(); }, toJSON: trap, toString: trap };
  const proxy = new Proxy(value, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  for (const input of [value, proxy, new String("{}")]) assert.deepEqual(prepare(input), { status: "invalid", reason: "invalid_input_type" });
  assert.equal(reads, 0);
});
for (const input of ["", "{", "undefined", "[1,]"]) test(`invalid JSON ${json(input)}`, () => assert.deepEqual(prepare(input), { status: "invalid", reason: "invalid_json" }));
test("raw duplicate-key rejection does not make reserialization original transport", () => {
  const command = fixture(); const canonical = json(command);
  const duplicate = canonical.replace('"version":1', '"version":2,"version":1');
  assert.deepEqual(prepare(duplicate), { status: "invalid", reason: "noncanonical_json" });
  const internal = json(JSON.parse(duplicate));
  assert.equal(internal, canonical);
  const result = prepare(internal); assert.equal(result.status, "syntax_valid");
  assert.equal(result.authority, "not_established");
  assert.equal(Object.hasOwn(result, "transport_verified"), false);
});
test("compact policy rejects erased numeric, string and whitespace distinctions", () => {
  const raw = json(fixture());
  for (const altered of [` ${raw}`, `${raw}\n`, JSON.stringify(fixture(), null, 2), raw.replace('"version":1', '"version":1.0'), raw.replace('"version":1', '"version":1e0'), raw.replace('"version"', '"\\u0076ersion"')]) {
    assert.deepEqual(prepare(altered), { status: "invalid", reason: "noncanonical_json" });
  }
});
for (const bad of ["\u0000", "\ud800", "\udfff"]) test(`storage-invalid Unicode ${json(bad)}`, () => {
  invalid(edit("sale_completion", c => { c.rationale = `x${bad}`; }), "invalid_unicode");
  const future = { version: 2, [bad]: "value" };
  invalid(future, "invalid_unicode");
});
test("closed structures reject authority bags, missing keys and wrong known/unknown pairs", () => {
  for (const key of ["actor_id", "organization_id", "signature", "ready", "source_payload", "debug"]) invalid(edit("sale_completion", c => { c[key] = "caller controlled"; }), "invalid_shape");
  invalid(edit("sale_completion", c => { delete c.rationale; }), "invalid_shape");
  invalid(edit("sale_completion", c => { c.target_ref.extra = true; }), "invalid_shape");
  invalid(edit("sale_completion", c => { c.claim.unknown_reason = "missing_evidence"; }));
  invalid(edit("sale_completion", c => { c.claim.state = "unknown"; c.claim.unknown_reason = "missing_evidence"; }));
});
test("refusals are fixed, frozen, small and do not retain request text", () => {
  const command = fixture(); command.operation_id = "SENSITIVE_SYNTHETIC_MARKER";
  const result = invoke(command); frozen(result);
  assert.equal(json(result).includes("SENSITIVE_SYNTHETIC_MARKER"), false);
  assert.deepEqual(Object.keys(result).sort(), ["reason", "status"]);
  assert.ok(Buffer.byteLength(json(result)) < 8192);
  assert.deepEqual(prepare(json(command), { input_bytes: Infinity, version: () => true }), result);
});
test("detached frozen results cannot change input, constants, or later calls", () => {
  const command = fixture(); const raw = json(command); const first = prepare(raw);
  assert.throws(() => { first.command.claim.value.completed = true; }, TypeError);
  assert.throws(() => { first.command.evidence_refs.push(cohortEvidenceRef(8)); }, TypeError);
  assert.equal(command.claim.value.completed, false);
  command.claim.value.completed = true;
  assert.equal(first.command.claim.value.completed, false);
  const second = prepare(raw); assert.deepEqual(second, first); assert.notEqual(second.command, first.command);
});
