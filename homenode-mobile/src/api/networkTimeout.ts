export class NetworkTimeoutError extends Error {
  constructor() {
    super("network_request_timeout");
  }
}

// The deadline also releases a sync lane if a native fetch implementation ignores abort.
export async function withNetworkTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal | null,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid_network_timeout");
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new NetworkTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (reason) {
    if (timedOut) throw new NetworkTimeoutError();
    throw reason;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}
