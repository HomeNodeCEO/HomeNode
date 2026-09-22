import type { ReactElement } from 'react';
import { checkReportedObservationAssessment, reportedObservationMeasurements, reportedObservationValue } from '../customReportedObservationPresentation.ts';

const panel = 'hn-subtle-panel rounded-xl border border-slate-200 p-3';
const cell = 'p-2 align-top whitespace-pre-wrap break-words';
const count = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US');
const period = (value: { start_date: string; end_date: string; date_basis: string }) => `${value.start_date} through ${value.end_date}; ${value.date_basis === 'capture_date' ? 'capture date' : 'reported closing date'}`;
const estimator = (value: string, probability?: number) => value === 'exact_median' ? 'Median (not predominant)'
  : value === 'exact_quantile' ? `Quantile (type 7); probability ${probability}` : value === 'count' ? 'Count' : 'Unsupported estimator';

/** Read-only presentation of one server-matched five-part accepted v2 group. */
export default function CustomReportedObservationSummary({ assessment }: { assessment: unknown }): ReactElement {
  let data;
  try { data = checkReportedObservationAssessment(assessment); } catch {
    return <section className={panel} aria-label="Accepted neighborhood summary unavailable"><h3 className="font-semibold">Neighborhood summary unavailable</h3>
      <p className="text-sm">The saved reported-observation group is incomplete or unsupported. Reload the file; legacy values have not been substituted.</p></section>;
  }
  return <section className="space-y-3 text-slate-900" aria-label="Accepted reported neighborhood observations">
    <header className={panel}><h3 className="text-sm font-semibold">Accepted reported neighborhood observations</h3>
      <p className="mt-1 text-xs">Descriptive observations, not verified market facts. CAD accounts are not economic properties; source records are not canonical transactions. Provider coverage is not established.</p>
      <p className="mt-2 text-xs">Effective date: {data.effective_date}; data cutoff: {data.data_cutoff}. Study: {period(data.observation_period)}.</p>
      <p className="mt-1 text-xs">Current CAD observations do not establish historical housing stock. Later CSV capture does not establish historical availability. Package totals are not allocated across accounts.</p>
    </header>
    <section className={panel} aria-label="Appraiser-defined observation boundary"><h4 className="text-sm font-semibold">Appraiser-defined observation boundary</h4>
      <p className="text-xs">Recorded manual boundary, not a legal subdivision or competitive pocket outline. A recorded subject-point relation does not establish full parcel containment.</p>
      <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">{['north', 'east', 'south', 'west'].map(side => <div key={side}><dt className="font-medium capitalize">{side}</dt>
        <dd className="whitespace-pre-wrap break-words">{data.geographic_neighborhood.status === 'ready' ? data.geographic_neighborhood.cardinal_summaries[side] ?? 'Unavailable'
          : `Unavailable - ${data.geographic_neighborhood.reasons.join('; ')}`}</dd></div>)}</dl>
    </section>
    <section className="space-y-3" aria-label="All reported population statistics">{data.populations.map(population => <article key={population.id} className={panel}>
      <h4 className="text-sm font-semibold">{population.kind === 'account_observations' ? 'Neighborhood property observations' : 'Neighborhood sales observations'}</h4>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{population.definition}</p>
      <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
        <div><dt>Member count</dt><dd>{count(population.member_count)} {population.member_unit === 'account' ? 'accounts' : 'source records'}</dd></div>
        <div><dt>Unique account count</dt><dd>{count(population.unique_account_count)}</dd></div><div><dt>Account link count</dt><dd>{count(population.account_link_count)}</dd></div>
        <div><dt>Retained roster completeness</dt><dd>{population.completeness}{population.reasons.length ? ` - ${population.reasons.join('; ')}` : ''}</dd></div>
        <div><dt>Observation period</dt><dd>{period(population.observation_period)}</dd></div><div><dt>Captured at</dt><dd>{population.captured_at ?? 'Unavailable'}</dd></div>
        <div><dt>Source records retained</dt><dd>{population.source_refs.length.toLocaleString('en-US')}</dd></div>
      </dl>
      <div className="mt-3 overflow-x-auto" role="region" aria-label="Neighborhood statistics" tabIndex={0}><table className="w-full min-w-[760px] text-left text-xs">
        <caption className="pb-2 text-left">Neighborhood statistics — exact retained values are available in each value’s title.</caption>
        <thead><tr>{['Statistic / estimator', 'Supplied observation', 'Observed / unavailable counts', 'Period / sources'].map(title => <th className={cell} key={title} scope="col">{title}</th>)}</tr></thead>
        <tbody>{data.statistics.filter(stat => stat.population_id === population.id).map(stat => <tr key={stat.id} className="border-t border-slate-200">
          <th scope="row" className={cell}>{reportedObservationMeasurements[stat.measurement].label}<span className="block font-normal">{estimator(stat.estimator, stat.estimator_parameters.probability)}</span></th>
          <td className={cell} title={stat.value === null ? undefined : `Exact retained value: ${stat.value}`}>{reportedObservationValue(stat)}</td>
          <td className={cell}><dl>{(['observed', 'missing', 'invalid', 'conflicting', 'unsupported', 'denominator'] as const).map(key => <div key={key}><dt className="inline capitalize">{key}: </dt><dd className="inline">{count(stat[`${key}_count`])}</dd></div>)}</dl></td>
          <td className={cell}>{period(stat.observation_period)}<span className="mt-1 block">{stat.source_refs.length.toLocaleString('en-US')} retained source reference{stat.source_refs.length === 1 ? '' : 's'}</span></td>
        </tr>)}</tbody>
      </table></div>
      {!data.statistics.some(stat => stat.population_id === population.id) && <p className="text-sm">Unavailable - no statistics supplied.</p>}
    </article>)}</section>
    <section className={panel} aria-label="Neighborhood evidence retention"><h4 className="text-sm font-semibold">Evidence retained in the workfile</h4>
      <p className="mt-1 text-xs">Source snapshots, internal record identifiers, selection revisions, and integrity checks remain available in the assignment workfile without appearing in the client-facing neighborhood summary.</p>
    </section>
  </section>;
}
