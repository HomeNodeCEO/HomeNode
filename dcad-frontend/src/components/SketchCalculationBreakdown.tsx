import type { CalculationArea, SketchCalculationBreakdown as Breakdown } from '@/lib/sketchCalculationTypes';

const PALETTE = ['#ede9fe', '#fef3c7', '#dcfce7', '#e0e7ff', '#ffe4e6'];
function sqft(value: number | null) {
  return value == null ? 'Pending' : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function SectionDiagram({ area }: { area: CalculationArea }) {
  const points = area.sections.flatMap(section => section.vertices);
  if (!points.length) return null;
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const scale = Math.min(470 / Math.max(1, maxX - minX), 180 / Math.max(1, maxY - minY));
  const plot = (point: { x: number; y: number }) => ({ x: 25 + ((point.x - minX) * scale), y: 20 + ((maxY - point.y) * scale) });
  return <svg aria-label={`${area.label} calculation sections`} className="my-3 max-h-64 w-full rounded-md bg-white" role="img" viewBox="0 0 520 220">
    {area.sections.map((section, index) => {
      const vertices = section.vertices.map(plot);
      return <g key={section.label}>
        <polygon points={vertices.map(point => `${point.x},${point.y}`).join(' ')} fill={PALETTE[index % PALETTE.length]} stroke="#6d28d9" strokeWidth="1" />
        <text x={vertices.reduce((sum, point) => sum + point.x, 0) / vertices.length} y={vertices.reduce((sum, point) => sum + point.y, 0) / vertices.length + 4} fill="#3b0764" fontSize="12" fontWeight="700" textAnchor="middle">{section.label}</text>
      </g>;
    })}
  </svg>;
}

export default function SketchCalculationBreakdown({ breakdown, revision, dirty }: {
  breakdown?: Breakdown;
  revision: number;
  dirty: boolean;
}) {
  if (!breakdown) return null;
  return <details className="mt-4 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
    <summary className="cursor-pointer text-sm font-semibold text-violet-950">Sketch calculation breakdown · saved revision {revision}</summary>
    <div className="mt-3 space-y-4">
      <p className="text-xs text-slate-600">These calculations belong to the saved sketch and are included in its PDF exhibit.{dirty ? ' Unsaved desktop edits are preserved; save the next revision to update its calculations.' : ''}</p>
      {breakdown.areas.map(area => <section className="rounded-md border border-violet-100 bg-white p-3" key={area.area_id}>
        <h4 className="text-sm font-semibold text-violet-950">{area.label}</h4>
        <p className="mt-1 text-xs text-slate-600">{area.level_label} · {area.classification.replaceAll('_', ' ')} · {area.gla_treatment === 'included' ? 'Included in GLA' : area.gla_treatment === 'deduction' ? 'GLA deduction' : 'Separate from GLA'}</p>
        {area.status === 'ready' ? <>
          <SectionDiagram area={area} />
          <div className="overflow-x-auto"><table className="w-full text-left text-xs">
            <thead className="bg-violet-50"><tr><th className="p-2">Section</th><th className="p-2">Calculation (feet)</th><th className="p-2 text-right">Sq ft</th></tr></thead>
            <tbody>{area.sections.map(section => <tr className="border-b border-violet-100" key={section.label}><td className="p-2">{section.label} · {section.shape}</td><td className="p-2">{section.formula}</td><td className="p-2 text-right tabular-nums">{sqft(section.calculated_area_sqft)}</td></tr>)}</tbody>
            <tfoot className="bg-amber-50 font-semibold"><tr><td className="p-2" colSpan={2}>Calculated area (sum of sections)</td><td className="p-2 text-right tabular-nums">{sqft(area.calculated_area_sqft)}</td></tr></tfoot>
          </table></div>
          <p className="mt-2 text-xs text-slate-600">Reported outline: {area.reported_area_sqft?.toLocaleString()} sq ft{area.gla_treatment === 'deduction' ? ' (deducted from parent GLA)' : ''}.</p>
          {area.displayed_row_rounding_difference_sqft ? <p className="mt-1 text-xs text-slate-600">Displayed row rounding difference: {sqft(area.displayed_row_rounding_difference_sqft)} sq ft. Totals retain full precision.</p> : null}
          {area.angled_walls.length ? <details className="mt-2 text-xs text-slate-600"><summary className="cursor-pointer font-semibold">Angled-wall working dimensions</summary><ul className="mt-2 space-y-1">{area.angled_walls.map(wall => <li key={wall.wall_index}>Wall {wall.wall_index}: {wall.formula}</li>)}</ul></details> : null}
        </> : <p className="mt-2 text-xs text-amber-800">{area.reason}</p>}
      </section>)}
      <div className="space-y-2 rounded-md bg-amber-50 p-3 text-xs text-violet-950">
        <h4 className="text-sm font-semibold">Area summary</h4>
        {breakdown.summary.levels.map(level => <p key={level.level_label}>{level.level_label}: {level.gross_included_sqft.toLocaleString()} gross - {level.deduction_sqft.toLocaleString()} deductions = {level.net_gla_sqft.toLocaleString()} sq ft GLA</p>)}
        <p className="font-semibold">{breakdown.summary.gross_included_sqft.toLocaleString()} gross - {breakdown.summary.deduction_sqft.toLocaleString()} deductions = {breakdown.summary.net_gla_sqft.toLocaleString()} sq ft reported GLA</p>
        <p>Calculated net included area: {sqft(breakdown.summary.net_calculated_sqft)} sq ft.</p>
        {breakdown.areas.filter(area => area.gla_treatment !== 'included').map(area => <p key={area.area_id}>{area.label}: {sqft(area.calculated_area_sqft)} sq ft · {area.gla_treatment === 'deduction' ? 'deduction' : 'excluded from GLA'}</p>)}
        {!breakdown.summary.all_breakdowns_ready ? <p>Incomplete or unavailable areas are identified above. Review all outlines before relying on the totals.</p> : null}
      </div>
      <p className="text-xs leading-5 text-slate-500">{breakdown.precision_note}</p>
    </div>
  </details>;
}
