// Synthetic syntax fixtures for frozen contract 0436f5a1. These are not source
// records, installed catalogs, approved decisions, or authenticated identities.
import { createHash } from "node:crypto";

export const COHORT_CLAIM_KINDS = Object.freeze([
  "sale_completion", "closing_date", "recorded_consideration",
  "economic_property_membership", "transaction_equivalence", "housing_at_date",
  "completed_home_at_closing", "material_condition", "study_fitness_review",
]);
export const COHORT_UNKNOWN_REASONS = Object.freeze([
  "missing_evidence", "conflicting_evidence", "unsupported_source_meaning",
  "incomplete_membership", "unresolved_equivalence", "unsupported_temporal_basis",
  "unreviewed_material_condition", "unsupported_mapping",
]);
export const cloneCohortFixture = value => JSON.parse(JSON.stringify(value));
export const cohortDigest = value => createHash("sha256").update(String(value)).digest("hex");
export const cohortUuid = index => `a1000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
export const cohortDecisionRef = index => ({ decision_id: cohortUuid(index), decision_sha256: cohortDigest(`decision:${index}`) });

export function cohortEvidenceRef(index = 1) {
  return {
    capture_id: `synthetic:capture:${index}`,
    capture_revision: "0007",
    manifest_sha256: cohortDigest(`manifest:${index}`),
    chunk_id: `synthetic:chunk:${index}`,
    chunk_sha256: cohortDigest(`chunk:${index}`),
    record_key: `000${index}`,
    record_content_sha256: cohortDigest(`record:${index}`),
  };
}

export function cohortTemporalSupport(evidence = cohortEvidenceRef()) {
  return {
    basis: "reconstructed", valid_from: "2024-02-01", valid_through: "2024-02-29",
    // Different source semantics intentionally do not imply generic ordering.
    observed_at: "2024-03-03T12:13:14.123456789Z",
    captured_at: "2024-03-01T12:13:14.1200Z",
    available_at: null, evidence_refs: [cloneCohortFixture(evidence)],
  };
}

export function cohortCommandFixture(kind = "sale_completion", options = {}) {
  if (!COHORT_CLAIM_KINDS.includes(kind)) throw new Error("fixture_kind");
  const evidence = cohortEvidenceRef(1);
  const second = cohortEvidenceRef(2);
  const decision = cohortDecisionRef(31);
  const qualifier = kind === "housing_at_date"
    ? { basis: "evaluated_date", evaluated_on: "2024-02-29" }
    : kind === "material_condition" ? { basis: "condition", condition_code: "synthetic:condition" }
      : kind === "study_fitness_review" ? { basis: "named_study" }
        : kind === "completed_home_at_closing" ? { basis: "closing_event" } : { basis: "event" };
  const values = {
    sale_completion: { completed: false, event_evidence_refs: [evidence] },
    closing_date: { date: "2024-02-29", event_evidence_refs: [evidence] },
    recorded_consideration: { currency: "ZZZ", amount_decimal: "9007199254740993.2300", meaning: "recorded_total_sale_price", interest_scope_refs: [{ interest_key: "interest:A", source_ref: evidence }] },
    economic_property_membership: {
      economic_property_key: "synthetic:economic-property",
      interest_members: [
        { interest_key: "same-bare-interest", source_ref: evidence, cad_link: null },
        { interest_key: "same-bare-interest", source_ref: second, cad_link: { provider_key: "synthetic:provider", jurisdiction_key: "synthetic:jurisdiction:B", account_id: "000123", mapping_evidence_ref: second } },
      ], completeness_evidence_refs: [evidence, second],
    },
    transaction_equivalence: { canonical_event_key: "synthetic:event", candidate_keys: ["candidate:001", "candidate:002"], equivalence_evidence_refs: [evidence] },
    housing_at_date: { evaluated_on: "2024-02-29", housing_code: "uninstalled:code", housing_catalog_id: "synthetic:catalog", housing_catalog_revision: "01", temporal_support: cohortTemporalSupport(evidence) },
    completed_home_at_closing: { closing_date: "2024-02-29", completed_home: false, temporal_support: cohortTemporalSupport(evidence) },
    material_condition: { condition_code: "synthetic:condition", present: false, condition_evidence_refs: [evidence] },
    study_fitness_review: { conclusion: "incompatible", required_fact_refs: [decision], condition_review_refs: [decision] },
  };
  const command = {
    version: 1, operation_id: cohortUuid(1),
    target_ref: { report_file_id: cohortUuid(2), workflow_type: options.workflow ?? "custom_appraisal", workflow_target_id: options.workflow === "uad_3_6" ? cohortUuid(3) : "9223372036854775807" },
    expected_context: { context_id: cohortUuid(4), context_revision: "1", context_sha256: cohortDigest("context") },
    study_ref: { study_id: cohortUuid(5), definition_revision: "1", definition_sha256: cohortDigest("study") },
    expected_generation: "0", expected_predecessor: cohortDecisionRef(30),
    subject_ref: { kind: kind === "housing_at_date" ? "stock_member" : "capture_candidate", key: "candidate:001" },
    claim: { kind, qualifier, state: "known", value: values[kind], unknown_reason: null, decision_refs: kind === "study_fitness_review" ? [decision] : [] },
    evidence_refs: kind === "economic_property_membership" ? [evidence, second] : [evidence],
    rationale: " Synthetic syntax review only.\nSource and actor authority remain unestablished. ",
  };
  if (options.unknownReason) {
    command.claim.state = "unknown";
    command.claim.value = null;
    command.claim.unknown_reason = options.unknownReason;
  }
  return cloneCohortFixture(command);
}

// Exactly 64 evidence occurrences: 32 root routes repeated once in one role.
// This creates a genuinely closed valid command at a requested raw-byte bound.
export function cohortCommandAtBytes(targetBytes) {
  const make = width => {
    const value = cohortCommandFixture();
    value.expected_predecessor = null;
    value.rationale = "x";
    value.evidence_refs = Array.from({ length: 32 }, (_, index) => {
      const ref = cohortEvidenceRef(index + 1);
      for (const key of ["capture_id", "capture_revision", "chunk_id", "record_key"]) {
        ref[key] = `${index}:`.padEnd(width, "x");
      }
      return ref;
    });
    value.claim.value.event_evidence_refs = cloneCohortFixture(value.evidence_refs);
    return value;
  };
  let selected;
  for (let width = 3; width <= 200; width++) {
    const candidate = make(width);
    const bytes = Buffer.byteLength(JSON.stringify(candidate));
    if (bytes > targetBytes) break;
    selected = candidate;
  }
  if (!selected) throw new Error("fixture_byte_target_too_small");
  const missing = targetBytes - Buffer.byteLength(JSON.stringify(selected));
  if (missing > 1999) throw new Error("fixture_byte_target_unreachable");
  selected.rationale += "x".repeat(missing);
  if (Buffer.byteLength(JSON.stringify(selected)) !== targetBytes) throw new Error("fixture_byte_mismatch");
  return selected;
}
