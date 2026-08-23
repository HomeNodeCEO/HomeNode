import fs from "node:fs";

import {
  APPENDIX_H1_COVERAGE_BASELINE,
  APPENDIX_H1_MANIFEST,
  APPENDIX_H1_RULE_IDS,
} from "../src/modules/uad/appendixH.js";
import { createUadComplianceRegistry } from "../src/modules/uad/uadComplianceClient.js";
import {
  buildUadPreOnboardingPlan,
  OFFICIAL_UCA_URAR_CASES,
  UCA_RESILIENCE_CASES,
} from "../src/modules/uad/uadComplianceCertification.js";

const requiredFiles = [
  new URL("../migrations/20260926_uad_appendix_h1_v1_5.sql", import.meta.url),
  new URL("../../docs/UAD_GSE_ONBOARDING_PACKET.md", import.meta.url),
  new URL("../../.github/workflows/uad-pre-onboarding.yml", import.meta.url),
];
const missingFiles = requiredFiles.filter((file) => !fs.existsSync(file)).map((file) => file.pathname);
const registry = createUadComplianceRegistry({});
const plan = buildUadPreOnboardingPlan(registry);
const uniqueRules = new Set(APPENDIX_H1_RULE_IDS);
const catalogReady = APPENDIX_H1_RULE_IDS.length === APPENDIX_H1_MANIFEST.active_rule_count
  && uniqueRules.size === APPENDIX_H1_MANIFEST.active_rule_count;
const ok = catalogReady
  && APPENDIX_H1_COVERAGE_BASELINE.cataloged_rule_count === APPENDIX_H1_MANIFEST.active_rule_count
  && registry.enabled === false
  && Object.values(registry.providers).every((provider) => provider.enabled === false)
  && Object.keys(OFFICIAL_UCA_URAR_CASES).length === 2
  && UCA_RESILIENCE_CASES.length >= 10
  && missingFiles.length === 0;

console.log(JSON.stringify({
  ok,
  generated_at: new Date().toISOString(),
  external_contact_performed: false,
  credentials_requested_or_used: false,
  appendix_h: {
    version: APPENDIX_H1_MANIFEST.version,
    published_on: APPENDIX_H1_MANIFEST.published_on,
    source_sha256: APPENDIX_H1_MANIFEST.source_sha256,
    rule_catalog_sha256: APPENDIX_H1_MANIFEST.rule_catalog_sha256,
    active_rule_count: APPENDIX_H1_MANIFEST.active_rule_count,
    fatal_rule_count: APPENDIX_H1_MANIFEST.fatal_rule_count,
    warning_rule_count: APPENDIX_H1_MANIFEST.warning_rule_count,
    catalog_complete: catalogReady,
    mapped_unverified_rule_count: APPENDIX_H1_COVERAGE_BASELINE.mapped_unverified_rule_count,
    reference_only_rule_count: APPENDIX_H1_COVERAGE_BASELINE.reference_only_rule_count,
    locally_verified_rule_count: APPENDIX_H1_COVERAGE_BASELINE.locally_verified_rule_count,
    gse_equivalence_claimed: false,
  },
  missing_required_files: missingFiles,
  plan,
}, null, 2));
if (!ok) process.exitCode = 1;
