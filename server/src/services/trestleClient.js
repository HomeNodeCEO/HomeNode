import { hasSourceValue } from "../util/nonDallasEnrichment.js";
import { readBoundedJsonResponse } from "../util/boundedResponse.js";

const DEFAULT_BASE_URL = "https://api.cotality.com/trestle/odata";
const DEFAULT_TOKEN_URL = "https://api.cotality.com/trestle/oidc/connect/token";
const MAX_TRESTLE_TOKEN_RESPONSE_BYTES = 256 * 1024;
const MAX_TRESTLE_API_RESPONSE_BYTES = 32 * 1024 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function optionalList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeOdataString(value) {
  return String(value ?? "").trim().replace(/'/g, "''");
}

function retryAfterMilliseconds(response, attempt, baseMilliseconds) {
  const raw = response?.headers?.get?.("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return Math.min(60_000, baseMilliseconds * (2 ** Math.max(0, attempt - 1)));
}

function quotaSnapshot(response) {
  const read = (name) => response?.headers?.get?.(name) || null;
  return {
    minute_limit: read("minute-quota-limit"),
    minute_remaining: read("minute-quota-remaining"),
    hour_limit: read("hour-quota-limit"),
    hour_remaining: read("hour-quota-remaining"),
  };
}

function trustedHttpsUrl(value, errorCode) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    throw new Error(errorCode);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error(errorCode);
  }
  return url;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Rejected provider bodies are best-effort cleanup only.
  }
}

async function readTrestleJson(response, maximumBytes, errorPrefix) {
  const tooLargeCode = `${errorPrefix}_response_too_large`;
  const unavailableCode = `${errorPrefix}_response_unavailable`;
  try {
    return await readBoundedJsonResponse(response, {
      maximumBytes,
      tooLargeCode,
      unavailableCode,
    });
  } catch (error) {
    const code = String(error?.message || "");
    if (code === tooLargeCode || code === unavailableCode) {
      throw new Error(code);
    }
    throw new Error(`${errorPrefix}_invalid_response`);
  }
}

export function trestleConfiguration(env = process.env) {
  const enabled = /^(1|true|yes)$/i.test(String(env.TRESTLE_ENABLED || ""));
  const replicationEnabled = /^(1|true|yes)$/i.test(
    String(env.TRESTLE_REPLICATION_ENABLED || ""),
  );
  const mediaEnabled = /^(1|true|yes)$/i.test(
    String(env.TRESTLE_MEDIA_ENABLED || ""),
  );
  const clientId = String(env.TRESTLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.TRESTLE_CLIENT_SECRET || "").trim();
  return {
    enabled,
    replicationEnabled,
    mediaEnabled,
    configured: Boolean(clientId && clientSecret),
    baseUrl: String(env.TRESTLE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    tokenUrl: String(env.TRESTLE_TOKEN_URL || DEFAULT_TOKEN_URL),
    clientId,
    clientSecret,
    scope: String(env.TRESTLE_SCOPE || "api").trim(),
    originatingSystemName: String(env.TRESTLE_ORIGINATING_SYSTEM_NAME || "").trim(),
    counties: optionalList(env.TRESTLE_COUNTIES),
    pageSize: boundedInteger(env.TRESTLE_PAGE_SIZE, 1_000, 1, 1_000),
    maximumPages: boundedInteger(env.TRESTLE_MAXIMUM_PAGES, 25, 1, 1_000),
    initialLookbackDays: boundedInteger(env.TRESTLE_INITIAL_LOOKBACK_DAYS, 730, 1, 3_650),
    overlapMinutes: boundedInteger(env.TRESTLE_CURSOR_OVERLAP_MINUTES, 10, 1, 1_440),
    requestTimeoutMs: boundedInteger(env.TRESTLE_REQUEST_TIMEOUT_MS, 45_000, 5_000, 120_000),
    retryAttempts: boundedInteger(env.TRESTLE_RETRY_ATTEMPTS, 5, 1, 10),
    retryBaseMs: boundedInteger(env.TRESTLE_RETRY_BASE_MS, 1_000, 100, 30_000),
  };
}

export function mapTrestleProperty(record = {}) {
  const first = (...values) => values.find(hasSourceValue) ?? null;
  const attachedValue = first(record.PropertyAttachedYN);
  return {
    bedrooms: first(record.BedroomsTotal),
    bathrooms_full: first(record.BathroomsFull),
    bathrooms_half: first(record.BathroomsHalf),
    living_area_sqft: first(record.LivingArea),
    site_size_sqft: first(record.LotSizeSquareFeet),
    attachment_type: typeof attachedValue === "boolean"
      ? (attachedValue ? "attached" : "detached")
      : attachedValue,
    housing_type: first(record.PropertySubType, record.StructureType),
    garage_spaces: first(record.GarageSpaces),
    pool: first(record.PoolPrivateYN),
    year_built: first(record.YearBuilt),
    sale_price: first(record.ClosePrice),
    sale_date: first(record.CloseDate),
    contract_date: first(record.PurchaseContractDate),
    listing_date: first(record.ListingContractDate),
    days_on_market: first(record.DaysOnMarket),
    concessions: first(record.ConcessionsAmount),
    financing_type: first(record.BuyerFinancing),
    fireplaces: first(record.FireplacesTotal),
    air_conditioning: first(record.Cooling),
    heating: first(record.Heating),
    stories: first(record.Stories),
    architectural_style: first(record.ArchitecturalStyle),
    construction_type: first(record.ConstructionMaterials),
    exterior_material: first(record.ExteriorFeatures),
  };
}

export class TrestleClient {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.config = trestleConfiguration(env);
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lastQuota = null;
  }

  status() {
    return {
      enabled: this.config.enabled,
      configured: this.config.configured,
      ready: this.config.enabled && this.config.configured,
      replication_enabled: this.config.replicationEnabled,
      replication_ready:
        this.config.enabled &&
        this.config.configured &&
        this.config.replicationEnabled,
      media_enabled: this.config.mediaEnabled,
      counties: this.config.counties,
      page_size: this.config.pageSize,
      maximum_pages: this.config.maximumPages,
      last_quota: this.lastQuota,
    };
  }

  async fetchWithRetry(url, options, errorPrefix) {
    const safeUrl = trustedHttpsUrl(url, `${errorPrefix}_endpoint_invalid`);
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetch(safeUrl, {
          ...options,
          redirect: "manual",
          signal: options?.signal || AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch {
        if (attempt === this.config.retryAttempts) {
          throw new Error(`${errorPrefix}_unavailable`);
        }
        await this.sleep(Math.min(60_000, this.config.retryBaseMs * (2 ** (attempt - 1))));
        continue;
      }
      this.lastQuota = quotaSnapshot(response);
      if (response.ok) return response;

      const status = Number.isInteger(response?.status)
        ? response.status
        : "unknown";
      const retryable = response?.status === 429 || response?.status >= 500;
      const retryDelay = retryable && attempt < this.config.retryAttempts
        ? retryAfterMilliseconds(response, attempt, this.config.retryBaseMs)
        : null;
      await cancelResponseBody(response);
      if (retryDelay == null) {
        throw new Error(`${errorPrefix}_http_${status}`);
      }
      await this.sleep(retryDelay);
    }
    throw new Error(`${errorPrefix}_unavailable`);
  }

  async accessToken() {
    if (!this.config.enabled) throw new Error("trestle_disabled");
    if (!this.config.configured) throw new Error("trestle_credentials_missing");
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: this.config.scope,
    });
    const tokenUrl = trustedHttpsUrl(
      this.config.tokenUrl,
      "trestle_token_endpoint_invalid",
    );
    const response = await this.fetchWithRetry(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }, "trestle_token");
    const payload = await readTrestleJson(
      response,
      MAX_TRESTLE_TOKEN_RESPONSE_BYTES,
      "trestle_token",
    );
    if (!payload?.access_token) throw new Error("trestle_token_missing");
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return this.token;
  }

  async request(path, searchParams = {}) {
    const base = trustedHttpsUrl(
      `${this.config.baseUrl}/`,
      "trestle_base_url_invalid",
    );
    if (base.search) throw new Error("trestle_base_url_invalid");
    const url = trustedHttpsUrl(
      new URL(String(path).replace(/^\/+/, ""), base),
      "trestle_untrusted_path",
    );
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error("trestle_untrusted_path");
    }
    const token = await this.accessToken();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetchWithRetry(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, "trestle");
    return readTrestleJson(
      response,
      MAX_TRESTLE_API_RESPONSE_BYTES,
      "trestle",
    );
  }

  async requestNextLink(nextLink) {
    const base = trustedHttpsUrl(
      `${this.config.baseUrl}/`,
      "trestle_base_url_invalid",
    );
    if (base.search) throw new Error("trestle_base_url_invalid");
    let url;
    try {
      url = trustedHttpsUrl(
        new URL(String(nextLink || ""), base),
        "trestle_untrusted_next_link",
      );
    } catch {
      throw new Error("trestle_untrusted_next_link");
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error("trestle_untrusted_next_link");
    }
    const token = await this.accessToken();
    const response = await this.fetchWithRetry(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, "trestle");
    return readTrestleJson(
      response,
      MAX_TRESTLE_API_RESPONSE_BYTES,
      "trestle",
    );
  }

  propertyChangesFilter({ modifiedAfter, counties = this.config.counties } = {}) {
    const clauses = [];
    const timestamp = new Date(modifiedAfter || 0);
    if (!Number.isFinite(timestamp.valueOf())) throw new Error("invalid_trestle_modified_after");
    clauses.push(`ModificationTimestamp gt ${timestamp.toISOString()}`);
    const countyClauses = (counties || [])
      .map(escapeOdataString)
      .filter(Boolean)
      .map((county) => `CountyOrParish eq '${county}'`);
    if (countyClauses.length) clauses.push(`(${countyClauses.join(" or ")})`);
    return clauses.join(" and ");
  }

  async propertyChangesPage({ modifiedAfter, nextLink, top, counties } = {}) {
    if (nextLink) return this.requestNextLink(nextLink);
    return this.request("Property", {
      "$filter": this.propertyChangesFilter({ modifiedAfter, counties }),
      "$orderby": "ModificationTimestamp asc,ListingKey asc",
      "$top": boundedInteger(top, this.config.pageSize, 1, 1_000),
    });
  }

  async mediaForProperty({ listingKey, top = 1_000 } = {}) {
    const key = escapeOdataString(listingKey);
    if (!key) throw new Error("missing_listing_identifier");
    const records = [];
    let nextLink = null;
    let pages = 0;
    do {
      const payload = nextLink
        ? await this.requestNextLink(nextLink)
        : await this.request("Media", {
          "$filter": `ResourceRecordKey eq '${key}'`,
          "$orderby": "Order asc,MediaKey asc",
          "$top": boundedInteger(top, 1_000, 1, 1_000),
        });
      records.push(...(Array.isArray(payload?.value) ? payload.value : []));
      nextLink = payload?.["@odata.nextLink"] || null;
      pages += 1;
      if (pages >= this.config.maximumPages && nextLink) {
        throw new Error("trestle_media_page_limit_reached");
      }
    } while (nextLink);
    return records;
  }

  async findProperty({ listingKey, listingId, originatingSystemName } = {}) {
    const safeKey = escapeOdataString(listingKey);
    const safeId = escapeOdataString(listingId);
    if (!safeKey && !safeId) throw new Error("missing_listing_identifier");
    const systemName = String(
      originatingSystemName || this.config.originatingSystemName || "",
    ).trim().replace(/'/g, "''");
    const clauses = [
      safeKey ? `ListingKey eq '${safeKey}'` : `ListingId eq '${safeId}'`,
    ];
    if (!safeKey && systemName) {
      clauses.push(`OriginatingSystemName eq '${systemName}'`);
    }
    const payload = await this.request("Property", {
      "$filter": clauses.join(" and "),
      "$top": 2,
    });
    if ((payload?.value?.length || 0) > 1) {
      throw new Error("ambiguous_listing_id");
    }
    const record = payload?.value?.[0] || null;
    return record ? { raw: record, attributes: mapTrestleProperty(record) } : null;
  }
}

export const trestleClientInternals = Object.freeze({
  MAX_TRESTLE_API_RESPONSE_BYTES,
  MAX_TRESTLE_TOKEN_RESPONSE_BYTES,
});
