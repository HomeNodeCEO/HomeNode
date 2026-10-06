type TransactionConnection = {
  execAsync(sql: string): Promise<void>;
  closeAsync(): Promise<void>;
};

// The factory must open and key its own connection before returning it.
// Expo's exclusive transaction helper opens a new, unkeyed connection, so
// it cannot inherit the SQLCipher key from the app's primary connection.
export async function runKeyedTransaction<T extends TransactionConnection>(
  openKeyedConnection: () => Promise<T>,
  task: (transaction: T) => Promise<void>,
): Promise<void> {
  const transaction = await openKeyedConnection();
  let started = false;
  let failed = false;
  try {
    await transaction.execAsync("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    await transaction.execAsync("BEGIN IMMEDIATE");
    started = true;
    await task(transaction);
    await transaction.execAsync("COMMIT");
    started = false;
  } catch (reason) {
    failed = true;
    if (started) await transaction.execAsync("ROLLBACK").catch(() => undefined);
    throw reason;
  } finally {
    try {
      await transaction.closeAsync();
    } catch (reason) {
      if (!failed) throw reason;
    }
  }
}
