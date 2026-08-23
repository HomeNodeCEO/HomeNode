import { createHash } from "node:crypto";
import fs from "node:fs";

const CATALOG_PATH = new URL("./spec/appendix-h1-v1.5.json", import.meta.url);
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value)), "utf8").digest("hex");
}

function validateCatalog(value) {
  const document = value?.document || {};
  const rules = Array.isArray(value?.rules) ? value.rules : [];
  if (value?.schema_version !== 1 || document.appendix !== "H-1" || document.version !== "1.5") {
    throw new Error("uad_appendix_h_catalog_contract_invalid");
  }
  if (rules.length !== Number(document.active_rule_count)) {
    throw new Error("uad_appendix_h_catalog_count_invalid");
  }
  const ids = new Set();
  let fatal = 0;
  let warning = 0;
  for (const rule of rules) {
    if (!/^UAD\d{4}$/.test(String(rule.rule_id || "")) || ids.has(rule.rule_id)) {
      throw new Error("uad_appendix_h_catalog_rule_id_invalid");
    }
    ids.add(rule.rule_id);
    if (rule.severity === "fatal") fatal += 1;
    else if (rule.severity === "warning") warning += 1;
    else throw new Error("uad_appendix_h_catalog_severity_invalid");
    if (!/^[0-9a-f]{64}$/.test(String(rule.source_fingerprint_sha256 || ""))) {
      throw new Error("uad_appendix_h_catalog_fingerprint_invalid");
    }
  }
  if (fatal !== Number(document.fatal_rule_count) || warning !== Number(document.warning_rule_count)) {
    throw new Error("uad_appendix_h_catalog_severity_count_invalid");
  }
  if (digest(rules) !== document.rule_catalog_sha256) {
    throw new Error("uad_appendix_h_catalog_checksum_invalid");
  }
  for (const deleted of document.deleted_rule_ids || []) {
    if (ids.has(deleted)) throw new Error("uad_appendix_h_deleted_rule_present");
  }
  return Object.freeze({ ids, fatal, warning });
}

const validated = validateCatalog(catalog);
const ruleMap = new Map(catalog.rules.map((rule) => [rule.rule_id, Object.freeze(rule)]));

export const APPENDIX_H1_MANIFEST = Object.freeze({ ...catalog.document });
export const APPENDIX_H1_COVERAGE_BASELINE = Object.freeze({ ...catalog.coverage });
export const APPENDIX_H1_RULE_IDS = Object.freeze([...validated.ids]);

export function getAppendixH1Rule(ruleIdValue) {
  return ruleMap.get(String(ruleIdValue || "").trim().toUpperCase()) || null;
}

export function buildAppendixH1Coverage(databaseRows = []) {
  const current = new Map();
  let unknownRuleCount = 0;
  for (const row of databaseRows) {
    const ruleId = String(row?.rule_id || "").trim().toUpperCase();
    if (!ruleMap.has(ruleId)) {
      unknownRuleCount += 1;
      continue;
    }
    current.set(ruleId, String(row.local_evaluation_status || "reference_only"));
  }
  const statusCounts = { reference_only: 0, mapped_unverified: 0, locally_verified: 0 };
  for (const status of current.values()) {
    if (Object.hasOwn(statusCounts, status)) statusCounts[status] += 1;
  }
  return Object.freeze({
    appendix: APPENDIX_H1_MANIFEST.appendix,
    version: APPENDIX_H1_MANIFEST.version,
    published_on: APPENDIX_H1_MANIFEST.published_on,
    expected_rule_count: APPENDIX_H1_MANIFEST.active_rule_count,
    cataloged_rule_count: current.size,
    missing_rule_count: APPENDIX_H1_MANIFEST.active_rule_count - current.size,
    unknown_rule_count: unknownRuleCount,
    reference_only_rule_count: statusCounts.reference_only,
    mapped_unverified_rule_count: statusCounts.mapped_unverified,
    locally_verified_rule_count: statusCounts.locally_verified,
    catalog_complete: current.size === APPENDIX_H1_MANIFEST.active_rule_count && unknownRuleCount === 0,
    local_gse_equivalence_complete: statusCounts.locally_verified === APPENDIX_H1_MANIFEST.active_rule_count,
    gse_equivalence_claimed: false,
  });
}

export function validateAppendixH1FindingRuleIds(findings = []) {
  const unknown = [];
  for (const finding of findings) {
    const ruleId = String(finding?.rule_id || "").trim().toUpperCase();
    if (ruleId && /^UAD\d+$/.test(ruleId) && !ruleMap.has(ruleId)) unknown.push(ruleId);
  }
  return Object.freeze({
    current: unknown.length === 0,
    unknown_rule_ids: Object.freeze([...new Set(unknown)].sort()),
  });
}
