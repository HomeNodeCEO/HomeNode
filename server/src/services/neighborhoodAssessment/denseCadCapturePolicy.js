// Installed server-side processing budget, not a request override, source grant,
// historical eligibility claim or guarantee that every city fits. Per-row SQL
// transport stays bounded and a complete capture is required at every tier.
export const DENSE_CAD_CACHE_READER_LIMITS = Object.freeze({
  records: 200_000, bytes: 128_000_000, row_bytes: 64_000, page_size: 250,
  selected_accounts: 50_000, duration_ms: 60_000, statement_ms: 5000, connect_ms: 3000,
});
export const DENSE_CAD_ACCOUNT_BATCH_SIZE = 1000;
