import { useEffect, useRef, useState } from 'react';
import type { NeighborhoodPocketDetails } from '@/lib/neighborhoodPocketDetails';

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const yearFormat = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 0 });
const moneyFormat = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const ppsfFormat = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const PAGE_SIZE = 25;

export default function NeighborhoodPocketDetailsPanel({
  details, label, included, liveSummary, onToggle, onClose,
}: {
  details: NeighborhoodPocketDetails;
  label: string;
  included: boolean;
  liveSummary: { reliabilityScore: number; compositeCod: number | null; saleCount: number } | null;
  onToggle: () => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const pageCount = Math.ceil(details.properties.length / PAGE_SIZE);
  const currentPage = Math.min(page, pageCount - 1);
  const metrics = [
    ['Living area (sq. ft.)', details.metrics.gla, numberFormat],
    ['Year built', details.metrics.yearBuilt, yearFormat],
    [`Age (years${details.asOfYear ? `, as of ${details.asOfYear}` : ''})`, details.metrics.age, numberFormat],
    ['Site size (sq. ft.)', details.metrics.site, numberFormat],
    ['CAD market value — not a sale price', details.metrics.cadValue, moneyFormat],
    ['Similarity score (%)', details.metrics.similarity, numberFormat],
    ['Closed-sale price', details.metrics.salePrice, moneyFormat],
    ['Closed-sale price / sq. ft.', details.metrics.salePpsf, ppsfFormat],
    ['Marketing time (days)', details.metrics.marketingDays, numberFormat],
  ] as const;
  return (
    <dialog ref={dialogRef} onCancel={onClose} aria-label={`${label} details`} className="m-auto max-h-[85vh] w-[min(960px,95vw)] overflow-y-auto rounded-xl border border-amber-300 bg-white p-0 shadow-xl backdrop:bg-slate-950/50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-gradient-to-r from-violet-100 to-amber-50 px-4 py-3">
        <div>
          <h4 className="font-semibold text-violet-950">{label} · Pocket details</h4>
          <p className="text-xs text-slate-700">
            {details.properties.length.toLocaleString()} mapped parcels · {details.metrics.salePrice.count.toLocaleString()} sale records
            {details.containsSubjectNeighborhood ? ' · Includes a subject-neighborhood match' : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="hn-action-primary btn btn-sm normal-case" onClick={onToggle}>
            {included ? 'Remove Pocket' : 'Add Pocket'}
          </button>
          <button type="button" autoFocus className="btn btn-outline btn-sm normal-case" onClick={onClose}>Close details</button>
        </div>
      </div>
      <div className="space-y-4 p-4 text-xs text-slate-800">
        <p role="status">
          {included ? 'Included in the analysis.' : 'Excluded from the analysis.'} Viewing these details does not change your selection.
          {' '}Add or remove this pocket to update the live analysis. No property or sale is deleted from the database.
        </p>
        {liveSummary ? <p className="rounded-lg bg-violet-50 p-2 font-semibold text-violet-950" aria-live="polite">
          Entire selected analysis: {liveSummary.reliabilityScore}/100 reliability · COD {liveSummary.compositeCod ?? 'Not available'} · {liveSummary.saleCount.toLocaleString()} sales
        </p> : null}
        <div className="grid gap-4 md:grid-cols-2">
          {([
            ['Recorded subdivisions', details.subdivisions],
            ['CAD land-use types', details.propertyTypes],
          ] as const).map(([title, groups]) => (
            <div key={title}>
              <h5 className="mb-1 font-semibold text-violet-950">{title}</h5>
              <ul className="max-h-32 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {groups.map((group) => <li key={group.label} className="flex justify-between gap-3 py-0.5">
                  <span>{group.label === 'NOT AVAILABLE' ? 'Not available' : group.label}</span>
                  <span className="tabular-nums">{group.count.toLocaleString()}</span>
                </li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left tabular-nums">
            <caption className="pb-2 text-left text-xs text-slate-600">
              All mapped parcels in this pocket, including currently excluded parcels. Sales: supplied {details.saleHistoryMonths}-month period, without time adjustments. Median is not a concluded predominant value.
            </caption>
            <thead><tr className="border-b border-slate-300 text-slate-600">
              <th className="py-2">Measure</th><th className="px-2 text-right">Low</th><th className="px-2 text-right">Median</th><th className="px-2 text-right">High</th><th className="px-2 text-right">Known / missing</th>
            </tr></thead>
            <tbody>{metrics.map(([title, metric, format]) => <tr key={title} className="border-b border-slate-100">
              <th className="py-2 font-medium">{title}</th>
              {([metric.low, metric.median, metric.high]).map((value, index) => <td key={index} className="whitespace-nowrap px-2 text-right">
                {value === null ? 'Not available' : format.format(value)}
              </td>)}
              <td className="px-2 text-right">{metric.count.toLocaleString()} / {metric.missing.toLocaleString()}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950">
          <h5 className="font-semibold">Additional neighborhood evidence</h5>
          <p className="mt-1">Original builder, HOA dues and billing frequency, amenities, and zoning are not supplied by this pocket dataset yet. They are not inferred from the subdivision name, CAD values, or map colors.</p>
        </div>
        <details>
          <summary className="cursor-pointer font-semibold text-violet-950">Monthly sale-price observations</summary>
          <p className="my-2 text-slate-600">Descriptive medians only. Changes in the properties sold can change these figures; this is not a market-appreciation conclusion.</p>
          {details.monthlySales.length ? <div className="max-h-48 overflow-auto">
            <table className="w-full text-left tabular-nums"><thead><tr><th>Month</th><th>Sales</th><th>Median sale price</th></tr></thead>
              <tbody>{details.monthlySales.map((month) => <tr key={month.month}><td className="py-1">{month.month}</td><td>{month.count}</td><td>{month.median === null ? 'Not available' : moneyFormat.format(month.median)}</td></tr>)}</tbody>
            </table>
          </div> : <p>No dated sale observations available.</p>}
        </details>
        <details>
          <summary className="cursor-pointer font-semibold text-violet-950">View properties in this pocket ({details.properties.length.toLocaleString()})</summary>
          <ul className="my-2 divide-y divide-slate-100">
            {details.properties.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((property) => <li key={property.parcel_object_id} className="flex justify-between gap-2 py-2">
              <span>{property.address || 'Address not available'}<span className="block text-[10px] text-slate-500">{property.account_id || `Parcel ${property.parcel_object_id}`}</span></span>
              <span>{property.primary_population ? 'Included' : 'Excluded'}</span>
            </li>)}
          </ul>
          <div className="flex items-center gap-3">
            <button type="button" className="btn btn-outline btn-xs normal-case" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
            <span>Page {currentPage + 1} of {pageCount}</span>
            <button type="button" className="btn btn-outline btn-xs normal-case" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
          </div>
        </details>
        <p className="text-[11px] text-slate-500">Source: cached CAD parcel characteristics and linked closed-sale records in the current relevance assessment ({details.generatedAt}). These are the supplied map records, not a claim of complete citywide coverage.</p>
      </div>
    </dialog>
  );
}
