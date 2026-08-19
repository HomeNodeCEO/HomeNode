function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function siteSizeSquareFeet(value) {
  const parsed = finiteNumber(value);
  if (!(parsed > 0)) return null;
  // NTREIS exports LotSizeArea as acreage for typical residential sites, while
  // CAD land records are already square feet. A positive value below 100 is not
  // a plausible residential square-foot site and is therefore acreage.
  return parsed < 100 ? parsed * 43_560 : parsed;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Build an allocation-method site study without altering historical prices. */
export function buildSiteValuationAnalysis(inputRows = []) {
  const evidence = [];
  let missingAllocationCount = 0;
  let missingSiteSizeCount = 0;
  for (const row of inputRows) {
    const salePrice = finiteNumber(row.sale_price);
    const landValue = finiteNumber(row.cad_land_value);
    const improvementValue = finiteNumber(row.cad_improvement_value);
    const siteSize = siteSizeSquareFeet(row.site_size);
    if (!(salePrice > 0) || !(landValue > 0) || !(improvementValue >= 0) || !(landValue + improvementValue > 0)) {
      missingAllocationCount += 1;
      continue;
    }
    if (!(siteSize > 0)) {
      missingSiteSizeCount += 1;
      continue;
    }
    const allocationRatio = landValue / (landValue + improvementValue);
    const allocatedSiteValue = salePrice * allocationRatio;
    const siteValuePerSquareFoot = allocatedSiteValue / siteSize;
    if (!(siteValuePerSquareFoot > 0) || !Number.isFinite(siteValuePerSquareFoot)) {
      missingAllocationCount += 1;
      continue;
    }
    evidence.push({
      saleId: row.sale_id == null ? null : Number(row.sale_id),
      sourceRecordId: String(row.source_record_id || "") || null,
      accountId: String(row.primary_account_id || "") || null,
      address: String(row.address || "") || null,
      closingDate: row.closing_date || null,
      salePrice: round(salePrice),
      cadLandValue: round(landValue),
      cadImprovementValue: round(improvementValue),
      allocationRatio: round(allocationRatio, 4),
      siteSizeSquareFeet: round(siteSize),
      allocatedSiteValue: round(allocatedSiteValue),
      siteValuePerSquareFoot: round(siteValuePerSquareFoot, 4),
    });
  }

  if (!evidence.length) {
    return {
      population: {
        eligibleSaleCount: inputRows.length,
        analyzedSaleCount: 0,
        missingAllocationCount,
        missingSiteSizeCount,
      },
      statistics: null,
      options: [],
      evidence: [],
      reliability: "limited",
      warnings: ["No sales had both a usable CAD land allocation and a known site size."],
    };
  }

  const rates = evidence.map((row) => row.siteValuePerSquareFoot);
  const medianRate = median(rates);
  const averageRate = average(rates);
  const deviation = standardDeviation(rates, averageRate);
  const cod = medianRate > 0
    ? average(rates.map((value) => Math.abs(value - medianRate))) / medianRate * 100
    : 0;
  const cv = averageRate > 0 ? deviation / averageRate * 100 : 0;
  const reliability = evidence.length >= 30 && cod <= 25
    ? "strong"
    : evidence.length >= 10
      ? "moderate"
      : "limited";
  const warnings = [];
  if (evidence.length < 30) warnings.push(`Only ${evidence.length} sales support the allocation study; 30 or more are preferred.`);
  if (cod > 25) warnings.push(`The site-value-per-square-foot COD is ${round(cod, 1)}%, indicating material dispersion.`);
  warnings.push("The allocation method uses each sale's unadjusted price and CAD land-to-total value ratio; it is not a substitute for verified vacant-land sales when those are available.");

  return {
    population: {
      eligibleSaleCount: inputRows.length,
      analyzedSaleCount: evidence.length,
      missingAllocationCount,
      missingSiteSizeCount,
    },
    statistics: {
      medianSiteValuePerSquareFoot: round(medianRate, 4),
      averageSiteValuePerSquareFoot: round(averageRate, 4),
      standardDeviation: round(deviation, 4),
      coefficientOfDispersion: round(cod, 2),
      coefficientOfVariation: round(cv, 2),
      minimumSiteValuePerSquareFoot: round(Math.min(...rates), 4),
      maximumSiteValuePerSquareFoot: round(Math.max(...rates), 4),
    },
    options: [
      { id: "median", label: "Median allocated site value", amount: round(medianRate, 2), reliability },
      { id: "average", label: "Average allocated site value", amount: round(averageRate, 2), reliability },
    ],
    evidence,
    reliability,
    warnings,
  };
}
