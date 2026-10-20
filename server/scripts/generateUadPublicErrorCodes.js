import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS as UAD_COMPLIANCE_PROVIDERS } from "../src/modules/uad/uadComplianceClient.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(serverRoot, "src", "modules", "uad", "publicErrorCodes.generated.js");
const sourcePaths = [
  join(serverRoot, "src", "modules", "uad"),
  join(serverRoot, "src", "modules", "delivery"),
  join(serverRoot, "src", "services", "assignmentDocuments.js"),
  join(serverRoot, "src", "services", "documentOcr.js"),
];
const staticCodeShape = /^[a-z][a-z0-9_]{0,95}$/;
const relevantCode = /^(?:uad_|invalid_|document_|assignment_document_|delivery_)/;
const relevantSuffix = /(?:not_found|not_configured|_conflict|_status_locked|_access_denied)$/;
const directError = /\bnew\s+(?:[A-Za-z]*Error)\s*\(\s*(["'])([a-z][a-z0-9_]{0,95})\1\s*\)/g;
const helperCodeArgument = new Map([
  ["requireThat", -1],
  ["fail", 0],
  ["acknowledgmentError", 0],
  ["optionalText", -1],
  ["plainObject", -1],
  ["assertUadWorkfileMutable", -1],
  ["responseError", -1],
  ["relationshipSection", 0],
  ["r2HostLabel", -1],
  ["fetchWithTimeout", -1],
]);
const quotedCode = /^\s*(["'])(([a-z][a-z0-9_]{0,95}))\1\s*$/;

function sourceFiles(path) {
  if (path.endsWith(".js")) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    // These are external probes, not request handlers or their producers.
    if (/RedTeam|StagingSmoke/.test(entry.name)) return [];
    return entry.isDirectory() ? sourceFiles(child) : entry.name.endsWith(".js") ? [child] : [];
  });
}

function callArguments(source, openIndex) {
  const args = [];
  let start = openIndex + 1;
  let parentheses = 1;
  let brackets = 0;
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") { index += 1; continue; }
        if (source[index] === quote) break;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return [];
      continue;
    }
    if (character === "/" && next === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) return [];
      index += 1;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") {
      parentheses -= 1;
      if (parentheses === 0) {
        args.push(source.slice(start, index));
        return args;
      }
    } else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "," && parentheses === 1 && brackets === 0 && braces === 0) {
      args.push(source.slice(start, index));
      start = index + 1;
    }
  }
  return [];
}

function literalCallArguments(source, name, position) {
  const literals = new Set();
  const calls = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const match of source.matchAll(calls)) {
    const args = callArguments(source, match.index + match[0].lastIndexOf("("));
    const argument = args[position < 0 ? args.length + position : position];
    const code = quotedCode.exec(argument || "")?.[2];
    if (code) literals.add(code);
  }
  return literals;
}

function requiredFamily(name, values) {
  if (!values.size) throw new Error(`uad_public_error_family_missing:${name}`);
  return values;
}

function producedStaticCodes(source) {
  const codes = new Set([...source.matchAll(directError)].map((match) => match[2]));
  // These named object fields are consumed as error constructors by their
  // services; unrelated strings such as SQL columns and route labels are not.
  const configuredError = /\b(?:errorCode|tooLargeCode|unavailableCode|rejection)\s*:\s*(["'])([a-z][a-z0-9_]{0,95})\1/g;
  for (const match of source.matchAll(configuredError)) codes.add(match[2]);
  for (const [name, position] of helperCodeArgument) {
    for (const code of literalCallArguments(source, name, position)) codes.add(code);
  }
  return codes;
}

function dynamicCodes() {
  const codes = new Set([
    "document_page_limit_exceeded",
    "invalid_neighborhood_validation_input",
    "uad_compliance_token_failed",
    "uad_compliance_request_failed",
    "uad_public_owner_field_missing",
    "uad_signature_acknowledgment_invalid",
    "uad_signature_policy_invalid",
    "uad_signature_reauthentication_unavailable",
    "uad_xml_attribute_value_required",
    "uad_xml_mapping_missing",
    "uad_xml_mapping_path_invalid",
    "uad_xml_entity_missing",
    "uad_xml_duplicate_data_point",
    "uad_xml_signer_name_missing",
    "uad_xml_signer_license_missing",
    "uad_xml_signer_execution_date_missing",
  ]);
  const storageSource = readFileSync(join(serverRoot, "src", "modules", "uad", "r2Storage.js"), "utf8");
  const operations = requiredFamily("object_operations", literalCallArguments(storageSource, "request", 0));
  const objectSuffixes = requiredFamily("object_suffixes", new Set(
    [...storageSource.matchAll(/uad_object_\$\{operation\}_([a-z_]+)/g)].map((match) => match[1]),
  ));
  for (const operation of operations) {
    for (const suffix of objectSuffixes) {
      codes.add(`uad_object_${operation}_${suffix}`);
    }
  }
  for (const provider of UAD_COMPLIANCE_PROVIDERS) {
    codes.add(`uad_compliance_${provider}_not_configured`);
  }
  const packageSource = readFileSync(join(serverRoot, "src", "modules", "uad", "uadPackageArtifacts.js"), "utf8");
  const packagePrefixes = requiredFamily(
    "package_prefixes", literalCallArguments(packageSource, "downloadVerifiedToFile", 2),
  );
  const packageSuffixes = requiredFamily("package_suffixes", new Set(
    [...packageSource.matchAll(/\$\{errorPrefix\}_([a-z_]+)/g)].map((match) => match[1]),
  ));
  for (const prefix of packagePrefixes) {
    for (const suffix of packageSuffixes) {
      codes.add(`${prefix}_${suffix}`);
    }
  }
  const assetSource = readFileSync(join(serverRoot, "src", "modules", "uad", "uadFileSecurity.js"), "utf8");
  const assetReasons = requiredFamily("asset_reasons", literalCallArguments(assetSource, "invalid", 0));
  const defaultReason = assetSource.match(/function invalid\(reason = ["']([a-z_]+)["']\)/)?.[1];
  if (!defaultReason) throw new Error("uad_public_error_family_missing:asset_default_reason");
  assetReasons.add(defaultReason);
  for (const reason of assetReasons) codes.add(`invalid_uad_asset_${reason}`);
  return codes;
}

export function renderUadPublicErrorCodes() {
  const codes = dynamicCodes();
  for (const root of sourcePaths) {
    for (const path of sourceFiles(root)) {
      if (path === outputPath) continue;
      const source = readFileSync(path, "utf8");
      for (const code of producedStaticCodes(source)) {
        if (staticCodeShape.test(code) && (relevantCode.test(code) || relevantSuffix.test(code))) {
          codes.add(code);
        }
      }
    }
  }
  return [
    "// Generated by scripts/generateUadPublicErrorCodes.js. Do not edit by hand.",
    "// Only source-known machine codes may cross the shared UAD API boundary.",
    "export const PUBLIC_UAD_ERROR_CODES = new Set([",
    ...[...codes].sort().map((code) => `  ${JSON.stringify(code)},`),
    "]);",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderUadPublicErrorCodes();
  if (process.argv.includes("--write")) {
    writeFileSync(outputPath, rendered);
  } else if (process.argv.includes("--check")) {
    if (readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n") !== rendered) {
      throw new Error("uad_public_error_catalog_stale");
    }
  } else {
    throw new Error("Specify --write or --check");
  }
}
