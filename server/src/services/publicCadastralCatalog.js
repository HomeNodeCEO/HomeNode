import {
  assertPublicCadastralCatalogGrant,
  normalizePublicCadastralAccountId,
} from "../security/publicCadastralCatalog.js";

export async function getPublicCadastralSubjectSummary(pool, grantValue) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("public_cadastral_query_client_required");
  }
  const grant = assertPublicCadastralCatalogGrant(grantValue);
  const accountId = normalizePublicCadastralAccountId(grant.accountId);
  const { rows } = await pool.query(
    `SELECT account_id, address, city, postal_code, county,
            neighborhood_code, subdivision, legal_description
       FROM core.accounts
      WHERE account_id = $1`,
    [accountId],
  );
  if (!rows.length) throw new Error("public_cadastral_account_not_found");
  return rows[0];
}
