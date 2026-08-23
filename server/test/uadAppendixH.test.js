import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  APPENDIX_H1_COVERAGE_BASELINE,
  APPENDIX_H1_MANIFEST,
  APPENDIX_H1_RULE_IDS,
  buildAppendixH1Coverage,
  getAppendixH1Rule,
  validateAppendixH1FindingRuleIds,
} from "../src/modules/uad/appendixH.js";

const migration = fs.readFileSync(
  new URL("../migrations/20260926_uad_appendix_h1_v1_5.sql", import.meta.url),
  "utf8",
);
const importer = fs.readFileSync(new URL("../scripts/importUadAppendixH.py", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(
  new URL("../src/modules/uad/spec/manifest.json", import.meta.url),
  "utf8",
));

test("pins the current official Appendix H-1 v1.5 catalog", () => {
  assert.equal(APPENDIX_H1_MANIFEST.version, "1.5");
  assert.equal(APPENDIX_H1_MANIFEST.published_on, "2026-08-13");
  assert.equal(APPENDIX_H1_MANIFEST.active_rule_count, 728);
  assert.equal(APPENDIX_H1_MANIFEST.fatal_rule_count, 592);
  assert.equal(APPENDIX_H1_MANIFEST.warning_rule_count, 136);
  assert.equal(APPENDIX_H1_RULE_IDS.length, 728);
  assert.equal(new Set(APPENDIX_H1_RULE_IDS).size, 728);
  assert.equal(getAppendixH1Rule("UAD1001").unique_id, "0100.0007");
  assert.equal(getAppendixH1Rule("UAD1438"), null);
  assert.equal(getAppendixH1Rule("UAD1443"), null);
  assert.equal(getAppendixH1Rule("UAD1625"), null);
  assert.equal(APPENDIX_H1_COVERAGE_BASELINE.cataloged_rule_count, 728);
  assert.equal(APPENDIX_H1_COVERAGE_BASELINE.mapped_unverified_rule_count, 383);
  assert.equal(APPENDIX_H1_COVERAGE_BASELINE.reference_only_rule_count, 345);
  assert.equal(APPENDIX_H1_COVERAGE_BASELINE.gse_equivalence_claimed, false);
});

test("reports source catalog and executable coverage separately", () => {
  const coverage = buildAppendixH1Coverage(APPENDIX_H1_RULE_IDS.map((ruleId, index) => ({
    rule_id: ruleId,
    local_evaluation_status: index < 10 ? "locally_verified" : "reference_only",
  })));
  assert.equal(coverage.catalog_complete, true);
  assert.equal(coverage.cataloged_rule_count, 728);
  assert.equal(coverage.locally_verified_rule_count, 10);
  assert.equal(coverage.reference_only_rule_count, 718);
  assert.equal(coverage.local_gse_equivalence_complete, false);
  assert.equal(coverage.gse_equivalence_claimed, false);

  assert.deepEqual(validateAppendixH1FindingRuleIds([
    { rule_id: "UAD1001" },
    { rule_id: "provider.non_uad" },
  ]), { current: true, unknown_rule_ids: [] });
  assert.deepEqual(validateAppendixH1FindingRuleIds([{ rule_id: "UAD9999" }]), {
    current: false,
    unknown_rule_ids: ["UAD9999"],
  });
});

test("imports all active official rules additively with source evidence", () => {
  const ids = new Set([...migration.matchAll(/"rule_id":"(UAD\d{4})"/g)].map((match) => match[1]));
  assert.equal(ids.size, 728);
  assert.doesNotMatch([...ids].join(","), /UAD1438|UAD1443|UAD1625/);
  assert.match(migration, /compliance_rule_source_manifests/);
  assert.match(migration, /local_evaluation_status/);
  assert.match(migration, /mapped_unverified/);
  assert.match(migration, /reference_only/);
  assert.match(migration, /df94cfb44b7460a619786a2e4f8c68ef472b167926ed0a3377ff6fb43ac283e8/);
  assert.match(importer, /keep_vba=False/);
  assert.match(importer, /EXPECTED_RULE_COUNT = 728/);
  assert.equal(manifest.runtimeAssets.appendixH1.officialRuleCount, 728);
  assert.equal(manifest.runtimeAssets.appendixH1.ruleCatalogSha256, APPENDIX_H1_MANIFEST.rule_catalog_sha256);
});
