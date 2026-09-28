import { useMemo, useState } from 'react';
import type { CheckedPocketRecommendation } from '../customCohortPocketRecommendation';
import { customCohortScoreBands } from '../customCohortScoreBands';

interface Props {
  recommendation: CheckedPocketRecommendation | null;
  included: readonly string[];
  subjectGroupId: string | null;
  disabled: boolean;
  allGroupsIncluded: boolean;
  onReplace: (ids: readonly string[]) => void;
  onAdd: (ids: readonly string[]) => void;
  onRemove: (ids: readonly string[]) => void;
}

const button = 'hn-action-secondary btn btn-sm normal-case';

/** Appraiser-directed selection over already checked group scores. All three
 * actions use the workspace's existing atomic selection save/preview path. */
export default function CustomCohortScoreBandSelector({ recommendation, included, subjectGroupId, disabled,
  allGroupsIncluded, onReplace, onAdd, onRemove }: Props) {
  const [minimum, setMinimum] = useState(90);
  const bands = useMemo(() => customCohortScoreBands(recommendation), [recommendation]);
  const band = bands.find(item => item.minimum === minimum);
  const ids = band?.recorded_group_ids ?? [];
  const selected = useMemo(() => new Set(included), [included]);
  const allSelected = ids.length > 0 && ids.every(id => selected.has(id));
  const anySelected = ids.some(id => selected.has(id));
  const onlySelected = allSelected && selected.size === ids.length;
  return <section className="rounded-xl border border-violet-200 bg-violet-50/40 p-3 text-sm" aria-label="Select recorded groups by similarity range">
    <h4 className="font-semibold text-violet-950">Select by similarity range</h4>
    <p className="mt-1 text-xs text-slate-600">Choose recorded groups using the same conservative similarity score as the map fill. This does not change the scoring formula.</p>
    {allGroupsIncluded && <p className="mt-1 text-xs text-rose-800">All recorded groups are currently included, which is why their parcel outlines appear red. Use a range to narrow the selection.</p>}
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <label className="min-w-40 flex-1 text-xs font-medium text-violet-900">Similarity range
        <select className="select select-bordered mt-1 w-full" aria-label="Similarity range" value={minimum}
          disabled={!bands.length} onChange={event => setMinimum(Number(event.target.value))}>
          {(bands.length ? bands : Array.from({ length: 10 }, (_, index) => ({ minimum: 90 - index * 10,
            label: index === 0 ? '90–100' : `${90 - index * 10}–<${100 - index * 10}` }))).map(item =>
            <option key={item.minimum} value={item.minimum}>{item.label}</option>)}
        </select>
      </label>
      <p className="pb-2 text-xs text-slate-700" role="status">{band
        ? `${ids.length.toLocaleString('en-US')} recorded groups · ${band.account_count.toLocaleString('en-US')} properties`
        : 'Similarity ranges unavailable for this capture'}</p>
    </div>
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" className={button} disabled={disabled || !ids.length || onlySelected}
        onClick={() => onReplace(ids)}>Use only this range</button>
      <button type="button" className={button} disabled={disabled || !ids.length || allSelected}
        onClick={() => onAdd(ids)}>Add this range</button>
      <button type="button" className={button} disabled={disabled || !anySelected}
        onClick={() => onRemove(ids)}>Remove this range</button>
    </div>
    {subjectGroupId && band && !ids.includes(subjectGroupId) && <p className="mt-2 text-xs text-amber-900">
      The subject’s recorded group is outside this range; “Use only this range” will exclude it from the preview.</p>}
    <p className="mt-2 text-xs text-slate-600">Scores are lower bounds for recorded CAD groups, not scores for individual parcels or statistical reliability. Unknown-score groups are excluded from range actions. Use map clicks to refine the selection.</p>
  </section>;
}
