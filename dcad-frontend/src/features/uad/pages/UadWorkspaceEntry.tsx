import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  createUadWorkfile,
  getUadCapabilities,
  getUadSubjectSummary,
  listUadWorkfiles,
  type UadCapabilities,
  type UadPropertyType,
  type UadWorkfile,
} from "../api";
import UadWorkfileEditor from "../components/UadWorkfileEditor";

const PROPERTY_TYPE_LABELS: Record<UadPropertyType, string> = {
  traditional_single_family: "Traditional single-family",
  manufactured_home: "Manufactured home",
  two_to_four_unit: "Two-to-four-unit",
  condominium: "Condominium",
  cooperative: "Cooperative",
};

export default function UadWorkspaceEntry() {
  const { accountId = "" } = useParams();
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(Boolean(accountId));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<UadCapabilities | null>(null);
  const [workfiles, setWorkfiles] = useState<UadWorkfile[]>([]);
  const [activeWorkfileId, setActiveWorkfileId] = useState<string | null>(null);
  const displayedWorkfile = workfiles.find((workfile) => workfile.id === activeWorkfileId) || workfiles[0];
  const displayedPropertyType = displayedWorkfile?.property_type || capabilities?.initial_property_type;

  useEffect(() => {
    if (!accountId) {
      setLoading(false);
      setError("No subject property was selected.");
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getUadSubjectSummary(accountId), getUadCapabilities()])
      .then(async ([subjectResponse, capabilityResponse]) => {
        if (cancelled) return;
        setAddress(subjectResponse.address || "");
        setCapabilities(capabilityResponse);
        if (capabilityResponse.enabled) {
          const existingWorkfiles = await listUadWorkfiles(accountId);
          if (!cancelled) setWorkfiles(existingWorkfiles);
        }
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

  async function handleCreateWorkfile() {
    if (!accountId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const workfile = await createUadWorkfile(accountId, {
        assignment_purpose: "Mortgage finance appraisal",
      });
      setWorkfiles((current) => [workfile, ...current.filter((item) => item.id !== workfile.id)]);
      setActiveWorkfileId(workfile.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD workfile could not be created.");
    } finally {
      setCreating(false);
    }
  }

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

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Property type</div>
            <div className="mt-2 font-medium">
              {displayedPropertyType ? PROPERTY_TYPE_LABELS[displayedPropertyType] : "Loading property type…"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">UAD baseline</div>
            <div className="mt-2 break-words font-medium">
              {capabilities?.specification_release_key || "Loading specification…"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cloud assets</div>
            <div className="mt-2 font-medium">
              {capabilities?.object_storage.configured ? "R2 ready" : "R2 configuration pending"}
            </div>
          </div>
        </div>

        {capabilities && !capabilities.enabled && (
          <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
            The isolated UAD foundation is installed but not active in this environment. Activation requires the
            additive UAD migration and the <code>UAD_WORKSPACE_ENABLED</code> feature flag. Custom Appraisal and
            Property Tax Protest remain unchanged.
          </div>
        )}

        {capabilities?.enabled && workfiles.length === 0 && (
          <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <h2 className="font-semibold text-emerald-950">Start the first UAD workfile</h2>
            <p className="mt-2 text-sm leading-6 text-emerald-900">
              HomeNode will preserve an immutable snapshot of the current subject data and create the initial
              property, dwelling, and unit records. Source data remains reviewable and never silently replaces an
              appraiser-confirmed value.
            </p>
            <button
              className="mt-4 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={creating}
              onClick={handleCreateWorkfile}
              type="button"
            >
              {creating ? "Creating workfile…" : "Create single-family UAD workfile"}
            </button>
          </div>
        )}

        {workfiles.length > 0 && (
          <section className="mt-6">
            <h2 className="text-lg font-semibold">UAD workfiles for this subject</h2>
            <div className="mt-3 space-y-3">
              {workfiles.map((workfile) => (
                <article className="rounded-xl border border-slate-200 bg-white p-4" key={workfile.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{workfile.file_number}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {PROPERTY_TYPE_LABELS[workfile.property_type]} · Revision {workfile.current_revision} ·{" "}
                        {workfile.inspection_method} inspection
                      </div>
                    </div>
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-900">
                      {workfile.status}
                    </span>
                  </div>
                  <button
                    className="mt-3 rounded-lg border border-emerald-700 bg-white px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
                    onClick={() => setActiveWorkfileId(workfile.id)}
                    type="button"
                  >
                    {activeWorkfileId === workfile.id ? "Editor open" : "Open Assignment & Subject"}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {activeWorkfileId && (
          <UadWorkfileEditor
            key={activeWorkfileId}
            onClose={() => setActiveWorkfileId(null)}
            workfileId={activeWorkfileId}
          />
        )}

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
