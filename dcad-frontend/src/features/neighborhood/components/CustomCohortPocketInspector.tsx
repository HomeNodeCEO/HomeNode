import { useEffect, useRef, useState } from 'react';
import { requestCustomCohortObservationPreview } from '../customCohortPreviewApi';
import { checkCustomCohortSummaryResponse, fingerprintCustomCohortSelection } from '../customCohortPreviewController';
import type { CustomCohortPreviewInput } from '../customCohortPreviewController';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import { selectionFromRecordedGroups } from '../customCohortPocketCatalog';
import { CUSTOM_CAD_FIELD_LABELS } from '../customCohortCadEvidence';
import type { CheckedCadRecordedEvidence } from '../customCohortCadEvidence';
import CustomCohortStatistics from './CustomCohortStatistics';

interface Props { input: CustomCohortPreviewInput; catalog: CheckedPocketCatalog; pocketId: string; label: string;
  previewTransport?: typeof requestCustomCohortObservationPreview; paused?: boolean }
const amount = (value: number) => value.toLocaleString('en-US');
const literalText = (value: string | boolean | null) => value === null ? 'null (missing)' : typeof value === 'string'
  ? `${JSON.stringify(value)}${value.trim() ? '' : ' (blank / missing)'}` : String(value);
function RecordedCadDetails({ evidence, pocketId }: { evidence: CheckedCadRecordedEvidence; pocketId: string }) {
  const pocket = evidence.status === 'available' ? evidence.pockets.find(p => p.id === pocketId) : null;
  if (evidence.status === 'available' && !pocket) return null; // Never substitute all/another pocket.
  return <details className="rounded-lg border border-purple-200 px-3 py-2" aria-label="Recorded CAD observations">
    <summary className="cursor-pointer text-sm font-medium">Recorded CAD observations{pocket ? ` · ${amount(pocket.member_count)} accounts` : ''}</summary>
    <p className="mt-2 text-xs text-slate-600">Captured {evidence.binding.captured_at}. Current retained observations only; not verified housing, historical facts, legal boundaries, or reliability. These values do not change similarity scores.</p>
    {evidence.status === 'details_unavailable' ? <p className="mt-2 text-xs text-amber-800">CAD detail display exceeded the response size limit. This does not mean CAD evidence is missing. {amount(evidence.member_count)} accounts across {amount(evidence.pocket_count)} groups remain represented by the catalog.</p>
      : pocket && <>
        <p className="my-2 text-xs text-slate-600">Literal comparisons require complete matching county observations and complete field observations for both the subject and member. Matching text is not a housing-similarity determination. Partial means some parcel rows are missing values; conflicting means multiple different nonblank values.</p>
        <div className="space-y-2">{(Object.keys(CUSTOM_CAD_FIELD_LABELS) as (keyof typeof CUSTOM_CAD_FIELD_LABELS)[]).map(key => {
          const field = pocket.fields[key], subject = evidence.subject.fields[key], comparison = field.subject_comparison;
          return <details key={key} className="rounded-lg border border-slate-200 px-2 py-2" data-cad-field={key}>
            <summary className="cursor-pointer text-xs font-medium">{CUSTOM_CAD_FIELD_LABELS[key]}
              <span className="ml-2 font-normal text-slate-600">{amount(field.observed_count)} observed · {amount(field.partial_count)} partial · {amount(field.missing_count)} missing · {amount(field.conflicting_count)} conflicting accounts</span></summary>
            <p className="mt-2 text-xs">Subject: {subject.state}{subject.state === 'observed' || subject.state === 'partial' ? <> — <code className="whitespace-pre-wrap break-words">{literalText(subject.literal)}</code></> : ''}. County observations: {evidence.subject.county_state}.</p>
            {key === 'built_up' && <p className="mt-1 text-xs text-slate-600">This boolean was derived locally; true does not verify a completed home, and false is not a missing value.</p>}
            <p className="mt-1 text-xs">Subject literal: {amount(comparison.same_literal_count)} same · {amount(comparison.different_literal_count)} different · {amount(comparison.unavailable_count)} unavailable comparisons.</p>
            <p className="mt-1 text-xs text-slate-600">{amount(field.record_count)} parcel rows: {amount(field.observed_record_count)} with values, {amount(field.missing_record_count)} missing. Each account may appear under multiple literals; counts are not additive or percentages.</p>
            {field.distribution.entries === null ? <p className="mt-2 text-xs text-amber-800">Value details are unavailable because a display limit was reached ({amount(field.distribution.distinct_literal_count)} distinct literals). Counts above remain available; no partial list is shown.</p>
              : field.distribution.entries.length === 0 ? <p className="mt-2 text-xs text-slate-600">No retained parcel-row values.</p>
                : <ul className="mt-2 space-y-1 text-xs">{field.distribution.entries.map(entry => <li key={JSON.stringify(entry.literal)} className="flex items-start justify-between gap-3">
                  <code className="min-w-0 whitespace-pre-wrap break-words">{literalText(entry.literal)}</code><span className="shrink-0 tabular-nums">{amount(entry.account_count)} accounts</span>
                </li>)}</ul>}
          </details>;
        })}</div>
      </>}
  </details>;
}
/** Inspect an excluded pocket without changing the main selection or fetching
 * its map again. Keyed identity prevents an old group's numbers flashing on click. */
export default function CustomCohortPocketInspector(props: Props) {
  const ref = props.input.contextRef;
  return <InspectorSession key={JSON.stringify([props.input.accountId, props.input.assignmentFileId,
    ref.context_id, ref.context_revision, ref.context_sha256, props.pocketId])} {...props} />;
}
function InspectorSession(props: Props) {
  const cad = props.catalog.recommendation?.cad_recorded_evidence;
  const sameCadContext = cad && Object.entries(props.input.contextRef).every(([key, expected]) =>
    cad.binding.context_ref[key as keyof typeof props.input.contextRef] === expected);
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
    {cad && sameCadContext && <RecordedCadDetails evidence={cad} pocketId={props.pocketId} />}
  </section>;
}
