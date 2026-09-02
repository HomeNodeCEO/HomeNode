import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getPropertyTaxProtestFile,
  getPropertyTaxEvidenceVersion,
  updatePropertyTaxInspectionSketch,
  updatePropertyTaxProtestFile,
  type PropertyTaxProtestFile,
} from '@/lib/api';
import { editorCredentialForRequest } from '@/lib/editorCredential';
import MobileSketchReview from '@/components/MobileSketchReview';
import PropertyTaxComparableGrid from '@/components/PropertyTaxComparableGrid';
import SketchWorkspaceEmptyState from '@/components/SketchWorkspaceEmptyState';

type FieldSpec = {
  path: [string, string];
  label: string;
  group: string;
  kind: 'text' | 'number' | 'date' | 'select';
  options?: string[];
  multiline?: boolean;
};

type PropertyTaxWorkfileReviewProps = {
  accountId: string;
  fileId?: string | null;
  onFileChange?: (file: PropertyTaxProtestFile | null) => void;
};

const CONDITION_OPTIONS = ['C1', 'C2-C1', 'C2', 'C3-C2', 'C3', 'C4-C3', 'C4', 'C5-C4', 'C5', 'C6-C5', 'C6'];
const QUALITY_OPTIONS = ['Q1', 'Q2-Q1', 'Q2', 'Q3-Q2', 'Q3', 'Q4-Q3', 'Q4', 'Q5-Q4', 'Q5', 'Q6-Q5', 'Q6'];
const EVIDENCE_REFRESH_MS = 5_000;
const EVIDENCE_RETRY_DELAY_MS = 30_000;

const OPTION_LABELS: Record<string, string> = {
  'tx-dallas-cad': 'Dallas Central Appraisal District (DCAD)',
  single_family_residential: 'Single-family residential',
  market_value: 'Market value',
  unequal_appraisal: 'Unequal appraisal',
  not_started: 'Not started',
  prepared: 'Prepared',
  filed: 'Filed',
  scheduled: 'Scheduled',
  settled: 'Settled',
  complete: 'Complete',
  sent: 'Sent',
  received: 'Received',
  ufile: 'DCAD uFile',
  mail: 'Mail',
  dropbox: 'DCAD drop box',
  in_person: 'In person',
  portal: 'District portal',
  other_documented: 'Other documented delivery',
  yes: 'Yes',
  no: 'No',
};

const FIELDS: FieldSpec[] = [
  { path: ['protest_case', 'district_code'], label: 'Appraisal district', group: 'Protest case & deadlines', kind: 'select', options: ['tx-dallas-cad'] },
  { path: ['protest_case', 'property_use'], label: 'MVP property use', group: 'Protest case & deadlines', kind: 'select', options: ['single_family_residential'] },
  { path: ['protest_case', 'notice_date'], label: 'Notice date', group: 'Protest case & deadlines', kind: 'date' },
  { path: ['protest_case', 'protest_deadline'], label: 'Deadline printed on notice', group: 'Protest case & deadlines', kind: 'date' },
  { path: ['protest_case', 'market_value_ground'], label: 'Market-value ground', group: 'Protest case & deadlines', kind: 'select', options: ['yes', 'no'] },
  { path: ['protest_case', 'unequal_appraisal_ground'], label: 'Unequal-appraisal ground', group: 'Protest case & deadlines', kind: 'select', options: ['yes', 'no'] },
  { path: ['protest_case', 'protest_status'], label: 'Protest status', group: 'Protest case & deadlines', kind: 'select', options: ['not_started', 'prepared', 'filed', 'scheduled', 'settled', 'complete'] },
  { path: ['protest_case', 'filing_method'], label: 'Filing method', group: 'Protest case & deadlines', kind: 'select', options: ['ufile', 'mail', 'dropbox', 'in_person'] },
  { path: ['protest_case', 'protest_filed_at'], label: 'Protest filed date', group: 'Protest case & deadlines', kind: 'date' },
  { path: ['protest_case', 'filing_receipt_reference'], label: 'Filing receipt reference', group: 'Protest case & deadlines', kind: 'text' },
  { path: ['protest_case', 'hearing_date'], label: 'ARB hearing date', group: 'Protest case & deadlines', kind: 'date' },
  { path: ['protest_case', 'evidence_request_status'], label: '§41.461 evidence request', group: 'Protest case & deadlines', kind: 'select', options: ['not_started', 'prepared', 'sent', 'received'] },
  { path: ['protest_case', 'evidence_request_sent_at'], label: 'Evidence request sent date', group: 'Protest case & deadlines', kind: 'date' },
  { path: ['protest_case', 'evidence_request_method'], label: 'Evidence request delivery method', group: 'Protest case & deadlines', kind: 'select', options: ['mail', 'portal', 'in_person', 'other_documented'] },
  { path: ['protest_case', 'evidence_request_proof_reference'], label: 'Evidence request proof reference', group: 'Protest case & deadlines', kind: 'text' },
  { path: ['protest_case', 'district_evidence_received_at'], label: 'District evidence received date', group: 'Protest case & deadlines', kind: 'date' },
  { path: ['subject', 'condition_rating'], label: 'Overall condition rating', group: 'Subject', kind: 'select', options: CONDITION_OPTIONS },
  { path: ['subject', 'quality_rating'], label: 'Quality rating', group: 'Subject', kind: 'select', options: QUALITY_OPTIONS },
  { path: ['subject', 'district_neighborhood_code'], label: 'DCAD neighborhood code', group: 'Subject', kind: 'text' },
  { path: ['subject', 'district_building_class'], label: 'DCAD building class', group: 'Subject', kind: 'text' },
  { path: ['subject', 'historic_district_name'], label: 'Historic district, if applicable', group: 'Subject', kind: 'text' },
  { path: ['subject', 'living_area_sqft'], label: 'Living area (sq ft)', group: 'Subject', kind: 'number' },
  { path: ['subject', 'site_size_sqft'], label: 'Site size (sq ft)', group: 'Subject', kind: 'number' },
  { path: ['subject', 'age_years'], label: 'Actual age (years)', group: 'Subject', kind: 'number' },
  { path: ['subject', 'bedroom_count'], label: 'Bedrooms', group: 'Subject', kind: 'number' },
  { path: ['subject', 'bath_count'], label: 'Total baths', group: 'Subject', kind: 'number' },
  { path: ['subject', 'garage_spaces'], label: 'Garage spaces', group: 'Subject', kind: 'number' },
  { path: ['subject', 'pool'], label: 'Pool', group: 'Subject', kind: 'select', options: ['yes', 'no'] },
  { path: ['subject', 'solar_panels'], label: 'Solar panels', group: 'Subject', kind: 'select', options: ['yes', 'no'] },
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

export default function PropertyTaxWorkfileReview({
  accountId,
  fileId,
  onFileChange,
}: PropertyTaxWorkfileReviewProps) {
  const [file, setFile] = useState<PropertyTaxProtestFile | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sketchRefreshing, setSketchRefreshing] = useState(false);
  const sketchRefreshInFlight = useRef(false);
  const evidenceCheckInFlight = useRef(false);
  const evidenceVersionRef = useRef<string | null>(null);
  const evidenceRetryAtRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = useMemo(() => Array.from(new Set(FIELDS.map((field) => field.group))), []);

  const acceptSavedFile = useCallback((current: PropertyTaxProtestFile) => {
    evidenceVersionRef.current = current.evidence_version || evidenceVersionRef.current;
    setFile(current);
    setValues(buildValues(current));
    onFileChange?.(current);
  }, [onFileChange]);

  const load = async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getPropertyTaxProtestFile(accountId, fileId || undefined);
      evidenceVersionRef.current = result?.evidence_version || null;
      setFile(result);
      setValues(result ? buildValues(result) : {});
      onFileChange?.(result);
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
      evidenceVersionRef.current = refreshed.evidence_version || evidenceVersionRef.current;
      setFile((current) => current?.tax_protest_file_id === refreshed.tax_protest_file_id
        ? {
            ...current,
            sketch: refreshed.sketch,
            photos: refreshed.photos,
            evidence_version: refreshed.evidence_version,
            photo_version: refreshed.photo_version,
            verified_photo_count: refreshed.verified_photo_count,
            sketch_revision: refreshed.sketch_revision,
            sketch_review_status: refreshed.sketch_review_status,
            sketch_updated_at: refreshed.sketch_updated_at,
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
    if (!activeFileId) return;
    const checkForUpdates = async () => {
      if (document.visibilityState !== 'visible' || evidenceCheckInFlight.current
          || Date.now() < evidenceRetryAtRef.current) return;
      evidenceCheckInFlight.current = true;
      try {
        const version = await getPropertyTaxEvidenceVersion(accountId, activeFileId);
        evidenceRetryAtRef.current = 0;
        if (evidenceVersionRef.current !== version.evidence_version) {
          evidenceVersionRef.current = version.evidence_version;
          await refreshSketchEvidence();
        }
      } catch {
        evidenceRetryAtRef.current = Date.now() + EVIDENCE_RETRY_DELAY_MS;
      } finally {
        evidenceCheckInFlight.current = false;
      }
    };
    const refreshWhenVisible = () => void checkForUpdates();
    const interval = window.setInterval(refreshWhenVisible, EVIDENCE_REFRESH_MS);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [accountId, activeFileId, refreshSketchEvidence]);

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
      acceptSavedFile(current);
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
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Canonical Property Tax file</div>
          <h2 className="mt-1 text-xl font-semibold">Desktop Property Tax workspace</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-700">
            Review and save the subject, protest case, valuation, comparable sales, and evidence for this desktop Property Tax file. Every save creates a new revision and preserves the prior history.
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
          No Property Tax Protest file exists for this property yet. Create one from the report file chooser; it will remain separate from Custom Appraisal and UAD files.
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

          <PropertyTaxComparableGrid
            accountId={accountId}
            file={file}
            onFileSaved={acceptSavedFile}
          />

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
                            {field.options?.map((option) => <option key={option} value={option}>{OPTION_LABELS[option] || option}</option>)}
                          </select>
                        ) : field.multiline ? (
                          <textarea className={controlClass} rows={4} value={values[key] || ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
                        ) : (
                          <input className={controlClass} type={field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text'} step={field.kind === 'number' ? 'any' : undefined} value={values[key] || ''} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
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
              <h3 className="text-sm font-semibold text-slate-800">Property photo evidence</h3>
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
              subtitle="Changes create a new audited sketch revision for this desktop Property Tax file only."
              revisionSourceLabel="Property Tax"
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
              subtitle={`No measured sketch is attached to ${file.file_number} yet. Photos and sketches will remain evidence scoped to this Property Tax file.`}
              onRefresh={refreshSketchEvidence}
              refreshing={sketchRefreshing}
              refreshLabel="Check for attached sketch"
              refreshingLabel="Checking for attached sketch…"
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
