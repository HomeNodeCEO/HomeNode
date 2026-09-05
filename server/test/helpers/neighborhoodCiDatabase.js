import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
const scripts = ["prepareUadCiDatabase.js", "runUadMigrations.js", "prepareMobileCiDatabase.js", "runMobileMigrations.js"];
// inet::text retains /32 or /128; host() returns the IP expected by isIP().
export const NEIGHBORHOOD_CI_IDENTITY_SQL = "SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address";

export function checkedNeighborhoodDatabaseUrl(value, mode) {
  if (mode !== "test") throw new Error("Neighborhood PG tests require NODE_ENV=test");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid neighborhood test DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) {
    throw new Error("Neighborhood PG tests require a loopback *_test URL without query overrides");
  }
  return { connectionString: value, databaseName: url.pathname.slice(1) };
}

export function neighborhoodCiDatabasePlan(environment, nonce = randomUUID()) {
  const parent = checkedNeighborhoodDatabaseUrl(environment.DATABASE_URL, environment.NODE_ENV);
  if (environment.GITHUB_ACTIONS !== "true" || environment.CI !== "true") {
    throw new Error("Neighborhood child database creation requires GitHub Actions CI");
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(nonce)) {
    throw new Error("Invalid neighborhood CI database nonce");
  }
  const databaseName = `neighborhood_${nonce.replaceAll("-", "")}_test`;
  if (databaseName === parent.databaseName) throw new Error("Neighborhood CI database must be new");
  const url = new URL(parent.connectionString);
  url.pathname = `/${databaseName}`;
  const child = checkedNeighborhoodDatabaseUrl(url.href, "test");
  // The existing preparation scripts import dotenv/config. An empty OS device
  // and no inherited preload/PG overrides prevent .env or connection defaults
  // from redirecting those scripts. PATH and all ordinary CI context stay intact.
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(PG|DOTENV)/i.test(key) && !/^(NODE_OPTIONS|NODE_PATH|DATABASE_URL)$/i.test(key)));
  Object.assign(env, { DATABASE_URL: child.connectionString, NODE_ENV: "test",
    DOTENV_CONFIG_PATH: devNull, DOTENV_CONFIG_QUIET: "true" });
  return { parent, child, env, scripts: [...scripts] };
}

function ipv4(address) { return address?.startsWith("::ffff:") ? address.slice(7) : address; }
function loopback(address) {
  const value = ipv4(address);
  return value === "::1" || (isIP(value ?? "") === 4 && value.startsWith("127."));
}
function privateServer(address) {
  const value = ipv4(address);
  if (loopback(value)) return true;
  if (isIP(value ?? "") === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(value ?? "") === 6 && /^(fc|fd)/i.test(value);
}

export function verifyNeighborhoodCiConnection(identity, remoteAddress, expectedDatabase) {
  // Docker port publishing may expose a private bridge address to PostgreSQL;
  // the actual client socket must nevertheless terminate on loopback.
  if (identity?.database_name !== expectedDatabase || !loopback(remoteAddress) || !privateServer(identity?.server_address)) {
    throw new Error("Neighborhood CI database connection identity mismatch");
  }
}

export async function prepareNeighborhoodCiDatabase(environment = process.env) {
  const plan = neighborhoodCiDatabasePlan(environment); // All guards precede pg import/connection.
  const { default: pg } = await import("pg");
  const admin = new pg.Client({ connectionString: plan.parent.connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: "neighborhood_ci_database_bootstrap" });
  let stage = "connection";
  try {
    await admin.connect();
    stage = "identity";
    const identity = (await admin.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0];
    verifyNeighborhoodCiConnection(identity, admin.connection?.stream?.remoteAddress, plan.parent.databaseName);
    // Name is generated from a validated UUID, ASCII-only and below 63 bytes.
    // Never clone the shared database, retry with broader privileges, or DROP it.
    stage = "creation";
    await admin.query(`CREATE DATABASE "${plan.child.databaseName}" TEMPLATE template0`);
  } catch {
    // Driver errors can contain connection details; expose no raw errors/URLs.
    throw new Error(`Neighborhood isolated CI database ${stage} failed; no shared-database fallback is allowed`);
  } finally {
    await admin.end().catch(() => { throw new Error("Neighborhood CI bootstrap connection did not close cleanly"); });
  }
  for (const script of plan.scripts) {
    try {
      await runFile(process.execPath, [fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url))], {
        cwd: serverDirectory, env: plan.env, timeout: 60_000, maxBuffer: 2_000_000,
        windowsHide: true, shell: false, killSignal: "SIGKILL",
      });
    } catch {
      throw new Error(`Neighborhood isolated CI preparation failed at ${script}; output suppressed to protect credentials`);
    }
  }
  // Child records/database remain only until the ephemeral CI service teardown.
  return plan.child;
}
