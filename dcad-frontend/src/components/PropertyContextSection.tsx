import type {
  PropertyComplexityAssessment,
  PropertyComplexityLevel,
} from "@/lib/api";
import { SummaryField } from "@/components/PropertyReportControls";

type PropertyContextSectionProps = {
  context: PropertyComplexityAssessment | null;
  loading: boolean;
  saving: boolean;
  message: string;
  complexity: PropertyComplexityLevel;
  notes: string;
  onAnalyze: () => void;
  onComplexityChange: (value: PropertyComplexityLevel) => void;
  onNotesChange: (value: string) => void;
  onSave: () => void;
};

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";
}

export default function PropertyContextSection({
  context,
  loading,
  saving,
  message,
  complexity,
  notes,
  onAnalyze,
  onComplexityChange,
  onNotesChange,
  onSave,
}: PropertyContextSectionProps) {
  return (
    <div className="mt-5 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Property Context &amp; Complexity</h3>
            {context ? (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                context.effective_complexity === "complex"
                  ? "bg-red-100 text-red-800"
                  : context.effective_complexity === "moderate"
                    ? "bg-amber-100 text-amber-900"
                    : "bg-emerald-100 text-emerald-800"
              }`}>
                {titleCase(context.effective_complexity)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
            Appraisal screening based on GLA, age, site size, amenities, parcel configuration,
            nearby land uses, and road influences. The appraiser remains responsible for the final determination.
          </p>
        </div>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={loading}
          className="btn btn-sm normal-case rounded-lg border-slate-900 bg-slate-900 text-white hover:bg-black disabled:opacity-60"
        >
          {loading ? "Analyzing..." : context ? "Refresh Context" : "Analyze Context"}
        </button>
      </div>

      {context ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryField
              label="Automatic Recommendation"
              value={`${titleCase(context.automatic_complexity)} (${context.score}/100)`}
            />
            <SummaryField label="Confidence" value={titleCase(context.confidence)} />
            <SummaryField
              label="Comparable Search Profile"
              value={context.recommended_search_profile
                .split("_")
                .map(titleCase)
                .join(" - ")}
            />
            <SummaryField
              label="Peer Properties"
              value={`${context.peer_statistics.peer_count.toLocaleString()} analyzed`}
            />
          </div>

          {context.factors.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {context.factors.map((factor) => (
                <div
                  key={factor.code}
                  className={`rounded-lg border px-3 py-2 ${
                    factor.severity === "high"
                      ? "border-red-200 bg-red-50"
                      : factor.severity === "moderate"
                        ? "border-amber-200 bg-amber-50"
                        : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 text-xs font-semibold text-slate-900">
                    <span>{factor.label}</span>
                    <span>+{factor.points}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-700">{factor.detail}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              No measured characteristic or location factor currently raises the automatic complexity score.
            </div>
          )}

          {context.warnings.length ? (
            <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-amber-950">
                Data coverage and source notices ({context.warnings.length})
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-950">
                {context.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </details>
          ) : null}

          <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 lg:grid-cols-[220px_minmax(0,1fr)_auto] lg:items-end">
            <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
              Appraiser Complexity
              <select
                value={complexity}
                onChange={(event) => onComplexityChange(event.target.value as PropertyComplexityLevel)}
                className="select select-bordered select-sm bg-white text-sm font-normal normal-case"
              >
                <option value="simple">Simple</option>
                <option value="moderate">Moderate</option>
                <option value="complex">Complex</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
              Review Notes
              <input
                value={notes}
                onChange={(event) => onNotesChange(event.target.value)}
                placeholder="Optional support for confirmation or override"
                className="input input-bordered input-sm bg-white text-sm font-normal normal-case"
              />
            </label>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="btn btn-sm normal-case rounded-lg border-slate-900 bg-slate-900 text-white hover:bg-black disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save Complexity Review"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Run the local context analysis to establish the assignment-complexity recommendation before selecting comparable sales.
        </div>
      )}

      {message ? <p className="mt-3 text-xs font-medium text-slate-700">{message}</p> : null}
    </div>
  );
}
