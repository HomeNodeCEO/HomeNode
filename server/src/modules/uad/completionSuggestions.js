import { loadSharedAppraisalCompletion } from "../../services/appraisalCompletionAdapter.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

export const UAD_COMPLETION_SUGGESTION_SCHEMA_VERSION = 1;
export const UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION = "2026-08-20.1";

const MAX_OMISSIONS = 200;
const UAD_CONDITION = /^C[1-6]$/;
const UAD_QUALITY = /^Q[1-6]$/;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, maxLength = 5_000) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function isoDate(value) {
  const normalized = text(value, 40);
  if (!normalized) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
  return Number.isNaN(date.valueOf()) ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

function sourceMetadata(completion, path) {
  return {
    source_reference: `custom_appraisal_completion:${completion.source.report_file_id}:${path}`,
    source_digest_sha256: completion.provenance.source_digest_sha256,
    observed_at: completion.generated_at,
    requires_appraiser_confirmation: true,
  };
}

function field(fieldKey, value, completion, path, options = {}) {
  if (value === null || value === undefined || value === "") return null;
  return {
    suggestion_id: `field:${fieldKey}`,
    field_key: fieldKey,
    value,
    ...sourceMetadata(completion, path),
    ...options,
  };
}

function addField(target, suggestion) {
  if (suggestion) target.push(suggestion);
}

function addOmission(omissions, omission) {
  if (omissions.length >= MAX_OMISSIONS) return;
  omissions.push(omission);
}

function boundaryDescription(boundary) {
  const values = [
    ["North", boundary?.north],
    ["East", boundary?.east],
    ["South", boundary?.south],
    ["West", boundary?.west],
  ].flatMap(([label, value]) => text(value, 250) ? [`${label}: ${text(value, 250)}`] : []);
  return values.length ? values.join("; ").slice(0, 1_250) : null;
}

function preferredMarketStudy(studies) {
  if (!Array.isArray(studies) || !studies.length) return null;
  return studies.find((study) => String(study?.market?.key || "").toLowerCase() === "appraiser")
    || studies.find((study) => String(study?.market?.key || "").toLowerCase() === "zip")
    || studies[0];
}

function demandSupply(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "shortage") return "Shortage";
  if (["inbalance", "balanced", "balance"].includes(normalized)) return "InBalance";
  if (["oversupply", "oversupplied"].includes(normalized)) return "OverSupply";
  return null;
}

function marketingTime(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("under3") || normalized.includes("underthree")) return "UnderThreeMonths";
  if (normalized.includes("3to6") || normalized.includes("threetosix")) return "ThreeToSixMonths";
  if (normalized.includes("over6") || normalized.includes("oversix")) return "OverSixMonths";
  return null;
}

function buildMarketSuggestions(completion, omissions) {
  const fields = [];
  const entities = [];
  const neighborhood = completion.analyses?.neighborhood || {};
  const market = completion.analyses?.market_conditions || {};
  const boundary = boundaryDescription(neighborhood.boundary);
  addField(fields, field(
    "market:3000.0008",
    boundary,
    completion,
    "analyses.neighborhood.boundary",
    { confidence: neighborhood.boundary?.confirmed ? "confirmed" : "review_required" },
  ));

  const study = preferredMarketStudy(market.studies);
  const periodMonths = integer(market.period_months, 1, 99);
  const studyLabel = text(study?.market?.label || study?.market?.key, 120);
  const periodStart = isoDate(study?.period?.start);
  const periodEnd = isoDate(study?.period?.end);
  const criteria = [
    studyLabel,
    periodStart && periodEnd ? `${periodStart} through ${periodEnd}` : null,
    periodMonths ? `${periodMonths} complete-month lookback` : null,
  ].filter(Boolean).join("; ");
  addField(fields, field("market:3000.0010", text(criteria, 1_250), completion, "analyses.market_conditions.studies"));
  addField(fields, field("market:3000.0009", periodMonths, completion, "analyses.market_conditions.period_months"));

  const saleCountValue = number(study?.population?.eligible_sale_count ?? study?.summary?.sale_count);
  const saleCount = integer(saleCountValue, 0, 999);
  if (saleCountValue !== null && saleCount === null) {
    addOmission(omissions, {
      scope: "market",
      code: "market_sale_count_outside_uad_bounds",
      source_value: saleCountValue,
      target_field_key: "market_total_sales:3000.0026",
    });
  }
  addField(fields, field("market_total_sales:3000.0026", saleCount, completion, "analyses.market_conditions.studies.population"));

  const medianSalePrice = number(study?.summary?.median_sale_price);
  addField(fields, field(
    "market_total_sales:3000.0029",
    medianSalePrice !== null && medianSalePrice > 0 && medianSalePrice <= 999_999_999.99
      ? medianSalePrice
      : null,
    completion,
    "analyses.market_conditions.studies.summary.median_sale_price",
  ));

  addField(fields, field(
    "market:3000.0033",
    demandSupply(neighborhood.profile?.demand_supply),
    completion,
    "analyses.neighborhood.profile.demand_supply",
  ));
  addField(fields, field(
    "market:3000.0031",
    marketingTime(neighborhood.profile?.marketing_time),
    completion,
    "analyses.neighborhood.profile.marketing_time",
  ));

  const trend = text(market.reconciliation?.trendConclusion, 80);
  const explanation = text(market.reconciliation?.explanation, 2_300);
  const commentary = [
    trend ? `Market trend conclusion: ${trend}.` : null,
    explanation,
  ].filter(Boolean).join(" ");
  addField(fields, field(
    "market_price_trend_commentary:3000.0040",
    text(commentary, 2_500),
    completion,
    "analyses.market_conditions.reconciliation",
  ));
  if (studyLabel) {
    entities.push({
      suggestion_id: "entity:market_price_trend_source:primary",
      entity_type: "market_price_trend_source",
      ordinal: 1,
      values: {
        "market_price_trend_source:3000.0051": text(`HomeNode ${studyLabel}`, 33),
      },
      ...sourceMetadata(completion, "analyses.market_conditions.studies.0"),
    });
  }

  return { fields, entities };
}

function attachmentType(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("detached")) return "Detached";
  if (normalized.includes("attached")) return "Attached";
  return null;
}

function exactRating(value, pattern) {
  const normalized = String(value || "").trim().toUpperCase();
  return pattern.test(normalized) ? normalized : null;
}

function comparableSourceKey(sale, ordinal) {
  return text(
    sale?.source_record_id
      || sale?.listing_key
      || sale?.listing_id
      || sale?.sale_id
      || sale?.primary_account_id
      || `ordinal-${ordinal}`,
    120,
  );
}

function finiteAdjustment(value) {
  const parsed = number(value);
  return parsed !== null && Math.abs(parsed) <= 999_999_999 ? parsed : null;
}

function buildComparableSuggestions(completion, omissions) {
  const sales = completion.analyses?.comparable_sales || {};
  const fields = [];
  const entities = [];
  const comparables = Array.isArray(sales.primary_comparables)
    ? sales.primary_comparables.slice(0, 12)
    : [];

  if (comparables.length) {
    addField(fields, field(
      "sales_comparison_scope:1000.0032",
      true,
      completion,
      "analyses.comparable_sales.primary_comparables",
    ));
  }
  const indicated = number(sales.indicated_value);
  addField(fields, field(
    "sales_comparison_summary:1300.0006",
    indicated !== null && indicated > 0 && indicated <= 999_999_999 ? indicated : null,
    completion,
    "analyses.comparable_sales.indicated_value",
  ));
  const reconciliation = [
    text(sales.sales_notes, 7_000),
    text(sales.adjustment_notes, 3_000),
  ].filter(Boolean).join("\n\n");
  addField(fields, field(
    "sales_comparison_reconciliation:1800.0278",
    text(reconciliation, 10_000),
    completion,
    "analyses.comparable_sales.notes",
  ));

  const subjectCondition = exactRating(completion.subject?.characteristics?.condition_rating, UAD_CONDITION);
  const subjectQuality = exactRating(completion.subject?.characteristics?.quality_rating, UAD_QUALITY);
  addField(fields, field("subject:1600.0006", subjectCondition, completion, "subject.characteristics.condition_rating"));
  addField(fields, field("subject:1600.0007", subjectQuality, completion, "subject.characteristics.quality_rating"));

  comparables.forEach((comparable, index) => {
    const sale = plainObject(comparable?.sale) ? comparable.sale : {};
    const ordinal = index + 1;
    const sourceKey = comparableSourceKey(sale, ordinal);
    const values = {
      "sales_comparable:1800.0192": ordinal,
    };
    const setValue = (key, value) => {
      if (value !== null && value !== undefined && value !== "") values[key] = value;
    };

    setValue("sales_comparable_address:1800.0001", text(sale.address, 100));
    setValue("sales_comparable_address:1800.0003", text(sale.city, 50));
    setValue("sales_comparable_address:1800.0005", text(sale.state, 2)?.toUpperCase());
    setValue("sales_comparable_address:1800.0004", text(sale.zip || sale.postal_code, 10));
    const distance = number(sale.distanceMiles ?? sale.distance_miles);
    if (distance !== null && distance >= 0 && distance <= 999.99) {
      setValue("sales_comparable_proximity:1800.0065", { amount: distance, unit: "Miles" });
    }
    setValue("sales_comparable_listing:1800.0075", "SettledSale");
    const salePrice = number(sale.sale_price);
    if (salePrice !== null && salePrice >= 0 && salePrice <= 999_999_999.99) {
      setValue("sales_comparable_sale:1800.0272", salePrice);
    }
    setValue("sales_comparable_sale:1800.0342", isoDate(sale.closing_date));
    setValue("sales_comparable_listing:1800.0189", integer(sale.days_on_market, 0, 9_999));
    setValue(
      "sales_comparable_property:1800.0195",
      attachmentType(sale.attachment_type || sale.comparableHousingType || sale.housing_type),
    );

    const condition = exactRating(comparable.condition, UAD_CONDITION);
    const quality = exactRating(comparable.quality, UAD_QUALITY);
    setValue("sales_comparable_property:1800.0196", condition);
    setValue("sales_comparable_property:1800.0197", quality);
    if (text(comparable.condition, 20) && !condition) {
      addOmission(omissions, {
        scope: `comparable:${sourceKey}`,
        code: "condition_range_requires_appraiser_reconciliation",
        source_value: text(comparable.condition, 20),
        target_field_key: "sales_comparable_property:1800.0196",
      });
    }
    if (text(comparable.quality, 20) && !quality) {
      addOmission(omissions, {
        scope: `comparable:${sourceKey}`,
        code: "quality_range_requires_appraiser_reconciliation",
        source_value: text(comparable.quality, 20),
        target_field_key: "sales_comparable_property:1800.0197",
      });
    }

    const adjustments = plainObject(comparable.adjustments) ? comparable.adjustments : {};
    const mappedAdjustments = [
      ["time", "sales_comparable_adjustment_sale_date:1800.0317"],
      ["livingArea", "sales_comparable_adjustment_standard_above:1800.0317"],
      ["garage", "sales_comparable_adjustment_vehicle_storage:1800.0317"],
      ["pool", "sales_comparable_adjustment_water_features_amenity:1800.0317"],
      ["siteSize", "sales_comparable_adjustment_site_size:1800.0317"],
      ["age", "sales_comparable_adjustment_year_built:1800.0317"],
      ["condition", "sales_comparable_adjustment_overall_condition:1800.0317"],
      ["quality", "sales_comparable_adjustment_overall_quality:1800.0317"],
    ];
    mappedAdjustments.forEach(([sourceName, targetKey]) => {
      const adjustment = finiteAdjustment(adjustments[sourceName]);
      if (adjustment !== null) setValue(targetKey, adjustment);
    });
    const concession = finiteAdjustment(adjustments.concessions);
    if (concession !== null) {
      setValue(
        "sales_comparable_adjustment_concessions:1800.0317",
        concession > 0 ? -concession : concession,
      );
    }
    if (finiteAdjustment(adjustments.roomCount)) {
      addOmission(omissions, {
        scope: `comparable:${sourceKey}`,
        code: "combined_room_count_adjustment_requires_split",
        source_value: finiteAdjustment(adjustments.roomCount),
        target_field_keys: [
          "sales_comparable_adjustment_bedrooms:1800.0317",
          "sales_comparable_adjustment_bathrooms:1800.0317",
        ],
      });
    }

    const relatedEntities = [];
    const listingId = text(sale.listing_id || sale.listing_key, 45);
    if (listingId || text(sale.source, 45)) {
      relatedEntities.push({
        entity_type: "sales_comparable_data_source",
        ordinal: 1,
        values: {
          "sales_comparable_data_source:0700.0125": "MLS",
          ...(listingId ? { "sales_comparable_data_source:1800.0347": listingId } : {}),
        },
        ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
      });
    }

    const dwellingValues = {};
    const yearBuilt = integer(
      sale.comparableYearBuilt ?? sale.cad_year_built ?? sale.mls_year_built,
      1000,
      2100,
    );
    if (yearBuilt !== null) {
      dwellingValues["sales_comparable_dwelling:1800.0128"] = String(yearBuilt);
    }
    const unitValues = {};
    const livingArea = number(sale.cad_living_area_sqft ?? sale.mls_living_area ?? sale.comparable_square_feet);
    if (livingArea !== null && livingArea > 0 && livingArea <= 999_999) {
      unitValues["sales_comparable_unit:1800.0390"] = { amount: livingArea, unit: "SquareFeet" };
    }
    const bedrooms = integer(sale.cad_bedroom_count ?? sale.mls_bedrooms_total, 0, 99);
    const fullBaths = integer(sale.cad_baths_full ?? sale.mls_bathrooms_full, 0, 99);
    const halfBaths = integer(sale.cad_baths_half ?? sale.mls_bathrooms_half, 0, 99);
    if (bedrooms !== null) unitValues["sales_comparable_unit:1800.0330"] = bedrooms;
    if (fullBaths !== null) unitValues["sales_comparable_unit:1800.0331"] = fullBaths;
    if (halfBaths !== null) unitValues["sales_comparable_unit:1800.0332"] = halfBaths;
    if (Object.keys(unitValues).length) {
      dwellingValues["sales_comparable_dwelling:1800.0368"] = 1;
      relatedEntities.push({
        entity_type: "sales_comparable_dwelling",
        ordinal: 1,
        values: dwellingValues,
        related_entities: [{
          entity_type: "sales_comparable_unit",
          ordinal: 1,
          values: unitValues,
          ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
        }],
        ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
      });
    } else if (Object.keys(dwellingValues).length) {
      relatedEntities.push({
        entity_type: "sales_comparable_dwelling",
        ordinal: 1,
        values: dwellingValues,
        ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
      });
    }

    const siteSize = number(sale.comparableSiteSize ?? sale.comparable_site_size);
    if (siteSize !== null && siteSize > 0 && siteSize <= 999_999_999) {
      setValue("sales_comparable_site:1800.0239", { amount: siteSize, unit: "SquareFeet" });
    }

    entities.push({
      suggestion_id: `entity:sales_comparable:${sourceKey}`,
      entity_type: "sales_comparable",
      source_key: sourceKey,
      ordinal,
      values,
      related_entities: relatedEntities,
      ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}`),
      data_quality_flags: Array.isArray(sale.data_quality_flags)
        ? sale.data_quality_flags.slice(0, 25)
        : [],
      requires_additional_review: Boolean(sale.requires_additional_review),
    });
  });

  return { fields, entities };
}

export function buildUadCompletionSuggestions(completion) {
  if (!plainObject(completion) || completion.schema_version !== 1) {
    throw new Error("unsupported_appraisal_completion_schema");
  }
  if (completion.target?.workflow_type !== "uad_3_6") {
    throw new Error("uad_completion_target_required");
  }
  if (
    !completion.source?.report_file_id
    || !completion.assignment_scope?.appraisal_case_id
    || !completion.assignment_scope?.subject_snapshot_id
    || !completion.provenance?.source_digest_sha256
  ) {
    throw new Error("invalid_appraisal_completion_provenance");
  }

  const omissions = [];
  const market = buildMarketSuggestions(completion, omissions);
  const sales = buildComparableSuggestions(completion, omissions);
  return {
    schema_version: UAD_COMPLETION_SUGGESTION_SCHEMA_VERSION,
    adapter_version: UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION,
    source_completion: {
      schema_version: completion.schema_version,
      adapter_version: completion.adapter_version,
      source_report_file_id: completion.source.report_file_id,
      target_report_file_id: completion.target.report_file_id,
      appraisal_case_id: completion.assignment_scope.appraisal_case_id,
      subject_snapshot_id: completion.assignment_scope.subject_snapshot_id,
      source_digest_sha256: completion.provenance.source_digest_sha256,
    },
    status: completion.readiness?.status === "complete" ? "ready_for_review" : "source_review_required",
    source_readiness: completion.readiness || { status: "review_required", blockers: [], warnings: [] },
    suggestions: {
      market_fields: market.fields,
      market_entities: market.entities,
      sales_comparison_fields: sales.fields,
      sales_comparable_entities: sales.entities,
    },
    omissions,
    counts: {
      field_suggestions: market.fields.length + sales.fields.length,
      entity_suggestions: market.entities.length + sales.entities.length,
      omissions: omissions.length,
    },
    apply_mode: "review_only",
    requires_appraiser_confirmation: true,
  };
}

export async function loadUadCompletionSuggestions(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const result = await pool.query(
    `SELECT id, account_id
       FROM app.report_files
      WHERE uad_workfile_id = $1
        AND workflow_type = 'uad_3_6'
      ORDER BY is_current DESC, updated_at DESC
      LIMIT 1`,
    [workfileId],
  );
  if (!result.rows.length) throw new Error("uad_completion_report_file_not_registered");
  const reportFile = result.rows[0];
  const completion = await loadSharedAppraisalCompletion(pool, {
    accountId: reportFile.account_id,
    reportFileId: reportFile.id,
  });
  return buildUadCompletionSuggestions(completion);
}
