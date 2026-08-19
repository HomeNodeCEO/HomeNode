const MINIMUM_STRONG_SAMPLE = 30;
const MINIMUM_OBSERVATIONS_PER_PARAMETER = 10;
const MINIMUM_PREDICTOR_COVERAGE = 0.7;

const FEATURE_DEFINITIONS = Object.freeze([
  { key: "living_area", label: "Gross Living Area", unit: "per_square_foot", rowKey: "living_area", priority: 1 },
  { key: "bathrooms", label: "Bath Equivalent", unit: "per_bath_equivalent", rowKey: "bathrooms", priority: 2 },
  { key: "garage", label: "Garage Spaces", unit: "per_garage_space", rowKey: "garage_spaces", priority: 3 },
  { key: "pool", label: "Pool", unit: "per_feature", rowKey: "pool_yn", priority: 4 },
  { key: "age", label: "Age / Effective Age", unit: "per_year", rowKey: "age_years", priority: 5 },
  { key: "site_size", label: "Site Size", unit: "per_square_foot", rowKey: "site_size", priority: 6 },
]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanNumber(value) {
  if (value === true || value === 1 || String(value).toLowerCase() === "true") return 1;
  if (value === false || value === 0 || String(value).toLowerCase() === "false") return 0;
  return null;
}

function valueFor(row, feature) {
  if (feature.key === "pool") return booleanNumber(row[feature.rowKey]);
  const parsed = finiteNumber(row[feature.rowKey]);
  if (feature.key === "site_size" && parsed !== null && parsed > 0 && parsed < 100) return parsed * 43_560;
  return parsed;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function multiply(left, right) {
  return left.map((row) => right[0].map((_, column) =>
    row.reduce((sum, value, index) => sum + (value * right[index][column]), 0)));
}

function invert(matrix) {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_, column) => index === column ? 1 : 0),
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    augmented[column] = augmented[column].map((value) => value / divisor);
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map((value, index) => value - (factor * augmented[column][index]));
    }
  }
  return augmented.map((row) => row.slice(size));
}

function recommendedAmount(coefficient, unit) {
  if (!Number.isFinite(coefficient)) return null;
  if (unit === "per_square_foot") return Math.round(coefficient * 100) / 100;
  return Math.round(coefficient / 100) * 100;
}

function fitModel(rows, features) {
  const complete = rows.filter((row) => features.every((feature) => valueFor(row, feature) !== null));
  if (complete.length <= features.length + 1) return null;
  const y = complete.map((row) => Number(row.sale_price));
  const featureStats = features.map((feature) => {
    const values = complete.map((row) => valueFor(row, feature));
    const mean = average(values);
    return { feature, mean, standardDeviation: standardDeviation(values, mean) };
  });
  const usableStats = featureStats.filter((item) => item.standardDeviation > 1e-9);
  if (!usableStats.length) return null;
  const x = complete.map((row) => [
    1,
    ...usableStats.map((item) => (valueFor(row, item.feature) - item.mean) / item.standardDeviation),
  ]);
  const xt = transpose(x);
  const xtx = multiply(xt, x);
  for (let index = 1; index < xtx.length; index += 1) xtx[index][index] += 1e-8;
  const inverse = invert(xtx);
  if (!inverse) return null;
  const beta = multiply(multiply(inverse, xt), y.map((value) => [value])).map((row) => row[0]);
  const coefficients = usableStats.map((item, index) => beta[index + 1] / item.standardDeviation);
  const intercept = beta[0] - coefficients.reduce((sum, coefficient, index) => sum + (coefficient * usableStats[index].mean), 0);
  const predicted = complete.map((row) => intercept + coefficients.reduce((sum, coefficient, index) => sum + (coefficient * valueFor(row, usableStats[index].feature)), 0));
  const yMean = average(y);
  const residualSumSquares = y.reduce((sum, value, index) => sum + ((value - predicted[index]) ** 2), 0);
  const totalSumSquares = y.reduce((sum, value) => sum + ((value - yMean) ** 2), 0);
  const rSquared = totalSumSquares > 0 ? 1 - (residualSumSquares / totalSumSquares) : 0;
  const parameterCount = coefficients.length;
  const adjustedRSquared = complete.length > parameterCount + 1
    ? 1 - ((1 - rSquared) * (complete.length - 1) / (complete.length - parameterCount - 1))
    : null;
  const rmse = Math.sqrt(residualSumSquares / complete.length);
  return {
    complete,
    usableStats,
    coefficients,
    intercept,
    rSquared,
    adjustedRSquared,
    rmse,
  };
}

export function buildRegressionAnalysis(inputRows = []) {
  const rows = inputRows.filter((row) => finiteNumber(row.sale_price) > 0);
  const coverage = FEATURE_DEFINITIONS.map((feature) => {
    const valid = rows.filter((row) => valueFor(row, feature) !== null).length;
    return { feature, valid, ratio: rows.length ? valid / rows.length : 0 };
  });
  let features = coverage
    .filter((item) => item.ratio >= MINIMUM_PREDICTOR_COVERAGE && item.valid >= 10)
    .sort((left, right) => left.feature.priority - right.feature.priority)
    .map((item) => item.feature);
  let fitted = fitModel(rows, features);
  while (features.length > 1 && fitted && fitted.complete.length < Math.max(MINIMUM_STRONG_SAMPLE, (features.length + 1) * MINIMUM_OBSERVATIONS_PER_PARAMETER)) {
    features = features.slice(0, -1);
    fitted = fitModel(rows, features);
  }
  if (!fitted) {
    return {
      methodology: {
        model: "ordinary_least_squares",
        salePricesTimeAdjusted: false,
        minimumStrongSample: MINIMUM_STRONG_SAMPLE,
        observationsPerParameter: MINIMUM_OBSERVATIONS_PER_PARAMETER,
        minimumPredictorCoveragePercent: MINIMUM_PREDICTOR_COVERAGE * 100,
      },
      population: { eligibleSaleCount: rows.length, modelSaleCount: 0, excludedIncompleteCount: rows.length },
      model: null,
      coefficients: [],
      warnings: ["Insufficient complete, variable sale data were available to estimate a stable regression model."],
      coverage: coverage.map((item) => ({ key: item.feature.key, label: item.feature.label, count: item.valid, percent: round(item.ratio * 100, 1) })),
    };
  }
  const parameterCount = fitted.usableStats.length + 1;
  const strongSampleRequired = Math.max(MINIMUM_STRONG_SAMPLE, parameterCount * MINIMUM_OBSERVATIONS_PER_PARAMETER);
  const reliability = fitted.complete.length >= strongSampleRequired && fitted.adjustedRSquared >= 0.35
    ? "strong"
    : fitted.complete.length >= parameterCount * 5 && fitted.adjustedRSquared >= 0.15
      ? "moderate"
      : "limited";
  const warnings = [];
  if (fitted.complete.length < strongSampleRequired) warnings.push(`The model uses ${fitted.complete.length} sales; at least ${strongSampleRequired} are preferred for this number of parameters.`);
  if (fitted.adjustedRSquared < 0.15) warnings.push("The adjusted R-squared indicates limited explanatory power; use coefficients only with additional market support.");
  if (fitted.rmse > average(fitted.complete.map((row) => Number(row.sale_price))) * 0.2) warnings.push("The model RMSE exceeds 20% of the average sale price.");
  const salePrices = fitted.complete.map((row) => Number(row.sale_price));
  const salePriceMean = average(salePrices);
  const salePriceStandardDeviation = standardDeviation(salePrices, salePriceMean);
  const coefficients = fitted.usableStats.map((item, index) => {
    const coefficient = fitted.coefficients[index];
    return {
      key: item.feature.key,
      label: item.feature.label,
      unit: item.feature.unit,
      coefficient: round(coefficient, 4),
      standardizedCoefficient: salePriceStandardDeviation > 1e-9
        ? round((coefficient * item.standardDeviation) / salePriceStandardDeviation, 4)
        : null,
      recommendedAdjustment: recommendedAmount(coefficient, item.feature.unit),
      mean: round(item.mean, 2),
      standardDeviation: round(item.standardDeviation, 2),
      coverageCount: coverage.find((entry) => entry.feature.key === item.feature.key)?.valid || 0,
      reliability,
    };
  });
  return {
    methodology: {
      model: "ordinary_least_squares",
      salePricesTimeAdjusted: false,
      minimumStrongSample: MINIMUM_STRONG_SAMPLE,
      observationsPerParameter: MINIMUM_OBSERVATIONS_PER_PARAMETER,
      minimumPredictorCoveragePercent: MINIMUM_PREDICTOR_COVERAGE * 100,
    },
    population: {
      eligibleSaleCount: rows.length,
      modelSaleCount: fitted.complete.length,
      excludedIncompleteCount: rows.length - fitted.complete.length,
    },
    model: {
      intercept: round(fitted.intercept, 2),
      rSquared: round(fitted.rSquared, 4),
      adjustedRSquared: round(fitted.adjustedRSquared, 4),
      rootMeanSquaredError: round(fitted.rmse, 2),
      parameterCount,
      reliability,
    },
    coefficients,
    warnings,
    coverage: coverage.map((item) => ({ key: item.feature.key, label: item.feature.label, count: item.valid, percent: round(item.ratio * 100, 1) })),
  };
}

export const REGRESSION_FEATURES = FEATURE_DEFINITIONS;
