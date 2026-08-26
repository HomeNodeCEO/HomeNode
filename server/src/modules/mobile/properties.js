import { listReportFiles, normalizeAccountId } from "./reportFiles.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function boundedLimit(value) {
  const limit = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error("invalid_property_search_limit");
  }
  return limit;
}

function searchPattern(value) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export function normalizePropertySearch(value) {
  const query = String(value || "").trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 120) throw new Error("invalid_property_search_query");
  return query;
}

function emptyWorkflowSummary() {
  return {
    custom_appraisal: { count: 0, current_file: null },
    uad_3_6: { count: 0, current_file: null },
    property_tax_protest: { count: 0, current_file: null },
  };
}

function propertyFromRow(row) {
  return {
    account_id: row.account_id,
    address: row.address || null,
    city: row.city || null,
    postal_code: row.postal_code || null,
    county: row.county || null,
    neighborhood_code: row.neighborhood_code || null,
    subdivision: row.subdivision || null,
    year_built: row.year_built == null ? null : Number(row.year_built),
    living_area_sqft: row.living_area_sqft == null ? null : Number(row.living_area_sqft),
    bedroom_count: row.bedroom_count == null ? null : Number(row.bedroom_count),
    bath_count: row.bath_count == null ? null : Number(row.bath_count),
    workflows: emptyWorkflowSummary(),
  };
}

function attachFile(property, row) {
  if (!row.report_file_id || !property.workflows[row.workflow_type]) return;
  const summary = property.workflows[row.workflow_type];
  summary.count += 1;
  if (row.is_current && !summary.current_file) {
    summary.current_file = {
      id: row.report_file_id,
      file_number: row.file_number,
      updated_at: row.report_file_updated_at,
    };
  }
}

function organizationScope(auth) {
  return {
    organizationIds: auth.organizations.map((item) => item.organizationId),
  };
}

export async function searchMobileProperties(pool, auth, { query: value, limit: limitValue } = {}) {
  const query = normalizePropertySearch(value);
  const limit = boundedLimit(limitValue);
  const { organizationIds } = organizationScope(auth);
  const { rows } = await pool.query(
    `WITH accessible_files AS (
       SELECT report_file.*
        FROM app.report_files report_file
       WHERE report_file.organization_id = ANY($3::uuid[])
     ), matching_accounts AS (
       SELECT account.account_id, account.address, account.city, account.postal_code,
              account.county, account.neighborhood_code, account.subdivision,
              improvement.year_built, improvement.living_area_sqft,
              improvement.bedroom_count, improvement.bath_count,
              CASE
                WHEN lower(account.account_id) = lower($1) THEN 0
                WHEN lower(COALESCE(account.address, '')) = lower($1) THEN 1
                WHEN account.account_id ILIKE $2 ESCAPE '\\' THEN 2
                WHEN COALESCE(account.address, '') ILIKE $2 ESCAPE '\\' THEN 3
                ELSE 4
              END AS match_rank
         FROM core.accounts account
         LEFT JOIN LATERAL (
           SELECT year_built, living_area_sqft, bedroom_count, bath_count
             FROM core.primary_improvements
            WHERE account_id = account.account_id
            LIMIT 1
         ) improvement ON true
        WHERE account.account_id ILIKE $2 ESCAPE '\\'
           OR COALESCE(account.address, '') ILIKE $2 ESCAPE '\\'
           OR COALESCE(account.city, '') ILIKE $2 ESCAPE '\\'
           OR COALESCE(account.postal_code, '') ILIKE $2 ESCAPE '\\'
           OR EXISTS (
             SELECT 1 FROM accessible_files file
              WHERE file.account_id = account.account_id
                AND file.file_number ILIKE $2 ESCAPE '\\'
           )
        ORDER BY match_rank, account.address NULLS LAST, account.account_id
        LIMIT $4
     )
     SELECT matching_accounts.*,
            file.id AS report_file_id, file.workflow_type, file.file_number,
            file.is_current, file.updated_at AS report_file_updated_at
       FROM matching_accounts
       LEFT JOIN accessible_files file ON file.account_id = matching_accounts.account_id
      ORDER BY matching_accounts.match_rank, matching_accounts.address NULLS LAST,
               matching_accounts.account_id, file.is_current DESC, file.updated_at DESC`,
    [query, searchPattern(query), organizationIds, limit],
  );
  const properties = new Map();
  for (const row of rows) {
    const property = properties.get(row.account_id) || propertyFromRow(row);
    attachFile(property, row);
    properties.set(row.account_id, property);
  }
  return Object.freeze({ query, results: [...properties.values()] });
}

export async function getMobileProperty(pool, auth, accountIdValue) {
  const accountId = normalizeAccountId(accountIdValue);
  const { rows } = await pool.query(
    `SELECT account.account_id, account.address, account.city, account.postal_code,
            account.county, account.neighborhood_code, account.subdivision,
            improvement.year_built, improvement.living_area_sqft,
            improvement.bedroom_count, improvement.bath_count
       FROM core.accounts account
       LEFT JOIN LATERAL (
         SELECT year_built, living_area_sqft, bedroom_count, bath_count
           FROM core.primary_improvements
          WHERE account_id = account.account_id
          LIMIT 1
       ) improvement ON true
      WHERE account.account_id = $1`,
    [accountId],
  );
  if (!rows.length) throw new Error("property_not_found");
  const discovery = await listReportFiles(pool, auth, { accountId });
  const property = propertyFromRow(rows[0]);
  for (const file of discovery.files) {
    attachFile(property, {
      report_file_id: file.id,
      workflow_type: file.workflow_type,
      file_number: file.file_number,
      is_current: file.is_current,
      report_file_updated_at: file.updated_at,
    });
  }
  return Object.freeze({ property, files: discovery.files });
}
