import { useEffect, useMemo, useState } from "react";

import {
  applyUadCompletionSuggestions,
  getUadSharedData,
  type UadCompletionApplyResult,
  type UadCompletionSuggestionEntity,
  type UadCompletionSuggestionField,
  type UadCompletionSuggestions,
  type UadEntity,
  type UadFieldDefinition,
  type UadSavedFieldValue,
} from "../api";

interface Props {
  workfileId: string;
  currentRevision: number;
  fields: UadFieldDefinition[];
  values: UadSavedFieldValue[];
  entities: UadEntity[];
  dirty: boolean;
  onApplied: (result: UadCompletionApplyResult) => Promise<void>;
}

function displayValue(value: unknown) {
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object" && "amount" in value) {
    const measurement = value as { amount?: unknown; unit?: unknown };
    return `${measurement.amount ?? ""} ${String(measurement.unit || "")}`.trim();
  }
  return String(value ?? "");
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}


function entityLabel(entity: UadCompletionSuggestionEntity) {
  if (entity.entity_type === "sales_comparable") {
    return `Comparable ${entity.ordinal}: ${String(entity.values["sales_comparable_address:1800.0001"] || "Address pending")}`;
  }
  return String(entity.values["market_price_trend_source:3000.0051"] || titleCase(entity.entity_type));
}

export default function UadCompletionSuggestionPanel({
  workfileId,
  currentRevision,
  fields,
  values,
  entities,
  dirty,
  onApplied,
}: Props) {
  const [document, setDocument] = useState<UadCompletionSuggestions | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getUadSharedData(workfileId)
      .then((response) => {
        if (!active) return;
        setDocument(response.suggestions.custom_completion);
        setSelected([]);
        setConfirmed(false);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "Custom Appraisal suggestions could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workfileId, currentRevision]);

  const definitions = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
  const existingRootKeys = useMemo(() => new Set(
    values.filter((value) => !value.entity_id).map((value) => `${value.context_key}:${value.uid}`),
  ), [values]);
  const existingEntityTypes = useMemo(() => new Set(entities.map((entity) => entity.entity_type)), [entities]);
  const suggestions = useMemo(() => {
    if (!document) return [];
    const suggestedFields = [
      ...document.suggestions.market_fields,
      ...document.suggestions.sales_comparison_fields,
    ].map((suggestion) => ({
      kind: "field" as const,
      suggestion,
      conflict: existingRootKeys.has(suggestion.field_key),
    }));
    const suggestedEntities = [
      ...document.suggestions.market_entities,
      ...document.suggestions.sales_comparable_entities,
    ].map((suggestion) => ({
      kind: "entity" as const,
      suggestion,
      conflict: existingEntityTypes.has(suggestion.entity_type),
    }));
    return [...suggestedFields, ...suggestedEntities];
  }, [document, existingEntityTypes, existingRootKeys]);
  const selectable = suggestions.filter((item) => !item.conflict).map((item) => item.suggestion.suggestion_id);

  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setConfirmed(false);
    setNotice(null);
  }

  async function handleApply() {
    if (!document || applying || dirty || !confirmed || !selected.length) return;
    if (!window.confirm(`Apply ${selected.length} reviewed Custom Appraisal suggestion${selected.length === 1 ? "" : "s"} to this UAD workfile? Existing UAD values will be preserved.`)) return;
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const result = await applyUadCompletionSuggestions(workfileId, {
        selected_suggestion_ids: selected,
        expected_source_digest_sha256: document.source_completion.source_digest_sha256,
        expected_adapter_version: document.adapter_version,
        expected_revision: currentRevision,
        preserve_existing: true,
        confirmed: true,
      });
      setSelected([]);
      setConfirmed(false);
      setNotice(`${result.applied_suggestion_count} suggestion${result.applied_suggestion_count === 1 ? "" : "s"} applied in revision ${result.current_revision}.${result.conflicts.length ? ` ${result.conflicts.length} existing item${result.conflicts.length === 1 ? " was" : "s were"} preserved.` : ""}`);
      await onApplied(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The selected suggestions could not be applied.");
    } finally {
      setApplying(false);
    }
  }

  if (loading && !document) {
    return <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">Checking for same-assignment Custom Appraisal suggestions…</div>;
  }
  if (!document && !error) return null;

  return (
    <section className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Custom Appraisal completion suggestions</h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-emerald-900">
            Review-only values from the exact same assignment and subject snapshot. Nothing is selected automatically, and existing UAD values are never replaced by this action.
          </p>
        </div>
        <button className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800" onClick={() => setExpanded((value) => !value)} type="button">
          {expanded ? "Hide suggestions" : `Review ${suggestions.length} suggestions`}
        </button>
      </div>
      {error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">{error}</p>}
      {notice && <p className="mt-3 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs text-emerald-950">{notice}</p>}
      {expanded && document && (
        <div className="mt-4 space-y-4 border-t border-emerald-200 pt-4">
          {document.status === "source_review_required" && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
              The Custom Appraisal still has readiness items. Only unambiguous mapped values are shown; review every selected item before applying it.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50" disabled={!selectable.length || applying} onClick={() => { setSelected(selectable); setConfirmed(false); }} type="button">Select available</button>
            <button className="rounded-lg border border-slate-400 bg-white px-3 py-2 text-xs font-semibold text-slate-900 disabled:opacity-50" disabled={!selected.length || applying} onClick={() => { setSelected([]); setConfirmed(false); }} type="button">Clear selection</button>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {suggestions.map((item) => {
              const suggestion = item.suggestion;
              const isField = item.kind === "field";
              const fieldSuggestion = isField ? suggestion as UadCompletionSuggestionField : null;
              const definition = fieldSuggestion ? definitions.get(fieldSuggestion.field_key) : null;
              return (
                <label className={`flex gap-3 rounded-lg border p-3 ${item.conflict ? "border-slate-200 bg-slate-100 text-slate-500" : "border-emerald-200 bg-white"}`} key={suggestion.suggestion_id}>
                  <input checked={selected.includes(suggestion.suggestion_id)} disabled={item.conflict || applying} onChange={() => toggle(suggestion.suggestion_id)} type="checkbox" />
                  <span className="min-w-0">
                    <span className="block font-medium">{isField ? definition?.label || fieldSuggestion?.field_key : entityLabel(suggestion as UadCompletionSuggestionEntity)}</span>
                    <span className="mt-1 block break-words text-xs">{isField ? displayValue(fieldSuggestion?.value) : `${Object.keys((suggestion as UadCompletionSuggestionEntity).values).length} mapped fields`}</span>
                    <span className="mt-1 block text-[11px]">{item.conflict ? "Existing UAD data preserved" : "Requires appraiser confirmation"}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {document.omissions.length > 0 && (
            <details className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <summary className="cursor-pointer font-medium text-amber-950">Review {document.omissions.length} items not mapped automatically</summary>
              <ul className="mt-2 space-y-1 text-xs text-amber-950">
                {document.omissions.map((omission, index) => <li key={`${omission.code}-${index}`}>• {titleCase(omission.code)}{omission.scope ? ` — ${omission.scope}` : ""}</li>)}
              </ul>
            </details>
          )}
          {dirty && <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">Save or discard the current unsaved UAD edits before applying suggestions.</p>}
          <label className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-white p-3 text-xs leading-5">
            <input checked={confirmed} disabled={!selected.length || dirty || applying} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
            I reviewed the selected values and omissions and confirm that these suggestions may be added to this UAD workfile. Existing UAD values must be preserved.
          </label>
          <button className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50" disabled={!selected.length || !confirmed || dirty || applying} onClick={() => void handleApply()} type="button">
            {applying ? "Applying reviewed suggestions…" : `Apply ${selected.length || "selected"} suggestion${selected.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </section>
  );
}
