import { createHash } from "node:crypto";

const PROVIDERS = Object.freeze(["fannie", "freddie"]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function enabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function requiredHttpsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("uad_compliance_https_url_required");
  }
  return url.toString();
}

function allowedHosts(value) {
  const hosts = new Set();
  for (const raw of String(value || "").split(",")) {
    const host = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
      throw new Error("uad_compliance_allowed_host_invalid");
    }
    hosts.add(host);
  }
  return hosts;
}

function isProductionEnvironment(value) {
  return /^(prod|production)$/i.test(String(value || "").trim());
}

function providerConfig(env, provider) {
  const prefix = provider === "fannie" ? "FANNIE_UAD_COMPLIANCE" : "FREDDIE_UAD_COMPLIANCE";
  const tokenAuthStyle = String(env[`${prefix}_TOKEN_AUTH_STYLE`] || "").trim().toLowerCase();
  if (tokenAuthStyle && !["basic", "body"].includes(tokenAuthStyle)) {
    throw new Error("uad_compliance_token_auth_style_invalid");
  }
  const hosts = allowedHosts(env[`${prefix}_ALLOWED_HOSTS`]);
  const verificationEvidenceSha256 = String(
    env[`${prefix}_VERIFICATION_EVIDENCE_SHA256`] || "",
  ).trim().toLowerCase();
  if (verificationEvidenceSha256 && !/^[0-9a-f]{64}$/.test(verificationEvidenceSha256)) {
    throw new Error("uad_compliance_verification_evidence_invalid");
  }
  const config = {
    provider,
    enabled: enabledFlag(env[`${prefix}_ENABLED`]),
    environment: String(env[`${prefix}_ENVIRONMENT`] || "").trim(),
    submitUrl: requiredHttpsUrl(env[`${prefix}_BASE_URL`]),
    tokenUrl: requiredHttpsUrl(env[`${prefix}_TOKEN_URL`]),
    clientId: String(env[`${prefix}_CLIENT_ID`] || "").trim(),
    clientSecret: String(env[`${prefix}_CLIENT_SECRET`] || "").trim(),
    scope: String(env[`${prefix}_SCOPE`] || "").trim(),
    tokenAuthStyle,
    allowedHosts: hosts,
    verificationEvidenceSha256,
  };
  const blockers = [];
  if (config.enabled) {
    if (!config.environment) blockers.push("environment_missing");
    if (!config.submitUrl) blockers.push("submission_url_missing");
    if (!config.tokenUrl) blockers.push("token_url_missing");
    if (!config.clientId) blockers.push("client_id_missing");
    if (!config.clientSecret) blockers.push("client_secret_missing");
    if (!config.tokenAuthStyle) blockers.push("token_auth_style_missing");
    if (!config.allowedHosts.size) blockers.push("allowed_hosts_missing");
    if (config.submitUrl && !config.allowedHosts.has(new URL(config.submitUrl).hostname.toLowerCase())) {
      blockers.push("submission_host_not_allowed");
    }
    if (config.tokenUrl && !config.allowedHosts.has(new URL(config.tokenUrl).hostname.toLowerCase())) {
      blockers.push("token_host_not_allowed");
    }
    if (isProductionEnvironment(config.environment) && !config.verificationEvidenceSha256) {
      blockers.push("production_verification_evidence_missing");
    }
  }
  config.blockers = Object.freeze(blockers);
  config.configured = Boolean(config.enabled && blockers.length === 0);
  return Object.freeze(config);
}

async function readBoundedText(response, maximum = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximum) throw new Error("uad_compliance_response_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximum) throw new Error("uad_compliance_response_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => {});
      throw new Error("uad_compliance_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseHeader(response, names) {
  for (const name of names) {
    const value = response.headers.get(name);
    if (value) return value.slice(0, 200);
  }
  return null;
}

export class UadComplianceClient {
  constructor(config, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(5_000, Math.min(Number(timeoutMs) || 30_000, 60_000));
  }

  async accessToken() {
    if (!this.config.configured) throw new Error(`uad_compliance_${this.config.provider}_not_configured`);
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (this.config.scope) form.set("scope", this.config.scope);
    const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (this.config.tokenAuthStyle === "basic") {
      headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64")}`;
    } else {
      form.set("client_id", this.config.clientId);
      form.set("client_secret", this.config.clientSecret);
    }
    let response;
    try {
      response = await this.fetchImpl(this.config.tokenUrl, {
        method: "POST",
        headers,
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (["AbortError", "TimeoutError"].includes(error?.name)) throw new Error("uad_compliance_timeout");
      throw new Error("uad_compliance_network_error");
    }
    const body = await readBoundedText(response, 256 * 1024);
    if (!response.ok) throw new Error(`uad_compliance_token_failed:${response.status}`);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("uad_compliance_token_response_invalid");
    }
    const token = String(parsed.access_token || "");
    if (!token || token.length > 16_384) throw new Error("uad_compliance_token_response_invalid");
    return token;
  }

  async submitXml(xml, { correlationId } = {}) {
    if (!this.config.configured) throw new Error(`uad_compliance_${this.config.provider}_not_configured`);
    const token = await this.accessToken();
    let response;
    try {
      response = await this.fetchImpl(this.config.submitUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, application/xml, text/xml",
          "content-type": "application/xml",
        },
        body: xml,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (["AbortError", "TimeoutError"].includes(error?.name)) throw new Error("uad_compliance_timeout");
      throw new Error("uad_compliance_network_error");
    }
    const body = await readBoundedText(response);
    const contentType = String(response.headers.get("content-type") || "application/octet-stream")
      .split(";", 1)[0].trim().toLowerCase();
    return {
      ok: response.ok,
      http_status: response.status,
      content_type: contentType,
      body,
      response_checksum_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      provider_correlation_id: responseHeader(response, [
        "x-correlation-id", "correlation-id", "x-request-id", "request-id", "trace-id",
      ]),
      request_correlation_id: correlationId || null,
    };
  }
}

export function createUadComplianceRegistry(env = process.env, options = {}) {
  const enabled = enabledFlag(env.UAD_COMPLIANCE_API_ENABLED);
  const timeoutMs = Math.max(5_000, Math.min(Number(env.UAD_COMPLIANCE_API_TIMEOUT_MS) || 30_000, 60_000));
  const configs = Object.fromEntries(PROVIDERS.map((provider) => [provider, providerConfig(env, provider)]));
  const clients = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    new UadComplianceClient(configs[provider], { ...options, timeoutMs }),
  ]));
  return Object.freeze({
    enabled,
    timeout_ms: timeoutMs,
    providers: Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [provider, Object.freeze({
      provider,
      enabled: configs[provider].enabled,
      configured: enabled && configs[provider].configured,
      environment: configs[provider].environment || null,
      blockers: configs[provider].enabled ? configs[provider].blockers : Object.freeze([]),
    })]))),
    getClient(providerValue) {
      const provider = String(providerValue || "").trim().toLowerCase();
      if (!PROVIDERS.includes(provider)) throw new Error("invalid_uad_compliance_provider");
      if (!enabled) throw new Error("uad_compliance_disabled");
      if (!configs[provider].configured) throw new Error(`uad_compliance_${provider}_not_configured`);
      return clients[provider];
    },
  });
}

function valuesForKeys(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function collectJsonFindings(value, findings, depth = 0) {
  if (depth > 12 || findings.length >= 2_000 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonFindings(item, findings, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const message = valuesForKeys(value, ["message", "messageText", "description", "findingMessage", "text"]);
  const code = valuesForKeys(value, ["ruleId", "ruleID", "code", "messageCode", "findingCode", "id"]);
  if (message && (code || valuesForKeys(value, ["severity", "level", "type"]))) {
    findings.push({
      rule_id: code == null ? null : String(code).slice(0, 120),
      severity: String(valuesForKeys(value, ["severity", "level", "type"]) || "warning"),
      message: String(message).slice(0, 2_000),
      uad_uid: valuesForKeys(value, ["uadUid", "uadUID", "uniqueId", "uniqueID"]),
      report_field_id: valuesForKeys(value, ["reportFieldId", "reportFieldID", "fieldId", "fieldID"]),
    });
  }
  Object.values(value).forEach((item) => collectJsonFindings(item, findings, depth + 1));
}

function xmlText(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "i"));
    if (match) return match[1].replace(/<[^>]+>/g, " ").replace(
      /&(lt|gt|amp|quot|apos);/g,
      (_entity, name) => {
        if (name === "lt") return "<";
        if (name === "gt") return ">";
        if (name === "amp") return "&";
        if (name === "quot") return '"';
        return "'";
      },
    ).trim();
  }
  return null;
}

function collectXmlFindings(body) {
  const findings = [];
  const blocks = body.match(/<(?:[A-Za-z0-9_-]+:)?(?:FINDING|MESSAGE|ERROR|VALIDATION_RESULT)\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?(?:FINDING|MESSAGE|ERROR|VALIDATION_RESULT)>/gi) || [];
  for (const block of blocks.slice(0, 2_000)) {
    const message = xmlText(block, ["MessageText", "FindingMessage", "Description", "Message", "Text"]);
    if (!message) continue;
    findings.push({
      rule_id: xmlText(block, ["RuleIdentifier", "RuleID", "MessageCode", "FindingCode", "Code"]),
      severity: xmlText(block, ["SeverityType", "Severity", "Level", "Type"]) || "warning",
      message: message.slice(0, 2_000),
      uad_uid: xmlText(block, ["UADUniqueIdentifier", "UniqueID", "UADUID"]),
      report_field_id: xmlText(block, ["ReportFieldIdentifier", "ReportFieldID", "FieldID"]),
    });
  }
  return findings;
}

function normalizeSeverity(value) {
  const severity = String(value || "").trim().toLowerCase();
  return /fatal|error|fail|critical|blocking/.test(severity) ? "fatal" : "warning";
}

export function parseUadComplianceResponse(response) {
  let findings = [];
  const body = String(response.body || "");
  const contentType = String(response.content_type || "").toLowerCase();
  if (contentType.includes("json")) {
    try {
      collectJsonFindings(JSON.parse(body), findings);
    } catch {
      throw new Error("uad_compliance_response_invalid");
    }
  } else if (contentType.includes("xml") || body.trim().startsWith("<")) {
    if (!body.trim().startsWith("<") || !body.trim().endsWith(">")) {
      throw new Error("uad_compliance_response_invalid");
    }
    findings = collectXmlFindings(body);
  } else {
    throw new Error("uad_compliance_response_invalid");
  }
  const normalized = findings.map((finding) => ({
    rule_id: finding.rule_id == null ? null : String(finding.rule_id).slice(0, 120),
    severity: normalizeSeverity(finding.severity),
    message: String(finding.message).slice(0, 2_000),
    uad_uid: finding.uad_uid == null ? null : String(finding.uad_uid).slice(0, 40),
    report_field_id: finding.report_field_id == null ? null : String(finding.report_field_id).slice(0, 40),
  }));
  return [...new Map(normalized.map((finding) => [
    [finding.rule_id, finding.severity, finding.message, finding.uad_uid, finding.report_field_id].join("\u0000"),
    finding,
  ])).values()];
}
