import { useEffect, useRef, useState } from 'react';
import type { createCustomWorkspaceApi } from '../customWorkspaceApi';
import type { CustomWorkspaceOperationOptions, CustomWorkspaceTarget } from '../customWorkspaceLifecycle';
import type { CustomCohortContextRef } from '../customCohortPreviewController';
import { decodeCustomReportedProposal, checkCustomReportedApply } from '../customReportedProposal';
import type { ReportedProposal, ReportedProposalExpectation } from '../customReportedProposal';
import { reportedObservationMeasurements, reportedObservationValue } from '../customReportedObservationPresentation';
import { acceptedNeighborhoodOutline } from '../acceptedNeighborhoodOutline';

const count = (value: number | null) => value?.toLocaleString('en-US') ?? 'Unavailable';

interface Props {
  target: CustomWorkspaceTarget; contextRef: CustomCohortContextRef; workspaceRevision: number;
  api: ReturnType<typeof createCustomWorkspaceApi>; disabled: boolean;
  run: (task: (io: CustomWorkspaceOperationOptions) => Promise<void>) => Promise<boolean>;
  onAccepted?: () => Promise<boolean>;
  onOutcomeUncertain?: (value: boolean) => void;
}
const button = 'hn-action-secondary btn btn-sm normal-case';
const issueText: Record<string, string> = {
  historical_stock_evidence_required: 'This retrospective date needs historical neighborhood inventory; current CAD data cannot stand in for it.',
  manual_cardinal_descriptions_required: 'Draw and save the rough neighborhood boundary and enter its north, east, south and west descriptions.',
  recorded_subject_point_not_covered: 'The saved outline must contain the subject’s recorded map location.',
};

/** Explicit report-only action. It uses the host's existing request lane/save
 * barrier. A failed response retains the SAME operation UUID for a safe retry;
 * unrelated autosaves do not drive this component's buttons or status. */
export default function CustomReportedObservationAdoption(props: Props) {
  const key = JSON.stringify([props.target.accountId, props.target.assignmentFileId, props.target.sessionKey,
    props.contextRef.context_id, props.contextRef.context_revision, props.contextRef.context_sha256, props.workspaceRevision]);
  return <AdoptionOwner key={key} {...props} />;
}

function AdoptionOwner(props: Props) {
  const [proposal, setProposal] = useState<ReportedProposal | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false), [busy, setBusy] = useState(false), [needsReload, setNeedsReload] = useState(false);
  const live = useRef(false), generation = useRef(0), pending = useRef<object | null>(null), acceptedRef = useRef(false);
  const expectation = useRef<ReportedProposalExpectation | null>(null), applyId = useRef<string | null>(null);
  const failed = useRef<'proposal' | 'apply' | null>(null), latest = useRef(props);
  latest.current = props;
  useEffect(() => { const epoch = generation; live.current = true; ++epoch.current; return () => { live.current = false; ++epoch.current; }; }, []);
  const current = (epoch: number, io?: CustomWorkspaceOperationOptions) => live.current && generation.current === epoch && !io?.signal.aborted;
  function failure(kind: 'proposal' | 'apply', epoch: number) {
    if (!current(epoch) || acceptedRef.current) return;
    failed.current = kind;
    setMessage(kind === 'proposal'
      ? 'The report proposal could not be confirmed. Retry this same request, or reload saved choices. Your accepted report has not been replaced.'
      : 'The save response could not be confirmed. Retry the same Apply request or reload the file to check its saved group; do not start a replacement save.');
  }
  function run(kind: 'proposal' | 'apply' | 'reload', task: (io: CustomWorkspaceOperationOptions, epoch: number) => Promise<void>) {
    if (!live.current || latest.current.disabled || pending.current || (acceptedRef.current && kind !== 'reload') || (kind === 'proposal' && failed.current === 'apply')) return;
    const token = {}, epoch = generation.current; pending.current = token; setBusy(true);
    const failedRun = () => { if (kind === 'reload') { if (current(epoch)) setMessage('The report group was saved, but its fresh read could not be confirmed. Reload the accepted group before continuing.'); }
      else failure(kind, epoch); };
    // Lock before the host lane: double clicks and retained event callbacks
    // cannot start concurrent requests for this target/session/context.
    void Promise.resolve().then(() => {
      if (!current(epoch)) return false;
      return latest.current.run(async io => {
        if (!current(epoch, io)) return;
        try { await task(io, epoch); } catch { failedRun(); }
      });
    }).then(result => { if (result === false) failedRun(); }).catch(failedRun).finally(() => {
      if (pending.current !== token) return;
      pending.current = null; ++generation.current; if (live.current) setBusy(false);
    });
  }
  async function reopen(io: CustomWorkspaceOperationOptions, epoch: number) {
    const reopened = await Promise.resolve().then(() => current(epoch, io) ? latest.current.onAccepted?.() : false).catch(() => false);
    if (!current(epoch, io)) return;
    if (reopened === true) {
      latest.current.onOutcomeUncertain?.(false);
      setNeedsReload(false); setMessage('Boundary and reported statistics saved together and reopened from this appraisal file.');
    } else {
      setNeedsReload(true); setMessage('Boundary and reported statistics were saved. Reload the accepted group before continuing.');
    }
  }
  function reloadAccepted() {
    if (!acceptedRef.current || !needsReload) return;
    run('reload', reopen);
  }
  function propose() {
    const request = { ...latest.current, target: { ...latest.current.target }, contextRef: { ...latest.current.contextRef } };
    run('proposal', async (io, epoch) => {
      if (!expectation.current) {
        const editorRevision = await request.api.readReportEditor(request.target, io);
        if (!current(epoch, io)) { failure('proposal', epoch); return; }
        expectation.current = { accountId: request.target.accountId, assignmentFileId: request.target.assignmentFileId,
          contextRef: { ...request.contextRef }, workspaceRevision: request.workspaceRevision, editorRevision, operationId: crypto.randomUUID() };
      }
      const e = expectation.current;
      const value = await request.api.reportedOperation({ target: request.target, operation: 'reported-proposal', body: {
        context_ref: e.contextRef, expected_workspace_revision: e.workspaceRevision,
        expected_editor_revision: e.editorRevision, operation_id: e.operationId,
      } }, io);
      if (!current(epoch, io)) { failure('proposal', epoch); return; }
      const result = decodeCustomReportedProposal(value, e);
      failed.current = null; setProposal(result); setMessage(null);
    });
  }
  function apply() {
    if (!proposal?.attachment || !expectation.current) return;
    const e = expectation.current, attachment = proposal.attachment, request = { ...latest.current, target: { ...latest.current.target } };
    run('apply', async (io, epoch) => {
      applyId.current ??= crypto.randomUUID();
      latest.current.onOutcomeUncertain?.(true);
      const value = await request.api.reportedOperation({ target: request.target, operation: 'reported-apply', body: {
        context_ref: e.contextRef, expected_workspace_revision: e.workspaceRevision,
        expected_editor_revision: e.editorRevision, proposal_operation_id: e.operationId,
        attachment_id: attachment.attachment_id, attachment_revision: attachment.attachment_revision,
        binding_digest: attachment.binding_digest, operation_id: applyId.current, adopt: true,
      } }, io);
      if (!current(epoch, io)) { failure('apply', epoch); return; }
      checkCustomReportedApply(value, e, applyId.current);
      failed.current = null; acceptedRef.current = true; setAccepted(true); setNeedsReload(true);
      // UI callbacks cannot turn a validated ACK into a failed save. An
      // unresolved host barrier can still require an explicit reload.
      setMessage('Boundary and reported statistics were saved. Confirming the fresh accepted group before continuing.');
      await reopen(io, epoch);
    });
  }
  const outline = proposal?.boundary ? acceptedNeighborhoodOutline(proposal.boundary.geometry) : null;
  return <section className="rounded-xl border border-amber-200 bg-white/80 p-3" aria-label="Apply neighborhood observations to report">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h4 className="font-semibold">Review neighborhood report group</h4>
        <p className="text-xs text-slate-600">Your rough boundary and the selected pockets’ reported statistics are applied together.</p></div>
      {!accepted && <button type="button" className={button} disabled={props.disabled || busy || failed.current === 'apply'} onClick={propose}>
        {failed.current === 'proposal' ? 'Retry report proposal' : proposal ? 'Reload this proposal' : 'Prepare report group'}</button>}
    </div>
    {busy && <p role="status" className="mt-2 text-xs">Confirming the report request…</p>}
    {message && <p role={failed.current ? 'alert' : 'status'} className="mt-2 text-sm">{message}</p>}
    {accepted && needsReload && <button type="button" className={`${button} mt-2`} disabled={props.disabled || busy} onClick={reloadAccepted}>Reload accepted group</button>}
    {proposal?.status === 'incomplete' && <div role="status" className="mt-2 text-sm">
      This selection is not ready to apply. {proposal.issues.map((code, index) => <p key={index}>
        {issueText[code] ?? `Review needed: ${code.replaceAll('_', ' ')}`}</p>)}
    </div>}
    {proposal && <>
      {proposal.boundary && <div className="mt-3 rounded-lg border border-violet-200 p-2">
        <h5 className="text-sm font-semibold">{accepted ? 'Accepted' : 'Proposed'} observation boundary</h5>
        {outline ? <svg role="img" aria-label="Exact proposed outline with excluded holes" viewBox="0 0 600 300" className="mt-2 max-h-64 w-full bg-violet-50">
          <text x="580" y="20" textAnchor="end" fontSize="12">N</text>
          {outline.paths.map((path, index) => <path key={index} d={path} fill="#ddd6fe" stroke="#7c3aed" strokeWidth="2" fillRule="evenodd" vectorEffect="non-scaling-stroke" />)}
        </svg> : <p className="text-xs">Proposed outline unavailable. No substitute shape was generated.</p>}
        <p className="text-xs">Exact retained proposal geometry, not a basemap or the current unsaved editor boundary. Recorded subject-point coverage is not full parcel containment.</p>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">{(['north', 'east', 'south', 'west'] as const).map(side => <div key={side}>
          <dt className="font-medium capitalize">{side}</dt><dd className="whitespace-pre-wrap break-words">{proposal.boundary!.cardinal_summaries[side] ?? 'Unavailable'}</dd></div>)}</dl>
      </div>}
      <p className="mt-3 text-xs text-slate-600">These are reported observations, not independently verified market facts. Source records are not a count of unique sale transactions; package prices remain whole.</p>
      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        {proposal.populations.map(pop => <div key={pop.id} className="overflow-x-auto rounded-lg border border-slate-200 p-2">
          <h5 className="text-sm font-semibold">{pop.kind === 'account_observations' ? 'CAD-account observations' : 'Source-record observations'} — {pop.id}</h5>
          <p className="text-xs">{count(pop.member_count)} {pop.member_unit === 'account' ? 'accounts' : 'source records'} · {count(pop.unique_account_count)} unique linked accounts; {count(pop.account_link_count)} account links</p>
          <table className="mt-2 w-full text-xs"><thead><tr><th className="text-left">Reported measure / estimator</th><th className="text-right">Supplied value</th><th className="text-right">Observation counts / period</th></tr></thead>
            <tbody>{proposal.statistics.filter(s => s.population_id === pop.id).map(s => <tr key={s.id} className="border-t border-slate-100">
              <td className="py-1">{reportedObservationMeasurements[s.measurement].label}<span className="block">{s.estimator === 'exact_median' ? 'Median (not predominant)' : s.estimator === 'exact_quantile'
                ? (s.estimator_parameters.probability === 0 ? 'Low (type 7 quantile)' : 'High (type 7 quantile)') : s.estimator === 'count' ? 'Count' : 'Unsupported estimator'}</span></td>
              <td className="text-right tabular-nums" title={s.value === null ? s.reason ?? '' : String(s.value)}>{reportedObservationValue(s)}</td>
              <td className="text-right tabular-nums">Observed: {count(s.observed_count)} / {count(s.denominator_count)}
                <span className="block">Missing: {count(s.missing_count)}; invalid: {count(s.invalid_count)}; conflicting: {count(s.conflicting_count)}; unsupported: {count(s.unsupported_count)}</span>
                <span className="block">{s.observation_period.start_date} through {s.observation_period.end_date} ({s.observation_period.date_basis === 'capture_date' ? 'capture date' : 'reported closing date'})</span>
                <span className="block break-all">Sources: {s.source_refs.join('; ') || 'Unavailable'}</span></td>
            </tr>)}</tbody></table>
        </div>)}
      </div>
      {proposal.status === 'proposed' && !accepted && <button type="button" className={`${button} mt-3`} disabled={props.disabled || busy} onClick={apply}>
        {failed.current === 'apply' ? 'Retry same Apply request' : 'Apply boundary and statistics together'}</button>}
    </>}
  </section>;
}
