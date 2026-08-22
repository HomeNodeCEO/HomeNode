const PLATFORM_DEFINITIONS = [
  {
    key: "valuelink_spur",
    display_name: "ValueLink / SPUR AMS",
    availability: "guided_manual_ready",
    direct_integration: "partner_documentation_required",
    host_suffixes: ["spurams.com"],
    capabilities: [
      "assignment_intake",
      "assignment_status",
      "inspection_scheduling",
      "secure_messages",
      "report_delivery",
      "revision_requests",
      "delivery_receipts",
    ],
    known_tenants: [
      {
        key: "amerimac",
        display_name: "AmeriMac Appraisal Management",
        hostname: "amerimacamc.spurams.com",
      },
    ],
  },
  {
    key: "appraisal_scope",
    display_name: "Appraisal Scope",
    availability: "guided_manual_ready",
    direct_integration: "partner_credentials_required",
    host_suffixes: ["appraisalscope.com"],
    capabilities: ["assignment_intake", "assignment_status", "report_delivery", "revision_requests"],
    known_tenants: [],
  },
  {
    key: "appraisalport",
    display_name: "AppraisalPort",
    availability: "guided_manual_ready",
    direct_integration: "partner_documentation_required",
    host_suffixes: ["appraisalport.com", "fncconnect.com"],
    capabilities: ["assignment_intake", "secure_messages", "report_delivery", "revision_requests"],
    known_tenants: [],
  },
  {
    key: "valutrac",
    display_name: "ValuTrac",
    availability: "guided_manual_ready",
    direct_integration: "partner_documentation_required",
    host_suffixes: [],
    capabilities: [
      "assignment_intake",
      "assignment_status",
      "inspection_scheduling",
      "secure_messages",
      "report_delivery",
      "revision_requests",
    ],
    known_tenants: [],
  },
  {
    key: "uwm_appraisal_direct",
    display_name: "UWM Appraisal Direct",
    availability: "guided_manual_ready",
    direct_integration: "partner_documentation_required",
    host_suffixes: [],
    capabilities: [
      "assignment_intake",
      "assignment_status",
      "inspection_scheduling",
      "secure_messages",
      "report_delivery",
      "revision_requests",
    ],
    known_tenants: [],
  },
  {
    key: "lenderx",
    display_name: "LenderX",
    availability: "guided_manual_ready",
    direct_integration: "partner_credentials_required",
    host_suffixes: ["lenderx.com", "lenderx-labs.com"],
    capabilities: ["assignment_intake", "assignment_status", "report_delivery", "revision_requests"],
    known_tenants: [],
  },
  {
    key: "mercury_network",
    display_name: "Mercury Network",
    availability: "guided_manual_ready",
    direct_integration: "partner_documentation_required",
    host_suffixes: ["mercuryvmp.com"],
    capabilities: ["assignment_intake", "assignment_status", "report_delivery", "revision_requests"],
    known_tenants: [],
  },
  {
    key: "generic_manual",
    display_name: "Other lender or AMC portal",
    availability: "guided_manual_ready",
    direct_integration: "not_configured",
    host_suffixes: [],
    capabilities: ["report_delivery", "delivery_receipts"],
    known_tenants: [],
  },
];

const PLATFORM_BY_KEY = new Map(PLATFORM_DEFINITIONS.map((platform) => [platform.key, platform]));

function publicPlatform(platform) {
  return Object.freeze({
    key: platform.key,
    display_name: platform.display_name,
    availability: platform.availability,
    delivery_mode: "guided_manual",
    direct_integration: platform.direct_integration,
    capabilities: Object.freeze([...platform.capabilities]),
    known_tenants: Object.freeze(platform.known_tenants.map((tenant) => Object.freeze({ ...tenant }))),
  });
}

export const DELIVERY_PLATFORMS = Object.freeze(PLATFORM_DEFINITIONS.map(publicPlatform));

function normalizePortalUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("delivery_portal_url_required");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("delivery_portal_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("delivery_portal_url_invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("delivery_portal_url_invalid");
  }
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return Object.freeze({
    hostname,
    portal_url: `${parsed.origin}${path}`,
  });
}

function hostnameMatches(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function inferredPlatform(hostname) {
  return PLATFORM_DEFINITIONS.find((platform) =>
    platform.key !== "generic_manual"
    && platform.host_suffixes.some((suffix) => hostnameMatches(hostname, suffix)))
    || PLATFORM_BY_KEY.get("generic_manual");
}

function tenantKey(hostname, platform, knownTenant) {
  if (knownTenant) return knownTenant.key;
  if (platform.key === "valuelink_spur") {
    const label = hostname.slice(0, -".spurams.com".length).split(".").filter(Boolean).at(-1);
    if (!label) throw new Error("delivery_spur_tenant_required");
    return label.replace(/[^a-z0-9_-]/g, "-").slice(0, 80);
  }
  return hostname.replace(/[^a-z0-9.-]/g, "-").slice(0, 120);
}

export function listDeliveryPlatforms() {
  return DELIVERY_PLATFORMS;
}

export function resolveDeliveryDestination({ portal_url: portalUrl, platform_key: platformKey } = {}) {
  const normalized = normalizePortalUrl(portalUrl);
  const inferred = inferredPlatform(normalized.hostname);
  const requestedKey = String(platformKey || "").trim();
  const platform = requestedKey ? PLATFORM_BY_KEY.get(requestedKey) : inferred;
  if (!platform) throw new Error("delivery_platform_invalid");
  if (
    requestedKey
    && platform.key !== "generic_manual"
    && platform.host_suffixes.length
    && !platform.host_suffixes.some((suffix) => hostnameMatches(normalized.hostname, suffix))
  ) {
    throw new Error("delivery_platform_host_mismatch");
  }
  const knownTenant = platform.known_tenants.find((tenant) => tenant.hostname === normalized.hostname) || null;
  const resolvedTenantKey = tenantKey(normalized.hostname, platform, knownTenant);
  return Object.freeze({
    platform: publicPlatform(platform),
    platform_key: platform.key,
    tenant_key: resolvedTenantKey,
    tenant_display_name: knownTenant?.display_name || null,
    known_tenant: Boolean(knownTenant),
    hostname: normalized.hostname,
    portal_url: normalized.portal_url,
    delivery_mode: "guided_manual",
    automated_submission: false,
  });
}

export function buildGuidedDeliveryPlan({ destination, attempt, artifact }) {
  if (!destination || !attempt || !artifact) throw new Error("delivery_plan_input_required");
  return Object.freeze({
    mode: "guided_manual",
    automated_submission: false,
    platform_key: destination.platform_key,
    tenant_key: destination.tenant_key,
    portal_url: destination.base_url,
    external_order_id: attempt.external_order_id || null,
    package: Object.freeze({
      artifact_id: artifact.id,
      content_type: artifact.content_type,
      byte_size: Number(artifact.byte_size),
      checksum_sha256: artifact.checksum_sha256,
      revision_number: Number(artifact.revision_number),
    }),
    steps: Object.freeze([
      "Confirm the portal assignment and engagement instructions match this HomeNode workfile.",
      "Download the immutable signed UAD 3.6 submission package for this revision.",
      "Sign in to the lender or AMC portal using the authorized user account and MFA.",
      "Upload the package and any client-required supporting documents.",
      "Review the portal preview and submit only after confirming the intended report and revision.",
      "Record the portal confirmation, receipt, or revision request in HomeNode.",
    ]),
    direct_integration_status: destination.direct_integration,
  });
}
