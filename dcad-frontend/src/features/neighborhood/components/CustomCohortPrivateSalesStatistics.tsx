import { PRIVATE_SALES_OBSERVED_METRICS, formatPrivateSalesObservedDecimal } from '../customCohortPrivateSales';
import type { CheckedPrivateSalesObservations, PrivateSalesObservedPopulation } from '../customCohortPrivateSales';

interface Props { observations: CheckedPrivateSalesObservations; freshness: 'none' | 'current' | 'stale'; selectedOnly?: boolean }
const units: Record<string, string> = { USD: 'USD (reviewer-declared)', sqft: 'sq ft (reported)', sqm: 'sq m (reported)',
  acre: 'acres (reported)', year: 'year', days: 'days' };
function Population({ value, title }: { value: PrivateSalesObservedPopulation; title: string }) {
  return <section className="min-w-0 rounded-xl border border-purple-200 p-3" aria-label={title}>
    <h5 className="font-semibold">{title}</h5>
    <p className="my-2 text-xs text-slate-600">{value.included_source_record_count} included source records; {value.single_account_source_record_count} single-account and {value.multi_account_source_record_count} multi-account records.
      {' '}{value.included_full_account_count} distinct accounts in their full confirmed match sets.</p>
    {value.partially_selected_full_account_set_count > 0 && <p className="mb-2 text-xs text-amber-800">{value.partially_selected_full_account_set_count} multi-account records only partly intersect this selection. Their full reported totals remain intact, with no price allocation.</p>}
    <div className="overflow-x-auto"><table className="w-full text-xs tabular-nums">
      <caption className="sr-only">Private CSV source-record distributions; exact reported decimals, not verified sale events</caption>
      <thead><tr className="border-b border-purple-100 text-slate-600">{['Measure', 'Low', 'Median', 'High', 'Observed / source records'].map(label =>
        <th key={label} scope="col" className={`px-2 py-2 font-medium ${label === 'Measure' ? 'text-left' : 'text-right'}`}>{label}</th>)}</tr></thead>
      <tbody>{Object.entries(PRIVATE_SALES_OBSERVED_METRICS).map(([key, label]) => {
        const metric = value.metrics[key as keyof typeof PRIVATE_SALES_OBSERVED_METRICS];
        return <tr key={key} className="border-b border-slate-100 align-top" data-private-metric={key}>
          <th scope="row" className="px-2 py-2 text-left font-medium">{label}<span className="block text-[10px] font-normal text-slate-500">{metric.unit === null ? 'Unit not established' : units[metric.unit]}</span></th>
          {(['low', 'median', 'high'] as const).map(field => <td key={field} className="whitespace-nowrap px-2 py-2 text-right" title={metric[field] === null ? undefined : `Exact reported statistic: ${metric[field]}`}>{formatPrivateSalesObservedDecimal(metric[field], key !== 'reported_year_built')}</td>)}
          <td className="px-2 py-2 text-right">{metric.count} / {metric.member_count}<span className="block text-[10px] text-slate-500">{metric.missing_count} missing; {metric.invalid_count} invalid; {metric.conflicting_count} conflicting; {metric.unsupported_count} unsupported</span></td>
        </tr>;
      })}</tbody>
    </table></div>
    <details className="mt-2 text-xs text-slate-600"><summary className="cursor-pointer">Row accounting: {value.retained_row_count} retained; {value.confirmed_match_row_count} with confirmed matches</summary>
      <ul className="mt-2 space-y-1">{Object.entries(value.disposition_counts).map(([key, count]) => <li key={key}>{key.replaceAll('_', ' ')}: {count}</li>)}</ul>
    </details>
  </section>;
}

/** Render only the checked addon belonging to the accepted preview group.
 * Decimal strings are deliberately never converted to floating-point numbers. */
export default function CustomCohortPrivateSalesStatistics({ observations: value, freshness, selectedOnly = false }: Props) {
  return <section className="space-y-3 rounded-xl border border-purple-200 bg-purple-50/30 p-3" aria-label="Private reviewed CSV observations" data-private-selection-revision={value.binding.selection_revision} data-freshness={freshness}>
    <div><h4 className="font-semibold">Private reviewed CSV observations</h4>
      <p className="mt-1 text-sm">{value.source_interpretation.source_name} — saved review revision {value.binding.review.revision}</p>
      <p className="mt-1 break-all text-[11px] text-slate-500">Batch {value.binding.batch.batch_id}; captured {value.captured_at}.</p>
      <p className="mt-1 text-xs text-slate-600">Closing-date period {value.observation_period.start_date} through {value.observation_period.end_date}; effective date {value.effective_date}. Context and selection revision {value.binding.selection_revision} match this displayed result.</p>
      <p className="mt-2 text-xs text-amber-900">These are private source-record observations, not verified sale events or housing-stock evidence. Old sales alone do not establish historical stock. Confirmed account matches do not establish complete economic membership.</p>
      <p className="mt-1 text-xs text-slate-600">All retained results cover this upload, including matches outside mapped discovery. Selected results require an intersection with the displayed selection; they are not additional canonical sales.</p>
      {freshness === 'stale' && <p role="status" className="mt-2 text-xs text-amber-900">These preceding CSV results remain with the preceding map and statistics until the changed selection succeeds.</p>}
      <p className="mt-2 text-xs text-slate-600">Designated total: {value.source_interpretation.consideration_field === 'close_price' ? 'ClosePrice' : value.source_interpretation.consideration_field === 'current_price' ? 'CurrentPrice' : 'not established'}. CurrentPrice and ClosePrice remain separate; neither is verified consideration. No unit conversion, price allocation, CAD fallback, or automatic report inclusion.</p>
      {value.source_interpretation.marketing_time_field !== 'days_on_market' && <p className="mt-1 text-xs text-slate-600">Marketing time is unavailable: {value.source_interpretation.marketing_time_field === null ? 'no field designated' : 'cumulative days on market is not retained by this import profile'}.</p>}
    </div>
    <div className={`grid gap-3 ${selectedOnly ? '' : '2xl:grid-cols-2'}`}>
      {!selectedOnly && <Population value={value.all} title="All retained private observations" />}
      <Population value={value.selected} title="Selected private observations" />
    </div>
    <p className="text-xs text-slate-600">Displays use at most two decimals; hover for the exact retained statistic. Missing, conflicting and unsupported measurements remain unavailable. Units are reviewer-declared, not independently verified measurements. Median is descriptive, not a supported predominant value. This preview cannot be applied to the report.</p>
  </section>;
}
