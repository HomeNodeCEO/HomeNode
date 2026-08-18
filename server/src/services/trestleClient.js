import { hasSourceValue } from "../util/nonDallasEnrichment.js";

const DEFAULT_BASE_URL = "https://api.cotality.com/trestle/odata";
const DEFAULT_TOKEN_URL = "https://api.cotality.com/trestle/oidc/connect/token";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function escapeODataString(value) {
  return String(value ?? "").trim().replace(/'/g, "''");
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(60_000, retryAfter * 1_000);
  }
  return Math.min(30_000, 500 * 2 ** attempt);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function trestleConfiguration(env = process.env) {
  const enabled = /^(1|true|yes)$/i.test(String(env.TRESTLE_ENABLED || ""));
  const clientId = String(env.TRESTLE_CLIENT_ID || "").trim();
  const clientSecret = String(env.TRESTLE_CLIENT_SECRET || "").trim();
  return {
    enabled,
    configured: Boolean(clientId && clientSecret),
    baseUrl: String(env.TRESTLE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    tokenUrl: String(env.TRESTLE_TOKEN_URL || DEFAULT_TOKEN_URL),
    clientId,
    clientSecret,
    scope: String(env.TRESTLE_SCOPE || "api").trim(),
    originatingSystemName: String(env.TRESTLE_ORIGINATING_SYSTEM_NAME || "").trim(),
    pageSize: boundedInteger(env.TRESTLE_PAGE_SIZE, 1000, 1, 1000),
    requestTimeoutMs: boundedInteger(
      env.TRESTLE_REQUEST_TIMEOUT_MS,
      45_000,
      5_000,
      120_000,
    ),
    maximumRetries: boundedInteger(env.TRESTLE_MAX_RETRIES, 4, 0, 8),
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
    parcel_number: first(record.ParcelNumber, record.TaxLegalDescription),
    listing_key: first(record.ListingKey),
    listing_id: first(record.ListingId),
    status: first(record.StandardStatus, record.MlsStatus),
    address: first(record.UnparsedAddress, record.StreetNumber && record.StreetName
      ? `${record.StreetNumber} ${record.StreetName}`
      : null),
    city: first(record.City, record.PostalCity),
    county: first(record.CountyOrParish),
    postal_code: first(record.PostalCode),
    latitude: first(record.Latitude),
    longitude: first(record.Longitude),
    list_price: first(record.ListPrice),
    original_list_price: first(record.OriginalListPrice),
    modification_timestamp: first(record.ModificationTimestamp),
  };
}

export class TrestleClient {
  constructor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
    this.config = trestleConfiguration(env);
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  status() {
    return {
      enabled: this.config.enabled,
      configured: this.config.configured,
      ready: this.config.enabled && this.config.configured,
      base_url: this.config.baseUrl,
      page_size: this.config.pageSize,
    };
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
    const response = await this.fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) throw new Error(`trestle_token_http_${response.status}`);
    const payload = await response.json();
    if (!payload?.access_token) throw new Error("trestle_token_missing");
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return this.token;
  }

  requestUrl(path, searchParams = {}) {
    const requested = String(path || "");
    const url = /^https:\/\//i.test(requested)
      ? new URL(requested)
      : new URL(`${this.config.baseUrl}/${requested.replace(/^\/+/, "")}`);
    const allowed = new URL(this.config.baseUrl);
    if (url.origin !== allowed.origin || !url.pathname.startsWith(allowed.pathname)) {
      throw new Error("trestle_untrusted_next_link");
    }
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async requestRaw(path, searchParams = {}, { accept = "application/json" } = {}) {
    const token = await this.accessToken();
    const url = this.requestUrl(path, searchParams);
    let lastResponse = null;
    for (let attempt = 0; attempt <= this.config.maximumRetries; attempt += 1) {
      const response = await this.fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept,
          "user-agent": "HomeNode-Trestle/1.0",
        },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      lastResponse = response;
      if (response.ok) return response;
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
      if (attempt < this.config.maximumRetries) {
        await wait(retryDelayMs(response, attempt));
      }
    }
    throw new Error(`trestle_http_${lastResponse?.status || "unknown"}`);
  }

  async request(path, searchParams = {}) {
    const response = await this.requestRaw(path, searchParams);
    return response.json();
  }

  async metadata() {
    const response = await this.requestRaw("$metadata", {}, {
      accept: "application/xml",
    });
    return response.text();
  }

  async propertyPage({
    modifiedAfter = null,
    nextLink = null,
    pageSize = this.config.pageSize,
    select = null,
    originatingSystemName = this.config.originatingSystemName,
  } = {}) {
    if (nextLink) return this.request(nextLink);
    const clauses = [];
    if (modifiedAfter) {
      const timestamp = new Date(modifiedAfter);
      if (Number.isNaN(timestamp.getTime())) throw new Error("invalid_trestle_watermark");
      clauses.push(`ModificationTimestamp gt ${timestamp.toISOString()}`);
    }
    const systemName = escapeODataString(originatingSystemName);
    if (systemName) clauses.push(`OriginatingSystemName eq '${systemName}'`);
    return this.request("Property", {
      "$filter": clauses.length ? clauses.join(" and ") : null,
      "$orderby": "ModificationTimestamp,ListingKey",
      "$select": Array.isArray(select) ? select.join(",") : select,
      "$top": boundedInteger(pageSize, this.config.pageSize, 1, 1000),
      PrettyEnums: "true",
    });
  }

  async mediaForListing(listingKey, { top = 100 } = {}) {
    const safeKey = escapeODataString(listingKey);
    if (!safeKey) throw new Error("missing_listing_identifier");
    return this.request("Media", {
      "$filter": `ResourceRecordKey eq '${safeKey}'`,
      "$orderby": "Order",
      "$top": boundedInteger(top, 100, 1, 1000),
    });
  }

  async findProperty({ listingKey, listingId, originatingSystemName } = {}) {
    const safeKey = escapeODataString(listingKey);
    const safeId = escapeODataString(listingId);
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
