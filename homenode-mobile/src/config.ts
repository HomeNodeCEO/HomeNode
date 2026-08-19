export type MobileConfig = Readonly<{
  apiBaseUrl: string;
  oidcIssuer: string;
  clientId: string;
  redirectUri: string;
}>;

type Environment = Record<string, string | undefined>;

function httpsUrl(value: string | undefined, name: string, { allowLocal = false } = {}) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name}_required`);
  }
  const local = allowLocal
    && parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "10.0.2.2"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local) throw new Error(`${name}_must_use_https`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name}_invalid`);
  }
  return raw;
}

export function createMobileConfig(environment: Environment): MobileConfig {
  const clientId = String(
    environment.EXPO_PUBLIC_OIDC_CLIENT_ID
      || environment.EXPO_PUBLIC_WORKOS_CLIENT_ID
      || "",
  ).trim();
  if (!clientId || clientId.length > 200 || /[\s/?#]/.test(clientId)) {
    throw new Error("oidc_client_id_required");
  }
  return Object.freeze({
    apiBaseUrl: httpsUrl(environment.EXPO_PUBLIC_API_BASE_URL, "api_base_url", { allowLocal: true }),
    oidcIssuer: httpsUrl(environment.EXPO_PUBLIC_OIDC_ISSUER, "oidc_issuer"),
    clientId,
    redirectUri: "homenode://oauth/callback",
  });
}

export function loadMobileConfig(): MobileConfig {
  return createMobileConfig(process.env);
}
