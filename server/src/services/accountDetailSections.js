const PRIMARY_IMPROVEMENT_SQL = `
  SELECT
    construction_type, percent_complete, year_built, effective_year_built,
    actual_age, depreciation, desirability, stories, living_area_sqft,
    total_living_area, bedroom_count, bath_count, basement, kitchens,
    wetbars, fireplaces, sprinkler, spa, pool, sauna, air_conditioning,
    heating, foundation, roof_material, roof_type, exterior_material,
    fence_type, number_units, building_class, total_area_sqft, baths_full,
    baths_half
  FROM core.primary_improvements
  WHERE account_id = $1
`;

const HOUSING_PROFILE_SQL = `
  SELECT
    structural_style, housing_type, attachment_type, architectural_style,
    source_name, source_url, source_record_reference, observed_at, confidence,
    profile_source
  FROM core.v_account_housing_profiles
  WHERE account_id = $1
`;

const OWNER_SQL = `
  SELECT
    os.owner_name,
    os.mailing_address,
    os.tax_year,
    COALESCE((
      SELECT json_agg(
        json_build_object(
          'owner_name', op.owner_name,
          'ownership_pct', op.ownership_pct,
          'tax_year', op.tax_year
        )
        ORDER BY op.id
      )
      FROM core.owner_parties op
      WHERE op.account_id = os.account_id
        AND op.tax_year = (
          SELECT MAX(latest.tax_year)
          FROM core.owner_parties latest
          WHERE latest.account_id = os.account_id
        )
    ), '[]'::json) AS owner_parties
  FROM core.owner_summary os
  WHERE os.account_id = $1
  ORDER BY os.tax_year DESC
  LIMIT 1
`;

const LEGAL_CURRENT_SQL = `
  SELECT tax_year, legal_lines, legal_text, deed_transfer_date
  FROM core.legal_description_current
  WHERE account_id = $1
  LIMIT 1
`;

const LEGAL_HISTORY_SQL = `
  SELECT tax_year, legal_lines, legal_text, deed_transfer_date
  FROM core.legal_description_history
  WHERE account_id = $1 AND deed_transfer_date IS NOT NULL
  ORDER BY tax_year DESC
  LIMIT 1
`;

const EXEMPTIONS_SQL = `
  SELECT tax_year, jurisdiction_key, taxing_jurisdiction,
         homestead_exemption, disabled_vet, taxable_value
  FROM core.exemptions_summary
  WHERE account_id = $1
  ORDER BY tax_year DESC
`;

const LAND_DETAIL_SQL = `
  SELECT line_number AS number,
         state_code,
         zoning,
         frontage_ft,
         depth_ft,
         area_sqft,
         pricing_method,
         unit_price,
         market_adjustment_pct,
         adjusted_price,
         ag_land
  FROM core.land_detail
  WHERE account_id = $1
    AND tax_year = (
      SELECT MAX(latest.tax_year)
      FROM core.land_detail latest
      WHERE latest.account_id = $1
    )
  ORDER BY line_number
`;

const SECONDARY_IMPROVEMENTS_SQL = `
  SELECT
    sec_imp_number AS number,
    sec_imp_type AS improvement_type,
    sec_imp_cons_type AS construction,
    sec_imp_floor AS floor,
    sec_imp_ext_wall AS exterior_wall,
    sec_imp_sqft AS area_sqft,
    sec_imp_value AS value,
    sec_imp_year_built AS year_built
  FROM core.secondary_improvements
  WHERE account_id = $1
  ORDER BY sec_imp_number NULLS LAST, id
`;

function rowsFrom(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}
async function optionalRows(promise, label, logger) {
  try {
    return rowsFrom(await promise);
  } catch (error) {
    logger?.error?.(`${label} query failed`, error);
    return [];
  }
}

export async function loadAccountDetailSections(pool, accountId, { logger = console } = {}) {
  const params = [accountId];
  const [
    improvementResult,
    housingResult,
    ownerResult,
    legalCurrentResult,
    legalHistoryResult,
    exemptionsResult,
    landRows,
    additionalImprovements,
  ] = await Promise.all([
    pool.query(PRIMARY_IMPROVEMENT_SQL, params),
    pool.query(HOUSING_PROFILE_SQL, params),
    pool.query(OWNER_SQL, params),
    pool.query(LEGAL_CURRENT_SQL, params),
    pool.query(LEGAL_HISTORY_SQL, params),
    pool.query(EXEMPTIONS_SQL, params),
    optionalRows(pool.query(LAND_DETAIL_SQL, params), "land_detail", logger),
    optionalRows(pool.query(SECONDARY_IMPROVEMENTS_SQL, params), "secondary_improvements", logger),
  ]);

  const exemptions = rowsFrom(exemptionsResult);
  const exemptionYear = exemptions[0]?.tax_year ?? null;
  const latestExemptions = exemptionYear == null
    ? []
    : exemptions.filter((row) => row.tax_year === exemptionYear);

  return {
    primaryImprovement: rowsFrom(improvementResult)[0] || null,
    housingProfile: rowsFrom(housingResult)[0] || null,
    owner: rowsFrom(ownerResult)[0] || null,
    legalCurrent: rowsFrom(legalCurrentResult)[0] || null,
    legalHistory: rowsFrom(legalHistoryResult)[0] || null,
    exemptionYear,
    exemptions: latestExemptions,
    homesteadYes: latestExemptions.some(
      (row) => Number(row.homestead_exemption || 0) > 0,
    ),
    landRows,
    additionalImprovements,
  };
}
