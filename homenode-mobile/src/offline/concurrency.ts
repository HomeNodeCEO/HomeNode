export async function runWithConcurrency<T>(
  items: readonly T[],
  requestedLimit: number,
  task: (item: T, index: number) => Promise<void>,
) {
  const limit = Math.max(1, Math.min(items.length || 1, Math.floor(requestedLimit) || 1));
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
}
