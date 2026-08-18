import * as AuthSession from "expo-auth-session";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { MobileConfig } from "../config";
import { clearActiveOfflineUser } from "../offline/store";

WebBrowser.maybeCompleteAuthSession();

const ACCESS_TOKEN_KEY = "homenode.mobile.access-token.v1";
const REFRESH_TOKEN_KEY = "homenode.mobile.refresh-token.v1";
const TOKEN_METADATA_KEY = "homenode.mobile.token-metadata.v1";

type StoredSession = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  issuedAt: number;
};

type AuthContextValue = {
  ready: boolean;
  signedIn: boolean;
  busy: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function clearStoredSession() {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(TOKEN_METADATA_KEY),
  ]);
}

async function storeSession(session: StoredSession) {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, session.accessToken);
  if (session.refreshToken) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, session.refreshToken);
  } else {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  }
  await SecureStore.setItemAsync(TOKEN_METADATA_KEY, JSON.stringify({
    expiresIn: session.expiresIn,
    issuedAt: session.issuedAt,
  }));
}

async function loadStoredSession(): Promise<StoredSession | null> {
  const [accessToken, refreshToken, metadataValue] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
    SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.getItemAsync(TOKEN_METADATA_KEY),
  ]);
  if (!accessToken || !metadataValue) return null;
  try {
    const metadata = JSON.parse(metadataValue) as { expiresIn?: number; issuedAt?: number };
    if (!Number.isFinite(metadata.issuedAt)) throw new Error("invalid_session");
    return {
      accessToken,
      refreshToken: refreshToken || undefined,
      expiresIn: Number.isFinite(metadata.expiresIn) ? metadata.expiresIn : undefined,
      issuedAt: Number(metadata.issuedAt),
    };
  } catch {
    await clearStoredSession();
    return null;
  }
}

function tokenSession(response: AuthSession.TokenResponse, fallbackRefreshToken?: string): StoredSession {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken || fallbackRefreshToken,
    expiresIn: response.expiresIn,
    issuedAt: response.issuedAt,
  };
}

function isFresh(session: StoredSession) {
  if (session.expiresIn == null) return true;
  return session.issuedAt + session.expiresIn - 60 > Date.now() / 1000;
}

export function AuthProvider({ config, children }: { config: MobileConfig; children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [discovery, setDiscovery] = useState<AuthSession.DiscoveryDocument | null>(null);
  const refreshPromise = useRef<Promise<StoredSession> | null>(null);
  const nonce = useMemo(() => Crypto.randomUUID(), []);
  const [request, response, promptAsync] = AuthSession.useAuthRequest({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes: ["openid", "profile", "email", "offline_access"],
    usePKCE: true,
    extraParams: { nonce },
  }, discovery);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [storedResult, discoveryResult] = await Promise.allSettled([
        loadStoredSession(),
        AuthSession.fetchDiscoveryAsync(config.oidcIssuer),
      ]);
      if (!active) return;
      if (storedResult.status === "fulfilled") setSession(storedResult.value);
      if (discoveryResult.status === "fulfilled") {
        setDiscovery(discoveryResult.value);
      } else if (storedResult.status !== "fulfilled" || !storedResult.value) {
        setError(discoveryResult.reason instanceof Error
          ? discoveryResult.reason.message
          : "oidc_discovery_failed");
      }
      setReady(true);
    })();
    return () => { active = false; };
  }, [config.oidcIssuer]);

  useEffect(() => {
    if (!response || response.type === "dismiss" || response.type === "cancel") return;
    if (response.type !== "success") {
      setError(response.type === "error" ? response.error?.message || "sign_in_failed" : `sign_in_${response.type}`);
      setBusy(false);
      return;
    }
    const code = response.params.code;
    const codeVerifier = request?.codeVerifier;
    if (!code || !codeVerifier || !discovery) {
      setError("sign_in_state_unavailable");
      setBusy(false);
      return;
    }
    void (async () => {
      try {
        const exchanged = await AuthSession.exchangeCodeAsync({
          clientId: config.clientId,
          code,
          redirectUri: config.redirectUri,
          extraParams: { code_verifier: codeVerifier },
        }, discovery);
        const next = tokenSession(exchanged);
        await storeSession(next);
        setSession(next);
        setError(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "token_exchange_failed");
      } finally {
        setBusy(false);
      }
    })();
  }, [config.clientId, config.redirectUri, discovery, request, response]);

  const getAccessToken = useCallback(async () => {
    if (!session) throw new Error("authentication_required");
    if (isFresh(session)) return session.accessToken;
    if (!session.refreshToken || !discovery) {
      await clearStoredSession();
      setSession(null);
      throw new Error("session_expired");
    }
    if (!refreshPromise.current) {
      refreshPromise.current = (async () => {
        try {
          const refreshed = await AuthSession.refreshAsync({
            clientId: config.clientId,
            refreshToken: session.refreshToken,
            scopes: ["openid", "profile", "email", "offline_access"],
          }, discovery);
          const next = tokenSession(refreshed, session.refreshToken);
          await storeSession(next);
          setSession(next);
          return next;
        } catch (reason) {
          await clearStoredSession();
          setSession(null);
          throw reason;
        } finally {
          refreshPromise.current = null;
        }
      })();
    }
    return (await refreshPromise.current).accessToken;
  }, [config.clientId, discovery, session]);

  const signIn = useCallback(async () => {
    if (!request || !discovery) throw new Error("sign_in_not_ready");
    setBusy(true);
    setError(null);
    const result = await promptAsync();
    if (result.type === "cancel" || result.type === "dismiss") setBusy(false);
  }, [discovery, promptAsync, request]);

  const signOut = useCallback(async () => {
    const prior = session;
    setSession(null);
    setError(null);
    await Promise.all([clearStoredSession(), clearActiveOfflineUser()]);
    if (prior && discovery?.revocationEndpoint) {
      await AuthSession.revokeAsync({
        clientId: config.clientId,
        token: prior.refreshToken || prior.accessToken,
      }, discovery).catch(() => false);
    }
  }, [config.clientId, discovery, session]);

  const value = useMemo<AuthContextValue>(() => ({
    ready,
    signedIn: Boolean(session),
    busy,
    error,
    signIn,
    signOut,
    getAccessToken,
  }), [busy, error, getAccessToken, ready, session, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
