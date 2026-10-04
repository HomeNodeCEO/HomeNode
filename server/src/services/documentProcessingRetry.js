// Only job IDs and service handles wait in memory, never PDF bytes or OCR text.
// PostgreSQL remains authoritative; maintenance resumes work after a restart or
// when this small foreground wake-up queue is full.
const queues = new WeakMap();
const maximumQueuedIds = 32;

export function scheduleDocumentProcessingRetry(pool, id, options, processDocument, {
  setTimer = setTimeout,
} = {}) {
  let queue = queues.get(pool);
  if (!queue) { queue = new Set(); queues.set(pool, queue); }
  if (queue.has(id) || queue.size >= maximumQueuedIds) return false;
  queue.add(id);
  const timer = setTimer(() => {
    queue.delete(id);
    // A busy result schedules its own next wake-up; actual extraction failures
    // use the existing persisted retry budget. No request or actor is retained.
    Promise.resolve().then(() => processDocument(pool, id, options)).catch(() => {});
  }, 15_250);
  timer?.unref?.();
  return true;
}
