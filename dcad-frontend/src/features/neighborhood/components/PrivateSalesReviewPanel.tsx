import { useEffect, useRef, useState } from 'react';
import { checkPrivateSalesReviewState, preparePrivateSalesReviewForPage } from '../privateSalesReview';
import type { PrivateSalesReviewCommand, PrivateSalesReviewPage, PrivateSalesReviewState, PrivateSalesRowDecision,
  PrivateSalesSourceInterpretation } from '../privateSalesReview';
import type { PrivateSalesIdentity, PrivateSalesReceipt } from '../privateSalesImports';
import { checkPrivateSalesMatchProposals } from '../privateSalesMatchProposals';
import type { PrivateSalesMatchProposalPage } from '../privateSalesMatchProposals';

export interface PrivateSalesReviewPanelProps {
  identity: PrivateSalesIdentity; receipt: PrivateSalesReceipt; page: PrivateSalesReviewPage;
  reviewState: PrivateSalesReviewState | null; proposals: PrivateSalesMatchProposalPage | null;
  readOnly: boolean; busy: boolean; reloadRequired?: boolean;
  /** The parent synchronously owns the operation lane, UUID and uncertain-save recovery. */
  onSave: (command: PrivateSalesReviewCommand) => void;
  onReload?: () => void;
}
const button = 'hn-action-secondary btn btn-sm normal-case';
const decisionLabels = { confirm_proposed_match: 'account match confirmed', exclude: 'excluded', clear: 'review cleared' } as const;
const unknownSource = (): PrivateSalesSourceInterpretation => ({ source_name: '', provenance_note: '', currency: null,
  living_area_unit: null, site_area_unit: null, consideration_field: null, marketing_time_field: null, source_use_confirmed: false });
const choices = [
  ['currency', 'Currency', [['USD', 'USD']]],
  ['living_area_unit', 'Living area unit', [['sqft', 'Square feet'], ['sqm', 'Square metres']]],
  ['site_area_unit', 'Site area unit', [['sqft', 'Square feet'], ['acre', 'Acres'], ['sqm', 'Square metres']]],
  ['consideration_field', 'Consideration field', [['close_price', 'ClosePrice'], ['current_price', 'CurrentPrice']]],
  ['marketing_time_field', 'Marketing time field', [['days_on_market', 'DaysOnMarket'], ['cumulative_days_on_market', 'CumulativeDaysOnMarket']]],
] as const;

/** Controlled staging only: no request, polling, source grant or analysis mutation.
 * A new exact target or durable review revision starts a new form session. */
export default function PrivateSalesReviewPanel(props: PrivateSalesReviewPanelProps) {
  return <ReviewSession key={JSON.stringify([props.identity.accountId, props.identity.assignmentFileId, props.identity.sessionKey,
    props.receipt.report_file_id, props.receipt.batch_id, props.receipt.source_sha256, props.receipt.preparation_sha256,
    props.reviewState?.revision, props.reviewState?.last_review_id])} {...props} />;
}
function ReviewSession(props: PrivateSalesReviewPanelProps) {
  let state: PrivateSalesReviewState | null = null, proposals: PrivateSalesMatchProposalPage | null = null;
  try { state = checkPrivateSalesReviewState(props.reviewState, props.identity, props.receipt, props.page); } catch { /* Unusable state stays blocked. */ }
  try { if (props.proposals) proposals = checkPrivateSalesMatchProposals(props.proposals,
    { identity: props.identity, receipt: props.receipt, page: props.page }); } catch { /* Exclude/clear do not require a proposal. */ }
  const [source, setSource] = useState(() => ({ ...(state?.source_interpretation ?? unknownSource()) }));
  const [sourceDirty, setSourceDirty] = useState(false), [error, setError] = useState('');
  const pageKey = JSON.stringify([props.page.batch_id, props.page.rows.map(row => [row.receipt_id, row.source_row_number]),
    props.page.next_after_row, proposals?.proposal_page_sha256 ?? null]);
  const [staged, setStaged] = useState<{ pageKey: string; rows: PrivateSalesRowDecision[] }>({ pageKey, rows: [] });
  const rows = staged.pageKey === pageKey ? staged.rows : [];
  const alive = useRef(true), current = useRef({ props, state, proposals, pageKey }); current.current = { props, state, proposals, pageKey };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const blocked = props.readOnly || props.busy || props.reloadRequired || !state || state.revision === 2147483647;
  const writable = () => alive.current && current.current.pageKey === pageKey && current.current.state !== null
    && current.current.state.revision < 2147483647 && !current.current.props.readOnly && !current.current.props.busy && !current.current.props.reloadRequired;
  function editSource<K extends keyof PrivateSalesSourceInterpretation>(key: K, value: PrivateSalesSourceInterpretation[K]) {
    if (!writable()) return; setSource(previous => ({ ...previous, [key]: value })); setSourceDirty(true); setError('');
  }
  function stage(receiptId: string, decision: PrivateSalesRowDecision['decision']) {
    if (!writable()) return;
    const row = props.page.rows.find(row => row.receipt_id === receiptId); if (!row) return;
    const proposal = proposals?.rows.find(row => row.receipt_id === receiptId);
    if (decision === 'confirm_proposed_match' && proposal?.proposal_status !== 'proposed') return;
    const prior = rows.find(row => row.receipt_id === receiptId);
    const saved = state?.row_decisions.find(row => row.receipt_id === receiptId);
    const next = { receipt_id: receiptId, source_row_number: row.source_row_number, decision,
      account_ids: decision === 'confirm_proposed_match' ? [...proposal!.proposed_account_ids].sort() : [], note: prior?.note ?? saved?.note ?? '' };
    setStaged({ pageKey, rows: [...rows.filter(row => row.receipt_id !== receiptId), next] }); setError('');
  }
  function stageAll() {
    if (!writable() || !proposals) return;
    const next = [...rows];
    for (const proposal of proposals.rows.filter(row => row.proposal_status === 'proposed')) {
      const index = next.findIndex(row => row.receipt_id === proposal.receipt_id), prior = next[index];
      const decision: PrivateSalesRowDecision = { receipt_id: proposal.receipt_id, source_row_number: proposal.source_row_number,
        decision: 'confirm_proposed_match', account_ids: [...proposal.proposed_account_ids].sort(),
        note: prior?.note ?? state?.row_decisions.find(row => row.receipt_id === proposal.receipt_id)?.note ?? '' };
      if (index < 0) next.push(decision); else next[index] = decision;
    }
    setStaged({ pageKey, rows: next }); setError('');
  }
  function save() {
    if (!writable()) return;
    try {
      const command = preparePrivateSalesReviewForPage({ review_version: 1, expected_revision: state!.revision,
        source_interpretation: sourceDirty ? source : null, row_decisions: rows }, state!, props.identity, props.receipt, props.page, proposals);
      current.current.props.onSave(command);
    } catch { setError('Check the staged review: a source name is required when changing interpretation, and each confirmation must match this page’s current proposal. Nothing is added to analysis.'); }
  }
  const proposedCount = proposals?.rows.filter(row => row.proposal_status === 'proposed').length ?? 0;
  return <section className="mt-3 space-y-3 rounded border border-base-300 p-3" aria-label="Private sales review">
    <h4 className="font-semibold">Review private sales</h4>
    <p className="text-sm">Review is saved separately from the original CSV. It does not automatically add any row to analysis or establish sale eligibility, economic membership, or historical stock coverage.</p>
    <p className="text-xs">CurrentPrice is not ClosePrice. Units and field meanings remain unknown until explicitly declared. Current account proposals do not establish historical ownership.</p>
    <p className="text-sm">{state ? state.revision === 0 ? 'No saved review yet.' : `Saved review revision ${state.revision}.`
      : 'Load the current review for this exact saved row page before editing.'}</p>
    {props.reloadRequired && <p role="status">This review needs an explicit saved-state reload before further changes. An uncertain operation ID must be preserved.</p>}
    {props.readOnly && <p className="text-sm">Private sales review is read-only.</p>}
    {props.busy && <p role="status">Review request in progress…</p>}
    {state?.revision === 2147483647 && <p role="status">This review revision cannot accept another change.</p>}
    {props.onReload && <button type="button" className={button} disabled={props.busy} onClick={() => {
      if (alive.current && !current.current.props.busy) current.current.props.onReload?.();
    }}>Reload saved review</button>}
    <details className="rounded border border-base-300 p-2">
      <summary className="cursor-pointer font-medium">Source interpretation {sourceDirty ? '(staged)' : state?.source_interpretation ? '(saved separately)' : '(not declared)'}</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label>Source name<input className="input input-bordered input-sm w-full" aria-label="Source name" maxLength={200}
          value={source.source_name} disabled={blocked} onChange={event => editSource('source_name', event.currentTarget.value)} /></label>
        <label className="sm:col-span-2">Provenance note<textarea className="textarea textarea-bordered w-full" aria-label="Provenance note" maxLength={1000}
          value={source.provenance_note} disabled={blocked} onChange={event => editSource('provenance_note', event.currentTarget.value)} /></label>
        {choices.map(([key, label, values]) => <label key={key}>{label}<select className="select select-bordered select-sm w-full"
          aria-label={label} value={source[key] ?? ''} disabled={blocked} onChange={event => editSource(key,
            (event.currentTarget.value || null) as PrivateSalesSourceInterpretation[typeof key])}>
          <option value="">Unknown / not declared</option>{values.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>)}
        <label className="sm:col-span-2"><input type="checkbox" className="checkbox checkbox-sm mr-2" aria-label="Source use confirmation"
          checked={source.source_use_confirmed} disabled={blocked} onChange={event => editSource('source_use_confirmed', event.currentTarget.checked)} />
          I affirm that I am permitted to use this source for this assignment. This records my affirmation; it does not grant provider rights.</label>
      </div>
    </details>
    <button type="button" className={button} disabled={blocked || proposedCount === 0} onClick={stageAll}>
      Stage confirmation of all {proposedCount} proposed matches on this page</button>
    <p className="text-xs">Save staged choices before changing pages or refreshing proposals; these actions reset staged row choices.</p>
    {state && props.page.rows.map(row => {
      const saved = state.row_decisions.find(decision => decision.receipt_id === row.receipt_id);
      const draft = rows.find(decision => decision.receipt_id === row.receipt_id);
      const proposal = proposals?.rows.find(proposal => proposal.receipt_id === row.receipt_id);
      return <details key={row.receipt_id} className="rounded border border-base-300 p-2 text-sm" data-review-row={row.source_row_number}>
        <summary className="cursor-pointer">Source row {row.source_row_number}: saved {saved ? decisionLabels[saved.decision] : 'not reviewed'};
          {' '}proposal {proposal?.proposal_status.replaceAll('_', ' ') ?? 'not loaded'}{draft ? `; staged ${decisionLabels[draft.decision]}` : ''}.</summary>
        {saved?.account_ids.length ? <p>Saved accounts: {saved.account_ids.join(', ')}.</p> : null}
        {proposal?.proposed_account_ids.length ? <p>Proposed accounts: {proposal.proposed_account_ids.join(', ')}.</p> : null}
        {draft?.account_ids.length ? <p>Staged accounts: {draft.account_ids.join(', ')}.</p> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={button} disabled={blocked || proposal?.proposal_status !== 'proposed'} onClick={() => stage(row.receipt_id, 'confirm_proposed_match')}>Stage confirm row {row.source_row_number}</button>
          <button type="button" className={button} disabled={blocked} onClick={() => stage(row.receipt_id, 'exclude')}>Stage exclude row {row.source_row_number}</button>
          <button type="button" className={button} disabled={blocked} onClick={() => stage(row.receipt_id, 'clear')}>Stage clear row {row.source_row_number}</button>
        </div>
        <label>Review note for row {row.source_row_number}<textarea className="textarea textarea-bordered mt-1 w-full" maxLength={1000}
          aria-label={`Review note for row ${row.source_row_number}`} value={draft?.note ?? saved?.note ?? ''} disabled={blocked || !draft}
          onChange={event => { if (!writable() || !draft) return;
            setStaged({ pageKey, rows: rows.map(decision => decision.receipt_id === row.receipt_id ? { ...decision, note: event.currentTarget.value } : decision) });
          }} /></label>
      </details>;
    })}
    {error && <p role="alert">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="hn-action-primary btn btn-sm normal-case" disabled={blocked || !sourceDirty && rows.length === 0} onClick={save}>Save staged review</button>
      <button type="button" className={button} disabled={blocked || !sourceDirty && rows.length === 0} onClick={() => {
        if (!writable()) return; setSource({ ...(state?.source_interpretation ?? unknownSource()) }); setSourceDirty(false); setStaged({ pageKey, rows: [] }); setError('');
      }}>Discard staged changes</button>
    </div>
  </section>;
}
