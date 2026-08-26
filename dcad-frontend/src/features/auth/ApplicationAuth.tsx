import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

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

type AuthState = {
  ready: boolean;
  configured: boolean;
  required: boolean;
  session: Session | null;
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
            if (active) setSession(body.session || null);
          }
        }
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
  }, []);

  const value = useMemo<AuthState>(() => ({
    ready,
    configured,
    required,
    session,
    signIn: () => { window.location.assign(authUrl('/api/auth/login')); },
    signOut: async () => {
      await fetch(authUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
      setSession(null);
    },
  }), [configured, ready, required, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useApplicationAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useApplicationAuth must be used inside ApplicationAuthProvider');
  return value;
}

export function ApplicationAuthGate({ children }: { children: React.ReactNode }) {
  const auth = useApplicationAuth();
  if (!auth.ready) {
    return <div className="min-h-screen grid place-items-center bg-slate-50 text-slate-600">Loading HomeNode…</div>;
  }
  // Preserve the existing editor-key workflow until production WorkOS values
  // and the first organization administrator have been provisioned.
  if (!auth.required || auth.session) return <>{children}</>;
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
