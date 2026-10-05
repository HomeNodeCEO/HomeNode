// A capture during an active upload requests one more queue pass, rather than
// starting a second upload worker or accumulating one waiter per photo.
export function createCoalescedSync(run: () => Promise<void>) {
  let active: Promise<void> | null = null;
  let rerunRequested = false;
  return () => {
    if (active) {
      rerunRequested = true;
      return active;
    }
    const task = (async () => {
      do {
        rerunRequested = false;
        await run();
      } while (rerunRequested);
    })();
    const settled = task.finally(() => {
      if (active === settled) active = null;
    });
    active = settled;
    return settled;
  };
}

export async function drainDuePhotoBatches(
  runBatch: (dueBefore: number) => Promise<number>,
  dueBefore = Date.now(),
) {
  let processed: number;
  do {
    processed = await runBatch(dueBefore);
  } while (processed > 0);
}
