import { useEffect, useRef, useState } from 'react';
import type { MarketConditionsResponse } from '@/lib/api';
import { validExplorationLandUse, type ExplorationLandUse } from '@/lib/explorationLandUse';
import type { CustomCohortPreviewGroup } from '@/features/neighborhood/customCohortPreviewController';
import { requestCustomCohortOperation } from '@/features/neighborhood/customCohortPreviewApi';
import { explorationAreaIdentity, marketExplorationIdentity } from '@/features/neighborhood/customCohortMarketArea';

const labels: Record<string, string> = { one_unit: 'One-Unit', two_to_four_unit: '2–4 Unit', multifamily: 'Multi-Family', commercial: 'Commercial', other_vacant: 'Other' };

export default function ExplorationLandUsePanel({ group, value, onChange }: {
  group: CustomCohortPreviewGroup | null;
  value: ExplorationLandUse | null;
  onChange: (value: ExplorationLandUse) => void;
}) {
  const identity = group ? explorationAreaIdentity(group.binding) : null;
  const identityRef = useRef(identity); identityRef.current = identity;
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => { requestRef.current?.abort(); identityRef.current = null; }, []);
  useEffect(() => { requestRef.current?.abort(); setMessage(''); }, [identity]);
  const [loading, setLoading] = useState(false), [message, setMessage] = useState('');
  const current = value?.explorationIdentity === identity ? value : null;
  async function run() {
    if (!group || loading || requestRef.current) return;
    const expected = explorationAreaIdentity(group.binding), controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65_000);
    requestRef.current = controller;
    setLoading(true); setMessage('');
    try {
      const result = await requestCustomCohortOperation(group.binding.accountId, 'land-use', {
        assignment_file_id: group.binding.assignmentFileId, context_ref: group.binding.contextRef,
        selection: group.request.selection, selection_sha256: group.binding.selectionFingerprint,
      }, { signal: controller.signal });
      if (identityRef.current !== expected || controller.signal.aborted) return;
      if (marketExplorationIdentity(result as unknown as MarketConditionsResponse) !== expected
        || !validExplorationLandUse(result)) {
        throw new Error('The land-use results do not match the current map selection.');
      }
      onChange({ ...result, explorationIdentity: expected });
    } catch (error) {
      if (identityRef.current === expected) setMessage(controller.signal.aborted ? 'Land use took too long. Your map selection is unchanged.'
        : error instanceof Error ? error.message : 'Land use could not be calculated.');
    } finally { clearTimeout(timeout); requestRef.current = null; if (identityRef.current !== null) setLoading(false); }
  }
  return <section aria-label="Exploration area present land use" className="rounded-xl border border-violet-200 bg-white p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-violet-950">Present land use · Exploration Map Area</h3>
      <button type="button" disabled={!group || loading} onClick={() => void run()}
        className="hn-action-secondary btn btn-sm normal-case">{loading ? 'Calculating land use…' : 'Calculate land use'}</button>
    </div>
    {message && <p role="alert" className="mt-2 text-sm text-amber-900">{message}</p>}
    {current ? <>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">{current.categories.map(category => <div key={category.key} className="rounded-lg border border-violet-200 bg-violet-50 p-2 text-violet-950">
        <div className="text-xs">{labels[category.key]}</div><strong className="text-lg">{category.percent.toFixed(1)}%</strong>
      </div>)}</div>
      <p className="mt-2 text-sm font-semibold text-violet-950">{current.selected_parcel_count.toLocaleString()} selected parcels + {current.neighbor_parcel_count.toLocaleString()} edge-sharing neighbors · Built-up {current.built_up_percent.toFixed(1)}%</p>
      {current.unknown_percent > 0 && <p className="text-sm text-amber-900">Unclassified: {current.unknown_percent.toFixed(1)}%</p>}
      <details className="mt-2 text-xs text-slate-600"><summary>Land-use basis and flags</summary><p>{current.denominator_note}</p>
        {current.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>Stored CAD source: {current.source_updated_at || 'Date unavailable'}</p>
      </details>
    </> : <p className="mt-2 text-sm text-violet-900">{value ? 'Map selection changed. Recalculate land use.' : 'Select map areas, then calculate their land-use breakdown.'}</p>}
  </section>;
}
