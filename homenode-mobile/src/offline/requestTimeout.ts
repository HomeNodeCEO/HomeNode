export const MOBILE_API_REQUEST_TIMEOUT_MS = 30_000;
export const MOBILE_PHOTO_UPLOAD_TIMEOUT_MS = 120_000;

export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super("request_timeout");
    this.name = "RequestTimeoutError";
  }
}

export async function runWithRequestTimeout<T>(
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
  upstreamSignal?: AbortSignal | null,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await request(controller.signal);
  } catch (reason) {
    if (timedOut) throw new RequestTimeoutError(timeoutMs);
    throw reason;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
