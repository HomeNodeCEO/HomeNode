import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getAccount } from "@/lib/api";

export default function UadWorkspaceEntry() {
  const { accountId = "" } = useParams();
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(Boolean(accountId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) {
      setLoading(false);
      setError("No subject property was selected.");
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    getAccount(accountId)
      .then((response) => {
        if (!cancelled) setAddress(response.account?.address || "");
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Subject information could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-950">
      <section className="mx-auto max-w-4xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
          UAD 3.6 appraisal
        </div>
        <h1 className="mt-2 text-3xl font-semibold">UAD 3.6 Workspace</h1>
        <p className="mt-3 text-sm text-slate-600">
          {loading
            ? "Loading the selected subject property…"
            : address || (accountId ? `Account ${accountId}` : "No subject selected")}
        </p>
        {accountId && <p className="mt-1 text-xs text-slate-500">Parcel / account {accountId}</p>}

        {error && (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {error}
          </div>
        )}

        <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <h2 className="font-semibold text-emerald-950">Workspace entry is ready</h2>
          <p className="mt-2 text-sm leading-6 text-emerald-900">
            This route is isolated from the Custom Appraisal and Property Tax Protest workspaces. The next UAD
            foundation step will create the persistent UAD workfile, snapshot the subject data, and begin the
            Assignment and Subject sections here.
          </p>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            to="/"
          >
            Back to property search
          </Link>
        </div>
      </section>
    </main>
  );
}
