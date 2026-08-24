export interface HomeNodeBrowserAuthentication {
  getAccessToken: () => string | null | Promise<string | null>;
}

declare global {
  interface Window {
    homenodeAuth?: HomeNodeBrowserAuthentication;
  }
}

function normalizedToken(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function getUadAccessToken() {
  if (typeof window === "undefined" || !window.homenodeAuth?.getAccessToken) return null;
  return normalizedToken(await window.homenodeAuth.getAccessToken());
}

export async function withUadAuthorization(init: RequestInit = {}): Promise<RequestInit> {
  const accessToken = await getUadAccessToken();
  if (!accessToken) return init;

  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${accessToken}`);
  return { ...init, headers };
}
