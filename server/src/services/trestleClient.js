import { hasSourceValue } from "../util/nonDallasEnrichment.js";

const DEFAULT_BASE_URL = "https://api.cotality.com/trestle/odata";
const DEFAULT_TOKEN_URL = "https://api.cotality.com/trestle/oidc/connect/token";

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

  async request(path, searchParams = {}) {
    const token = await this.accessToken();
    const url = new URL(`${this.config.baseUrl}/${String(path).replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`trestle_http_${response.status}`);
    return response.json();
  }

  async findProperty({ listingKey, listingId, originatingSystemName } = {}) {
    const safeKey = String(listingKey ?? "").trim().replace(/'/g, "''");
    const safeId = String(listingId ?? "").trim().replace(/'/g, "''");
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
