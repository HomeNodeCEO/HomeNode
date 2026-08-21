import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { validateXML } from "xmllint-wasm";

const SCHEMA_VERSION = "1.3";
const SCHEMA_FILE = `GSE_UAD_3.6.0_v${SCHEMA_VERSION}.xsd`;
const XLINK_FILE = `GSE_UAD_3.6.0_xlink_v${SCHEMA_VERSION}.xsd`;
const SCHEMA_BASE = new URL(`./spec/subschema/v${SCHEMA_VERSION}/`, import.meta.url);
const MAX_UAD_XML_BYTES = 16 * 1024 * 1024;
const MAX_UAD_XML_MARKUP_TOKENS = 250_000;

export const UAD_SUBSCHEMA_VALIDATOR_VERSION = `gse-uad-3.6.0-v${SCHEMA_VERSION}-xmllint-wasm-5.3.0`;

let schemaFilesPromise;

function loadSchemaFiles() {
  schemaFilesPromise ||= Promise.all([
    readFile(new URL(SCHEMA_FILE, SCHEMA_BASE), "utf8"),
    readFile(new URL(XLINK_FILE, SCHEMA_BASE), "utf8"),
    readFile(new URL("xml.xsd", SCHEMA_BASE), "utf8"),
  ]).then(([schema, xlink, xmlNamespace]) => ({
    schema,
    xlink,
    xmlNamespace,
    schema_sha256: createHash("sha256").update(schema, "utf8").digest("hex"),
  }));
  return schemaFilesPromise;
}

function normalizeError(error, index) {
  if (typeof error === "string") {
    return { index, line: null, column: null, code: null, message: error.trim() };
  }
  const message = String(error?.message || error?.rawMessage || error?.raw || error || "XML schema validation failed.").trim();
  return {
    index,
    line: Number.isFinite(Number(error?.line)) ? Number(error.line) : null,
    column: Number.isFinite(Number(error?.column)) ? Number(error.column) : null,
    code: error?.code == null ? null : String(error.code),
    message,
  };
}

export async function validateUadSubschema(xml) {
  const contents = String(xml || "");
  if (!contents.trim()) throw new Error("uad_xml_empty");
  if (Buffer.byteLength(contents, "utf8") > MAX_UAD_XML_BYTES) throw new Error("uad_xml_bytes_exceeded");
  if (contents.includes("\0")) throw new Error("uad_xml_unsafe_markup");
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(contents)) throw new Error("uad_xml_dtd_forbidden");
  const withoutDeclaration = contents.replace(/^\s*<\?xml\s[^?]*\?>/i, "");
  if (/<\?/.test(withoutDeclaration)) throw new Error("uad_xml_processing_instruction_forbidden");
  if ((contents.match(/</g) || []).length > MAX_UAD_XML_MARKUP_TOKENS) {
    throw new Error("uad_xml_complexity_exceeded");
  }
  const files = await loadSchemaFiles();
  const result = await validateXML({
    xml: [{ fileName: "homenode-uad.xml", contents }],
    schema: [{ fileName: SCHEMA_FILE, contents: files.schema }],
    preload: [
      { fileName: XLINK_FILE, contents: files.xlink },
      { fileName: "xml.xsd", contents: files.xmlNamespace },
    ],
    initialMemoryPages: 512,
    maxMemoryPages: 4096,
  });
  const rawErrorLines = String(result.rawOutput || "").split(/\r?\n/)
    .filter((line) => /validity error/i.test(line));
  const errors = (result.errors || []).map(normalizeError).map((error, index) => {
    if (error.line !== null) return error;
    const location = rawErrorLines[index]?.match(/homenode-uad\.xml:(\d+)(?::(\d+))?/i);
    return location ? {
      ...error,
      line: Number(location[1]),
      column: location[2] ? Number(location[2]) : null,
    } : error;
  });
  return {
    valid: Boolean(result.valid),
    errors,
    raw_output: result.rawOutput || "",
    validator_version: UAD_SUBSCHEMA_VALIDATOR_VERSION,
    subschema_version: SCHEMA_VERSION,
    schema_sha256: files.schema_sha256,
  };
}
