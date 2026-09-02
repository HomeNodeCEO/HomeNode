import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import PreviousAppraisalFiles from "@/components/PreviousAppraisalFiles";
import AssignmentDocumentCenter from "@/components/AssignmentDocumentCenter";

import {
  createUadWorkfile,
  getUadCapabilities,
  getUadSubjectSummary,
  listUadWorkfiles,
  type UadCapabilities,
  type UadPropertyType,
  type UadSectionKey,
  type UadWorkfile,
} from "../api";
import UadWorkfileEditor, { type UadWorkfileEditorHandle } from "../components/UadWorkfileEditor";

const PROPERTY_TYPE_LABELS: Record<UadPropertyType, string> = {
  traditional_single_family: "Traditional single-family",
  manufactured_home: "Manufactured home",
  two_to_four_unit: "Two-to-four-unit",
  condominium: "Condominium",
  cooperative: "Cooperative",
};

export default function UadWorkspaceEntry() {
  const { accountId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedWorkfileId = searchParams.get("workfileId");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(Boolean(accountId));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<UadCapabilities | null>(null);
  const [workfiles, setWorkfiles] = useState<UadWorkfile[]>([]);
  const [activeWorkfileId, setActiveWorkfileId] = useState<string | null>(null);
  const [editorRefreshToken, setEditorRefreshToken] = useState(0);
  const [editorInitialSection, setEditorInitialSection] = useState<UadSectionKey>("assignment");
  const workfileEditorRef = useRef<UadWorkfileEditorHandle>(null);
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
          if (!cancelled) {
            setWorkfiles(existingWorkfiles);
            if (requestedWorkfileId && existingWorkfiles.some((item) => item.id === requestedWorkfileId)) {
              setActiveWorkfileId(requestedWorkfileId);
            }
          }
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
  }, [accountId, requestedWorkfileId]);

  async function handleCreateWorkfile() {
    if (!accountId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const workfile = await createUadWorkfile(accountId, {
        assignment_purpose: "Mortgage finance appraisal",
      });
      setWorkfiles((current) => [workfile, ...current.filter((item) => item.id !== workfile.id)]);
      setEditorInitialSection("assignment");
      setActiveWorkfileId(workfile.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD workfile could not be created.");
    } finally {
      setCreating(false);
    }
  }

  function handleCloseReport() {
    if (workfileEditorRef.current) {
      void workfileEditorRef.current.closeReport();
      return;
    }
    navigate("/");
  }

  return (
    <div className="hn-app-shell">
      <div className="hn-app-header navbar shadow-sm">
        <div className="mx-auto w-full max-w-[1600px] px-4">
          <div className="flex w-full items-center justify-between gap-4">
            <div>
              <span className="hn-eyebrow block text-[10px]">HomeNode</span>
              <h1 className="text-xl font-semibold">UAD 3.6 Workspace</h1>
            </div>
            <button
              className="hn-action-secondary btn btn-ghost btn-sm normal-case"
              onClick={handleCloseReport}
              type="button"
            >
              ← Close Report
            </button>
          </div>
        </div>
      </div>

      <main className="px-4 py-8">
      <section className="hn-workspace-surface mx-auto w-full max-w-none rounded-2xl border p-6">
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

        <div className="mt-4 grid gap-2 md:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Property type</div>
            <div className="mt-0.5 text-sm font-medium">
              {displayedPropertyType ? PROPERTY_TYPE_LABELS[displayedPropertyType] : "Loading property type…"}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">UAD baseline</div>
            <div className="mt-0.5 break-words text-sm font-medium">
              {capabilities?.specification_release_key || "Loading specification…"}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Cloud assets</div>
            <div className="mt-0.5 text-sm font-medium">
              {capabilities?.object_storage.configured
                ? capabilities.object_storage.isolated
                  ? "Dedicated R2 ready"
                  : "R2 ready"
                : "R2 configuration pending"}
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
              className="hn-action-primary mt-4 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
              disabled={creating}
              onClick={handleCreateWorkfile}
              type="button"
            >
              {creating ? "Creating workfile…" : "Create single-family UAD workfile"}
            </button>
          </div>
        )}

        {workfiles.length > 0 && (
          <details className="group mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            <summary className="cursor-pointer list-none px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  <span className="block text-sm font-semibold text-slate-900">UAD workfiles for this subject</span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {workfiles.length} file{workfiles.length === 1 ? "" : "s"}{displayedWorkfile ? ` · ${displayedWorkfile.file_number}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <span className="group-open:hidden">Show files</span>
                  <span className="hidden group-open:inline">Hide files</span>
                  <span aria-hidden="true" className="transition-transform group-open:rotate-180">⌄</span>
                </span>
              </span>
            </summary>
            <div className="space-y-3 border-t border-slate-200 bg-white p-3">
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
                    className="hn-action-secondary mt-3 rounded-lg border px-3 py-2 text-sm font-semibold"
                    onClick={() => {
                      setEditorInitialSection("assignment");
                      setActiveWorkfileId(workfile.id);
                    }}
                    type="button"
                  >
                    {activeWorkfileId === workfile.id ? "Editor open" : "Open Assignment & Subject"}
                  </button>
                </article>
              ))}
            </div>
          </details>
        )}

        {activeWorkfileId ? (
          <AssignmentDocumentCenter
            accountId={accountId}
            className="mt-4"
            onUadApplied={(result) => {
              if (!result.applied) return;
              const listedWorkfile = workfiles.find((workfile) => workfile.id === activeWorkfileId);
              const nextRevision = result.current_revision || listedWorkfile?.current_revision || 0;
              if (
                listedWorkfile
                && nextRevision <= listedWorkfile.current_revision
                && (result.changed_field_count || 0) === 0
              ) return;
              setWorkfiles((current) => current.map((workfile) => (
                workfile.id === activeWorkfileId
                  ? {
                      ...workfile,
                      current_revision: nextRevision || workfile.current_revision,
                      updated_at: new Date().toISOString(),
                    }
                  : workfile
              )));
              setEditorInitialSection(result.section || "assignment");
              setEditorRefreshToken((current) => current + 1);
            }}
            subjectAddress={address}
            uadWorkfileId={activeWorkfileId}
          />
        ) : null}

        {activeWorkfileId && (
          <UadWorkfileEditor
            initialSection={editorInitialSection}
            key={`${activeWorkfileId}:${editorRefreshToken}`}
            onClose={() => navigate("/")}
            ref={workfileEditorRef}
            workfileId={activeWorkfileId}
          />
        )}

        {accountId ? <PreviousAppraisalFiles accountId={accountId} /> : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            className="hn-action-secondary rounded-lg border px-4 py-2 text-sm font-medium"
            to="/"
          >
            Back to property search
          </Link>
        </div>
      </section>
      </main>
    </div>
  );
}
