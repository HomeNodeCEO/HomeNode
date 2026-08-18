import "dotenv/config";
import pg from "pg";

import { normalizeOidcIssuer } from "../src/modules/mobile/auth.js";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const email = (option("email") || process.env.MOBILE_IDENTITY_EMAIL || "").toLowerCase();
const issuer = normalizeOidcIssuer(option("issuer") || process.env.OIDC_ISSUER);
const subject = option("subject") || process.env.MOBILE_IDENTITY_SUBJECT || "";
const providerKey = option("provider") || "workos";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!email || email.length > 320) throw new Error("valid --email is required");
if (!subject || subject.length > 500) throw new Error("valid --subject is required");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const user = await pool.query(
    "SELECT id, email FROM app_auth.users WHERE lower(email) = $1 AND active = true",
    [email],
  );
  if (user.rows.length !== 1) throw new Error("exactly one active HomeNode user is required");
  const existing = await pool.query(
    `SELECT user_id FROM app_auth.oidc_identities
      WHERE (issuer = $1 AND subject = $2) OR (user_id = $3 AND issuer = $1)`,
    [issuer, subject, user.rows[0].id],
  );
  if (existing.rows.some((row) => row.user_id !== user.rows[0].id)) {
    throw new Error("OIDC identity is already mapped to another HomeNode user");
  }
  await pool.query(
    `INSERT INTO app_auth.oidc_identities (issuer, subject, user_id, provider_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (issuer, subject) DO UPDATE
       SET provider_key = EXCLUDED.provider_key, updated_at = now()`,
    [issuer, subject, user.rows[0].id, providerKey],
  );
  console.log(JSON.stringify({ provisioned: true, email: user.rows[0].email, issuer, subject }));
} finally {
  await pool.end();
}
