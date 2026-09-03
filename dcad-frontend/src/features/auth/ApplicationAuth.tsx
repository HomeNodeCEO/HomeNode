import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { setApplicationSessionActive } from '@/lib/editorCredential';
import {
  authStatusFromResponse,
  readinessFromResponse,
  sessionFromResponse,
  type AuthReadiness,
  type Session,
} from './applicationAuthData';

type AuthState = {
  ready: boolean;
  configured: boolean;
  required: boolean;
  session: Session | null;
  bootstrapError: string | null;
  readiness: AuthReadiness | null;
  readinessError: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);
const API_BASE = String(
  import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE || '',
).replace(/\/+$/, '');
const authUrl = (path: string) => `${API_BASE}${path}`;
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

async function fetchAuthRequest(path: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(authUrl(path), {
      ...init,
      credentials: 'include',
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchAuthBootstrap(path: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchAuthRequest(path);
    } catch (error) {
      if (attempt === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 750));
        continue;
      }
      throw error;
    }
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      continue;
    }
    return response;
  }
  throw new Error('authentication_status_unavailable');
}

export function ApplicationAuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [required, setRequired] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<AuthReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const statusResponse = await fetchAuthBootstrap('/api/auth/status');
        if (!statusResponse.ok) throw new Error('authentication_status_unavailable');
        const statusBody: unknown = await statusResponse.json();
        const status = authStatusFromResponse(statusBody);
        if (!active) return;
        setConfigured(status.configured);
        setRequired(status.required);
        if (status.configured) {
          const sessionResponse = await fetchAuthBootstrap('/api/auth/me');
          if (sessionResponse.ok) {
            const body: unknown = await sessionResponse.json();
            const nextSession = sessionFromResponse(body);
            if (active) setSession(nextSession);
            const canAuditReadiness = nextSession?.organizations.some((organization) =>
              organization.roles.some((role) => role === 'organization_admin' || role === 'homenode_admin'));
            if (canAuditReadiness) {
              const readinessResponse = await fetchAuthRequest('/api/auth/readiness');
              if (readinessResponse.ok) {
                const readinessBody: unknown = await readinessResponse.json();
                const nextReadiness = readinessFromResponse(readinessBody);
                if (active && nextReadiness) setReadiness(nextReadiness);
                else if (active) setReadinessError('auth_readiness_unavailable');
              } else if (active) {
                setReadinessError('auth_readiness_unavailable');
              }
            }
          } else if (sessionResponse.status !== 401) throw new Error('authentication_status_unavailable');
        }
      } catch {
        if (active) setBootstrapError('authentication_status_unavailable');
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setApplicationSessionActive(Boolean(session));
    return () => setApplicationSessionActive(false);
  }, [session]);

  const value = useMemo<AuthState>(() => ({
    ready,
    configured,
    required,
    session,
    bootstrapError,
    readiness,
    readinessError,
    signIn: () => { window.location.assign(authUrl('/api/auth/login')); },
    signOut: async () => {
      try {
        await fetchAuthRequest('/api/auth/logout', { method: 'POST' });
      } finally {
        setSession(null);
        setReadiness(null);
        setReadinessError(null);
      }
    },
  }), [bootstrapError, configured, readiness, readinessError, ready, required, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// The provider and its hook intentionally share the private context.
// eslint-disable-next-line react-refresh/only-export-components
export function useApplicationAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useApplicationAuth must be used inside ApplicationAuthProvider');
  return value;
}

const WORKFLOW_LABELS: Record<string, string> = {
  custom_appraisal: 'Custom Appraisal',
  uad_3_6: 'UAD 3.6',
  property_tax_protest: 'Property Tax Protest',
};

function readableCode(code: string) {
  return code.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ApplicationSessionBar() {
  const auth = useApplicationAuth();
  if (!auth.configured) return null;
  if (!auth.session) {
    return (
      <aside className="hn-app-header sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-sm shadow-sm">
        <span><strong>Secure accounts are ready.</strong> Sign in to verify your HomeNode access.</span>
        <button
          type="button"
          onClick={auth.signIn}
          className="hn-action-gold rounded-lg px-4 py-2 font-semibold transition"
        >
          Sign in
        </button>
      </aside>
    );
  }

  const displayName = auth.session.display_name || auth.session.email || 'HomeNode user';
  const roles = [...new Set(auth.session.organizations.flatMap((organization) => organization.roles))];
  const canAuditReadiness = roles.some((role) => role === 'organization_admin' || role === 'homenode_admin');
  const readinessLabel = auth.readinessError
    ? 'Activation check unavailable'
    : auth.readiness?.activation_ready
      ? 'Authentication activation ready'
      : auth.readiness
        ? `${auth.readiness.blockers.length} activation blocker${auth.readiness.blockers.length === 1 ? '' : 's'}`
        : canAuditReadiness
          ? 'Checking activation readiness…'
          : 'Secure session active';
  const readinessClass = auth.readiness?.activation_ready
    ? 'bg-emerald-100 text-emerald-800'
    : auth.readiness || auth.readinessError
      ? 'bg-amber-100 text-amber-900'
      : 'bg-slate-100 text-slate-700';

  return (
    <aside className="hn-app-header sticky top-0 z-50 border-b px-4 py-2 text-sm shadow-sm">
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <span className="font-semibold text-white">{displayName}</span>
          {auth.session.email && auth.session.email !== displayName && (
            <span className="ml-2 text-violet-100">{auth.session.email}</span>
          )}
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${readinessClass}`}>{readinessLabel}</span>
        <details className="relative">
          <summary className="cursor-pointer select-none font-medium text-amber-200 hover:text-amber-100">
            Account and permissions
          </summary>
          <div className="absolute left-0 mt-2 max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] overflow-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            {auth.session.organizations.map((organization) => (
              <section key={organization.organization_id} className="not-last:mb-5">
                <h2 className="font-semibold text-slate-950">{organization.display_name || 'HomeNode organization'}</h2>
                <p className="mt-1 text-xs text-slate-500">Roles: {organization.roles.map(readableCode).join(', ') || 'None'}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {Object.entries(organization.permissions).map(([workflow, permission]) => (
                    <div key={workflow} className="rounded-xl bg-slate-50 p-3">
                      <p className="font-medium text-slate-900">{WORKFLOW_LABELS[workflow] || readableCode(workflow)}</p>
                      <p className="mt-1 text-xs text-slate-600">
                        {[
                          permission.read && 'Read',
                          permission.write && 'Edit',
                          permission.sign && 'Sign',
                        ].filter(Boolean).join(' · ') || 'No access'}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            ))}
            {auth.readiness && (
              <section className="mt-4 border-t border-slate-200 pt-4">
                <h2 className="font-semibold text-slate-950">Authentication activation audit</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Checked {new Date(auth.readiness.checked_at).toLocaleString()}
                </p>
                {auth.readiness.blockers.length === 0 ? (
                  <p className="mt-3 text-sm font-medium text-emerald-700">All ownership and identity gates passed.</p>
                ) : (
                  <ul className="mt-3 space-y-1 text-sm text-amber-900">
                    {auth.readiness.blockers.map((blocker, index) => (
                      <li key={`${blocker.code}-${blocker.organization_id || 'global'}-${index}`}>
                        {readableCode(blocker.code)}{blocker.count > 1 ? ` (${blocker.count})` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        </details>
        <button
          type="button"
          onClick={() => { void auth.signOut(); }}
          className="hn-action-secondary ml-auto rounded-lg border px-3 py-1.5 font-medium transition"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

export function ApplicationAuthGate({ children }: { children: React.ReactNode }) {
  const auth = useApplicationAuth();
  if (!auth.ready) {
    return <div className="route-loading">Loading HomeNode…</div>;
  }
  if (auth.bootstrapError) {
    return (
      <main className="hn-app-shell grid place-items-center px-6">
        <section className="hn-workspace-surface w-full max-w-md overflow-hidden rounded-3xl border p-8">
          <p className="hn-eyebrow text-xs tracking-[0.22em]">HomeNode</p>
          <h1 className="mt-3 text-2xl font-semibold text-slate-950">Secure workspace temporarily unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            HomeNode could not verify this browser session. Your appraisal data is unchanged; retry the connection.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="hn-action-primary mt-7 w-full rounded-xl px-5 py-3 font-semibold transition"
          >
            Retry connection
          </button>
        </section>
      </main>
    );
  }
  // Preserve the existing editor-key workflow until production WorkOS values
  // and the first organization administrator have been provisioned.
  if (!auth.required || auth.session) {
    return (
      <>
        <ApplicationSessionBar />
        {children}
      </>
    );
  }
  return (
    <main className="hn-app-shell grid place-items-center px-6">
      <section className="hn-workspace-surface w-full max-w-md overflow-hidden rounded-3xl border p-8">
        <p className="hn-eyebrow text-xs tracking-[0.22em]">HomeNode</p>
        <h1 className="mt-3 text-3xl font-semibold text-slate-950">Sign in to your workspace</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Access appraisal assignments, reports, property-tax files, and UAD 3.6 workfiles securely.
        </p>
        <button
          type="button"
          onClick={auth.signIn}
          className="hn-action-primary mt-7 w-full rounded-xl px-5 py-3 font-semibold transition"
        >
          Continue to secure sign in
        </button>
        <p className="mt-5 text-xs leading-5 text-slate-500">
          Passwords, account recovery, and multi-factor authentication are securely managed through HomeNode AuthKit.
        </p>
      </section>
    </main>
  );
}
