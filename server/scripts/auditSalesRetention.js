import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: node scripts/auditSalesRetention.js --as-of=YYYY-MM-DD [--sample-limit=0..50]';
const fail = () => { throw new TypeError('invalid_sales_retention_audit_arguments'); };

export function parseSalesRetentionAuditArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 2) fail();
  let asOfDate, sampleLimit = 0, sampled = false;
  for (const arg of argv) {
    if (typeof arg !== 'string') fail();
    if (arg.startsWith('--as-of=')) {
      if (asOfDate !== undefined) fail();
      const value = arg.slice(8), iso = `${value}T00:00:00.000Z`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 6 || !Number.isFinite(Date.parse(iso))
        || new Date(iso).toISOString() !== iso) fail();
      asOfDate = value;
    } else if (arg.startsWith('--sample-limit=')) {
      const value = arg.slice(15);
      if (sampled || !/^(?:0|[1-9]\d?)$/.test(value) || Number(value) > 50) fail();
      sampleLimit = Number(value); sampled = true;
    } else fail();
  }
  if (asOfDate === undefined) fail();
  return Object.freeze({ asOfDate, sampleLimit });
}

export function salesRetentionAuditPoolOptions(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl || databaseUrl.length > 16_384) throw new TypeError('database_configuration_invalid');
  let url;
  try { url = new URL(databaseUrl); } catch { throw new TypeError('database_configuration_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) throw new TypeError('database_configuration_invalid');
  // pg merges URL query options after pool options. Admit only these explicit
  // TLS choices, then remove them so neither TLS nor timeout/host can be reset.
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'ssl'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new TypeError('database_configuration_invalid');
  }
  const mode = url.searchParams.get('sslmode'), ssl = url.searchParams.get('ssl');
  if (mode !== null && !['disable', 'require', 'verify-full'].includes(mode)) throw new TypeError('database_configuration_invalid');
  if (ssl !== null && !['true', 'false', '1', '0'].includes(ssl)) throw new TypeError('database_configuration_invalid');
  const disabled = mode === 'disable' || ssl === 'false' || ssl === '0';
  const required = mode === 'require' || mode === 'verify-full' || ssl === 'true' || ssl === '1';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((disabled && required) || (disabled && !loopback)) throw new TypeError('database_configuration_invalid');
  url.searchParams.delete('sslmode'); url.searchParams.delete('ssl');
  return {
    connectionString: url.href, ssl: !loopback || required ? { rejectUnauthorized: true } : false,
    max: 1, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 1_000, allowExitOnIdle: true,
    statement_timeout: 5_000, query_timeout: 6_000, idle_in_transaction_session_timeout: 10_000,
    application_name: 'homenode-sales-retention-audit',
  };
}

async function loadEnvironment() { await import('dotenv/config'); return process.env; }
async function createPool(options) { const { default: pg } = await import('pg'); return new pg.Pool(options); }
async function audit(pool, options) {
  const { auditSalesRetention } = await import('../src/services/salesRetentionAudit.js');
  return auditSalesRetention(pool, options);
}

/** Injectable for offline CLI tests. No environment, driver or database work
 * occurs on import or before argument admission. Errors never echo raw inputs. */
export async function runSalesRetentionAudit(argv, dependencies = {}) {
  const stderr = dependencies.stderr ?? (line => process.stderr.write(line));
  let options;
  try { options = parseSalesRetentionAuditArgs(argv); }
  catch { stderr(`sales_retention_audit_invalid_arguments\n${USAGE}\n`); return 2; }
  let pool, output, failed = false;
  try {
    const environment = await (dependencies.loadEnvironment ?? loadEnvironment)();
    pool = await (dependencies.createPool ?? createPool)(salesRetentionAuditPoolOptions(environment.DATABASE_URL));
    pool.on('error', () => { failed = true; }); // Never let idle pg errors print connection details.
    output = JSON.stringify(await (dependencies.audit ?? audit)(pool, options), null, 2);
    if (output === undefined) failed = true;
  } catch { failed = true; }
  finally {
    if (pool) try { await pool.end(); } catch { failed = true; }
  }
  if (failed) { stderr('sales_retention_audit_failed\n'); return 1; }
  (dependencies.stdout ?? (line => process.stdout.write(line)))(`${output}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runSalesRetentionAudit(process.argv.slice(2));
}
