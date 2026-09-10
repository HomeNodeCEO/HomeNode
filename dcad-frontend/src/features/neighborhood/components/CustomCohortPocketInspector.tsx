import { useEffect, useRef, useState } from 'react';
import { requestCustomCohortObservationPreview } from '../customCohortPreviewApi';
import { checkCustomCohortSummaryResponse, fingerprintCustomCohortSelection } from '../customCohortPreviewController';
import type { CustomCohortPreviewInput } from '../customCohortPreviewController';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import { selectionFromRecordedGroups } from '../customCohortPocketCatalog';
import CustomCohortStatistics from './CustomCohortStatistics';

interface Props { input: CustomCohortPreviewInput; catalog: CheckedPocketCatalog; pocketId: string; label: string;
  previewTransport?: typeof requestCustomCohortObservationPreview; paused?: boolean }
/** Inspect an excluded pocket without changing the main selection or fetching
 * its map again. Keyed identity prevents an old group's numbers flashing on click. */
export default function CustomCohortPocketInspector(props: Props) {
  const ref = props.input.contextRef;
  return <InspectorSession key={JSON.stringify([props.input.accountId, props.input.assignmentFileId,
    ref.context_id, ref.context_revision, ref.context_sha256, props.pocketId])} {...props} />;
}
function InspectorSession(props: Props) {
  const [input] = useState(() => ({ ...props.input,
    selection: selectionFromRecordedGroups(props.catalog, [props.pocketId], 1) }));
  const [group, setGroup] = useState<ReturnType<typeof checkCustomCohortSummaryResponse> | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const completed = useRef(false);
  const failedRetry = useRef<number | null>(null);
  const paused = props.paused === true;
  const transport = useRef(props.previewTransport ?? requestCustomCohortObservationPreview);
  transport.current = props.previewTransport ?? requestCustomCohortObservationPreview;
  useEffect(() => {
    if (paused || completed.current || failedRetry.current === retry) return;
    let active = true; const abort = new AbortController();
    setGroup(null); setError(false);
    const timeout = setTimeout(() => { abort.abort(); if (active) { failedRetry.current = retry; setError(true); } }, 65_000);
    void (async () => {
      const hash = await fingerprintCustomCohortSelection(input);
      if (!active || abort.signal.aborted) return;
      const value = await transport.current({ ...input, include_map: false }, { signal: abort.signal });
      if (!active || abort.signal.aborted) return;
      const record = value as Record<string, unknown> | null;
      const omitted = record?.parcel_map as Record<string, unknown> | null;
      if (omitted?.status !== 'omitted' || omitted.reason !== 'geometry_not_requested') throw new Error('Unexpected inspection geometry');
      const checked = checkCustomCohortSummaryResponse(value, input, hash);
      completed.current = true; setGroup(checked);
    })().catch(() => { if (active && !abort.signal.aborted) { failedRetry.current = retry; setError(true); } }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); abort.abort(); };
  }, [input, retry, paused]);
  return <section className="space-y-2 rounded-xl border border-violet-200 p-3 print:hidden" aria-label={`Inspect ${props.label}`}>
    <h4 className="font-semibold">Inside {props.label}</h4>
    <p className="text-sm">Independent inspection only. Opening this group does not include or exclude it.</p>
    {paused && <p role="status">Group inspection is paused while the report is being saved or finalized. Any displayed observations are retained from this context.</p>}
    {!group && !error && !paused && <p role="status">Loading this group’s observations…</p>}
    {error && <div role="alert"><p>This group could not be inspected. The main selection has not changed.</p>
      <button type="button" className="hn-action-secondary btn btn-sm normal-case" disabled={paused}
        onClick={() => { if (!paused) setRetry(n => n + 1); }}>Retry inspection</button></div>}
    {group && <CustomCohortStatistics group={group} freshness={paused ? 'stale' : 'current'} selectedOnly />}
  </section>;
}
