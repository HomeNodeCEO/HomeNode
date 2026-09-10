import { useEffect, useRef, useState } from 'react';
import { fingerprintCustomCohortSelection } from '../customCohortPreviewController';
import type { checkCustomCohortSummaryResponse, CustomCohortPreviewInput } from '../customCohortPreviewController';
import { checkCustomCohortMemberPage, createCustomCohortMemberContinuation } from '../customCohortMemberPage';
import type { CheckedCustomCohortMemberPage, CustomCohortInspectedMember, CustomCohortMemberExpectation,
  CustomCohortMemberKind, CustomCohortMemberPageRequest } from '../customCohortMemberPage';
import type { CustomCohortMemberTransport } from '../customCohortPreviewTransport';

interface Props {
  input: CustomCohortPreviewInput;
  group: ReturnType<typeof checkCustomCohortSummaryResponse>;
  paused?: boolean;
  memberTransport: CustomCohortMemberTransport;
}
type Row = Record<string, unknown>;
type Continuation = ReturnType<typeof createCustomCohortMemberContinuation>;
type Intent = { kind: CustomCohortMemberKind; index: number; page: CustomCohortMemberPageRequest; previous?: Continuation };
type Status = 'idle' | 'loading' | 'ready' | 'failed' | 'interrupted';
const LIMIT = 50, MAX_PAGES = 2000;
const LABELS = { stock: 'Current CAD accounts', source_reported: 'Source-reported records',
  transactions: 'In-period transaction observations', omitted_transactions: 'Omitted transaction observations' } as const;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const count = (value: number) => value.toLocaleString('en-US');
const button = 'rounded-lg border border-amber-300 bg-purple-50 px-3 py-2 text-xs font-medium text-purple-950 hover:border-amber-500 hover:bg-purple-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-600 disabled:cursor-not-allowed disabled:opacity-50';

function expectations(group: Props['group']): Record<CustomCohortMemberKind, CustomCohortMemberExpectation> | null {
  const selected = object(group.summary.selected), result = {} as Record<CustomCohortMemberKind, CustomCohortMemberExpectation>;
  for (const kind of Object.keys(LABELS) as CustomCohortMemberKind[]) {
    const source = object(selected[kind === 'omitted_transactions' ? 'transactions' : kind]);
    const descriptor = object(source[kind === 'omitted_transactions' ? 'omitted_inspection' : 'inspection']);
    const population = object(descriptor.population), total = descriptor.total_count;
    if (population.group !== 'selected' || population.kind !== kind || Object.keys(population).length !== 2
      || descriptor.maximum_page_size !== LIMIT || !Number.isSafeInteger(total) || Number(total) < 0 || Number(total) > 100000
      || total !== source[kind === 'omitted_transactions' ? 'omitted_count' : 'member_count']) return null;
    result[kind] = { group: 'selected', kind, total_count: Number(total) };
  }
  return result;
}
function aligned(input: Props['input'], group: Props['group']): boolean {
  const binding = group.binding;
  return binding.accountId === input.accountId && binding.assignmentFileId === input.assignmentFileId
    && binding.selectionRevision === input.selection.revision
    && Object.entries(input.contextRef).every(([key, value]) => binding.contextRef[key as keyof typeof input.contextRef] === value);
}

/** Explicit, read-only inspection of the very same captured summary. A changed
 * context or selection remounts closed; no request is made by merely mounting. */
export default function CustomCohortMemberBrowser(props: Props) {
  const populations = expectations(props.group);
  if (!populations || !aligned(props.input, props.group)) return <p role="status" className="text-xs text-amber-800 print:hidden">Record inspection is unavailable for this summary. Refresh the pocket information first.</p>;
  const key = JSON.stringify([props.input, props.group.binding, props.group.summary.selected,
    props.group.summary.effective_date, props.group.summary.observation_period, props.group.summary.captured_at]);
  return <MemberSession key={key} {...props} populations={populations} />;
}

function MemberSession(props: Props & { populations: Record<CustomCohortMemberKind, CustomCohortMemberExpectation> }) {
  const [snapshot] = useState(() => ({ input: props.input, group: props.group, populations: props.populations }));
  const [open, setOpen] = useState(false), [kind, setKind] = useState<CustomCohortMemberKind>('stock');
  const [status, setStatus] = useState<Status>('idle'), [result, setResult] = useState<CheckedCustomCohortMemberPage | null>(null);
  const transport = useRef(props.memberTransport); transport.current = props.memberTransport;
  const paused = useRef(props.paused === true); paused.current = props.paused === true;
  const live = useRef(true), opened = useRef(false), active = useRef<{ abort: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const lastIntent = useRef<Intent | null>(null), cursors = useRef<{ token: Continuation; next: string | null }[]>([]);
  const populationId = useRef<string | null>(null);
  const stop = () => { const request = active.current; active.current = null; if (request) { clearTimeout(request.timer); request.abort.abort(); } };
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; const request = active.current; active.current = null;
      if (request) { clearTimeout(request.timer); request.abort.abort(); } };
  }, []);
  useEffect(() => {
    if (!props.paused || !active.current) return;
    const request = active.current; active.current = null; clearTimeout(request.timer); request.abort.abort(); setStatus('interrupted');
  }, [props.paused]);

  function request(intent: Intent) {
    if (!live.current || paused.current || !opened.current || intent.index < 0 || intent.index >= MAX_PAGES) return;
    stop(); lastIntent.current = intent;
    const expected = snapshot.populations[intent.kind];
    if (expected.total_count === 0) { setResult(null); setStatus('ready'); return; }
    setStatus('loading');
    const abort = new AbortController();
    const pending = { abort, timer: setTimeout(() => {
      if (active.current !== pending) return;
      active.current = null; abort.abort(); if (live.current) setStatus('failed');
    }, 65000) };
    active.current = pending;
    const current = () => live.current && opened.current && !paused.current && active.current === pending && !abort.signal.aborted;
    void (async () => {
      try {
        const hash = await fingerprintCustomCohortSelection(snapshot.input);
        if (!current()) return;
        if (hash !== snapshot.group.binding.selectionFingerprint) throw new TypeError('summary_selection_changed');
        const value = await transport.current(snapshot.input, { group: 'selected', kind: intent.kind }, intent.page, { signal: abort.signal });
        if (!current()) return;
        const checked = checkCustomCohortMemberPage(value, snapshot.input, hash, expected, intent.page, intent.previous);
        const summary = snapshot.group.summary, period = object(summary.observation_period);
        if (checked.page.effective_date !== summary.effective_date || checked.page.captured_at !== summary.captured_at
          || checked.page.observation_period.start_date !== period.start_date || checked.page.observation_period.end_date !== period.end_date) throw new TypeError('summary_period_changed');
        if (populationId.current !== null && populationId.current !== checked.page.population_id) throw new TypeError('population_changed');
        populationId.current = checked.page.population_id;
        // Compact decoder-issued tokens hold continuity, not prior record pages.
        cursors.current[intent.index] = { token: createCustomCohortMemberContinuation(checked), next: checked.page.next_after_member_id };
        cursors.current.length = intent.index + 1;
        setResult(checked); setStatus('ready');
      } catch { if (current()) setStatus('failed'); }
      finally { clearTimeout(pending.timer); if (active.current === pending) {
        active.current = null; if (live.current && paused.current) setStatus('interrupted');
      } }
    })();
  }
  function first(nextKind: CustomCohortMemberKind) {
    if (paused.current) return;
    stop(); cursors.current = []; populationId.current = null; setResult(null); setKind(nextKind);
    request({ kind: nextKind, index: 0, page: { limit: LIMIT, after_member_id: null } });
  }
  function toggle() {
    if (opened.current) { stop(); opened.current = false; setOpen(false); if (status === 'loading') setStatus('interrupted'); return; }
    if (paused.current) return;
    opened.current = true; setOpen(true);
    if (status !== 'ready') request(lastIntent.current ?? { kind, index: 0, page: { limit: LIMIT, after_member_id: null } });
  }
  function move(direction: -1 | 1) {
    if (!result || status !== 'ready' || paused.current) return;
    const index = result.page.start_index / LIMIT + direction;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PAGES || (direction === 1 && !result.page.has_more)) return;
    const link = index ? cursors.current[index - 1] : undefined, previous = link?.token;
    const after = direction === 1 ? result.page.next_after_member_id : link?.next ?? null;
    if (index && (!previous || !after)) return;
    request({ kind, index, page: { limit: LIMIT, after_member_id: after }, ...(previous ? { previous } : {}) });
  }
  const population = snapshot.populations[kind], page = result?.page, busy = status === 'loading', disabled = props.paused === true;
  return <section className="space-y-3 rounded-xl border border-purple-200 bg-white/80 p-3 print:hidden" aria-label="Pocket record inspection" data-selection-revision={snapshot.input.selection.revision}>
    <button type="button" className={button} aria-expanded={open} disabled={!open && disabled} onClick={toggle}>{open ? 'Hide records' : 'Show records'}</button>
    {open && <>
      <p className="text-xs text-slate-600">Read-only records for the inspected group, independent of its inclusion in the main analysis. At most 50 records per page; the complete population count is retained.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Record population">
        {(Object.keys(LABELS) as CustomCohortMemberKind[]).map(value => <button key={value} type="button" className={button} aria-pressed={kind === value} disabled={disabled}
          onClick={() => { if (kind !== value) first(value); }}>{LABELS[value]} ({count(snapshot.populations[value].total_count)})</button>)}
      </div>
      <p className="text-xs text-slate-600">CAD values describe the current retained mirror, not historical property condition. Source records are not additional canonical sales; their period eligibility is not established. Transaction totals may cover multiple accounts and are not verified property sale prices. Currency, coverage, eligibility and reliability are not established.</p>
      {disabled && <p role="status" className="text-xs text-amber-800">Record inspection is paused. Previously loaded records remain from the same captured summary; no new reads are admitted.</p>}
      {!disabled && busy && <p role="status" className="text-xs text-slate-600">Loading records{page ? ' — the previous page remains below' : ''}…</p>}
      {(status === 'failed' || status === 'interrupted') && <div role="status" className="space-y-2 text-xs text-amber-800">
        <p>{status === 'interrupted' ? 'The record request was interrupted.' : 'The record page could not be verified or loaded.'} {page ? 'The previous checked page is unchanged.' : 'No records have been substituted.'}</p>
        <button type="button" className={button} disabled={disabled} onClick={() => { if (lastIntent.current) request(lastIntent.current); }}>Retry records</button>
      </div>}
      {population.total_count === 0 && <p className="text-xs text-slate-600">No records in this population. Other populations have not been substituted.</p>}
      {page && <>
        <p className="text-xs font-medium" aria-live="polite">{LABELS[kind]}: records {count(page.start_index + 1)}–{count(page.end_index_exclusive)} of {count(page.total_count)}.</p>
        <ol className="space-y-3" aria-label="Captured records">{page.members.map((member, index) => <li key={member.member_id} className="rounded-lg border border-purple-100 p-3">
          <RecordDetails member={member} ordinal={page.start_index + index + 1} />
        </li>)}</ol>
        <div className="flex gap-2">
          <button type="button" className={button} disabled={disabled || status !== 'ready' || page.start_index === 0} onClick={() => move(-1)}>Previous page</button>
          <button type="button" className={button} disabled={disabled || status !== 'ready' || !page.has_more} onClick={() => move(1)}>Next page</button>
        </div>
      </>}
    </>}
  </section>;
}

function RecordDetails({ member, ordinal }: { member: CustomCohortInspectedMember; ordinal: number }) {
  return <>
    <h5 className="break-words text-sm font-semibold">{'account_id' in member ? `CAD account ${member.account_id}` : `${'sale_date' in member ? 'Transaction observation' : 'Source record'} ${count(ordinal)}`}</h5>
    <p className="my-1 text-xs text-slate-600">{'account_id' in member ? `${count(member.parcel_object_count)} retained parcel objects`
      : `${count(member.associated_account_count)} associated accounts${member.has_source_disagreement ? ' · Source disagreement is present' : ''}`}
      {'canonical_transaction_count' in member ? ` · ${count(member.canonical_transaction_count)} canonical transaction associations (not additional sales)` : ''}.</p>
    {'sale_date' in member && <p className="mb-2 text-xs text-slate-600">Recorded date: {member.sale_date ?? 'Unavailable'} · {member.disposition.replaceAll('_', ' ')}
      {member.multiple_parcel_evidence ? ' · Multiple-parcel evidence' : ''} · {count(member.unresolved_link_count)} unresolved links. Complete membership and market eligibility are not established.</p>}
    <div className="overflow-x-auto"><table className="w-full text-xs">
      <thead><tr className="border-b border-purple-100 text-left"><th scope="col" className="py-1">Observation</th><th scope="col">Value</th><th scope="col">State / source-row coverage</th></tr></thead>
      <tbody>{Object.entries(member.observations).map(([key, cell]) => <tr key={key} className="border-b border-slate-100 align-top">
        <th scope="row" className="py-2 pr-3 text-left font-medium">{cell.label}<span className="block font-normal text-slate-500">{cell.unit ?? 'Unit not established'}</span></th>
        <td className="whitespace-nowrap py-2 pr-3 tabular-nums" title={cell.exact_value === null ? undefined : `Exact retained numeric observation: ${cell.exact_value}`}>{cell.display_value}</td>
        <td className="py-2 text-slate-600">{cell.state}<span className="block">{count(cell.observed_record_count)} observed · {count(cell.missing_record_count)} missing · {count(cell.invalid_record_count)} invalid</span></td>
      </tr>)}</tbody>
    </table></div>
  </>;
}
