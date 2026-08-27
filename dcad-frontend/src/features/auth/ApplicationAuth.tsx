import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { setApplicationSessionActive } from '@/lib/editorCredential';

type Organization = {
  organization_id: string;
  display_name: string | null;
  roles: string[];
  permissions: Record<string, { read: boolean; write: boolean; sign: boolean }>;
};

type Session = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  organizations: Organization[];
};

type ReadinessBlocker = {
  code: string;
  count: number;
  group: string;
  organization_id?: string;
};

type AuthReadiness = {
  checked_at: string;
  activation_ready: boolean;
  blockers: ReadinessBlocker[];
  organizations: Array<{
    organization_id: string;
    legal_name: string | null;
    display_name: string | null;
    active: boolean;
    active_memberships: number;
    mapped_identities: number;
    active_appraiser_profiles: number;
    valid_appraiser_licenses: number;
    custom_assignment_files: number;
    uad_workfiles: number;
    property_tax_files: number;
  }>;
};

type AuthState = {
  ready: boolean;
  configured: boolean;
  required: boolean;
  session: Session | null;
  readiness: AuthReadiness | null;
  readinessError: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);
const API_BASE = String(
  (import.meta as any).env?.VITE_API_URL || (import.meta as any).env?.VITE_API_BASE || '',
).replace(/\/+$/, '');
const authUrl = (path: string) => `${API_BASE}${path}`;

export function ApplicationAuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [required, setRequired] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [readiness, setReadiness] = useState<AuthReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const statusResponse = await fetch(authUrl('/api/auth/status'), { credentials: 'include' });
        const status = statusResponse.ok
          ? await statusResponse.json()
          : { configured: false, required: false };
        if (!active) return;
        setConfigured(Boolean(status.configured));
        setRequired(Boolean(status.configured && status.required));
        if (status.configured) {
          const sessionResponse = await fetch(authUrl('/api/auth/me'), { credentials: 'include' });
          if (sessionResponse.ok) {
            const body = await sessionResponse.json();
            const nextSession = (body.session || null) as Session | null;
            if (active) setSession(nextSession);
            const canAuditReadiness = nextSession?.organizations.some((organization) =>
              organization.roles.some((role) => role === 'organization_admin' || role === 'homenode_admin'));
            if (canAuditReadiness) {
              const readinessResponse = await fetch(authUrl('/api/auth/readiness'), { credentials: 'include' });
              if (readinessResponse.ok) {
                const readinessBody = await readinessResponse.json();
                if (active) setReadiness(readinessBody.readiness || null);
              } else if (active) {
                setReadinessError('auth_readiness_unavailable');
              }
            }
          }
        }
      } catch {
        if (active) setReadinessError('authentication_status_unavailable');
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
    readiness,
    readinessError,
    signIn: () => { window.location.assign(authUrl('/api/auth/login')); },
    signOut: async () => {
      try {
        await fetch(authUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
      } finally {
        setSession(null);
        setReadiness(null);
        setReadinessError(null);
      }
    },
  }), [configured, readiness, readinessError, ready, required, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

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
      <aside className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950 shadow-sm">
        <span><strong>Secure accounts are ready.</strong> Sign in to verify your HomeNode access.</span>
        <button
          type="button"
          onClick={auth.signIn}
          className="rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white transition hover:bg-blue-800"
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
    <aside className="sticky top-0 z-50 border-b border-slate-200 bg-white/95 px-4 py-2 text-sm text-slate-700 shadow-sm backdrop-blur">
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <span className="font-semibold text-slate-950">{displayName}</span>
          {auth.session.email && auth.session.email !== displayName && (
            <span className="ml-2 text-slate-500">{auth.session.email}</span>
          )}
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${readinessClass}`}>{readinessLabel}</span>
        <details className="relative">
          <summary className="cursor-pointer select-none font-medium text-blue-700 hover:text-blue-900">
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
          className="ml-auto rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
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
    return <div className="min-h-screen grid place-items-center bg-slate-50 text-slate-600">Loading HomeNode…</div>;
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
    <main className="min-h-screen grid place-items-center bg-slate-100 px-6">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-blue-700">HomeNode</p>
        <h1 className="mt-3 text-3xl font-semibold text-slate-950">Sign in to your workspace</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Access appraisal assignments, reports, property-tax files, and UAD 3.6 workfiles securely.
        </p>
        <button
          type="button"
          onClick={auth.signIn}
          className="mt-7 w-full rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white transition hover:bg-blue-700"
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
