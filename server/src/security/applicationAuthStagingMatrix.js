const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,100}$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_UUID = "00000000-0000-4000-8000-000000000001";
const PROBE_ACCOUNT = "AUTH_STAGING_PROBE";

function configurationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requiredText(value, code, maximum = 1_000) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    throw configurationError(code);
  }
  return normalized;
}

function uuid(value, code) {
  const normalized = requiredText(value, code, 100);
  if (!UUID_PATTERN.test(normalized)) throw configurationError(code);
  return normalized.toLowerCase();
}

function positiveInteger(value, code) {
  const normalized = requiredText(value, code, 30);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(Number(normalized)) || Number(normalized) < 1) {
    throw configurationError(code);
  }
  return normalized;
}

function baseUrl(value) {
  let parsed;
  try {
    parsed = new URL(requiredText(value, "invalid_application_auth_staging_base_url", 2_000));
  } catch {
    throw configurationError("invalid_application_auth_staging_base_url");
  }
  const local = new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw configurationError("invalid_application_auth_staging_base_url");
  }
  return parsed.origin;
}

function timeout(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(parsed, 30_000));
}

function token(value, code) {
  return requiredText(value, code, 16_384);
}

export function normalizeApplicationAuthStagingConfiguration(input = {}) {
  const organizationAId = uuid(input.organizationAId, "invalid_application_auth_staging_organization_a");
  const organizationBId = uuid(input.organizationBId, "invalid_application_auth_staging_organization_b");
  const organizationAToken = token(input.organizationAToken, "invalid_application_auth_staging_token_a");
  const organizationBToken = token(input.organizationBToken, "invalid_application_auth_staging_token_b");
  if (organizationAId === organizationBId) {
    throw configurationError("application_auth_staging_organizations_must_differ");
  }
  if (organizationAToken === organizationBToken) {
    throw configurationError("application_auth_staging_tokens_must_differ");
  }
  const accountId = requiredText(input.accountId, "invalid_application_auth_staging_account", 100);
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw configurationError("invalid_application_auth_staging_account");
  }
  return Object.freeze({
    baseUrl: baseUrl(input.baseUrl),
    organizationAId,
    organizationBId,
    organizationAToken,
    organizationBToken,
    accountId,
    customAssignmentFileId: positiveInteger(
      input.customAssignmentFileId,
      "invalid_application_auth_staging_custom_assignment",
    ),
    uadWorkfileId: uuid(input.uadWorkfileId, "invalid_application_auth_staging_uad_workfile"),
    propertyTaxFileId: uuid(
      input.propertyTaxFileId,
      "invalid_application_auth_staging_property_tax_file",
    ),
    timeoutMs: timeout(input.timeoutMs),
  });
}

async function boundedJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (!chunks.length) return null;
    const text = Buffer.concat(chunks.map((value) => Buffer.from(value))).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
}

async function request(fetchImpl, configuration, path, {
  method = "GET",
  bearer = null,
  headers = {},
  body = undefined,
} = {}) {
  const url = new URL(path, `${configuration.baseUrl}/`);
  if (url.origin !== configuration.baseUrl) throw configurationError("invalid_application_auth_probe_url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), configuration.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    return Object.freeze({
      status: response.status,
      body: await boundedJson(response),
      noStore: /(?:^|,)\s*(?:no-store|private)(?:\s*(?:=[^,]+)?)(?:,|$)/i
        .test(String(response.headers.get("cache-control") || "")),
    });
  } catch (error) {
    return Object.freeze({
      status: 0,
      body: null,
      noStore: false,
      networkError: error?.name === "AbortError" ? "request_timeout" : "request_failed",
    });
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(response) {
  const value = response?.body?.error;
  return typeof value === "string" && /^[a-z0-9_:-]{1,100}$/i.test(value) ? value : null;
}

function evidence(response, passed, detail = null) {
  return Object.freeze({
    passed: Boolean(passed),
    http_status: Number(response?.status || 0),
    error_code: errorCode(response) || response?.networkError || null,
    ...(detail ? { detail } : {}),
  });
}

function add(checks, name, response, passed, detail = null) {
  checks[name] = evidence(response, passed, detail);
}

function privatePaths(fixtures) {
  const account = encodeURIComponent(fixtures.accountId);
  const custom = encodeURIComponent(fixtures.customAssignmentFileId);
  const uad = encodeURIComponent(fixtures.uadWorkfileId);
  const propertyTax = encodeURIComponent(fixtures.propertyTaxFileId);
  return Object.freeze({
    customWorkfile: `/api/accounts/${account}/assignment-files/${custom}/workfile`,
    customDocuments: `/api/accounts/${account}/documents?assignment_file_id=${custom}`,
    customPhotos: `/api/accounts/${account}/assignment-files/${custom}/photos`,
    customSection: `/api/accounts/${account}/assignment-files/${custom}/workfile/sections/subject`,
    customSign: `/api/accounts/${account}/assignment-files/${custom}/workfile/sign`,
    customDocumentUpload: `/api/accounts/${account}/documents`,
    customPhotoUpload: `/api/accounts/${account}/assignment-files/${custom}/photos/upload-requests`,
    uadWorkfile: `/api/uad/workfiles/${uad}`,
    uadDocuments: `/api/uad/workfiles/${uad}/documents`,
    uadSection: `/api/uad/workfiles/${uad}/sections/subject`,
    uadDocumentUpload: `/api/uad/workfiles/${uad}/documents`,
    propertyTaxWorkfile: `/api/accounts/${account}/property-tax-protest?file_id=${propertyTax}`,
    propertyTaxDocuments: `/api/accounts/${account}/property-tax-protest/${propertyTax}/documents`,
    propertyTaxUpdate: `/api/accounts/${account}/property-tax-protest/${propertyTax}`,
    propertyTaxSketch: `/api/accounts/${account}/property-tax-protest/${propertyTax}/sketch`,
    propertyTaxDocumentUpload: `/api/accounts/${account}/property-tax-protest/${propertyTax}/documents`,
    mobileFiles: `/api/mobile/report-files?account_id=${account}`,
  });
}

function publicProbeConfiguration(input = {}) {
  return Object.freeze({
    baseUrl: baseUrl(input.baseUrl),
    timeoutMs: timeout(input.timeoutMs),
  });
}

async function runProbes(fetchImpl, configuration, definitions) {
  return Promise.all(definitions.map(async (definition) => ({
    ...definition,
    response: await request(fetchImpl, configuration, definition.path, definition.options),
  })));
}

export async function runApplicationAuthPublicPreflight({
  baseUrl: targetBaseUrl,
  timeoutMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw configurationError("application_auth_staging_fetch_required");
  const configuration = publicProbeConfiguration({ baseUrl: targetBaseUrl, timeoutMs });
  const fixtures = privatePaths({
    accountId: PROBE_ACCOUNT,
    customAssignmentFileId: "1",
    uadWorkfileId: PROBE_UUID,
    propertyTaxFileId: PROBE_UUID,
  });
  const probes = await runProbes(fetchImpl, configuration, [
    { name: "runtime_ready", path: "/ready", expected: [200] },
    { name: "web_auth_status", path: "/api/auth/status", expected: [200] },
    { name: "uad_capabilities", path: "/api/uad/capabilities", expected: [200] },
    { name: "mobile_capabilities", path: "/api/mobile/capabilities", expected: [200] },
    { name: "anonymous_browser_session", path: "/api/auth/me", expected: [401] },
    { name: "anonymous_custom_workfile", path: fixtures.customWorkfile, expected: [401] },
    { name: "anonymous_uad_workfile", path: fixtures.uadWorkfile, expected: [401] },
    { name: "anonymous_property_tax_workfile", path: fixtures.propertyTaxWorkfile, expected: [401] },
    { name: "anonymous_mobile_identity", path: "/api/mobile/me", expected: [401] },
    {
      name: "legacy_editor_key_inert",
      path: fixtures.customWorkfile,
      expected: [401],
      options: { headers: { "x-homenode-editor-key": "staging-negative-control" } },
    },
  ]);
  const checks = {};
  for (const probe of probes) {
    let passed = probe.expected.includes(probe.response.status);
    if (probe.name === "web_auth_status") {
      passed = passed
        && probe.response.body?.configured === true
        && probe.response.body?.required === true;
    }
    if (probe.name === "uad_capabilities") {
      passed = passed
        && probe.response.body?.authentication?.configured === true
        && probe.response.body?.authentication?.required === true;
    }
    if (probe.name === "mobile_capabilities") {
      passed = passed
        && probe.response.body?.enabled === true
        && probe.response.body?.authentication?.configured === true
        && probe.response.body?.authentication?.client_secret_embedded === false;
    }
    add(checks, probe.name, probe.response, passed);
  }
  const blockers = Object.entries(checks)
    .filter(([, check]) => !check.passed)
    .map(([name]) => name);
  return Object.freeze({
    ok: blockers.length === 0,
    mode: "public_preflight",
    checked_at: new Date().toISOString(),
    blockers: Object.freeze(blockers),
    checks: Object.freeze(checks),
  });
}

function sessionOrganizationIds(response) {
  const organizations = response?.body?.session?.organizations;
  if (!Array.isArray(organizations)) return [];
  return organizations.map((item) => String(item?.organization_id || "").toLowerCase()).filter(Boolean);
}

function targetIds(response) {
  return Array.isArray(response?.body?.files)
    ? response.body.files.map((file) => String(file?.target_id || "").toLowerCase()).filter(Boolean)
    : [];
}

const JSON_HEADERS = Object.freeze({ "content-type": "application/json" });
const PDF_HEADERS = Object.freeze({
  "content-type": "application/pdf",
  "x-document-file-name": "authorization-probe.pdf",
  "x-document-title": "Authorization probe",
});
const EMPTY_JSON = "{}";
const INVALID_SIGN_JSON = '{"acknowledged_warning_codes":["invalid negative control"]}';
const INVALID_PDF_PROBE = "HomeNode invalid PDF negative control";

export async function runApplicationAuthStagingMatrix(input = {}) {
  const configuration = normalizeApplicationAuthStagingConfiguration(input);
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw configurationError("application_auth_staging_fetch_required");
  const paths = privatePaths(configuration);
  const publicResult = await runApplicationAuthPublicPreflight({
    baseUrl: configuration.baseUrl,
    timeoutMs: configuration.timeoutMs,
    fetchImpl,
  });
  const checks = { ...publicResult.checks };

  const identityProbes = await runProbes(fetchImpl, configuration, [
    { name: "organization_a_browser_identity", path: "/api/auth/me", options: { bearer: configuration.organizationAToken } },
    { name: "organization_b_browser_identity", path: "/api/auth/me", options: { bearer: configuration.organizationBToken } },
    { name: "organization_a_mobile_identity", path: "/api/mobile/me", options: { bearer: configuration.organizationAToken } },
    { name: "organization_b_mobile_identity", path: "/api/mobile/me", options: { bearer: configuration.organizationBToken } },
    { name: "activation_readiness", path: "/api/auth/readiness", options: { bearer: configuration.organizationAToken } },
  ]);
  for (const probe of identityProbes) {
    let passed = probe.response.status === 200;
    if (probe.name === "organization_a_browser_identity") {
      const ids = sessionOrganizationIds(probe.response);
      passed = passed && ids.includes(configuration.organizationAId)
        && !ids.includes(configuration.organizationBId);
    }
    if (probe.name === "organization_b_browser_identity") {
      const ids = sessionOrganizationIds(probe.response);
      passed = passed && ids.includes(configuration.organizationBId)
        && !ids.includes(configuration.organizationAId);
    }
    if (probe.name === "activation_readiness") {
      passed = passed && probe.response.body?.readiness?.activation_ready === true;
    }
    add(checks, probe.name, probe.response, passed);
  }

  const anonymousProbes = await runProbes(fetchImpl, configuration, [
    ["anonymous_custom_documents", paths.customDocuments, {}],
    ["anonymous_custom_photos", paths.customPhotos, {}],
    ["anonymous_custom_section_write", paths.customSection, { method: "PUT", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["anonymous_custom_sign", paths.customSign, { method: "POST", headers: JSON_HEADERS, body: INVALID_SIGN_JSON }],
    ["anonymous_custom_document_upload", paths.customDocumentUpload, { method: "POST", headers: { ...PDF_HEADERS, "x-assignment-file-id": configuration.customAssignmentFileId }, body: INVALID_PDF_PROBE }],
    ["anonymous_custom_photo_upload", paths.customPhotoUpload, { method: "POST", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["anonymous_uad_documents", paths.uadDocuments, {}],
    ["anonymous_uad_section_write", paths.uadSection, { method: "PATCH", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["anonymous_uad_document_upload", paths.uadDocumentUpload, { method: "POST", headers: PDF_HEADERS, body: INVALID_PDF_PROBE }],
    ["anonymous_property_tax_documents", paths.propertyTaxDocuments, {}],
    ["anonymous_property_tax_write", paths.propertyTaxUpdate, { method: "PATCH", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["anonymous_property_tax_sketch_write", paths.propertyTaxSketch, { method: "PATCH", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["anonymous_property_tax_document_upload", paths.propertyTaxDocumentUpload, { method: "POST", headers: PDF_HEADERS, body: INVALID_PDF_PROBE }],
  ].map(([name, path, options]) => ({ name, path, options })));
  for (const probe of anonymousProbes) add(checks, probe.name, probe.response, probe.response.status === 401);

  const positiveProbes = await runProbes(fetchImpl, configuration, [
    ["organization_a_custom_workfile", paths.customWorkfile],
    ["organization_a_custom_documents", paths.customDocuments],
    ["organization_a_custom_photos", paths.customPhotos],
    ["organization_a_uad_workfile", paths.uadWorkfile],
    ["organization_a_uad_documents", paths.uadDocuments],
    ["organization_a_property_tax_workfile", paths.propertyTaxWorkfile],
    ["organization_a_property_tax_documents", paths.propertyTaxDocuments],
    ["organization_a_mobile_files", paths.mobileFiles],
  ].map(([name, path]) => ({ name, path, options: { bearer: configuration.organizationAToken } })));
  for (const probe of positiveProbes) add(checks, probe.name, probe.response, probe.response.status === 200);

  const deniedProbes = await runProbes(fetchImpl, configuration, [
    ["organization_b_custom_workfile_denied", paths.customWorkfile, {}],
    ["organization_b_custom_documents_denied", paths.customDocuments, {}],
    ["organization_b_custom_photos_denied", paths.customPhotos, {}],
    ["organization_b_custom_section_write_denied", paths.customSection, { method: "PUT", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["organization_b_custom_sign_denied", paths.customSign, { method: "POST", headers: JSON_HEADERS, body: INVALID_SIGN_JSON }],
    ["organization_b_custom_document_upload_denied", paths.customDocumentUpload, { method: "POST", headers: { ...PDF_HEADERS, "x-assignment-file-id": configuration.customAssignmentFileId }, body: INVALID_PDF_PROBE }],
    ["organization_b_custom_photo_upload_denied", paths.customPhotoUpload, { method: "POST", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["organization_b_uad_workfile_denied", paths.uadWorkfile, {}],
    ["organization_b_uad_documents_denied", paths.uadDocuments, {}],
    ["organization_b_uad_section_write_denied", paths.uadSection, { method: "PATCH", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["organization_b_uad_document_upload_denied", paths.uadDocumentUpload, { method: "POST", headers: PDF_HEADERS, body: INVALID_PDF_PROBE }],
    ["organization_b_property_tax_workfile_denied", paths.propertyTaxWorkfile, {}],
    ["organization_b_property_tax_documents_denied", paths.propertyTaxDocuments, {}],
    ["organization_b_property_tax_write_denied", paths.propertyTaxUpdate, { method: "PATCH", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["organization_b_property_tax_sketch_write_denied", paths.propertyTaxSketch, { method: "PATCH", headers: JSON_HEADERS, body: EMPTY_JSON }],
    ["organization_b_property_tax_document_upload_denied", paths.propertyTaxDocumentUpload, { method: "POST", headers: PDF_HEADERS, body: INVALID_PDF_PROBE }],
  ].map(([name, path, options]) => ({
    name,
    path,
    options: { ...options, bearer: configuration.organizationBToken },
  })));
  for (const probe of deniedProbes) add(checks, probe.name, probe.response, probe.response.status === 403);

  const organizationBFiles = await request(fetchImpl, configuration, paths.mobileFiles, {
    bearer: configuration.organizationBToken,
  });
  const organizationAFiles = positiveProbes.find((probe) => probe.name === "organization_a_mobile_files")?.response;
  const fixtureTargets = new Set([
    configuration.customAssignmentFileId.toLowerCase(),
    configuration.uadWorkfileId,
    configuration.propertyTaxFileId,
  ]);
  const aTargets = new Set(targetIds(organizationAFiles));
  const bTargets = new Set(targetIds(organizationBFiles));
  add(
    checks,
    "organization_a_mobile_fixture_discovery",
    organizationAFiles,
    organizationAFiles?.status === 200 && [...fixtureTargets].every((id) => aTargets.has(id)),
  );
  add(
    checks,
    "organization_b_mobile_fixture_isolation",
    organizationBFiles,
    organizationBFiles.status === 200 && [...fixtureTargets].every((id) => !bTargets.has(id)),
  );

  const blockers = Object.entries(checks)
    .filter(([, check]) => !check.passed)
    .map(([name]) => name);
  return Object.freeze({
    ok: blockers.length === 0,
    mode: "two_organization_matrix",
    checked_at: new Date().toISOString(),
    blockers: Object.freeze(blockers),
    checks: Object.freeze(checks),
  });
}
