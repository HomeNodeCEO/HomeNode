import {
  APPENDIX_H1_MANIFEST,
  validateAppendixH1FindingRuleIds,
} from "./appendixH.js";
import { parseUadComplianceResponse } from "./uadComplianceClient.js";

export const OFFICIAL_UCA_URAR_CASES = Object.freeze({
  no_findings: Object.freeze({
    key: "urar_no_uad_findings",
    label: "URAR: No UAD Findings",
    source_url: "https://singlefamily.fanniemae.com/media/document/xml/sf1appraisalv1-no-uad-findings",
    expected: "successful_response_without_findings",
  }),
  uad_findings: Object.freeze({
    key: "urar_uad_findings",
    label: "URAR: UAD Findings",
    source_url: "https://singlefamily.fanniemae.com/media/document/xml/sf1appraisalv2-uad-findings-response",
    expected: "successful_response_with_current_appendix_h_findings",
  }),
});

export const UCA_RESILIENCE_CASES = Object.freeze([
  "malformed_xml",
  "subschema_failure",
  "invalid_or_expired_oauth",
  "token_timeout",
  "submission_timeout",
  "oversized_response",
  "unsupported_response_media_type",
  "provider_unavailable",
  "duplicate_or_replayed_request",
  "workfile_revision_changed_during_request",
]);

export function verifyOfficialUcaCaseResult(caseName, response) {
  const definition = OFFICIAL_UCA_URAR_CASES[caseName];
  if (!definition) throw new Error("uad_certification_case_invalid");
  if (!response?.ok) throw new Error("uad_certification_response_unsuccessful");
  const findings = parseUadComplianceResponse(response);
  const ruleIds = validateAppendixH1FindingRuleIds(findings);
  if (!ruleIds.current) throw new Error("uad_certification_unknown_rule_id");
  if (caseName === "no_findings" && findings.length !== 0) {
    throw new Error("uad_certification_unexpected_findings");
  }
  if (caseName === "uad_findings" && findings.length === 0) {
    throw new Error("uad_certification_expected_findings_missing");
  }
  return Object.freeze({
    case_key: definition.key,
    status: "passed",
    finding_count: findings.length,
    fatal_count: findings.filter((finding) => finding.severity === "fatal").length,
    warning_count: findings.filter((finding) => finding.severity === "warning").length,
    appendix_h_version: APPENDIX_H1_MANIFEST.version,
    unknown_rule_ids: ruleIds.unknown_rule_ids,
  });
}

export function buildUadPreOnboardingPlan(registry) {
  const providers = Object.fromEntries(Object.entries(registry.providers).map(([provider, value]) => [
    provider,
    Object.freeze({
      enabled: Boolean(value.enabled),
      configured: Boolean(value.configured),
      environment: value.environment || null,
      blockers: Object.freeze([...(value.blockers || [])]),
    }),
  ]));
  return Object.freeze({
    external_contact_performed: false,
    credentials_requested: false,
    steps: Object.freeze([
      Object.freeze({
        step: 1,
        key: "official_appendix_h",
        status: "ready",
        evidence: Object.freeze({
          version: APPENDIX_H1_MANIFEST.version,
          published_on: APPENDIX_H1_MANIFEST.published_on,
          active_rule_count: APPENDIX_H1_MANIFEST.active_rule_count,
          rule_catalog_sha256: APPENDIX_H1_MANIFEST.rule_catalog_sha256,
        }),
      }),
      Object.freeze({
        step: 2,
        key: "credential_configuration_contract",
        status: registry.enabled ? "activation_in_progress" : "prepared_disabled",
        evidence: Object.freeze({ providers }),
      }),
      Object.freeze({
        step: 3,
        key: "official_urar_test_cases",
        status: "harness_ready_credentials_required",
        evidence: Object.freeze({ cases: Object.values(OFFICIAL_UCA_URAR_CASES) }),
      }),
      Object.freeze({
        step: 4,
        key: "failure_and_recovery_matrix",
        status: "harness_ready_provider_contract_pending",
        evidence: Object.freeze({ cases: UCA_RESILIENCE_CASES }),
      }),
      Object.freeze({
        step: 5,
        key: "verification_and_production_activation",
        status: "guarded_external_gate",
        evidence: Object.freeze({
          production_requires_verification_evidence_sha256: true,
          provider_credentials_are_independent: true,
          gse_acceptance_claimed: false,
        }),
      }),
    ]),
  });
}
