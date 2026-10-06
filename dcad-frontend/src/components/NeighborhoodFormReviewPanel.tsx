import type { NeighborhoodFormReview } from '@/lib/neighborhoodFormReview';

export default function NeighborhoodFormReviewPanel({ value, onChange, onUseFigures, current }: {
  value: NeighborhoodFormReview; onChange: (value: NeighborhoodFormReview) => void; onUseFigures: () => void; current: boolean;
}) {
  const choices = [
    { key: 'builtUp', label: 'Built-up', items: [['over_75', 'Over 75%'], ['25_to_75', '25–75%'], ['under_25', 'Under 25%']] },
    { key: 'growth', label: 'Growth', items: [['rapid', 'Rapid'], ['stable', 'Stable'], ['slow', 'Slow']] },
    { key: 'demandSupply', label: 'Demand / Supply', items: [['shortage', 'Shortage'], ['in_balance', 'In Balance'], ['over_supply', 'Over Supply']] },
  ] as const;
  return <details className="rounded-xl border border-violet-200 bg-white p-3">
    <summary className="cursor-pointer font-semibold text-violet-950">1004 / 2055 neighborhood fields</summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">{choices.map(choice => <label key={choice.key} className="grid gap-1 text-sm text-violet-950">
      {choice.label}<select className="select select-bordered select-sm bg-white" value={value[choice.key]}
        onChange={event => onChange({ ...value, [choice.key]: event.target.value })}>
        <option value="">Select</option>{choice.items.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>)}</div>
    <div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" className="hn-action-secondary btn btn-sm normal-case"
      disabled={!current} onClick={onUseFigures}>Use exploration study figures</button><span className="text-xs text-slate-600">Price in $000; age from selected CAD homes. Growth and supply require appraiser selection.</span></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {([['priceLow', 'Price low ($000)'], ['priceHigh', 'Price high ($000)'], ['pricePredominant', 'Price predominant ($000)'],
        ['ageLow', 'Age low'], ['ageHigh', 'Age high'], ['agePredominant', 'Age predominant']] as const).map(([key, label]) => <label key={key} className="grid gap-1 text-xs text-violet-950">
        {label}<input type="number" min="0" step="1" className="input input-bordered input-sm bg-white" value={value[key]}
          onChange={event => onChange({ ...value, [key]: event.target.value })} /></label>)}
    </div>
    <label className="mt-3 grid gap-1 text-sm text-violet-950">Neighborhood boundaries<textarea className="textarea textarea-bordered bg-white" rows={2}
      maxLength={8000} value={value.boundaries} onChange={event => onChange({ ...value, boundaries: event.target.value })} /></label>
  </details>;
}
