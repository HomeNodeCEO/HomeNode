type RequestOptions = { signal: AbortSignal };
type RunOptions = RequestOptions & { timeoutMs?: number };
// Five seconds of transport/cleanup grace beyond the server's capture-only
// two-minute budget. Saves, catalogs and previews keep the ordinary timeout.
export const CUSTOM_WORKSPACE_CAPTURE_TIMEOUT_MS = 125_000;
const validTimeout = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 180_000;
interface Options {
  timeoutMs?: number;
  timer?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}
const cancelled = () => new DOMException('Neighborhood workspace request cancelled', 'AbortError');
const failure = (reason: string) => new Error(`custom_workspace_lane_${reason}`);
interface Entry {
  work: (options: RequestOptions) => Promise<unknown>;
  signal: AbortSignal; timeoutMs: number; resolve: (value: unknown) => void; reject: (error: unknown) => void;
  onAbort: () => void; delivered: boolean;
}

/** One live assignment/session's exploration I/O lane. Do not share globally
 * across organizations or unrelated files. Routine UI cancellation drops the
 * subscriber, NOT the in-flight HTTP call: the next save/preview waits for its
 * response to finish. This reduces overlapping final NOWAIT database locks.
 * A deadline is not proof a remote lock was released. Deadline failure blocks
 * queued work until an explicit recovery attempt; never automatically retries.
 */
export function createCustomWorkspaceRequestLane(options: Options = {}) {
  const timeoutMs = options.timeoutMs ?? 65_000;
  if (!validTimeout(timeoutMs)) throw failure('invalid_timeout');
  const timer = options.timer ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const queue: Entry[] = [];
  let active: Entry | null = null, owner: AbortController | null = null, closed = false, uncertain = false;
  const waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  function deliver(entry: Entry, ok: boolean, value: unknown) {
    if (entry.delivered) return; entry.delivered = true;
    entry.signal.removeEventListener('abort', entry.onAbort);
    if (ok) entry.resolve(value); else entry.reject(value);
  }
  function notify() {
    if (active || queue.length) return;
    for (const waiter of waiters) {
      if (closed || uncertain) waiter.reject(failure(closed ? 'disposed' : 'recovery_required')); else waiter.resolve();
    }
    waiters.clear();
  }
  function clearQueue(error: Error) { for (const entry of queue.splice(0)) deliver(entry, false, error); }
  function pump() {
    if (active || closed || uncertain) { notify(); return; }
    const entry = queue.shift();
    if (!entry) { notify(); return; }
    if (entry.signal.aborted) { deliver(entry, false, cancelled()); pump(); return; }
    active = entry; const controller = new AbortController(); owner = controller;
    let timedOut = false;
    const deadline = timer.set(() => {
      timedOut = true; uncertain = true; controller.abort();
      deliver(entry, false, failure('deadline'));
      clearQueue(failure('recovery_required'));
      for (const waiter of waiters) waiter.reject(failure('recovery_required')); waiters.clear();
      // Keep active until the actual injected operation settles, even if that
      // adapter ignores abort. Its late response cannot become a successful UI.
    }, entry.timeoutMs);
    void Promise.resolve().then(() => {
      if (closed || controller.signal.aborted) throw cancelled();
      return entry.work({ signal: controller.signal });
    }).then(value => {
      if (!closed && !timedOut && !entry.signal.aborted) deliver(entry, true, value);
      else deliver(entry, false, cancelled());
    }, error => deliver(entry, false, error)).finally(() => {
      timer.clear(deadline); if (active === entry) active = null; if (owner === controller) owner = null;
      pump(); notify();
    });
  }
  return Object.freeze({
    run<T>(work: (value: RequestOptions) => Promise<T>, { signal, timeoutMs: requestTimeout = timeoutMs }: RunOptions): Promise<T> {
      if (closed || uncertain) return Promise.reject(failure(closed ? 'disposed' : 'recovery_required'));
      if (!validTimeout(requestTimeout)) return Promise.reject(failure('invalid_timeout'));
      if (signal.aborted) return Promise.reject(cancelled());
      if (queue.length >= 8) return Promise.reject(failure('queue_full'));
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = { work, signal, timeoutMs: requestTimeout, resolve: value => resolve(value as T), reject, delivered: false, onAbort: () => {} };
        entry.onAbort = () => {
          const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
          deliver(entry, false, cancelled()); notify();
        };
        signal.addEventListener('abort', entry.onAbort, { once: true }); queue.push(entry); pump();
      });
    },
    isIdle: () => !active && queue.length === 0,
    needsRecovery: () => uncertain,
    /** Explicit host recovery only, once the previous operation really settled.
     * This permits a new checked read; it does not certify server freshness. */
    recover() {
      if (closed || active || queue.length) throw failure(closed ? 'disposed' : 'busy');
      uncertain = false;
    },
    flush(): Promise<void> {
      if (closed || uncertain) return Promise.reject(failure(closed ? 'disposed' : 'recovery_required'));
      if (!active && !queue.length) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.add({ resolve, reject }));
    },
    dispose() {
      if (closed) return; closed = true; owner?.abort();
      if (active) deliver(active, false, cancelled()); clearQueue(cancelled());
      for (const waiter of waiters) waiter.reject(failure('disposed')); waiters.clear();
    },
  });
}
