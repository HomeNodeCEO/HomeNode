import { useEffect, useRef, useState } from 'react';
import { fetchWithApplicationAuthentication, makeUrl } from '@/lib/api';
import { PRIVATE_SALES_MAX_BYTES, PrivateSalesError, createPrivateSalesImportsClient, privateSalesFileDigest,
  makePrivateSalesPending, readPrivateSalesPending, savePrivateSalesPending, clearPrivateSalesPending } from '../privateSalesImports';
import type { PrivateSalesIdentity, PrivateSalesTarget, PrivateSalesReceipt, PrivateSalesPending, PrivateSalesRow, PrivateSalesIo } from '../privateSalesImports';
import type { PrivateSalesMatchProposalPage } from '../privateSalesMatchProposals';
import PrivateSalesReviewPanel from './PrivateSalesReviewPanel';
import { preparePrivateSalesReviewForPage } from '../privateSalesReview';
import type { PrivateSalesReviewCommand, PrivateSalesReviewState, PrivateSalesReviewReceipt } from '../privateSalesReview';
import { makePrivateSalesReviewPending, readPrivateSalesReviewPending, savePrivateSalesReviewPending,
  clearPrivateSalesReviewPending } from '../privateSalesReviewPending';
import type { PrivateSalesReviewPending } from '../privateSalesReviewPending';
import type { CustomWorkspacePrivateSalesImport } from '../customWorkspaceCheckpoint';

export interface PrivateSalesImportsPanelProps extends PrivateSalesIdentity {
  readOnly: boolean; onBusyChange?: (busy: boolean) => void;
  onUseReviewedSales?: (reference: CustomWorkspacePrivateSalesImport) => Promise<boolean>;
}
const button = 'hn-action-secondary btn btn-sm normal-case';
const message = (error: unknown) => error instanceof PrivateSalesError && error.code === 'wrong_file'
  ? 'Choose the same file name and exact file contents to retry this pending upload.'
  : error instanceof PrivateSalesError && error.code === 'pending_storage_unavailable'
    ? 'Browser session storage is unavailable. No new upload can start until its operation ID can be retained.'
    : error instanceof PrivateSalesError && error.code === 'invalid_file'
      ? 'Choose a non-empty CSV file no larger than 8 MiB with a valid file name.'
      : error instanceof PrivateSalesError && error.status === 403
        ? 'This request is not authorized. Any pending operation is retained; check its saved status before retrying.'
        : error instanceof PrivateSalesError && error.status === 409
          ? 'The file may be read-only or this operation may conflict. Its ID is retained; check the saved upload.'
          : 'The request could not be confirmed. Any pending operation is retained; use Check saved upload before retrying.';

/** Unmounted until an authenticated Custom report host explicitly supplies its
 * exact file/session. This panel never edits report drafts, stats or selection. */
export default function PrivateSalesImportsPanel(props: PrivateSalesImportsPanelProps) {
  return <PanelSession key={JSON.stringify([props.accountId, props.assignmentFileId, props.sessionKey])} {...props} />;
}
function PanelSession(props: PrivateSalesImportsPanelProps) {
  const [identity] = useState<PrivateSalesIdentity>(() => ({ accountId: props.accountId,
    assignmentFileId: props.assignmentFileId, sessionKey: props.sessionKey }));
  const [api] = useState(() => createPrivateSalesImportsClient(identity,
    { request: fetchWithApplicationAuthentication, urlFor: path => {
      const separator = path.indexOf('?');
      return separator < 0 ? makeUrl(path) : makeUrl(path.slice(0, separator),
        Object.fromEntries(new URLSearchParams(path.slice(separator + 1))));
    } }));
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<PrivateSalesTarget | null>(null), [pending, setPending] = useState<PrivateSalesPending | null>(null);
  const [storageInvalid, setStorageInvalid] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [imports, setImports] = useState<PrivateSalesReceipt[]>([]), [older, setOlder] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null), [selected, setSelected] = useState<PrivateSalesReceipt | null>(null);
  const [rows, setRows] = useState<PrivateSalesRow[]>([]), [nextRow, setNextRow] = useState<number | null>(null);
  const [proposals, setProposals] = useState<PrivateSalesMatchProposalPage | null>(null);
  const [reviewState, setReviewState] = useState<PrivateSalesReviewState | null>(null);
  const [reviewPending, setReviewPending] = useState<PrivateSalesReviewPending | null>(null);
  const [reviewStorageInvalid, setReviewStorageInvalid] = useState(false);
  const rowPageRef = useRef<{ receipt: PrivateSalesReceipt; after: number;
    page: { batch_id: string; rows: PrivateSalesRow[]; next_after_row: number | null } } | null>(null);
  const alive = useRef(true), active = useRef<AbortController | null>(null), busyRef = useRef(false);
  const writing = useRef(false);
  const busyCallback = useRef(props.onBusyChange); busyCallback.current = props.onBusyChange;
  const current = useRef({ readOnly: props.readOnly, target, pending, storageInvalid });
  current.current = { readOnly: props.readOnly, target, pending, storageInvalid };
  const captureChoice = useRef({ reviewState, reviewPending, reviewStorageInvalid, use: props.onUseReviewedSales });
  captureChoice.current = { reviewState, reviewPending, reviewStorageInvalid, use: props.onUseReviewedSales };
  useEffect(() => { alive.current = true; return () => {
    alive.current = false; active.current?.abort();
    if (busyRef.current) { busyRef.current = false; busyCallback.current?.(false); }
  }; }, []);
  useEffect(() => { if (props.readOnly && writing.current) active.current?.abort(); }, [props.readOnly]);
  const live = (controller: AbortController) => alive.current && active.current === controller && !controller.signal.aborted;
  async function run(work: (io: PrivateSalesIo, currentRun: () => boolean) => Promise<void>, timeoutMs = 45000) {
    if (!alive.current || busyRef.current) return;
    const controller = new AbortController(); active.current = controller; busyRef.current = true;
    busyCallback.current?.(true);
    setBusy(true); setError(''); setNotice('');
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let interrupted: (() => void) | undefined;
    try {
      // File.arrayBuffer and hashing cannot themselves be canceled. Release the
      // operation on abort; every late continuation still checks its own live ID.
      await Promise.race([new Promise<never>((_, reject) => {
        interrupted = () => reject(new PrivateSalesError('request_interrupted'));
        controller.signal.addEventListener('abort', interrupted, { once: true });
        if (controller.signal.aborted) interrupted();
      }), work({ signal: controller.signal, deadlineMs: 30000 }, () => live(controller))]);
    }
    catch (problem) { if (alive.current && active.current === controller) setError(message(problem)); }
    finally {
      clearTimeout(timeout);
      if (interrupted) controller.signal.removeEventListener('abort', interrupted);
      if (alive.current && active.current === controller) {
        busyRef.current = false; writing.current = false; setBusy(false); active.current = null; busyCallback.current?.(false);
      }
    }
  }
  async function list(reportId: string, cursor: string | null, io: PrivateSalesIo, currentRun: () => boolean) {
    const result = await api.list(reportId, cursor, io);
    if (currentRun()) { setImports(result.imports); setOlder(result.next_before_batch_id); }
  }
  function acknowledge(receipt: PrivateSalesReceipt, currentRun: () => boolean) {
    if (!currentRun()) return;
    clearPrivateSalesPending(sessionStorage, identity);
    current.current.pending = null; setPending(null); setFile(null);
    setNotice(`Saved ${receipt.row_count} private row receipts. They are not automatically matched or included in analysis.`);
  }
  const initialize = () => run(async (io, currentRun) => {
    setLoaded(false);
    const restored = readPrivateSalesPending(sessionStorage, identity);
    if (currentRun()) {
      const saved = restored.status === 'restored' ? restored.pending : null;
      setPending(saved); current.current.pending = saved;
      setStorageInvalid(restored.status === 'invalid'); current.current.storageInvalid = restored.status === 'invalid';
    }
    const destination = await api.target(io); if (!currentRun()) return;
    setTarget(destination); current.current.target = destination;
    if (restored.status === 'restored' && restored.pending.report_file_id !== destination.report_file_id) {
      setStorageInvalid(true); current.current.storageInvalid = true;
      throw new PrivateSalesError('invalid_pending_target');
    }
    await list(destination.report_file_id, null, io, currentRun);
    if (!currentRun()) return; setLoaded(true);
    if (restored.status === 'restored') {
      const saved = await api.check(restored.pending, io); if (!currentRun()) return;
      if (saved) { acknowledge(saved, currentRun); await list(destination.report_file_id, null, io, currentRun); }
      else setNotice('No saved receipt was found. This does not prove an earlier request stopped. Re-select the same file to retry the same operation ID.');
    }
  });
  const initializeRef = useRef(initialize); initializeRef.current = initialize;
  const openedOnce = useRef(false);
  useEffect(() => {
    if (open && !openedOnce.current) { openedOnce.current = true; void initializeRef.current(); }
    // Only first explicit expansion starts acquisition. Rerenders (including
    // unrelated report saves) must not restart requests or upload operations.
  }, [open]);
  const checkSaved = () => run(async (io, currentRun) => {
    const savedPending = current.current.pending;
    if (!savedPending || current.current.storageInvalid) return;
    const receipt = await api.check(savedPending, io); if (!currentRun()) return;
    if (receipt) { acknowledge(receipt, currentRun); await list(receipt.report_file_id, null, io, currentRun); }
    else setNotice('No receipt was found yet. Keep this operation ID; retry only with the same file. A 404 is not proof that an earlier request cannot commit.');
  });
  const upload = () => run(async (io, currentRun) => {
    if (!loaded || current.current.readOnly || !current.current.target?.can_upload || current.current.storageInvalid || !file) return;
    writing.current = true;
    if (file.size < 1 || file.size > PRIVATE_SALES_MAX_BYTES) throw new PrivateSalesError('invalid_file');
    const chosen = file, bytes = new Uint8Array(await chosen.arrayBuffer());
    const descriptor = { file_name: chosen.name, file_size: bytes.byteLength, file_sha256: await privateSalesFileDigest(bytes) };
    if (!currentRun() || current.current.readOnly || !current.current.target?.can_upload) return;
    const retained = current.current.pending;
    if (retained && (retained.file_name !== descriptor.file_name || retained.file_size !== descriptor.file_size
      || retained.file_sha256 !== descriptor.file_sha256)) throw new PrivateSalesError('wrong_file');
    const operation = retained ?? makePrivateSalesPending(identity, current.current.target.report_file_id, descriptor, crypto.randomUUID());
    // Durable browser metadata precedes POST. Never store file contents, raw
    // rows, report drafts or session credentials in this recovery record.
    savePrivateSalesPending(sessionStorage, identity, operation);
    setPending(operation); current.current.pending = operation;
    if (!currentRun() || current.current.readOnly) return;
    let receipt: PrivateSalesReceipt;
    try { receipt = await api.commit(operation, bytes, io); }
    catch (problem) {
      // Only this never-previously-sent ID can be released on a fixed, explicit
      // input rejection. A retry may overlap an earlier unknown commit, even if
      // its own request is rejected or a status read currently returns 404.
      if (!retained && currentRun() && problem instanceof PrivateSalesError && problem.code === 'input_rejected') {
        clearPrivateSalesPending(sessionStorage, identity);
        current.current.pending = null; setPending(null); setFile(null);
        setNotice('This new upload was not saved because its CSV or file metadata was rejected. Correct the file and choose it again.');
        return;
      }
      throw problem;
    }
    if (currentRun()) { acknowledge(receipt, currentRun); await list(receipt.report_file_id, null, io, currentRun); }
  });
  const showRows = (receipt: PrivateSalesReceipt, after = 0) => run(async (io, currentRun) => {
    const result = await api.rows(receipt, after, 50, io);
    if (currentRun()) {
      rowPageRef.current = { receipt, after, page: result }; setProposals(null);
      setReviewState(null); setReviewPending(null); setReviewStorageInvalid(false);
      setSelected(receipt); setRows(result.rows); setNextRow(result.next_after_row);
      try { setReviewPending(readPrivateSalesReviewPending(sessionStorage, identity, receipt)); }
      catch { setReviewStorageInvalid(true); }
      const state = await api.reviews.get(receipt, result, after, 50, io);
      if (currentRun()) setReviewState(state);
    }
  });
  const reloadReviews = () => run(async (io, currentRun) => {
    const displayed = rowPageRef.current; if (!displayed) return;
    setReviewState(null); setProposals(null);
    const state = await api.reviews.get(displayed.receipt, displayed.page, displayed.after, 50, io);
    if (currentRun() && rowPageRef.current === displayed) { setReviewState(state); setProposals(null); }
  });
  async function acknowledgeReview(saved: PrivateSalesReviewReceipt, receipt: PrivateSalesReceipt,
    io: PrivateSalesIo, currentRun: () => boolean) {
    if (!currentRun()) return;
    if (saved.actor_user_id !== identity.sessionKey.toLowerCase()) throw new PrivateSalesError('invalid_response');
    clearPrivateSalesReviewPending(sessionStorage, identity, receipt); setReviewPending(null); setProposals(null);
    setNotice(`Review revision ${saved.revision} is saved in PostgreSQL. Original rows are unchanged; analysis inclusion is a separate step.`);
    const displayed = rowPageRef.current;
    if (displayed?.receipt.batch_id !== receipt.batch_id) return;
    setReviewState(null);
    const state = await api.reviews.get(receipt, displayed.page, displayed.after, 50, io);
    if (currentRun() && rowPageRef.current === displayed) setReviewState(state);
  }
  const saveReview = (draft: PrivateSalesReviewCommand | null, retry = false) => run(async (io, currentRun) => {
    const displayed = rowPageRef.current;
    if (!displayed || current.current.readOnly || !current.current.target?.can_upload || reviewStorageInvalid) return;
    const retained = readPrivateSalesReviewPending(sessionStorage, identity, displayed.receipt);
    if ((!retry && retained) || (retry && !retained)) throw new PrivateSalesError('invalid_pending_review');
    if (!retained && (!reviewState || !draft)) return;
    const command = retained?.command ?? preparePrivateSalesReviewForPage(draft, reviewState!, identity,
      displayed.receipt, displayed.page, proposals);
    const operation = retained ?? makePrivateSalesReviewPending(identity, displayed.receipt, crypto.randomUUID(), command);
    // Temporary bounded review command + operation metadata permit exact retry
    // after a refresh. No CSV bytes/row evidence or authentication secrets are
    // retained here; only a committed PostgreSQL receipt is displayed as saved.
    savePrivateSalesReviewPending(sessionStorage, identity, displayed.receipt, operation);
    setReviewPending(operation); writing.current = true;
    if (!currentRun() || current.current.readOnly) return;
    let saved: PrivateSalesReviewReceipt;
    try {
      saved = await api.reviews.save(displayed.receipt, operation.operation_id, command, io);
    } catch (problem) {
      if (!retained && currentRun() && problem instanceof PrivateSalesError
        && ['input_rejected', 'review_conflict'].includes(problem.code)) {
        clearPrivateSalesReviewPending(sessionStorage, identity, displayed.receipt); setReviewPending(null);
        setReviewState(null); setProposals(null);
        setError('The new review was not saved. Reload review status and refresh account proposals before correcting and retrying.');
        return;
      }
      throw problem;
    }
    await acknowledgeReview(saved, displayed.receipt, io, currentRun);
  });
  const checkReview = () => run(async (io, currentRun) => {
    const displayed = rowPageRef.current; if (!displayed) return;
    const operation = readPrivateSalesReviewPending(sessionStorage, identity, displayed.receipt);
    if (!operation) return;
    const saved = await api.reviews.checkOperation(displayed.receipt, operation.operation_id, operation.command, io);
    if (saved) await acknowledgeReview(saved, displayed.receipt, io, currentRun);
    else if (currentRun()) setNotice('No committed review receipt was found yet. The operation is retained; retry uses exactly the same review.');
  });
  const showProposals = () => run(async (io, currentRun) => {
    const displayed = rowPageRef.current; if (!displayed) return;
    setProposals(null);
    try {
      const result = await api.matchProposals(displayed.receipt, displayed.page, displayed.after, 50, io);
      if (currentRun() && rowPageRef.current === displayed) setProposals(result);
    } catch {
      if (currentRun()) setError('Account match proposals could not be loaded. Saved row receipts have not changed.');
    }
  });
  const canWrite = loaded && !busy && !props.readOnly && target?.can_upload === true && !storageInvalid;
  const captureReviewedSales = () => run(async (_io, currentRun) => {
    const displayed = rowPageRef.current, choice = captureChoice.current, review = choice.reviewState;
    if (!displayed || !review || review.revision < 1 || review.source_interpretation?.source_use_confirmed !== true
      || review.batch_id !== displayed.receipt.batch_id || current.current.readOnly || !current.current.target?.can_upload
      || choice.reviewPending || choice.reviewStorageInvalid || !choice.use) return;
    const completed = await choice.use({ batch_id: displayed.receipt.batch_id, expected_review_revision: review.revision });
    if (currentRun()) {
      if (completed) setNotice('This saved CSV review is now retained in the new neighborhood capture. Review its private-source observations in Neighborhood Pocket Exploration; the accepted report has not changed.');
      else setError('The neighborhood capture was not confirmed. Check its study dates, source permissions and saved pending operation in Neighborhood Pocket Exploration before retrying.');
    }
  }, 180000);
  return <details className="print:hidden rounded-lg border border-purple-200 bg-white/80 p-3" open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold text-purple-900">Private neighborhood sales (CSV)</summary>
    {open && <div className="mt-3 space-y-3">
      <p className="text-sm">The original file and every row stay private to this assignment. Saving does not automatically match accounts or include sales in analysis.</p>
      <p className="text-sm">Older sales alone do not establish historical housing stock for a retrospective appraisal.</p>
      {props.readOnly || (target && !target.can_upload) ? <p className="text-sm">Uploads are read-only. Saved files and rows remain available to authorized readers.</p> : null}
      {storageInvalid && <p role="alert">Pending upload metadata is unavailable or belongs to a different report. Uploads are blocked; do not replace an unresolved operation.</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {busy && <p role="status" className="text-sm">Working on this private upload…</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => void initialize()}>Refresh saved uploads</button>
        {pending && <button type="button" className={button} disabled={busy || storageInvalid} onClick={() => void checkSaved()}>Check saved upload</button>}
      </div>
      {pending && <p className="text-sm">Pending: {pending.file_name} ({pending.file_size.toLocaleString()} bytes). Retry reuses the saved operation ID; a different file cannot replace it.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">CSV file (up to 8 MiB)
          <input aria-label="Private sales CSV file" type="file" accept=".csv,text/csv" disabled={!canWrite}
            onChange={event => setFile(event.currentTarget.files?.[0] ?? null)} className="block text-sm" /></label>
        <button type="button" className="hn-action-primary btn btn-sm normal-case" disabled={!canWrite || !file}
          onClick={() => void upload()}>{pending ? 'Retry same upload' : 'Save private CSV'}</button>
      </div>
      {loaded && imports.length === 0 && <p className="text-sm">No saved uploads are shown for this file.</p>}
      <ul className="space-y-2">{imports.map(receipt => <li key={receipt.batch_id} className="rounded border border-purple-100 p-2 text-sm">
        <div className="font-medium">{receipt.file_name} — {receipt.row_count.toLocaleString()} saved rows</div>
        <div>{Object.entries(receipt.summary).map(([name, count]) => `${name.replaceAll('_', ' ')}: ${count}`).join(' · ')}</div>
        <div className="text-xs">{receipt.stored_at} · {receipt.source_byte_length.toLocaleString()} original bytes</div>
        <button type="button" className={button} disabled={busy} onClick={() => void showRows(receipt)}>View row receipts</button>
      </li>)}</ul>
      {older && target && <button type="button" className={button} disabled={busy}
        onClick={() => void run((io, currentRun) => list(target.report_file_id, older, io, currentRun))}>Older uploads</button>}
      {selected && <section aria-label="Private CSV row receipts" className="space-y-2">
        <h4 className="font-medium">Rows from {selected.file_name}</h4>
        <p className="text-sm">Account proposals use current CAD observations, not historical parcel membership. Proposals alone do not confirm identity or include sales in analysis.
          CurrentPrice is not ClosePrice; source interpretation, units and currency still require review.</p>
        <button type="button" className={button} disabled={busy} onClick={() => void showProposals()}>Check account match proposals</button>
        {proposals && <p className="text-xs">{proposals.observed_at ? `CAD observed at ${proposals.observed_at}.` : 'No supported account lookup was requested.'}
          {' '}Account identity proposals only; review and analysis inclusion remain separate.</p>}
        {reviewStorageInvalid && <p role="alert">Pending review recovery metadata is unavailable. New reviews are blocked to avoid replacing an unresolved operation.</p>}
        {reviewPending && <div className="space-x-2 rounded border border-amber-300 p-2 text-sm">
          <p>A review operation is awaiting confirmation. It has not been marked saved.</p>
          <button type="button" className={button} disabled={busy || reviewStorageInvalid} onClick={() => void checkReview()}>Check saved review</button>
          <button type="button" className={button} disabled={busy || props.readOnly || !target?.can_upload || reviewStorageInvalid}
            onClick={() => void saveReview(null, true)}>Retry same review</button>
        </div>}
        {rowPageRef.current && reviewState ? <PrivateSalesReviewPanel identity={identity} receipt={selected}
          page={rowPageRef.current.page} reviewState={reviewState} proposals={proposals}
          readOnly={props.readOnly || !target?.can_upload || reviewStorageInvalid || reviewPending !== null}
          busy={busy} onSave={command => void saveReview(command)} onReload={() => void reloadReviews()} />
          : <button type="button" className={button} disabled={busy} onClick={() => void reloadReviews()}>Load review status</button>}
        {props.onUseReviewedSales && <div className="rounded border border-purple-200 p-2 text-sm">
          <button type="button" className="hn-action-primary btn btn-sm normal-case"
            disabled={!canWrite || !reviewState || reviewState.revision < 1 || reviewState.source_interpretation?.source_use_confirmed !== true
              || reviewPending !== null || reviewStorageInvalid}
            onClick={() => void captureReviewedSales()}>Use saved CSV review in neighborhood analysis</button>
          <p className="mt-1 text-xs">Uses the saved review revision and the study dates shown in Neighborhood Pocket Exploration. Unsaved review edits are not included. Starts a new capture; it does not replace the accepted report.</p>
        </div>}
        {rows.length === 0 && <p className="text-sm">This saved file has no logical data rows.</p>}
        {rows.map(row => {
          const proposal = proposals?.rows.find(item => item.receipt_id === row.receipt_id);
          return <details key={row.receipt_id} className="rounded border border-purple-100 p-2 text-sm">
          <summary className="cursor-pointer">Source row {row.source_row_number}: {row.preparation_disposition.replaceAll('_', ' ')}
            {proposal && <span> — account proposal: {proposal.proposal_status.replaceAll('_', ' ')}
              {proposal.proposed_account_ids.length > 0 ? ` (${proposal.proposed_account_ids.join(', ')})` : ''}</span>}</summary>
          {proposal && <div className="my-2 rounded border border-purple-200 bg-purple-50 p-2">
              <p>Account match: {proposal.proposal_status.replaceAll('_', ' ')}. Appraiser review is required.</p>
              {proposal.proposed_account_ids.length > 0 && <p>Proposed account IDs: {proposal.proposed_account_ids.join(', ')}</p>}
              {proposal.observed_candidate_account_ids.length > 0 && <p>Observed candidate IDs (not approved): {proposal.observed_candidate_account_ids.join(', ')}</p>}
              {proposal.reasons.length > 0 && <p>Review reasons: {proposal.reasons.map(reason => reason.replaceAll('_', ' ')).join('; ')}</p>}
            </div>}
          <p>{row.issues.length ? row.issues.join(' · ') : 'No preparation issues recorded; source interpretation is still not reviewed.'}</p>
          <dl>{row.raw_cells.map((value, index) => <div key={index} className="mt-1">
            <dt className="font-medium">{selected.raw_headers[index] ?? `Extra column ${index + 1}`}</dt>
            <dd className="whitespace-pre-wrap break-words">{value || '(empty)'}</dd>
          </div>)}</dl>
          <details><summary className="cursor-pointer">Prepared observations (not verified analysis)</summary>
            <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(row.values, null, 2)}</pre></details>
        </details>;
        })}
        <div className="flex gap-2">
          <button type="button" className={button} disabled={busy} onClick={() => void showRows(selected)}>First rows</button>
          {nextRow !== null && <button type="button" className={button} disabled={busy}
            onClick={() => void showRows(selected, nextRow)}>Next rows</button>}
        </div>
      </section>}
    </div>}
  </details>;
}
