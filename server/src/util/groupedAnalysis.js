function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundAdjustment(value) {
  return Number.isFinite(value) ? Math.round(value / 100) * 100 : null;
}

function reliabilityFor(leftCount, rightCount) {
  const minimumCount = Math.min(leftCount, rightCount);
  if (minimumCount >= 30) return "strong";
  if (minimumCount >= 10) return "moderate";
  return "limited";
}

function normalizeGroupRow(row) {
  return {
    groupValue:
      row.dimension === "pool"
        ? String(row.group_value).toLowerCase() === "true"
        : finiteNumber(row.group_value),
    sampleSize: finiteNumber(row.sample_size) ?? 0,
    minimumSalePrice: finiteNumber(row.minimum_sale_price),
    maximumSalePrice: finiteNumber(row.maximum_sale_price),
    averageSalePrice: round(finiteNumber(row.average_sale_price), 2),
    medianSalePrice: round(finiteNumber(row.median_sale_price), 2),
    lowerQuartileSalePrice: round(
      finiteNumber(row.lower_quartile_sale_price),
      2,
    ),
    upperQuartileSalePrice: round(
      finiteNumber(row.upper_quartile_sale_price),
      2,
    ),
    salePriceStandardDeviation: round(
      finiteNumber(row.sale_price_standard_deviation),
      2,
    ),
    averagePricePerSquareFoot: round(
      finiteNumber(row.average_price_per_square_foot),
      2,
    ),
    medianPricePerSquareFoot: round(
      finiteNumber(row.median_price_per_square_foot),
      2,
    ),
    averageLivingArea: round(finiteNumber(row.average_living_area), 0),
    medianLivingArea: round(finiteNumber(row.median_living_area), 0),
    minimumLivingArea: round(finiteNumber(row.minimum_living_area), 0),
    maximumLivingArea: round(finiteNumber(row.maximum_living_area), 0),
    averageDaysOnMarket: round(finiteNumber(row.average_days_on_market), 1),
    medianDaysOnMarket: round(finiteNumber(row.median_days_on_market), 1),
  };
}

function emptyGroup(groupValue) {
  return {
    groupValue,
    sampleSize: 0,
    minimumSalePrice: null,
    maximumSalePrice: null,
    averageSalePrice: null,
    medianSalePrice: null,
    lowerQuartileSalePrice: null,
    upperQuartileSalePrice: null,
    salePriceStandardDeviation: null,
    averagePricePerSquareFoot: null,
    medianPricePerSquareFoot: null,
    averageLivingArea: null,
    medianLivingArea: null,
    minimumLivingArea: null,
    maximumLivingArea: null,
    averageDaysOnMarket: null,
    medianDaysOnMarket: null,
  };
}

function numericGroupLabel(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function adjustmentOptions(previous, current) {
  if (!previous.sampleSize || !current.sampleSize) return [];

  const reliability = reliabilityFor(previous.sampleSize, current.sampleSize);
  const createOption = (basis, label, currentValue, previousValue) => {
    if (
      !Number.isFinite(currentValue) ||
      !Number.isFinite(previousValue)
    ) {
      return null;
    }
    const rawAmount = currentValue - previousValue;
    return {
      id: basis,
      label,
      basis,
      rawAmount: round(rawAmount, 2),
      amount: roundAdjustment(rawAmount),
      reliability,
      sampleSizeLow: Math.min(previous.sampleSize, current.sampleSize),
      sampleSizeHigh: Math.max(previous.sampleSize, current.sampleSize),
      recommended: basis === "median_sale_price_difference",
    };
  };

  return [
    createOption(
      "median_sale_price_difference",
      "Median sale-price difference",
      current.medianSalePrice,
      previous.medianSalePrice,
    ),
    createOption(
      "average_sale_price_difference",
      "Average sale-price difference",
      current.averageSalePrice,
      previous.averageSalePrice,
    ),
  ].filter(Boolean);
}

function livingAreaAdjustmentOptions(previous, current) {
  if (!previous.sampleSize || !current.sampleSize) return [];

  const reliability = reliabilityFor(previous.sampleSize, current.sampleSize);
  const createOption = (
    basis,
    label,
    currentPrice,
    previousPrice,
    currentArea,
    previousArea,
  ) => {
    if (
      !Number.isFinite(currentPrice) ||
      !Number.isFinite(previousPrice) ||
      !Number.isFinite(currentArea) ||
      !Number.isFinite(previousArea)
    ) {
      return null;
    }
    const areaDifference = currentArea - previousArea;
    if (areaDifference <= 0) return null;
    const priceDifference = currentPrice - previousPrice;
    const rawAmount = priceDifference / areaDifference;
    return {
      id: basis,
      label,
      basis,
      rawAmount: round(rawAmount, 2),
      amount: Math.round(rawAmount),
      priceDifference: round(priceDifference, 2),
      livingAreaDifference: round(areaDifference, 2),
      reliability,
      sampleSizeLow: Math.min(previous.sampleSize, current.sampleSize),
      sampleSizeHigh: Math.max(previous.sampleSize, current.sampleSize),
      recommended: basis === "median_sale_price_difference",
    };
  };

  return [
    createOption(
      "median_sale_price_difference",
      "Median sale-price difference per square foot",
      current.medianSalePrice,
      previous.medianSalePrice,
      current.medianLivingArea,
      previous.medianLivingArea,
    ),
    createOption(
      "average_sale_price_difference",
      "Average sale-price difference per square foot",
      current.averageSalePrice,
      previous.averageSalePrice,
      current.averageLivingArea,
      previous.averageLivingArea,
    ),
  ].filter(Boolean);
}

function buildNumericDimension({
  key,
  label,
  rows,
  minimum,
  singular,
  plural,
}) {
  const normalized = rows.map(normalizeGroupRow);
  const byValue = new Map(
    normalized
      .filter((row) => Number.isInteger(row.groupValue))
      .map((row) => [row.groupValue, row]),
  );
  const maximum = normalized.reduce(
    (current, row) =>
      Number.isInteger(row.groupValue)
        ? Math.max(current, row.groupValue)
        : current,
    minimum,
  );
  const groups = [];
  for (let value = minimum; value <= maximum; value += 1) {
    groups.push({
      ...(byValue.get(value) ?? emptyGroup(value)),
      label: numericGroupLabel(value, singular, plural),
    });
  }

  const transitions = groups.slice(1).map((current, index) => {
    const previous = groups[index];
    return {
      id: `${previous.groupValue}-to-${current.groupValue}`,
      label: `${previous.label} → ${current.label}`,
      fromGroupValue: previous.groupValue,
      toGroupValue: current.groupValue,
      fromSampleSize: previous.sampleSize,
      toSampleSize: current.sampleSize,
      options: adjustmentOptions(previous, current),
    };
  });

  return { key, label, groups, transitions };
}

function buildPoolDimension(rows) {
  const normalized = rows.map(normalizeGroupRow);
  const byValue = new Map(normalized.map((row) => [row.groupValue, row]));
  const groups = [
    {
      ...(byValue.get(false) ?? emptyGroup(false)),
      label: "Without pool",
    },
    {
      ...(byValue.get(true) ?? emptyGroup(true)),
      label: "With pool",
    },
  ];
  return {
    key: "pool",
    label: "Pool",
    groups,
    transitions: [
      {
        id: "without-to-with",
        label: "Without pool → With pool",
        fromGroupValue: false,
        toGroupValue: true,
        fromSampleSize: groups[0].sampleSize,
        toSampleSize: groups[1].sampleSize,
        options: adjustmentOptions(groups[0], groups[1]),
      },
    ],
  };
}

function livingAreaGroupLabel(group, index) {
  if (
    !Number.isFinite(group.minimumLivingArea) ||
    !Number.isFinite(group.maximumLivingArea)
  ) {
    return `Band ${index}`;
  }
  const minimum = Math.floor(group.minimumLivingArea / 100) * 100;
  const maximum = Math.ceil(group.maximumLivingArea / 100) * 100;
  return `${minimum.toLocaleString("en-US")} - ${maximum.toLocaleString("en-US")} sf`;
}

function buildLivingAreaDimension(rows) {
  const normalized = rows.map(normalizeGroupRow);
  const byValue = new Map(
    normalized
      .filter((row) => Number.isInteger(row.groupValue))
      .map((row) => [row.groupValue, row]),
  );
  const groups = Array.from({ length: 10 }, (_, index) => {
    const groupValue = index + 1;
    const group = byValue.get(groupValue) ?? emptyGroup(groupValue);
    return {
      ...group,
      label: livingAreaGroupLabel(group, groupValue),
    };
  });
  const transitions = groups.slice(1).map((current, index) => {
    const previous = groups[index];
    return {
      id: `${previous.groupValue}-to-${current.groupValue}`,
      label: `${previous.label} to ${current.label}`,
      fromGroupValue: previous.groupValue,
      toGroupValue: current.groupValue,
      fromSampleSize: previous.sampleSize,
      toSampleSize: current.sampleSize,
      options: livingAreaAdjustmentOptions(previous, current),
    };
  });

  return {
    key: "living_area",
    label: "Gross living area",
    groups,
    transitions,
  };
}

export function buildGroupedAnalysis(rows) {
  const rowsFor = (dimension) =>
    rows.filter((row) => row.dimension === dimension);
  return [
    buildNumericDimension({
      key: "bathrooms",
      label: "Total bathrooms",
      rows: rowsFor("bathrooms"),
      minimum: 1,
      singular: "bath",
      plural: "baths",
    }),
    buildNumericDimension({
      key: "garage",
      label: "Garage spaces",
      rows: rowsFor("garage"),
      minimum: 0,
      singular: "space",
      plural: "spaces",
    }),
    buildPoolDimension(rowsFor("pool")),
    buildLivingAreaDimension(rowsFor("living_area")),
  ];
}
