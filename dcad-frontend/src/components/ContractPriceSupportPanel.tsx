import type { ContractPriceSupportAnalysis, SaleRow } from '@/lib/api';

type Props = {
  analysis: ContractPriceSupportAnalysis;
  selectedSales: Array<SaleRow | null>;
  onLoadReviewSet: () => void;
  onToggleSale: (sale: SaleRow, selectedSlot: number) => void;
};

function saleKey(sale: SaleRow): string {
  return sale.source_record_id != null
    ? `source-${sale.source_record_id}`
    : `legacy-${sale.sale_id}`;
}

function displayAddress(sale: SaleRow): string {
  if (sale.address?.trim()) return sale.address.trim();
  if (sale.primary_account_id) return `Account ${sale.primary_account_id}`;
  return 'Address unavailable';
}

function money(value: unknown): string {
  const parsed = typeof value === 'string'
    ? Number(value.replace(/[^0-9.-]/g, ''))
    : Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—';
}

export default function ContractPriceSupportPanel({
  analysis,
  selectedSales,
  onLoadReviewSet,
  onToggleSale,
}: Props) {
  if (!analysis.available) return null;
  const tone = analysis.support_status === 'supported'
    ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
    : analysis.support_status === 'limited'
      ? 'border-amber-300 bg-amber-50 text-amber-950'
      : 'border-red-300 bg-red-50 text-red-950';

  return (
    <section className={`mt-3 rounded-xl border p-4 text-sm ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide">Independent contract-price support test</div>
          <div className="mt-1 text-lg font-semibold">
            {money(analysis.contract_price)} · {analysis.support_status.replace('_', ' ')} support
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-white/80 px-2 py-1 font-semibold">
            {analysis.within_5_percent_count ?? 0} within 5%
          </span>
          <span className="rounded-full bg-white/80 px-2 py-1 font-semibold">
            {analysis.within_10_percent_count ?? 0} within 10%
          </span>
          <span className="rounded-full bg-white/80 px-2 py-1 font-semibold">
            {analysis.strong_physical_support_count ?? 0} strong physical matches
          </span>
          <span className="rounded-full bg-white/80 px-2 py-1 font-semibold">
            {(analysis.local_sale_count ?? 0).toLocaleString()} local sales screened
          </span>
        </div>
      </div>
      <p className="mt-2 leading-6">{analysis.reconciliation}</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <span>Radius: <strong>{analysis.local_radius_miles} miles</strong></span>
        {analysis.contract_percentile != null && (
          <span>Contract price percentile: <strong>{analysis.contract_percentile.toFixed(1)}%</strong></span>
        )}
        {analysis.upper_quartile_price != null && (
          <span>Local upper quartile: <strong>{money(analysis.upper_quartile_price)}</strong></span>
        )}
        {analysis.subject_condition && (
          <span>Subject condition: <strong>{analysis.subject_condition}</strong></span>
        )}
      </div>
      <p className="mt-2 text-xs opacity-80">
        The ordinary similarity recommendations remain unchanged. This separate screen tests the contract rather than targeting it, and every upper-tier candidate still requires appraiser verification of condition, quality, concessions, and remodeling.
      </p>

      {analysis.review_set_sales.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">Nearby contract-support and upper-tier review sales</div>
            <button
              type="button"
              onClick={onLoadReviewSet}
              className="rounded-lg border border-amber-600 bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-950 shadow-sm hover:bg-amber-400"
            >
              Load Contract-Support Review Set
            </button>
          </div>
          <div className="mt-2 overflow-x-auto rounded-lg border border-white/70 bg-white/75">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-white/80 text-slate-700">
                <tr>
                  <th className="px-3 py-2">Sale</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Contract difference</th>
                  <th className="px-3 py-2">Distance / physical score</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {analysis.review_set_sales.map((sale) => {
                  const selectedSlot = selectedSales.findIndex(
                    (item) => item && saleKey(item) === saleKey(sale),
                  );
                  return (
                    <tr key={`contract-support-${saleKey(sale)}`} className="border-t border-slate-200">
                      <td className="px-3 py-2 font-medium text-slate-950">{displayAddress(sale)}</td>
                      <td className="px-3 py-2 font-semibold text-slate-950">{money(sale.sale_price)}</td>
                      <td className="px-3 py-2 text-slate-700">
                        {sale.contract_price_difference_percent?.toFixed(1) ?? '—'}%
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {sale.distanceMiles?.toFixed(2) ?? '—'} mi · {sale.comparableScore?.toFixed(1) ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onToggleSale(sale, selectedSlot)}
                          className="rounded-md border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-800 hover:border-amber-500"
                        >
                          {selectedSlot >= 0 ? 'Remove' : 'Use as Comparable'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
