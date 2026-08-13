import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import * as api from '@/lib/api';
import {
  readAppraisalReportDraft,
  saveAppraisalReportDraft,
  type AppraisalReportSalesDraft,
} from '@/lib/appraisalReportDraft';

const DEFAULT_SALES_NOTES =
  "Comparable sales are analyzed based on the subject's condition to provide the best comparisons possible.";
const DEFAULT_ADJUSTMENT_NOTES =
  'Applied adjustments for time/date of sale, neighborhood, gross living area, room and bath count, condition, quality, and feature differences based on market-supported evidence.';
const DEFAULT_COST_TO_CURE_TOTAL = 31_900;

type PhotoPreview = {
  file: File;
  url: string;
};

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

  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [subjectAddress, setSubjectAddress] = useState('');
  const [subjectLoading, setSubjectLoading] = useState(false);
  const [subjectError, setSubjectError] = useState<string | null>(null);
  const [photoPreviews, setPhotoPreviews] = useState<PhotoPreview[]>([]);
  const [salesDraft, setSalesDraft] = useState<AppraisalReportSalesDraft | null>(null);
  const [salesNotes, setSalesNotes] = useState(DEFAULT_SALES_NOTES);
  const [adjustmentNotes, setAdjustmentNotes] = useState(DEFAULT_ADJUSTMENT_NOTES);
  const [costToCureNotes, setCostToCureNotes] = useState(
    `Estimated cost to cure is $${DEFAULT_COST_TO_CURE_TOTAL.toLocaleString()} for necessary repairs and deferred maintenance that buyers typically expect to be reflected in price.`,
  );
  const [summary, setSummary] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const authorizationUrl = propertyId
    ? `/signup?accountId=${encodeURIComponent(propertyId)}${
        ownerName ? `&ownerName=${encodeURIComponent(ownerName)}` : ''
      }`
    : '/signup';

  useEffect(() => {
    const draft = propertyId ? readAppraisalReportDraft(propertyId) : null;
    setSalesDraft(draft);
    setSalesNotes(draft?.salesNotes || DEFAULT_SALES_NOTES);
    setAdjustmentNotes(draft?.adjustmentNotes || DEFAULT_ADJUSTMENT_NOTES);
    if (draft?.opinionOfValue != null && draft?.opinionAfterCostToCure != null) {
      const measuredCost = Math.max(
        0,
        Math.round(draft.opinionOfValue - draft.opinionAfterCostToCure),
      );
      if (measuredCost > 0) {
        setCostToCureNotes(
          `The current sales-comparison draft reflects a $${measuredCost.toLocaleString()} cost-to-cure impact. Necessary repairs and deferred maintenance should be considered in the final value reconciliation.`,
        );
      }
    }
  }, [propertyId]);

  useEffect(() => {
    if (!salesDraft) return;
    const updatedDraft = {
      ...salesDraft,
      savedAt: new Date().toISOString(),
      salesNotes,
      adjustmentNotes,
    };
    saveAppraisalReportDraft(updatedDraft);
    setSalesDraft(updatedDraft);
    // The state update above intentionally tracks the latest saved timestamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesNotes, adjustmentNotes]);

  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    setSubjectLoading(true);
    setSubjectError(null);
    api.getAccount(propertyId)
      .then((response) => {
        if (!cancelled) setSubjectAddress(response?.account?.address || '');
      })
      .catch((error: any) => {
        if (!cancelled) setSubjectError(error?.message || 'Subject information could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setSubjectLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  useEffect(
    () => () => {
      photoPreviews.forEach((photo) => URL.revokeObjectURL(photo.url));
    },
    [photoPreviews],
  );

  const replacePhotos = (files: File[]) => {
    setPhotoPreviews(
      files.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      })),
    );
  };

  const generateSummary = async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    const subject = subjectAddress || (propertyId ? `account ${propertyId}` : 'the subject property');
    try {
      try {
        const response = await fetch(api.makeUrl('/api/summary'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject,
            salesNotes,
            adjustmentNotes,
            costToCure: {
              total: DEFAULT_COST_TO_CURE_TOTAL,
              narrative: costToCureNotes,
            },
          }),
        });
        if (response.ok) {
          const data = await response.json();
          const generated = String(data?.summary || data?.content || '').trim();
          if (generated) {
            setSummary(generated);
            return;
          }
        }
      } catch {
        // The local template below keeps this rough-draft workspace functional.
      }

      setSummary(
        [
          `The property-tax protest for ${subject} is supported by a sales comparison analysis using nearby, competitive transactions with similar physical and market characteristics. ${salesNotes}`,
          adjustmentNotes,
          costToCureNotes,
          'The appraisal district evidence should be reviewed against the selected market evidence, adjustment support, property condition, and subject photographs before the final protest position is reconciled.',
        ].join(' '),
      );
    } catch (error: any) {
      setSummaryError(error?.message || 'The protest summary could not be generated.');
    } finally {
      setSummaryLoading(false);
    }
  };

  const downloadSummaryPdf = () => {
    const printable = `<!doctype html><html><head><meta charset="utf-8"><title>Property Tax Protest Summary</title>
      <style>body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial;line-height:1.45;padding:24px;color:#0f172a}h1{font-size:22px;margin:0 0 8px}.meta{color:#475569;font-size:12px;margin-bottom:18px}</style>
      </head><body><h1>Property Tax Protest Summary</h1><div class="meta">${subjectAddress || propertyId || 'Subject property'} · Generated ${new Date().toLocaleString()}</div><div>${summary.replace(/\r?\n/g, '<br/>')}</div></body></html>`;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(printable);
    printWindow.document.close();
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
    <div className="min-h-screen bg-slate-100 px-4 py-4 text-slate-950">
      <main className="mx-auto max-w-6xl">
        <header className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                Rough-draft workspace
              </div>
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
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Back to Property Report
                </a>
              )}
              <a
                href={authorizationUrl}
                className="rounded-md border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Begin Authorization Form
              </a>
            </div>
          </div>
          {subjectError && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {subjectError}
            </div>
          )}
        </header>

        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold">Appraisal District Evidence Analysis</h2>
          <p className="mt-2 max-w-5xl text-sm text-slate-700">
            District evidence has not yet been requested for this rough draft. Once a protest is filed, this area can compare the district&apos;s sales, adjustments, and valuation support with the appraiser-selected evidence.
          </p>
          <p className="mt-2 text-sm text-slate-600">
            The sample rows below preserve the working layout for the future evidence review.
          </p>
          <DistrictEvidenceAccordion />
        </section>

        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Subject Photos</h2>
              <p className="mt-1 text-sm text-slate-600">Upload condition and property photos for the protest packet.</p>
            </div>
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="rounded-md border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Upload Photos
            </button>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => replacePhotos(Array.from(event.target.files || []))}
            />
          </div>

          {photoPreviews.length > 0 ? (
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {photoPreviews.map((photo, index) => (
                <figure
                  key={`${photo.file.name}-${photo.file.lastModified}-${index}`}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
                >
                  <img
                    src={photo.url}
                    alt={`Subject photo ${index + 1}`}
                    className="aspect-[4/3] h-full w-full object-cover"
                  />
                </figure>
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-600">
              No subject photos uploaded yet.
            </div>
          )}
        </section>

        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Protest Summary Generator</h2>
              <p className="mt-1 text-sm text-slate-600">
                Build a rough narrative from the sales comparison, adjustment support, and property condition evidence.
              </p>
            </div>
            <div className="text-xs text-slate-500">
              {salesDraft ? 'Connected to the current sales-comparison draft' : 'Local rough draft'}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="flex flex-col text-xs text-slate-600">
              Sales Comparison Approach
              <textarea
                value={salesNotes}
                onChange={(event) => setSalesNotes(event.target.value)}
                className="mt-1 h-20 rounded-md border border-slate-300 p-2 text-sm text-slate-800"
              />
            </label>
            <label className="flex flex-col text-xs text-slate-600">
              Adjustment Analysis
              <textarea
                value={adjustmentNotes}
                onChange={(event) => setAdjustmentNotes(event.target.value)}
                className="mt-1 h-20 rounded-md border border-slate-300 p-2 text-sm text-slate-800"
              />
            </label>
            <label className="flex flex-col text-xs text-slate-600">
              Cost to Cure
              <textarea
                value={costToCureNotes}
                onChange={(event) => setCostToCureNotes(event.target.value)}
                className="mt-1 h-20 rounded-md border border-slate-300 p-2 text-sm text-slate-800"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={generateSummary}
              disabled={summaryLoading}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-60"
            >
              {summaryLoading ? 'Generating…' : 'Generate Summary'}
            </button>
            {summary && (
              <>
                <button
                  type="button"
                  onClick={downloadSummaryPdf}
                  className="rounded-md border border-slate-800 bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
                >
                  Download PDF
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
            {summaryError && <div className="text-sm text-red-600">{summaryError}</div>}
          </div>

          <label className="mt-3 block text-xs text-slate-600">
            Generated Summary
            <textarea
              value={summary}
              readOnly
              className="mt-1 h-32 w-full rounded-md border border-slate-300 p-3 text-sm text-slate-800"
              placeholder="Summary will appear here"
            />
          </label>
        </section>
      </main>
    </div>
  );
}

function DistrictEvidenceAccordion() {
  const [open, setOpen] = useState<number | null>(null);
  const rows = [
    'District Comp 1: 789 Elm St - $510,000',
    'District Comp 2: 101 Oak Dr - $499,000',
    'District Comp 3: 212 Cedar Ave - $505,000',
    'District Comp 4: 313 Birch Rd - $515,000',
  ];

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
      {rows.map((label, index) => {
        const isOpen = open === index;
        return (
          <div key={label} className="border-t border-slate-200 first:border-t-0">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : index)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-slate-50"
            >
              <span className="font-medium text-slate-800">{label}</span>
              <span aria-hidden="true" className={`text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                ▾
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                District evidence details and the appraiser&apos;s rebuttal will appear here once the evidence packet is received.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
