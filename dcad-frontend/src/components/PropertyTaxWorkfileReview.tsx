import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getPropertyTaxProtestFile,
  updatePropertyTaxInspectionSketch,
  updatePropertyTaxProtestFile,
  type PropertyTaxProtestFile,
} from '@/lib/api';
import { editorCredentialForRequest } from '@/lib/editorCredential';
import MobileSketchReview from '@/components/MobileSketchReview';
import SketchWorkspaceEmptyState from '@/components/SketchWorkspaceEmptyState';

type FieldSpec = {
  path: [string, string];
  label: string;
  group: string;
  kind: 'text' | 'number' | 'select';
  options?: string[];
  multiline?: boolean;
};

const CONDITION_OPTIONS = ['C1', 'C2-C1', 'C2', 'C3-C2', 'C3', 'C4-C3', 'C4', 'C5-C4', 'C5', 'C6-C5', 'C6'];
const QUALITY_OPTIONS = ['Q1', 'Q2-Q1', 'Q2', 'Q3-Q2', 'Q3', 'Q4-Q3', 'Q4', 'Q5-Q4', 'Q5', 'Q6-Q5', 'Q6'];

const FIELDS: FieldSpec[] = [
  { path: ['subject', 'condition_rating'], label: 'Overall condition rating', group: 'Subject', kind: 'select', options: CONDITION_OPTIONS },
  { path: ['subject', 'quality_rating'], label: 'Quality rating', group: 'Subject', kind: 'select', options: QUALITY_OPTIONS },
  { path: ['subject', 'living_area_sqft'], label: 'Living area (sq ft)', group: 'Subject', kind: 'number' },
  { path: ['subject', 'bedroom_count'], label: 'Bedrooms', group: 'Subject', kind: 'number' },
  { path: ['subject', 'bath_count'], label: 'Total baths', group: 'Subject', kind: 'number' },
  { path: ['subject', 'condition_notes'], label: 'Condition notes', group: 'Subject', kind: 'text', multiline: true },
  { path: ['condition', 'defects_deferred_maintenance'], label: 'Defects / deferred maintenance', group: 'Condition & repairs', kind: 'text', multiline: true },
  { path: ['condition', 'repair_cost_to_cure'], label: 'Repair cost to cure', group: 'Condition & repairs', kind: 'number' },
  { path: ['condition', 'repair_cost_to_cure_notes'], label: 'Cost-to-cure support', group: 'Condition & repairs', kind: 'text', multiline: true },
  { path: ['valuation', 'tax_year'], label: 'Tax year', group: 'Valuation', kind: 'number' },
  { path: ['valuation', 'district_appraised_value'], label: 'District appraised value', group: 'Valuation', kind: 'number' },
  { path: ['valuation', 'requested_market_value'], label: 'Requested market value', group: 'Valuation', kind: 'number' },
  { path: ['valuation', 'appraiser_opinion_of_value'], label: 'Appraiser opinion of value', group: 'Valuation', kind: 'number' },
  { path: ['analysis', 'sales_comparison_notes'], label: 'Sales comparison analysis', group: 'Analysis', kind: 'text', multiline: true },
  { path: ['analysis', 'adjustment_notes'], label: 'Adjustment support', group: 'Analysis', kind: 'text', multiline: true },
  { path: ['analysis', 'district_evidence_summary'], label: 'District evidence summary', group: 'Analysis', kind: 'text', multiline: true },
  { path: ['analysis', 'protest_rationale'], label: 'Protest rationale', group: 'Analysis', kind: 'text', multiline: true },
  { path: ['inspection', 'appraiser_comments'], label: 'Appraiser field comments', group: 'Inspection', kind: 'text', multiline: true },
];

function keyFor(field: FieldSpec) {
  return field.path.join('.');
}

function readNested(source: Record<string, unknown>, path: [string, string]) {
  const group = source[path[0]];
  if (!group || typeof group !== 'object' || Array.isArray(group)) return '';
  const value = (group as Record<string, unknown>)[path[1]];
  return value == null ? '' : String(value);
}

function buildValues(file: PropertyTaxProtestFile) {
  return Object.fromEntries(FIELDS.map((field) => [keyFor(field), readNested(file.workfile_data, field.path)]));
}

function mergeValues(file: PropertyTaxProtestFile, values: Record<string, string>) {
  const next = structuredClone(file.workfile_data);
  for (const field of FIELDS) {
    const [groupKey, valueKey] = field.path;
    const currentGroup = next[groupKey];
    const group = currentGroup && typeof currentGroup === 'object' && !Array.isArray(currentGroup)
      ? { ...(currentGroup as Record<string, unknown>) }
      : {};
    const raw = values[keyFor(field)]?.trim() || '';
    if (!raw) delete group[valueKey];
    else if (field.kind === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`${field.label} requires a valid number.`);
      group[valueKey] = parsed;
    } else {
      group[valueKey] = raw;
    }
    next[groupKey] = group;
  }
  return next;
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function PropertyTaxWorkfileReview({ accountId, fileId }: { accountId: string; fileId?: string | null }) {
  const [file, setFile] = useState<PropertyTaxProtestFile | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sketchRefreshing, setSketchRefreshing] = useState(false);
  const sketchRefreshInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = useMemo(() => Array.from(new Set(FIELDS.map((field) => field.group))), []);

  const load = async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getPropertyTaxProtestFile(accountId, fileId || undefined);
      setFile(result);
      setValues(result ? buildValues(result) : {});
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'The canonical protest file could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // load is scoped to the active account and intentionally refreshed when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, fileId]);

  const activeFileId = file?.tax_protest_file_id || null;
  const refreshSketchEvidence = useCallback(async () => {
    if (!accountId || !activeFileId || sketchRefreshInFlight.current) return;
    sketchRefreshInFlight.current = true;
    setSketchRefreshing(true);
    try {
      const refreshed = await getPropertyTaxProtestFile(accountId, activeFileId);
      if (!refreshed) return;
      setFile((current) => current?.tax_protest_file_id === refreshed.tax_protest_file_id
        ? {
            ...current,
            sketch: refreshed.sketch,
            photos: refreshed.photos,
            registry_revision: refreshed.registry_revision,
            updated_at: refreshed.updated_at,
          }
        : current);
    } catch {
      // A background sync failure must never disturb the active workfile draft.
    } finally {
      sketchRefreshInFlight.current = false;
      setSketchRefreshing(false);
    }
  }, [accountId, activeFileId]);

  useEffect(() => {
    if (!activeFileId || file?.sketch) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshSketchEvidence();
    };
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [activeFileId, file?.sketch, refreshSketchEvidence]);

  const save = async () => {
    if (!file) return;
    const editorKey = editorCredentialForRequest();
    if (!editorKey) {
      setError('Sign in or enter an editor key before saving canonical property-tax data.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await updatePropertyTaxProtestFile(
        accountId,
        file.tax_protest_file_id,
        {
          expected_revision: file.revision,
          workfile_data: mergeValues(file, values),
          reviewer: 'HomeNode desktop review',
        },
        editorKey,
      );
      const refreshed = await getPropertyTaxProtestFile(accountId, saved.tax_protest_file_id);
      const current = refreshed || saved;
      setFile(current);
      setValues(buildValues(current));
      setNotice(`Saved revision ${current.revision}. Earlier revisions remain in the audit history.`);
    } catch (saveError: unknown) {
      const message = saveError instanceof Error ? saveError.message : 'The canonical protest file could not be saved.';
      if (message === 'property_tax_protest_revision_conflict') {
        setError('A newer revision exists. The latest canonical values were reloaded; review them before saving again.');
        await load();
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!accountId) return null;

  return (
    <section className="mt-4 rounded-2xl border border-blue-200 bg-blue-50/60 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Canonical mobile workfile</div>
          <h2 className="mt-1 text-xl font-semibold">Accepted field evidence review</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-700">
            Only mobile changes explicitly accepted during review appear here. Saving creates a new revision and preserves the prior file history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || saving}
          className="rounded-md border border-blue-300 bg-white px-4 py-2 text-sm font-semibold text-blue-800 hover:bg-blue-50 disabled:opacity-60"
        >
          {loading ? 'Refreshing…' : 'Refresh canonical file'}
        </button>
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
      {notice && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}

      {!loading && !file && !error && (
        <div className="mt-4 rounded-xl border border-dashed border-blue-300 bg-white p-4 text-sm text-slate-700">
          No Property Tax Protest file exists for this property yet. Creating one from the mobile assignment picker will add it here without overwriting earlier appraisal files.
        </div>
      )}

      {file && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="File number" value={file.file_number} />
            <Metric label="Revision" value={String(file.revision)} />
            <Metric label="Status" value={file.status.replaceAll('_', ' ')} />
            <Metric label="Verified photos" value={String(file.photos?.verified_count || 0)} />
            <Metric label="Sketch" value={file.sketch ? `Revision ${file.sketch.revision} · ${file.sketch.review_status}` : 'Not started'} />
          </div>
          <p className="mt-2 text-xs text-slate-500">Last updated {formatDate(file.updated_at)}</p>

          <div className="mt-5 space-y-4">
            {groups.map((group) => (
              <fieldset key={group} className="rounded-xl border border-slate-200 bg-white p-4">
                <legend className="px-1 text-sm font-semibold text-slate-800">{group}</legend>
                <div className="grid gap-4 md:grid-cols-2">
                  {FIELDS.filter((field) => field.group === group).map((field) => {
                    const key = keyFor(field);
                    const controlClass = 'mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200';
                    return (
                      <label key={key} className={field.multiline ? 'md:col-span-2' : ''}>
                        <span className="text-sm font-medium text-slate-700">{field.label}</span>
                        {field.kind === 'select' ? (
                          <select className={controlClass} value={values[key] || ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}>
                            <option value="">Not entered</option>
                            {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        ) : field.multiline ? (
                          <textarea className={controlClass} rows={4} value={values[key] || ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
                        ) : (
                          <input className={controlClass} type={field.kind === 'number' ? 'number' : 'text'} step="any" value={values[key] || ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
                        )}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>

          {file.photos?.items?.length > 0 && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-slate-800">Verified mobile photo index</h3>
              <ul className="mt-2 grid gap-2 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
                {file.photos.items.map((photo) => (
                  <li key={photo.id} className="rounded-md bg-slate-50 px-3 py-2">
                    <span className="font-medium">{photo.room_label || photo.category}</span>
                    {photo.caption && <span className="block text-xs text-slate-500">{photo.caption}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {file.sketch?.document ? (
            <MobileSketchReview
              sketch={file.sketch}
              title="Property Tax Protest measured sketch editor"
              subtitle="Changes create a new audited inspection-sketch revision for this protest file only."
              saveDraft={(draft) => updatePropertyTaxInspectionSketch(
                accountId,
                file.tax_protest_file_id,
                file.sketch!,
                draft,
              )}
              onSaved={(savedSketch) => setFile((current) => current ? { ...current, sketch: savedSketch } : current)}
            />
          ) : (
            <SketchWorkspaceEmptyState
              title="Property Tax Protest measured sketch"
              subtitle={`No measured sketch is synchronized to ${file.file_number} yet. This area checks for accepted mobile evidence every 30 seconds while the page is visible.`}
              onRefresh={refreshSketchEvidence}
              refreshing={sketchRefreshing}
            />
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-3xl text-xs text-slate-600">
              Saving is guarded by the current revision. If another reviewer saves first, this page reloads instead of replacing their work.
            </p>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || loading}
              className="rounded-md border border-blue-700 bg-blue-700 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {saving ? 'Saving revision…' : 'Save reviewed revision'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-blue-100 bg-white px-3 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold capitalize text-slate-900">{value}</div>
    </div>
  );
}
