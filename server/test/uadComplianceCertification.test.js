import assert from "node:assert/strict";
import test from "node:test";

import { createUadComplianceRegistry } from "../src/modules/uad/uadComplianceClient.js";
import {
  buildUadPreOnboardingPlan,
  OFFICIAL_UCA_URAR_CASES,
  UCA_RESILIENCE_CASES,
  verifyOfficialUcaCaseResult,
} from "../src/modules/uad/uadComplianceCertification.js";

function response(findings) {
  return {
    ok: true,
    content_type: "application/json",
    body: JSON.stringify({ findings }),
  };
}

test("verifies the public clean and findings URAR case contracts", () => {
  const clean = verifyOfficialUcaCaseResult("no_findings", response([]));
  assert.equal(clean.status, "passed");
  assert.equal(clean.finding_count, 0);

  const findings = verifyOfficialUcaCaseResult("uad_findings", response([
    { ruleId: "UAD1001", severity: "Fatal", message: "Required address is missing" },
    { ruleId: "UAD1008", severity: "Warning", message: "Review latitude" },
  ]));
  assert.equal(findings.finding_count, 2);
  assert.equal(findings.fatal_count, 1);
  assert.equal(findings.warning_count, 1);
  assert.throws(
    () => verifyOfficialUcaCaseResult("uad_findings", response([{ ruleId: "UAD9999", severity: "Fatal", message: "Drift" }])),
    /uad_certification_unknown_rule_id/,
  );
  assert.throws(() => verifyOfficialUcaCaseResult("no_findings", response([
    { ruleId: "UAD1001", severity: "Fatal", message: "Unexpected" },
  ])), /uad_certification_unexpected_findings/);
});

test("builds a five-step credentialless pre-onboarding plan", () => {
  const plan = buildUadPreOnboardingPlan(createUadComplianceRegistry({}));
  assert.equal(plan.external_contact_performed, false);
  assert.equal(plan.credentials_requested, false);
  assert.equal(plan.steps.length, 5);
  assert.equal(plan.steps[0].evidence.active_rule_count, 728);
  assert.equal(plan.steps[1].status, "prepared_disabled");
  assert.equal(Object.keys(OFFICIAL_UCA_URAR_CASES).length, 2);
  assert.ok(UCA_RESILIENCE_CASES.includes("duplicate_or_replayed_request"));
  assert.equal(plan.steps[4].evidence.production_requires_verification_evidence_sha256, true);
  assert.equal(plan.steps[4].evidence.gse_acceptance_claimed, false);
});
