import test from 'node:test';
import { runSalesRetentionAuditDatabaseChecks } from './helpers/salesRetentionAuditDatabaseChecks.js';

// Explicit opt-in only. The owner creates a new empty loopback database; this
// test never creates/drops databases, uses DATABASE_URL as a fallback, starts a
// cluster, or claims the synthetic schema represents deployed source rights.
test('sales retention audit uses one native read-only snapshot and exact conservative review counts', {
  skip: !process.env.SALES_RETENTION_AUDIT_DATABASE_URL, timeout: 90_000,
}, async () => {
  await runSalesRetentionAuditDatabaseChecks(process.env.SALES_RETENTION_AUDIT_DATABASE_URL);
});
