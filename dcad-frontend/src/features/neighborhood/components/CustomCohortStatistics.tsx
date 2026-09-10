import type { CustomCohortPreviewGroup, CustomCohortPreviewState } from '../customCohortPreviewController';
import CustomCohortPrivateSalesStatistics from './CustomCohortPrivateSalesStatistics';

interface Props {
  group: Pick<CustomCohortPreviewGroup, 'binding' | 'summary' | 'private_sales'> | null;
  freshness: CustomCohortPreviewState['freshness'];
  pocketId?: string | null;
  selectedOnly?: boolean;
}
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown, fallback = 'Unavailable') => typeof value === 'string' && value.length > 0 ? value : fallback;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable';
// Compare only valid retained UTC dates, never the browser's current clock.
const utcDay = (value: unknown, dateOnly = false): string | null => {
  if (typeof value !== 'string' || !(dateOnly ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).test(value)) return null;
  const iso = dateOnly ? `${value}T00:00:00.000Z` : value, date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso ? iso.slice(0, 10) : null;
};
const CAD_METRICS = ['year_built', 'gla_sqft', 'site_area_sqft', 'assessed_value'];
const REPORTED_METRICS = ['living_area', 'lot_size_area', 'year_built', 'bedrooms_total', 'bathrooms_total_integer',
  'bathrooms_full', 'bathrooms_half', 'garage_spaces', 'days_on_market', 'current_price'];

function MetricTable({ population, keys }: { population: Row; keys: readonly string[] }) {
  const metrics = object(population.metrics);
  return <div className="overflow-x-auto"><table className="w-full text-xs tabular-nums">
    <caption className="sr-only">Captured metric distributions; medians are not predominant values</caption>
    <thead><tr className="border-b border-purple-100 text-slate-600">
      {['Measure', 'Low', 'Median', 'High', 'Observed / members', 'COD'].map(label => <th key={label} className={`px-2 py-2 font-medium ${label === 'Measure' ? 'text-left' : 'text-right'}`} scope="col">{label}</th>)}
    </tr></thead>
    <tbody>{keys.map(key => {
      const metric = object(metrics[key]), display = object(metric.display);
      return <tr key={key} className="border-b border-slate-100 align-top" data-metric={key}>
        <th scope="row" className="max-w-44 px-2 py-2 text-left font-medium">
          {text(metric.label, key.replaceAll('_', ' '))}
          <span className="block text-[10px] font-normal text-slate-500">{text(metric.unit, 'Unit not established')}
            {['assessed_value', 'recorded_total_price', 'current_price'].includes(key) ? ' · Currency not established' : ''}</span>
          {metric.state !== 'ready' && <span className="block text-[10px] font-normal text-amber-800">{text(metric.state, 'Unavailable')}{metric.reason ? `: ${text(metric.reason)}` : ''}</span>}
        </th>
        {['low', 'median', 'high'].map(field => <td key={field} className="whitespace-nowrap px-2 py-2 text-right">{text(display[field])}</td>)}
        <td className="whitespace-nowrap px-2 py-2 text-right">{count(metric.count)} / {count(metric.member_count)}<span className="block text-[10px] text-slate-500">{count(metric.missing_count)} missing</span></td>
        <td className="whitespace-nowrap px-2 py-2 text-right">{text(display.cod_percent)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
function Population({ value, title }: { value: unknown; title: string }) {
  const population = object(value), stock = object(population.stock), transactions = object(population.transactions);
  const reported = object(population.source_reported);
  return <section className="min-w-0 rounded-xl border border-purple-200 p-3" aria-label={title}>
    <h4 className="font-semibold">{title}</h4>
    <p className="my-1 text-xs text-slate-600">{count(population.account_count)} accounts · {count(stock.member_count)} CAD members · {count(transactions.member_count)} recorded transactions</p>
    <h5 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide">Current captured CAD characteristics</h5>
    <MetricTable population={stock} keys={CAD_METRICS} />
    <h5 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide">Recorded transaction observations</h5>
    <MetricTable population={transactions} keys={['recorded_total_price']} />
    <p className="mt-1 text-[11px] text-slate-600">{count(transactions.omitted_count)} omitted transactions. Recorded total price may cover multiple properties; it is not a property-level sale price.</p>
    <details className="mt-3 rounded-lg border border-slate-200 px-2 py-2">
      <summary className="cursor-pointer text-xs font-medium">Source-reported observations ({count(reported.member_count)} members)</summary>
      <p className="my-2 text-[11px] text-slate-600">These source records are a separate population, not additional canonical sales or confirmed subject characteristics.</p>
      <MetricTable population={reported} keys={REPORTED_METRICS} />
    </details>
  </section>;
}

/** Display the server-formatted observation summary without recalculating,
 * relabeling its median as predominant, or inferring a reliability score. */
export default function CustomCohortStatistics({ group, freshness, pocketId, selectedOnly = false }: Props) {
  if (!group) return <p role="status" className="text-sm text-slate-600 print:hidden">No captured statistics are available yet.</p>;
  const summary = group.summary;
  const pockets = Array.isArray(summary.pockets) ? summary.pockets.map(object) : [];
  const pocket = pocketId ? pockets.find(p => p.id === pocketId) : null;
  const period = object(summary.observation_period);
  const effectiveDay = utcDay(summary.effective_date, true), captureDay = utcDay(summary.captured_at);
  return <section className="space-y-3 print:hidden" aria-label="Captured observation statistics" data-selection-revision={group.binding.selectionRevision} data-freshness={freshness}>
    <div>
      <h3 className="font-semibold">Captured observations — not report conclusions</h3>
      <p className="mt-1 text-xs text-slate-600">Observation period: {text(period.start_date)} through {text(period.end_date)}. Effective date: {text(summary.effective_date)}.</p>
      <p className="mt-1 text-xs text-slate-600">All and selected results use the same captured context and selection revision {group.binding.selectionRevision}. Provider coverage and historical applicability are not established.</p>
      {effectiveDay && captureDay && effectiveDay < captureDay && <p className="mt-2 text-sm text-amber-800">
        Current CAD captured on {captureDay} is later than the effective date. Use it as a current reference only;
        historical stock evidence is required for that appraisal date. In-period transaction observations remain available below.
      </p>}
      {freshness === 'stale' && <p role="status" className="mt-2 text-sm text-amber-800">Previous coherent results — the changed selection has not completed. These numbers still match the displayed map.</p>}
    </div>
    <div className={`grid gap-3 ${selectedOnly ? '' : '2xl:grid-cols-2'}`}>
      {!selectedOnly && <Population value={summary.all} title="All captured observations" />}
      <Population value={summary.selected} title="Selected observations" />
    </div>
    {pocketId && (pocket ? <Population value={pocket.result} title={`Inspected group: ${text(pocket.label)}`} />
      : <p role="status" className="rounded-lg border border-amber-200 p-3 text-sm">This group's statistics are not part of the displayed result. Inspect it separately; inclusion has not been changed.</p>)}
    {group.private_sales && <CustomCohortPrivateSalesStatistics observations={group.private_sales} freshness={freshness} selectedOnly={selectedOnly} />}
    <p className="text-xs text-slate-600">Median is a descriptive midpoint, not a supported predominant value. COD describes dispersion, not reliability. Similarity, housing eligibility, market eligibility, trends, and report readiness have not been established. Missing values remain unavailable. This preview cannot be applied to the report.</p>
  </section>;
}
