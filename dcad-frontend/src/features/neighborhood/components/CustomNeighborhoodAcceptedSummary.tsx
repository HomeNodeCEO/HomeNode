import type { ReactElement } from 'react';
import CustomReportedObservationSummary from './CustomReportedObservationSummary';

type RecordValue = Record<string, unknown>;
interface Props { assessment: unknown }
const panel = 'hn-subtle-panel rounded-xl border border-slate-200 p-3';
const cell = 'p-2 align-top whitespace-pre-wrap break-words';
const unavailable = 'Unavailable';
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim().length > 0 ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? value as number : null;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const currencyPerSf = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatNumber = (value: number, unit: unknown): string => unit === 'USD' ? currency.format(value)
  : unit === 'USD/ft2' ? currencyPerSf.format(value) : unit === 'year' ? String(value) : decimal.format(value);
const displayCount = (value: unknown): string => count(value) === null ? unavailable : decimal.format(value as number);
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.every(item => text(item) !== null) ? value : null;
const reasons = (value: unknown, fallback: string): string => strings(value)?.join('; ') || fallback;
const date = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
};
const dateBases: Record<string, string> = {
  closing_date: 'Closing date', contract_date: 'Contract date', status_as_of: 'Status as of', effective_date: 'Effective date',
};
const populationKinds: Record<string, string> = {
  geographic_stock: 'Geographic stock', competitive_stock: 'Competitive stock', transactions: 'Transactions', listings: 'Listings',
};
const memberUnits: Record<string, string> = {
  property: 'Properties', canonical_transaction: 'Canonical transactions', allocated_property_sale: 'Allocated property sales', listing: 'Listings',
};
const estimators: Record<string, string> = {
  count: 'Count', exact_median: 'Median', exact_quantile: 'Quantile (type 7)', arithmetic_mean: 'Arithmetic mean',
  modal_interval: 'Predominant modal interval [lower, upper)', ratio: 'Ratio', coefficient_of_dispersion: 'Coefficient of dispersion',
  unsupported: 'Unsupported estimator',
};
const distribution = ['exact_median', 'exact_quantile', 'arithmetic_mean', 'unsupported'];
const measurements: Record<string, { label: string; unit: string; estimators: string[] }> = Object.fromEntries([
  ['property_count', 'Property count', 'properties', ['count', 'unsupported']],
  ['transaction_count', 'Transaction count', 'transactions', ['count', 'unsupported']],
  ['allocated_property_sale_count', 'Allocated property sale count', 'property_sales', ['count', 'unsupported']],
  ['listing_count', 'Listing count', 'listings', ['count', 'unsupported']],
  ['unique_property_count', 'Unique property count', 'properties', ['count', 'unsupported']],
  ['recorded_sale_price', 'Recorded sale price', 'USD', distribution],
  ['allocated_sale_price', 'Package-allocated property sale price (not a recorded transaction price)', 'USD', distribution],
  ['assessed_market_value', 'CAD assessed market value (not a sale price)', 'USD', distribution],
  ['predominant_sale_price', 'Predominant sale price', 'USD', ['modal_interval', 'unsupported']],
  ['sale_price_per_square_foot', 'Sale price per square foot', 'USD/ft2', distribution],
  ['assessed_value_per_square_foot', 'CAD assessed value per square foot (not a sale price)', 'USD/ft2', distribution],
  ['gla', 'Gross living area', 'ft2', distribution],
  ['site_area', 'Site area', 'ft2', distribution],
  ['age_at_effective_date', 'Age at effective date', 'years', distribution],
  ['age_at_sale', 'Age at sale', 'years', distribution],
  ['year_built', 'Year built', 'year', distribution],
  ['days_on_market', 'Days on market', 'days', distribution],
  ['sale_coverage_percent', 'Sale coverage', 'percent', ['ratio', 'unsupported']],
  ['data_coverage_percent', 'Data coverage', 'percent', ['ratio', 'unsupported']],
  ['cod_percent', 'Coefficient of dispersion (COD)', 'percent', ['coefficient_of_dispersion', 'unsupported']],
  ['underlying_market_change_percent', 'Underlying market change', 'percent', ['unsupported']],
].map(([key, label, unit, allowed]) => [key, { label, unit, estimators: allowed }])) as typeof measurements;
const known = (labels: Record<string, string>, value: unknown): string | null => typeof value === 'string' && Object.hasOwn(labels, value)
  ? labels[value] : null;

function Period({ value }: { value: unknown }): ReactElement {
  const period = record(value), start = date(period.start_date), end = date(period.end_date), basis = known(dateBases, period.date_basis);
  return start && end && basis && start <= end
    ? <span><time dateTime={start}>{start}</time> through <time dateTime={end}>{end}</time><span className="block">Date basis: {basis}</span></span>
    : <span>Unavailable — observation period or date basis not supplied/supported.</span>;
}

function metricPresentation(statistic: RecordValue, population: RecordValue, sourceIds: Set<string>) {
  const measurement = typeof statistic.measurement === 'string' && Object.hasOwn(measurements, statistic.measurement)
    ? measurements[statistic.measurement] : null;
  let label = measurement?.label ?? 'Unsupported measurement';
  if (population.member_unit === 'allocated_property_sale' && ['predominant_sale_price', 'sale_price_per_square_foot'].includes(text(statistic.measurement) ?? '')) {
    label = `Package-allocated ${label.toLowerCase()}`;
  }
  const assessed = statistic.measurement === 'assessed_market_value' || statistic.measurement === 'assessed_value_per_square_foot';
  const taxYear = count(statistic.assessment_tax_year);
  if (assessed) label += ` — tax year: ${taxYear !== null && taxYear >= 1800 ? taxYear : unavailable}`;
  let estimator = known(estimators, statistic.estimator) ?? 'Unavailable — unknown estimator';
  let issue = !measurement || !measurement.estimators.includes(text(statistic.estimator) ?? '') || statistic.unit !== measurement.unit
    ? 'measurement, unit or estimator is not supported' : null;
  if (statistic.estimator === 'unsupported') issue = 'estimator is unsupported';
  const parameters = record(statistic.estimator_parameters);
  if (statistic.estimator === 'exact_quantile') {
    if (parameters.convention !== 'type_7' || !finite(parameters.probability) || parameters.probability < 0 || parameters.probability > 1) issue = 'quantile parameters are unavailable';
    else estimator += `; probability ${parameters.probability}`;
  }
  if (statistic.estimator === 'ratio') {
    if (count(parameters.numerator_count) === null) issue = 'ratio numerator is unavailable';
    else estimator += `; numerator ${displayCount(parameters.numerator_count)}`;
  }
  if (assessed && (taxYear === null || taxYear < 1800)) issue = 'assessment tax year is unavailable';
  if (!known(populationKinds, population.kind) || !known(memberUnits, population.member_unit) || !text(population.definition)) issue = 'population definition is unavailable or unsupported';
  if (['observed_count', 'missing_count', 'denominator_count'].some(key => count(statistic[key]) === null)
    || !['population_members', 'unique_properties'].includes(text(statistic.denominator_basis) ?? '')) issue = 'observation coverage is unavailable';
  const period = record(statistic.observation_period), start = date(period.start_date), end = date(period.end_date);
  if (!start || !end || start > end || !known(dateBases, period.date_basis)) issue ??= 'observation period or date basis is unavailable';
  const refs = strings(statistic.source_refs);
  if (!refs?.length || refs.some(id => !sourceIds.has(id))) issue ??= 'referenced source snapshots are unavailable';
  let value = finite(statistic.value) ? formatNumber(statistic.value, statistic.unit) : null;
  if (statistic.estimator === 'modal_interval') {
    if (parameters.method !== 'fixed_width_histogram' || !finite(parameters.lower_bound) || !finite(parameters.upper_bound)
      || !finite(parameters.bin_width) || parameters.upper_bound <= parameters.lower_bound || parameters.bin_width <= 0) issue = 'predominant interval parameters are unavailable';
    else value = `[${formatNumber(parameters.lower_bound, statistic.unit)}, ${formatNumber(parameters.upper_bound, statistic.unit)}); supplied value ${value ?? unavailable}`;
  }
  if (statistic.status !== 'ready') issue = text(statistic.reason) ?? 'statistic status is unavailable or unsupported';
  else if (population.completeness !== 'complete') issue ??= reasons(population.reasons, 'population completeness is unavailable');
  else if (!finite(statistic.value)) issue = 'a finite value was not supplied';
  return { label, estimator, value: issue ? `Unavailable — ${issue}.` : `${value} ${measurement!.unit}` };
}

/** Presentation of server-normalized v1 evidence only. The host must establish
 * exact target, acceptance and current revision before mounting this component.
 * No source verification, authority decision, recomputation, requests or writes. */
export default function CustomNeighborhoodAcceptedSummary({ assessment }: Props): ReactElement {
  const data = record(assessment);
  if (data.contract_version === 2) return <CustomReportedObservationSummary assessment={assessment} />;
  if (data.contract_version !== 1 || !Array.isArray(data.populations) || !Array.isArray(data.statistics) || !Array.isArray(data.source_snapshots)) {
    return <section className={panel} aria-label="Accepted neighborhood summary unavailable"><h3 className="font-semibold">Neighborhood summary unavailable</h3>
      <p className="mt-1 text-sm">Unavailable — a normalized NeighborhoodAssessment v1 with populations, statistics and source snapshots is required.</p></section>;
  }
  const populations = data.populations.map(record), statistics = data.statistics.map(record), sources = data.source_snapshots.map(record);
  const sourceIds = new Set(sources.flatMap(source => text(source.id) ? [source.id as string] : []));
  const geography = record(data.geographic_neighborhood), cardinals = record(geography.cardinal_summaries);
  const pockets = strings(record(data.selection).pocket_ids);
  const sourceReferences = (value: unknown) => {
    const refs = strings(value);
    return !refs || refs.length === 0 ? <span>Unavailable — no source references supplied.</span>
      : <ul className="space-y-1">{refs.map((id, index) => {
        const source = sources.find(item => item.id === id);
        return <li key={index}>{id}{source ? ` — ${text(source.provider) ?? 'provider unavailable'}` : ' — unavailable source snapshot'}</li>;
      })}</ul>;
  };
  const statisticsTable = (rows: RecordValue[], population: RecordValue, caption: string) => rows.length === 0
    ? <p className="mt-3 text-sm">Unavailable — no statistics supplied for this population.</p>
    : <div className="mt-3 overflow-x-auto" role="region" aria-label={caption} tabIndex={0}>
      <table className="w-full min-w-[760px] table-fixed text-left text-xs">
        <caption className="pb-2 text-left font-medium">{caption}</caption>
        <thead><tr>{['Statistic / estimator', 'Supplied value', 'Observed / missing / denominator', 'Observation period / sources'].map(label => <th key={label} scope="col" className={cell}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((statistic, index) => {
          const display = metricPresentation(statistic, population, sourceIds);
          return <tr key={index} className="border-t border-slate-200"><th scope="row" className={cell}>{display.label}
            <span className="mt-1 block font-normal">{display.estimator}</span><span className="mt-1 block font-normal text-slate-600">ID: {text(statistic.id) ?? unavailable}</span></th>
            <td className={cell}>{display.value}</td>
            <td className={cell}><dl>{[['observed_count', 'Observed'], ['missing_count', 'Missing'], ['denominator_count', 'Denominator']].map(([key, label]) =>
              <div key={key}><dt className="inline">{label}: </dt><dd className="inline">{displayCount(statistic[key])}</dd></div>)}
              <div><dt className="inline">Denominator basis: </dt><dd className="inline">{statistic.denominator_basis === 'population_members' ? 'Population members' : statistic.denominator_basis === 'unique_properties' ? 'Unique properties' : unavailable}</dd></div></dl></td>
            <td className={cell}><Period value={statistic.observation_period} /><div className="mt-2">Sources: {sourceReferences(statistic.source_refs)}</div></td></tr>;
        })}</tbody>
      </table>
    </div>;
  const unmatched = statistics.filter(statistic => !text(statistic.population_id) || !populations.some(population => population.id === statistic.population_id));
  return <section aria-label="Accepted neighborhood summary" className="space-y-3 text-slate-900">
    <header className={panel}><h3 className="text-sm font-semibold">Accepted neighborhood evidence</h3>
      <p className="mt-1 text-xs text-slate-600">Read-only summary of supplied evidence. This display does not verify sources or authorize report changes.</p>
      <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-3"><div><dt>Effective date</dt><dd>{date(data.effective_date) ?? unavailable}</dd></div>
        <div><dt>Data cutoff</dt><dd>{date(data.data_cutoff) ?? unavailable}</dd></div><div><dt>Study observation period</dt><dd><Period value={data.observation_period} /></dd></div></dl>
    </header>
    <section className={panel} aria-label="Descriptive geographic boundaries"><h4 className="text-sm font-semibold">Descriptive geographic boundaries</h4>
      <p className="mt-1 text-xs text-slate-600">These cardinal descriptions define the geographic neighborhood, not the selected competitive pockets.</p>
      <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">{['north', 'east', 'south', 'west'].map(side => <div key={side}><dt className="font-medium capitalize">{side}</dt>
        <dd className="whitespace-pre-wrap break-words">{geography.status === 'ready' && text(cardinals[side]) ? text(cardinals[side])
          : `Unavailable — ${reasons(geography.reasons, 'cardinal boundary not supplied or not ready')}.`}</dd></div>)}</dl>
    </section>
    <section className={panel} aria-label="Selected competitive pocket IDs"><h4 className="text-sm font-semibold">Selected competitive pocket IDs</h4>
      <p className="mt-1 text-xs text-slate-600">Selection identifiers only; they are not cardinal boundaries or an instruction to combine populations.</p>
      {pockets === null ? <p className="mt-2 text-sm">Unavailable — selected pocket IDs were not supplied.</p>
        : pockets.length === 0 ? <p className="mt-2 text-sm">No competitive pockets selected (0 supplied IDs).</p>
          : <ul className="mt-2 flex flex-wrap gap-2 text-xs">{pockets.map((id, index) => <li className="rounded border border-amber-200 bg-amber-50 px-2 py-1 break-all" key={index}>{id}</li>)}</ul>}
    </section>
    <section className="space-y-3" aria-label="All supplied population statistics"><h4 className="text-sm font-semibold">Population statistics</h4>
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs">Member counts and unique property counts are different measures. COD describes dispersion, not reliability. No metrics are recalculated here.</p>
      {populations.length === 0 && <p className="text-sm">Unavailable — no populations supplied.</p>}
      {populations.map((population, index) => <article key={index} className={panel}>
        <h5 className="text-sm font-semibold">{known(populationKinds, population.kind) ?? 'Unavailable population kind'} — {text(population.id) ?? unavailable}</h5>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{text(population.definition) ?? 'Unavailable — population definition not supplied.'}</p>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div><dt>Member count</dt><dd>{displayCount(population.member_count)} — {known(memberUnits, population.member_unit) ?? 'member unit unavailable'}</dd></div>
          <div><dt>Unique property count</dt><dd>{displayCount(population.unique_property_count)}</dd></div>
          <div><dt>Property link count</dt><dd>{displayCount(population.property_link_count)}</dd></div>
          <div><dt>Completeness</dt><dd>{population.completeness === 'complete' ? 'Complete' : `Unavailable — ${reasons(population.reasons, 'completeness not supplied')}.`}</dd></div>
          <div><dt>Observation period</dt><dd><Period value={population.observation_period} /></dd></div>
          <div><dt>Sources</dt><dd>{sourceReferences(population.source_refs)}</dd></div>
          <div><dt>Population pocket IDs</dt><dd className="break-words">{strings(population.pocket_ids) === null ? unavailable : strings(population.pocket_ids)!.join('; ') || 'None supplied'}</dd></div>
        </dl>
        {statisticsTable(statistics.filter(statistic => text(population.id) && statistic.population_id === population.id), population, `Statistics for ${text(population.id) ?? 'unavailable population'}`)}
      </article>)}
      {unmatched.length > 0 && <article className={panel}><h5 className="text-sm font-semibold">Unavailable population references</h5>
        {statisticsTable(unmatched, {}, 'Statistics without a supplied population')}</article>}
    </section>
    <section className={panel} aria-label="Supplied source snapshots"><h4 className="text-sm font-semibold">Source snapshots</h4>
      {sources.length === 0 && <p className="mt-2 text-sm">Unavailable — no source snapshots supplied.</p>}
      {sources.map((source, index) => <details key={index} className="mt-2 rounded-lg border border-slate-200 p-2 text-xs">
        <summary className="cursor-pointer break-words font-medium">{text(source.id) ?? unavailable} — {text(source.provider) ?? 'provider unavailable'}</summary>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2"><div><dt>Revision</dt><dd>{text(source.revision) ?? unavailable}</dd></div>
          <div><dt>Observed at</dt><dd>{text(source.observed_at) ?? unavailable}</dd></div><div><dt>Valid from / through</dt><dd>{date(source.valid_from) ?? unavailable} / {date(source.valid_to) ?? unavailable}</dd></div>
          <div><dt>Historical availability</dt><dd>{known({ contemporaneous: 'Contemporaneous', reconstructed: 'Reconstructed', unknown: 'Unknown' }, source.historical_availability) ?? unavailable}</dd></div>
          <div className="sm:col-span-2"><dt>Content SHA-256</dt><dd className="break-all">{text(source.content_sha256) ?? unavailable}</dd></div></dl>
      </details>)}
    </section>
  </section>;
}
