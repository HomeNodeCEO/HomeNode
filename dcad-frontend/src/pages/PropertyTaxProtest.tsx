import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import PropertyTaxPacketWorkspace from '@/components/PropertyTaxPacketWorkspace';
import PropertyTaxWorkfileReview from '@/components/PropertyTaxWorkfileReview';
import * as api from '@/lib/api';
import type { PropertyTaxProtestFile } from '@/lib/api';
import {
  buildPropertyTaxSummary,
  readPropertyTaxWorkspace,
  type PropertyTaxDatabaseDefaults,
} from '@/lib/propertyTaxWorkspace';

const EMPTY_DATABASE_DEFAULTS: PropertyTaxDatabaseDefaults = Object.freeze({
  loaded: false,
  taxYear: null,
  neighborhoodCode: '',
});

function displayCurrency(value: number | null): string {
  if (value == null) return 'Not entered';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function SourceCard({ label, value, empty }: { label: string; value: string; empty: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</div>
      <p className={`mt-2 whitespace-pre-wrap text-sm ${value ? 'text-slate-800' : 'italic text-slate-500'}`}>
        {value || empty}
      </p>
    </div>
  );
}

function ComparableGridUnavailable({ hasProperty }: { hasProperty: boolean }) {
  return (
    <section className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">Shared calculation engine · Property Tax persistence</div>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">Comparable sales grid</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            HomeNode-recommended sales and appraisal-district sales will appear together here after a canonical Property Tax file is loaded.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="hn-action-secondary rounded-lg px-3 py-2 text-sm font-semibold" disabled>Add recommended sales</button>
          <button type="button" className="hn-action-secondary rounded-lg px-3 py-2 text-sm font-semibold" disabled>Add district sale</button>
          <button type="button" className="hn-action-primary rounded-lg px-4 py-2 text-sm font-semibold" disabled>Save comparable grid</button>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
        {hasProperty
          ? 'Loading the canonical Property Tax file. If this message remains, refresh the file or confirm that this property has a Property Tax file.'
          : 'Select a property first. The comparable grid, recommendations, and evidence documents are isolated to that property’s Property Tax file.'}
        {!hasProperty && (
          <a href="/" className="ml-2 font-semibold underline">Open Property Search</a>
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-[900px] w-full border-collapse text-left text-xs">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['Source', 'Review', 'Address', 'Sale date', 'Sale price', 'District adjusted', 'Current adjustment', 'Adjusted indication', 'Analysis'].map((label) => (
                <th key={label} className="border-b border-slate-200 px-3 py-2 font-semibold">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">
                No Property Tax file loaded yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/50 p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">File-scoped source documents</div>
        <h3 className="mt-1 text-lg font-semibold text-slate-950">District evidence &amp; MLS document loader</h3>
        <p className="mt-2 text-sm text-slate-600">Select a Property Tax file to upload and view district evidence packets or MLS sheets.</p>
      </div>
    </section>
  );
}

export default function PropertyTaxProtest() {
  const location = useLocation();
  const propertyId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('propertyId') || params.get('accountId') || '';
  }, [location.search]);
  const ownerName = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('ownerName') || '';
  }, [location.search]);
  const requestedPropertyTaxFileId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('fileId');
  }, [location.search]);

  const [subjectAddress, setSubjectAddress] = useState('');
  const [subjectLoading, setSubjectLoading] = useState(false);
  const [subjectError, setSubjectError] = useState<string | null>(null);
  const [databaseDefaults, setDatabaseDefaults] = useState<PropertyTaxDatabaseDefaults>(EMPTY_DATABASE_DEFAULTS);
  const [canonicalFile, setCanonicalFile] = useState<PropertyTaxProtestFile | null>(null);
  const [summary, setSummary] = useState('');

  const snapshot = useMemo(
    () => readPropertyTaxWorkspace(canonicalFile?.workfile_data),
    [canonicalFile?.workfile_data],
  );
  const authorizationUrl = propertyId
    ? `/signup?accountId=${encodeURIComponent(propertyId)}${
        ownerName ? `&ownerName=${encodeURIComponent(ownerName)}` : ''
      }`
    : '/signup';

  useEffect(() => {
    setCanonicalFile(null);
    setSummary('');
  }, [propertyId, requestedPropertyTaxFileId]);

  useEffect(() => {
    if (!propertyId) {
      setSubjectAddress('');
      setDatabaseDefaults({ ...EMPTY_DATABASE_DEFAULTS, loaded: true });
      return;
    }
    let cancelled = false;
    setSubjectLoading(true);
    setSubjectError(null);
    setDatabaseDefaults(EMPTY_DATABASE_DEFAULTS);
    api.getAccount(propertyId)
      .then((response) => {
        if (!cancelled) {
          const latestTaxYear = Number(response?.account?.latest_tax_year);
          setSubjectAddress(response?.account?.address || '');
          setDatabaseDefaults({
            loaded: true,
            taxYear: Number.isInteger(latestTaxYear) && latestTaxYear >= 2000 && latestTaxYear <= 2200
              ? latestTaxYear
              : null,
            neighborhoodCode: String(response?.account?.neighborhood_code || '').trim(),
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSubjectError(error instanceof Error
            ? error.message
            : 'Subject information could not be loaded.');
          setDatabaseDefaults({ ...EMPTY_DATABASE_DEFAULTS, loaded: true });
        }
      })
      .finally(() => {
        if (!cancelled) setSubjectLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  useEffect(() => {
    setSummary('');
  }, [canonicalFile?.tax_protest_file_id, canonicalFile?.revision]);

  const generateSummary = () => {
    if (!canonicalFile) return;
    setSummary(buildPropertyTaxSummary({
      subject: subjectAddress || `account ${propertyId}`,
      snapshot,
    }));
  };

  const printSummary = () => {
    if (!summary) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const printableDocument = printWindow.document;
    const style = printableDocument.createElement('style');
    style.textContent = 'body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial;line-height:1.45;padding:24px;color:#0f172a}h1{font-size:22px;margin:0 0 8px}.meta{color:#475569;font-size:12px;margin-bottom:18px}';
    const title = printableDocument.createElement('title');
    title.textContent = 'Property Tax Protest Summary';
    printableDocument.head.replaceChildren(title, style);
    const heading = printableDocument.createElement('h1');
    heading.textContent = 'Property Tax Protest Summary';
    const meta = printableDocument.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${canonicalFile?.file_number || propertyId} · ${subjectAddress || 'Subject property'} · Generated ${new Date().toLocaleString()}`;
    const narrative = printableDocument.createElement('div');
    summary.split(/\r?\n/).forEach((line, index) => {
      if (index > 0) narrative.append(printableDocument.createElement('br'));
      narrative.append(printableDocument.createTextNode(line));
    });
    printableDocument.body.replaceChildren(heading, meta, narrative);
    printWindow.focus();
    window.setTimeout(() => {
      try {
        printWindow.print();
      } catch {
        // The generated summary remains available for copy if printing is blocked.
      }
    }, 300);
  };

  return (
    <div className="hn-app-shell px-4 py-4">
      <main className="mx-auto max-w-6xl">
        <header className="hn-app-header rounded-2xl border px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="hn-eyebrow text-xs tracking-[0.16em]">Canonical protest workspace</div>
              <h1 className="mt-1 text-2xl font-semibold">Property Tax Protest</h1>
              <p className="mt-1 text-sm text-slate-600">
                {subjectLoading
                  ? 'Loading subject information…'
                  : subjectAddress || (propertyId ? `Account ${propertyId}` : 'No subject selected')}
              </p>
              {propertyId && <p className="text-xs text-slate-500">Parcel / account {propertyId}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {propertyId && (
                <a
                  href={`/report/${encodeURIComponent(propertyId)}`}
                  className="hn-action-secondary rounded-md border px-4 py-2 text-sm font-medium"
                >
                  Back to Property Report
                </a>
              )}
              <a
                href={authorizationUrl}
                className="hn-action-gold rounded-md border px-4 py-2 text-sm font-semibold"
              >
                Begin Authorization Form
              </a>
              <a href="/" className="hn-action-secondary btn btn-ghost btn-sm normal-case">
                ← Close Report
              </a>
            </div>
          </div>
          {subjectError && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {subjectError}
            </div>
          )}
        </header>

        <PropertyTaxPacketWorkspace file={canonicalFile} databaseDefaults={databaseDefaults} />

        {!canonicalFile && <ComparableGridUnavailable hasProperty={Boolean(propertyId)} />}

        {propertyId ? (
          <PropertyTaxWorkfileReview
            accountId={propertyId}
            fileId={requestedPropertyTaxFileId}
            databaseDefaults={databaseDefaults}
            onFileChange={setCanonicalFile}
          />
        ) : (
          <section className="hn-workspace-surface mt-4 rounded-2xl border p-6 text-center text-sm text-slate-600">
            Select a property and Property Tax Protest file to open this workspace.
          </section>
        )}

        <section className="hn-workspace-surface mt-4 rounded-2xl border p-4">
          <h2 className="text-xl font-semibold">Appraisal District Evidence Analysis</h2>
          {snapshot.districtEvidenceSummary ? (
            <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">
              {snapshot.districtEvidenceSummary}
            </p>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-600">
              No district evidence analysis has been entered in this protest file.
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            This evidence belongs only to the selected Property Tax Protest file. It is never loaded from or saved to Custom Appraisal or UAD 3.6 files.
          </p>
        </section>

        <section className="hn-workspace-surface mt-4 rounded-2xl border p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Canonical Protest Summary</h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                Build a deterministic narrative from the selected protest file. Edit the source fields above and save a new revision before regenerating.
              </p>
            </div>
            <div className="text-right text-xs text-slate-500">
              <div>{canonicalFile ? canonicalFile.file_number : 'No protest file loaded'}</div>
              {canonicalFile && <div>Revision {canonicalFile.revision}</div>}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <SourceCard
              label="Sales comparison analysis"
              value={snapshot.salesComparisonNotes}
              empty="No sales-comparison analysis entered."
            />
            <SourceCard
              label="Adjustment support"
              value={snapshot.adjustmentNotes}
              empty="No adjustment support entered."
            />
            <SourceCard
              label="Cost to cure"
              value={[
                snapshot.repairCostToCure == null ? '' : displayCurrency(snapshot.repairCostToCure),
                snapshot.repairCostToCureNotes,
              ].filter(Boolean).join(' — ')}
              empty="No cost-to-cure amount or support entered."
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={generateSummary}
              disabled={!canonicalFile}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Generate Summary
            </button>
            {summary && (
              <>
                <button
                  type="button"
                  onClick={printSummary}
                  className="rounded-md border border-slate-800 bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
                >
                  Print / Save PDF
                </button>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(summary)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  Copy
                </button>
              </>
            )}
          </div>

          <label className="mt-3 block text-xs text-slate-600">
            Generated Summary
            <textarea
              value={summary}
              readOnly
              className="mt-1 h-40 w-full rounded-md border border-slate-300 p-3 text-sm text-slate-800"
              placeholder={canonicalFile
                ? 'Generate a summary from the saved canonical protest data.'
                : 'Load a Property Tax Protest file first.'}
            />
          </label>
        </section>
      </main>
    </div>
  );
}
