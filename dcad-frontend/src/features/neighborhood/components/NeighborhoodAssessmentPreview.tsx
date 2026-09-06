import type { ReactElement } from 'react';
import {
  createNeighborhoodPreviewIntent, prepareNeighborhoodPreview,
  type NeighborhoodPreviewIntent, type OutlinePreview,
} from '../neighborhoodPreviewModel';

interface Props { envelopeJson: string; onIntent?: (intent: NeighborhoodPreviewIntent) => void }
const panel = 'hn-subtle-panel rounded-xl border border-slate-200 p-4';
const action = 'hn-action-secondary rounded-lg border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const titles = {
  new: 'Proposed addition', reused: 'Previously accepted value retained', conflict: 'Existing value preserved',
  unmapped: 'Not mapped', empty_companion: 'No proposed value',
  recommended: 'Recommended for review', needs_review: 'Needs review', excluded: 'Excluded',
  supported: 'Supported', unknown: 'Support unknown', conflicting: 'Conflicting evidence',
  available: 'Available', not_available: 'Not available',
};
const roles = { geographic_stock: 'Geographic stock', competitive_stock: 'Competitive stock', sales_sample: 'Sales sample' };
const outlineColors = { subject: '#b91c1c', neighborhood: '#2563eb', analysis_area: '#047857', pocket: '#7c3aed' };

/** Display-plane scaling only. Admitted rings are already closed; no geometry
 * repair, coordinate-system conversion, measurements or topology inference. */
function AreaOutline({ outline }: { outline: OutlinePreview }): ReactElement {
  const [x0, y0, x1, y1] = outline.frame;
  const scale = Math.min(600 / (x1 - x0), 320 / (y1 - y0));
  const left = (640 - (x1 - x0) * scale) / 2;
  const top = (360 - (y1 - y0) * scale) / 2;
  const position = ([x, y]: [number, number]) => `${left + (x - x0) * scale},${top + (y1 - y) * scale}`;
  return <figure className="mt-3">
    <svg viewBox="0 0 640 360" role="img" aria-label="Area outline" className="max-h-80 w-full rounded-lg border border-slate-200 bg-white">
      <title>Area outline</title>
      <desc>Supplied area shapes in a display plane. This outline does not measure distances or verify boundaries.</desc>
      {outline.features.map(feature => <g key={feature.id}>
        <title>{feature.label}</title>
        {feature.polygons.map((polygon, index) => <path key={index}
          d={polygon.map(ring => `M${ring.map(position).join(' L')} Z`).join(' ')}
          fill={outlineColors[feature.role]} fillOpacity={feature.role === 'subject' ? 0.24 : 0.08}
          fillRule="evenodd" stroke={outlineColors[feature.role]} strokeWidth={feature.role === 'subject' ? 2.5 : 1.5} />)}
      </g>)}
    </svg>
    <figcaption className="mt-2 text-xs text-slate-600">Area outline · supplied shapes, without a basemap.</figcaption>
    <ul className="mt-2 flex flex-wrap gap-3 text-xs">
      {outline.features.map(feature => <li key={feature.id}><span aria-hidden="true" style={{ color: outlineColors[feature.role] }}>■ </span>{feature.label}</li>)}
    </ul>
  </figure>;
}

/** Controlled, inactive presentation. No requests, storage, saving or selection.
 * Only trusted host code may receive these locally guarded review intents. */
export default function NeighborhoodAssessmentPreview({ envelopeJson, onIntent }: Props): ReactElement {
  const prepared = prepareNeighborhoodPreview(envelopeJson);
  function button(type: string, label: string, itemKey?: string): ReactElement {
    const permitted = typeof onIntent === 'function' && createNeighborhoodPreviewIntent(prepared, type, itemKey) !== null;
    return <button type="button" className={action} disabled={!permitted} onClick={() => {
      const intent = createNeighborhoodPreviewIntent(prepared, type, itemKey);
      if (intent && typeof onIntent === 'function') onIntent(intent);
    }}>{label}</button>;
  }
  if (prepared.phase === 'unavailable') return <section className={panel} aria-label="Neighborhood preview unavailable">
    <h3 className="font-semibold">Neighborhood preview unavailable</h3>
    <p className="mt-1 text-sm text-slate-600">A current, accessible preview is required before neighborhood evidence can be shown.</p>
  </section>;
  if (prepared.phase === 'loading') return <section className={panel} aria-label="Neighborhood preview" aria-busy="true">
    <p role="status">Loading neighborhood preview…</p>
  </section>;
  if (prepared.phase !== 'shown') return <section className={panel} aria-label="Neighborhood preview">
    <h3 className="font-semibold">Neighborhood preview</h3>
    <p role={prepared.phase === 'error' ? 'alert' : 'status'} className="my-3 text-sm text-slate-600">
      {prepared.phase === 'error' ? 'The neighborhood preview could not be loaded. Try again.' : 'No neighborhood preview is available yet.'}
    </p>
    {button('refresh', 'Refresh preview')}
  </section>;

  const d = prepared.document;
  const evidence = new Map(d.evidence.map(item => [item.key, item]));
  const links = (keys: string[]) => <span className="mt-2 flex flex-wrap gap-2">
    {keys.map(key => <span key={key}>{button('inspect-evidence', `View evidence: ${evidence.get(key)!.label}`, key)}</span>)}
  </span>;
  const blockers = [
    prepared.freshness === 'stale' ? 'This preview is out of date. Refresh before continuing review.' : null,
    prepared.read_only ? 'This report is read-only. You can inspect the available evidence.' : null,
    prepared.dirty ? 'Save or discard current edits, then refresh this preview before reviewing changes.' : null,
    prepared.spatial_blocked ? 'The area needs further spatial review before report changes can be reviewed.' : null,
    prepared.review_blocked ? 'Resolve the displayed conflicts or required review items before reviewing report changes.' : null,
  ].filter((message): message is string => message !== null);
  return <section key={prepared.render_key} aria-label="Neighborhood assessment preview" className="space-y-4 text-slate-900">
    <header className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Neighborhood review</h2>
          <p className="mt-1 font-medium">{d.subject_label}</p>
          <p className="mt-1 text-sm text-slate-600">{d.workflow === 'uad_3_6' ? 'UAD 3.6' : 'Custom Appraisal'}</p>
        </div>
        {d.origin === 'synthetic_fixture' && <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-sm">Example preview</span>}
      </div>
      <p className="mt-3 text-sm">Suggested area and values for review. No report fields have changed.</p>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-slate-600">Effective date</dt><dd><time dateTime={d.effective_date}>{d.effective_date}</time></dd></div>
        <div><dt className="text-slate-600">Observation period</dt><dd><time dateTime={d.observation_period.start_date}>{d.observation_period.start_date}</time> to <time dateTime={d.observation_period.end_date}>{d.observation_period.end_date}</time></dd></div>
        <div><dt className="text-slate-600">Data cutoff</dt><dd><time dateTime={d.data_cutoff}>{d.data_cutoff}</time></dd></div>
      </dl>
      {blockers.length > 0 && <ul className="mt-3 space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" aria-label="Review status">
        {blockers.map(message => <li key={message}>{message}</li>)}
      </ul>}
    </header>
    <section className={panel} aria-label="Area definitions"><h3 className="font-semibold">Area definitions</h3>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {([['neighborhood', 'Neighborhood area'], ['analysis_area', 'Sales analysis area']] as const).map(([key, label]) => {
          const area = d.boundary[key];
          return <div key={key}><h4 className="text-sm font-semibold">{label}</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{area.description ?? 'Not available'}</p>
            {area.evidence_key && links([area.evidence_key])}</div>;
        })}
      </div>
      {d.boundary.outline ? <AreaOutline outline={d.boundary.outline} /> : <p className="mt-3 text-sm text-slate-600">Area outline unavailable.</p>}
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        {(['north', 'east', 'south', 'west'] as const).map(direction => {
          const side = d.boundary.cardinals[direction];
          return <div key={direction}><dt className="text-sm font-semibold">{direction[0].toUpperCase() + direction.slice(1)}</dt>
            <dd className="whitespace-pre-wrap break-words text-sm">{side.text ?? 'Not available'}<span className="ml-2 text-xs text-slate-600">{titles[side.status]}</span>{links(side.evidence_keys)}</dd></div>;
        })}
      </dl>
    </section>
    <section className={panel} aria-label="Population summaries"><h3 className="font-semibold">Population summaries</h3>
      {d.populations.length === 0 && <p className="mt-2 text-sm text-slate-600">No population summary supplied.</p>}
      <div className="mt-3 grid gap-4 lg:grid-cols-3">{d.populations.map(population => <article key={population.id} className="min-w-0 rounded-lg border border-slate-200 p-3">
        <h4 className="font-semibold">{roles[population.role]}</h4><p className="mt-1 whitespace-pre-wrap break-words text-sm">{population.definition}</p>
        <dl className="mt-2 text-sm"><div><dt className="inline">Members: </dt><dd className="inline">{population.member_count ?? 'Not available'}</dd></div>
          <div><dt className="inline">Unique properties: </dt><dd className="inline">{population.unique_property_count ?? 'Not available'}</dd></div></dl>
        {population.coverage_text && <p className="mt-2 text-sm">{population.coverage_text}</p>}
        {links([population.evidence_key])}
        <dl className="mt-3 space-y-3">{population.metrics.map(metric => <div key={metric.id}>
          <dt className="text-sm font-medium">{metric.label}</dt><dd className="text-sm">{metric.display_value ?? 'Not available'}{metric.unit && <span> {metric.unit}</span>}
            <span className="block text-xs text-slate-600">{metric.estimator_label} · {titles[metric.status]}</span>{links(metric.evidence_keys)}</dd>
        </div>)}</dl>
      </article>)}</div>
    </section>
    <section className={panel} aria-label="Pocket review"><h3 className="font-semibold">Nearby pockets</h3>
      <p className="mt-1 text-sm text-slate-600">Inspect each area and its supporting evidence. Pocket alternatives are not added together automatically.</p>
      {d.pockets.length === 0 && <p className="mt-2 text-sm">No pocket comparison supplied.</p>}
      {d.pockets.length > 0 && <div className="mt-3 overflow-x-auto" role="region" aria-label="Pocket comparison" tabIndex={0}>
        <table className="w-full min-w-[480px] text-left text-sm"><thead><tr><th scope="col" className="p-2">Pocket</th><th scope="col" className="p-2">Review</th><th scope="col" className="p-2">Evidence</th></tr></thead>
          <tbody>{d.pockets.map(pocket => <tr key={pocket.id} className="border-t border-slate-200"><th scope="row" className="p-2 align-top">{pocket.label}</th>
            <td className="p-2 align-top"><p>{titles[pocket.disposition]}</p><p className="mt-1 whitespace-pre-wrap break-words">{pocket.explanation}</p>{pocket.overlap_text && <p className="mt-1 text-amber-900">{pocket.overlap_text}</p>}</td>
            <td className="p-2 align-top">{button('inspect-pocket', `Inspect pocket: ${pocket.label}`, pocket.id)}{links(pocket.evidence_keys)}</td></tr>)}</tbody>
        </table>
      </div>}
    </section>
    <section className={panel} aria-label="Proposed report values"><h3 className="font-semibold">Proposed report values</h3>
      <p className="mt-1 text-sm text-slate-600">These values belong to one review group. Existing and reused values remain visible.</p>
      {d.fields.length === 0 && <p className="mt-2 text-sm">No report values proposed.</p>}
      <div className="mt-3 grid gap-3 md:grid-cols-2">{d.fields.map(field => <article key={field.id} className="min-w-0 rounded-lg border border-slate-200 p-3">
        <h4 className="font-semibold">{field.label}</h4><p className="mt-1 text-xs text-slate-600">{titles[field.disposition]}</p>
        <dl className="mt-2 space-y-2 text-sm"><div><dt className="font-medium">Proposed</dt><dd className="whitespace-pre-wrap break-words">{field.proposed.status === 'value' ? field.proposed.text : 'No proposed value'}</dd></div>
          <div><dt className="font-medium">Current</dt><dd className="whitespace-pre-wrap break-words">{field.current.status === 'known_value' ? field.current.text : field.current.status === 'known_empty' ? 'Empty' : 'Current value not supplied'}</dd></div></dl>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{field.explanation}</p>{links(field.evidence_keys)}
      </article>)}</div>
    </section>
    <section className={panel} aria-label="Supporting evidence"><h3 className="font-semibold">Supporting evidence</h3>
      {d.evidence.map(item => <details key={item.key} className="mt-3 rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer font-medium">{item.label} · {titles[item.support]}</summary>
        {item.observation_text && <p className="mt-2 text-sm text-slate-600">{item.observation_text}</p>}
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.detail}</p>
        <div className="mt-2">{button('inspect-evidence', `View evidence: ${item.label}`, item.key)}</div>
      </details>)}
    </section>
    {d.review_items.length > 0 && <section className={panel} aria-label="Items needing review"><h3 className="font-semibold">Items needing review</h3>
      {d.review_items.map(item => <article key={item.id} className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <h4 className="font-medium">{item.label}</h4><p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.detail}</p>
        {item.blocks_review && <p className="mt-1 text-xs">Review required before continuing.</p>}{links(item.evidence_keys)}
      </article>)}
    </section>}
    <footer className="flex flex-wrap gap-3">{button('refresh', 'Refresh preview')}{button('edit-area', 'Edit area')}{button('review-group', 'Review report changes')}</footer>
  </section>;
}
