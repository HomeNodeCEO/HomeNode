export class StartupTimeoutError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "StartupTimeoutError";
  }
}

export async function withStartupTimeout<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StartupTimeoutError(code)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
