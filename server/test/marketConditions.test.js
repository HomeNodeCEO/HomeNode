import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMarketContextOverride,
  buildMarketTrendRecommendation,
  buildMarketConditionsAnalyses,
  calculateMarketStudyStatistics,
  completeCalendarMonthWindow,
  ensureSpatialSupport,
  getMarketContext,
  MARKET_AREA_KEYS,
  marketConditionsErrorStatus,
  normalizeMarketAnalysisRequest,
  parseMarketAreaKeys,
  validateCustomMarketGeometry,
  weightedCompositeDispersion,
} from "../src/services/marketConditions.js";
import { MARKET_SPATIAL_MIGRATION_NAME } from "../src/database/marketSpatialMigration.js";

test('recent marketing windows use the same eligible population and actual trailing medians in one query', async () => {
  let calculations = 0;
  const pool = { async query(sql) {
    if (sql.includes('market_spatial_support_probe')) return { rows: [{ column_present: true, migration_applied: true, index_valid: true }] };
    if (sql.includes('FROM core.accounts account')) return { rows: [{ account_id: '26355500170360000', postal_code: '75041' }] };
    calculations++;
    assert.match(sql, /CROSS JOIN \(VALUES \(3\), \(6\), \(12\)\)/);
    assert.match(sql, /PERCENTILE_CONT\(0.5\)[\s\S]*eligible.days_on_market/);
    assert.match(sql, /LEFT JOIN eligible ON eligible.closing_date >=/);
    return { rows: [{ recent_periods: [{ months: 3, start: '2026-07-01', end: '2026-09-30', sale_count: 5,
      marketing_observation_count: 4, median_days_on_market: '17.5' }] }] };
  } };
  const value = await buildMarketConditionsAnalyses(pool, { subjectAccountId: '26355500170360000', areaKeys: ['zip'], asOfDate: '2026-09-30', periodMonths: 24 });
  assert.equal(calculations, 1);
  assert.deepEqual(value.analyses[0].recent_periods, [{ months: 3, start: '2026-07-01', end: '2026-09-30', sale_count: 5,
    marketing_observation_count: 4, median_days_on_market: 17.5 }]);
});

test('exact exploration analysis needs neither parcel coordinates nor a fresh CAD lookup', async t => {
  const subjectAccountId = '26355500170360000', calls = [], originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('Fresh CAD lookup is forbidden in this study.'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/);
    if (sql.includes('market_spatial_support_probe')) return { rows: [{ column_present: true, migration_applied: true, index_valid: true }] };
    if (sql.includes('FROM core.accounts account')) return { rows: [{ account_id: subjectAccountId, city: 'Garland', county: 'Dallas',
      latitude: null, longitude: null, location_status: 'unavailable' }] };
    assert.match(sql, /FROM core.v_sales_enriched/);
    assert.equal(values[7], 'exploration'); assert.deepEqual(values[10], [subjectAccountId]);
    return { rows: [{}] };
  } };
  const result = await buildMarketConditionsAnalyses(pool, { subjectAccountId, areaKeys: ['exploration'],
    explorationAccountIds: [subjectAccountId], asOfDate: '2026-08-31', periodMonths: 24 });
  assert.equal(fetches, 0); assert.equal(calls.length, 3);
  assert.equal(result.analyses[0].market.label, 'Exploration Map Area');
  assert.equal(result.subject.latitude, null);
});

test('ZIP/city numeric studies honor the chosen observation dates without waiting for location repair or an appraisal cutoff', async t => {
  const originalFetch = globalThis.fetch, queries = [];
  globalThis.fetch = () => assert.fail('Numeric calculations must not request external CAD data');
  t.after(() => { globalThis.fetch = originalFetch; });
  const subjectAccountId = '26355500170360000';
  const pool = { async query(sql, values) {
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/);
    if (sql.includes('market_spatial_support_probe')) return { rows: [{ column_present: true, migration_applied: true, index_valid: true }] };
    if (sql.includes('FROM core.accounts account')) return { rows: [{ account_id: subjectAccountId, city: 'Garland', county: 'Dallas',
      postal_code: '75041', latitude: null, longitude: null, location_status: 'unavailable' }] };
    assert.match(sql, /FROM core.v_sales_enriched/); queries.push(values);
    return { rows: [{}] };
  } };
  const result = await buildMarketConditionsAnalyses(pool, { subjectAccountId, areaKeys: ['zip', 'city', 'radius_1', 'radius_2'],
    asOfDate: '2026-10-31', periodMonths: 12, effectiveDate: '2026-08-31' });
  assert.deepEqual(result.analyses.map(item => item.market.key), ['zip', 'city']);
  assert.deepEqual(result.unavailable_areas.map(item => item.key), ['radius_1', 'radius_2']);
  assert.ok(queries.every(values => values[0] === '2026-10-31' && values[1] === 12));
});

test('every numeric study exposes its fixed parameters to the planner without trimming sales or exploration membership', async () => {
  const accounts = Array.from({ length: 50000 }, (_, index) => `A${index}`), queries = [];
  const pool = { async query(sql, values) {
    if (sql.includes('market_spatial_support_probe')) return { rows: [{ column_present: true, migration_applied: true, index_valid: true }] };
    if (sql.includes('FROM core.accounts account')) return { rows: [{ account_id: '26355500170360000', city: 'Garland', county: 'Dallas',
      postal_code: '75041', latitude: 32.9, longitude: -96.6, location_status: 'matched' }] };
    queries.push({ sql, values });
    assert.match(sql, /WITH parameters AS NOT MATERIALIZED \(/);
    assert.match(sql, /sale\.closing_date >= parameters\.period_start/);
    assert.match(sql, /sale\.closing_date <= parameters\.period_end/);
    assert.match(sql, /sale\.primary_account_id = ANY\(parameters\.exploration_accounts\)/);
    assert.match(sql, /link\.account_id = ANY\(parameters\.exploration_accounts\)/);
    assert.doesNotMatch(sql.slice(0, sql.indexOf('numeric_medians AS')), /\bLIMIT\b/);
    assert.doesNotMatch(sql, /\bSET\b|set_config\(/i, 'No global or session planner setting changes');
    return { rows: [{}] };
  } };
  const result = await buildMarketConditionsAnalyses(pool, { subjectAccountId: '26355500170360000',
    areaKeys: ['zip', 'city', 'radius_1', 'radius_2', 'exploration'], explorationAccountIds: accounts,
    asOfDate: '2026-09-30', periodMonths: 12 });
  assert.deepEqual(result.analyses.map(item => item.market.key), ['zip', 'city', 'radius_1', 'radius_2', 'exploration']);
  assert.deepEqual(queries.map(query => query.values[7]), ['zip', 'city', 'radius', 'radius', 'exploration']);
  assert.ok(queries.every(query => query.values[0] === '2026-09-30' && query.values[1] === 12));
  assert.deepEqual(queries.at(-1).values[10], accounts);
});

test("spatial support is a shared migration-and-index readiness probe, never request-path maintenance", async () => {
  const statements = [];
  const parameters = [];
  const pool = {
    query: async (sql, values) => {
      statements.push(String(sql));
      parameters.push(values);
      return {
        rows: [{
          column_present: true,
          migration_applied: true,
          index_valid: true,
        }],
      };
    },
  };

  await Promise.all([
    ensureSpatialSupport(pool),
    ensureSpatialSupport(pool),
  ]);
  await ensureSpatialSupport(pool);
  assert.equal(statements.length, 1);
  assert.deepEqual(parameters, [[MARKET_SPATIAL_MIGRATION_NAME]]);
  assert.match(statements[0], /market_spatial_support_probe/);
  assert.match(statements[0], /pg_catalog\.pg_attribute/);
  assert.match(statements[0], /app\.schema_migrations/);
  assert.match(statements[0], /pg_catalog\.pg_index/);
  assert.match(statements[0], /index_state\.indisvalid/);
  assert.doesNotMatch(statements[0], /FROM core\.account_locations/);
  assert.doesNotMatch(statements[0], /::regclass/);
  assert.doesNotMatch(
    statements[0],
    /\b(?:CREATE|ALTER|UPDATE|INSERT|DELETE|DROP|TRIGGER)\b/i,
  );
});

test("spatial support fails closed until the migration and index are complete, then retries", async () => {
  let ready = false;
  let calls = 0;
  const pool = {
    async query() {
      calls += 1;
      return {
        rows: [{
          column_present: ready,
          migration_applied: ready,
          index_valid: ready,
        }],
      };
    },
  };

  await assert.rejects(
    () => ensureSpatialSupport(pool),
    /market_spatial_support_not_ready/,
  );
  ready = true;
  await ensureSpatialSupport(pool);
  await ensureSpatialSupport(pool);
  assert.equal(calls, 2);
  assert.equal(marketConditionsErrorStatus("market_spatial_support_not_ready"), 503);
});

test("spatial catalog failures are bounded as retryable unavailability and are not cached", async () => {
  const diagnostic = new Error("relation core.account_locations does not exist");
  let calls = 0;
  const pool = {
    async query() {
      calls += 1;
      if (calls === 1) throw diagnostic;
      return {
        rows: [{ column_present: true, migration_applied: true, index_valid: true }],
      };
    },
  };

  await assert.rejects(
    () => ensureSpatialSupport(pool),
    (error) => error.message === "market_spatial_support_not_ready" && error.cause === diagnostic,
  );
  await ensureSpatialSupport(pool);
  assert.equal(calls, 2);
});

test("market context can use an environment-scoped account-id policy", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      if (/market_spatial_support_probe/.test(String(sql))) {
        return {
          rows: [{
            column_present: true,
            migration_applied: true,
            index_valid: true,
          }],
        };
      }
      if (/SELECT\s+account\.account_id/.test(String(sql))) {
        return {
          rows: [{
            account_id: "UAD-REDTEAM-SFR-0001",
            address: "300 Red Team Test Dr",
            city: "Garland",
            county: "Dallas",
            postal_code: "75044",
            neighborhood_code: "RT-001",
            latitude: 32.95,
            longitude: -96.65,
            location_status: "matched",
            location_source: "redteam_fixture",
          }],
        };
      }
      return { rows: [] };
    },
  };
  const subject = await getMarketContext(pool, "UAD-REDTEAM-SFR-0001", {
    accountIdAllowed: (value) => value === "UAD-REDTEAM-SFR-0001",
  });
  assert.equal(subject.account_id, "UAD-REDTEAM-SFR-0001");
  assert.equal(subject.location_status, "matched");
  assert.ok(statements.some((statement) => /location_geom/.test(statement)));
});

test("location-refresh failures preserve market context without logging private diagnostics", async () => {
  const privateDetail = "postgresql://private-user:private-password@database.example/private-db";
  const pool = {
    async query(sql) {
      if (String(sql).includes("market_spatial_support_probe")) {
        return { rows: [{ column_present: true, migration_applied: true, index_valid: true }] };
      }
      if (/SELECT\s+account\.account_id/.test(String(sql))) {
        return { rows: [{
          account_id: "UAD-REDTEAM-SFR-0001",
          county: "Dallas",
          location_status: "unmatched",
          latitude: null,
          longitude: null,
        }] };
      }
      throw Object.assign(new Error(privateDetail), { code: "42P01" });
    },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const subject = await getMarketContext(pool, "UAD-REDTEAM-SFR-0001", {
      accountIdAllowed: (value) => value === "UAD-REDTEAM-SFR-0001",
    });
    assert.equal(subject.account_id, "UAD-REDTEAM-SFR-0001");
    assert.equal(subject.location_status, "unmatched");
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [["[market-conditions] subject location refresh failed", "42P01"]]);
  assert.doesNotMatch(JSON.stringify(warnings), /private-password/);
});

test("market studies use the requested number of complete calendar months", () => {
  assert.deepEqual(completeCalendarMonthWindow("2026-08-03", 24), {
    analysisAsOf: "2026-08-03",
    start: "2024-08-01",
    end: "2026-07-31",
    periodMonths: 24,
    partialMonthExcluded: true,
  });
  assert.deepEqual(completeCalendarMonthWindow("2026-07-31", 12), {
    analysisAsOf: "2026-07-31",
    start: "2025-08-01",
    end: "2026-07-31",
    periodMonths: 12,
    partialMonthExcluded: false,
  });
});

test("partial first-month dates and invalid calendar dates are handled", () => {
  const window = completeCalendarMonthWindow("2026-07-30", 24);
  assert.equal(window.start, "2024-07-01");
  assert.equal(window.end, "2026-06-30");
  assert.throws(
    () => completeCalendarMonthWindow("2026-02-30", 24),
    /invalid_as_of/,
  );
});

test("market areas preserve the requested independent scopes", () => {
  const areas = parseMarketAreaKeys([
    "city",
    "zip",
    "radius_1",
    "radius_5",
    "custom",
    "city",
  ]);
  assert.deepEqual(
    areas.map((area) => area.key),
    ["city", "zip", "radius_1", "radius_5", "custom"],
  );
});

test("market area selection rejects work beyond the supported scope count", () => {
  assert.throws(
    () => parseMarketAreaKeys(Array(MARKET_AREA_KEYS.length + 1).fill("city")),
    /market_area_limit_exceeded/,
  );
  assert.throws(
    () => parseMarketAreaKeys(`city,${",".repeat(MARKET_AREA_KEYS.length)}`),
    /market_area_limit_exceeded/,
  );
  assert.throws(
    () => parseMarketAreaKeys(`city,${",".repeat(1_000_000)}`),
    /market_area_limit_exceeded/,
  );
});

test("a single trailing comma does not reject the complete supported area selection", () => {
  assert.deepEqual(
    parseMarketAreaKeys(`${MARKET_AREA_KEYS.join(",")},`).map((area) => area.key),
    MARKET_AREA_KEYS,
  );
});

test("equivalent market analysis inputs share one canonical representation", () => {
  assert.deepEqual(
    normalizeMarketAnalysisRequest({
      subjectAccountId: " A-1 ",
      areaKeys: " city, radius_3 ",
      periodMonths: "24",
    }),
    normalizeMarketAnalysisRequest({
      subjectAccountId: "A-1",
      areaKeys: ["city", "radius_3"],
      periodMonths: 24,
    }),
  );
});

test("a valid closed DFW polygon is normalized", () => {
  const geometry = validateCustomMarketGeometry({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-96.67, 32.9],
          [-96.65, 32.9],
          [-96.65, 32.92],
          [-96.67, 32.9],
        ],
      ],
    },
  });
  assert.equal(geometry.type, "Polygon");
  assert.equal(geometry.coordinates[0].length, 4);
});

test("custom polygons must be closed and remain in the DFW guardrail", () => {
  assert.throws(
    () =>
      validateCustomMarketGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-96.67, 32.9],
            [-96.65, 32.9],
            [-96.65, 32.92],
            [-96.66, 32.91],
          ],
        ],
      }),
    /custom_area_ring_not_closed/,
  );

  assert.throws(
    () =>
      validateCustomMarketGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-101, 32.9],
            [-96.65, 32.9],
            [-96.65, 32.92],
            [-101, 32.9],
          ],
        ],
      }),
    /custom_area_outside_dfw_bounds/,
  );
});

test("market context can be overridden without changing subject identity", () => {
  const subject = {
    account_id: "005530000001A0000",
    address: "10010 STRAIT LN, DALLAS",
    city: "DALLAS",
    county: "DALLAS COUNTY",
    postal_code: null,
    latitude: 32.88,
    longitude: -96.82,
    location_status: "matched",
    location_source: "dcad_parcel_query",
    location_precision: "parcel_centroid",
    location_confidence: "high",
    location_review_required: false,
    location_review_reason: null,
  };
  const result = applyMarketContextOverride(subject, {
    source: "dcad_related_parcel",
    source_account_id: "00000416188000000",
    postal_code: "75229-1234",
    latitude: 32.881,
    longitude: -96.823,
    review_note: "Related land parcel selected as the study origin.",
  });
  assert.equal(result.account_id, subject.account_id);
  assert.equal(result.postal_code, "75229");
  assert.equal(result.context_override_active, true);
  assert.equal(result.context_source_account_id, "00000416188000000");
  assert.equal(result.location_source, "dcad_related_parcel_override");
  assert.equal(result.location_review_required, true);
  assert.deepEqual(result.context_overridden_fields, [
    "postal_code",
    "coordinates",
    "source_account_id",
  ]);
});

test("market context override coordinates must be complete and inside DFW", () => {
  const subject = { account_id: "005530000001A0000" };
  assert.throws(
    () => applyMarketContextOverride(subject, { latitude: 32.88 }),
    /market_context_coordinates_incomplete/,
  );
  assert.throws(
    () =>
      applyMarketContextOverride(subject, {
        latitude: 40,
        longitude: -96.8,
      }),
    /market_context_coordinates_outside_dfw/,
  );
});

test("market congruency prioritizes living area, age, and housing type", () => {
  const factors = {
    living_area: { count: 50, cod: 20, cv: 20 },
    price_per_square_foot: { count: 50, cod: 30, cv: 30 },
    sale_price: { count: 50, cod: 40, cv: 40 },
    age: { count: 50, cod: 50, cv: 50 },
    housing_type: { count: 50, dispersion: 10 },
  };
  assert.deepEqual(weightedCompositeDispersion(factors, "cod"), {
    value: 28.5,
    available_weight: 1,
  });
  assert.deepEqual(weightedCompositeDispersion(factors, "cv"), {
    value: 28.5,
    available_weight: 1,
  });
});

test("missing congruency factors are omitted and remaining weights renormalize", () => {
  const factors = {
    living_area: { count: 50, cod: 20 },
    price_per_square_foot: { count: 0, cod: null },
    sale_price: { count: 50, cod: 40 },
    age: { count: 50, cod: 50 },
    housing_type: { count: 0, dispersion: null },
  };
  assert.deepEqual(weightedCompositeDispersion(factors, "cod"), {
    value: 33.33,
    available_weight: 0.75,
  });
});

test("market statistics annualize first-to-last complete monthly medians", () => {
  const statistics = calculateMarketStudyStatistics({
    monthlySeries: [
      { period_start: "2024-01-01", median_sale_price: 100 },
      { period_start: "2025-01-01", median_sale_price: 110 },
      { period_start: "2026-01-01", median_sale_price: 121 },
    ],
    eligibleSaleCount: 75,
    periodMonths: 25,
    congruencyFactors: {
      living_area: { count: 75, cod: 10, cv: 12 },
      price_per_square_foot: { count: 75, cod: 15, cv: 18 },
      sale_price: { count: 75, cod: 20, cv: 24 },
      age: { count: 75, cod: 25, cv: 30 },
      housing_type: { count: 75, dispersion: 8 },
    },
  });
  assert.equal(statistics.annualized_change_percent, 10);
  assert.equal(statistics.composite_cod, 14.85);
  assert.equal(statistics.composite_cv, 17.5);
  assert.equal(statistics.reliability_score, 86.1);
  assert.equal(statistics.sample_sufficient, true);
});

const consistencyStudy = (key, cod, cv, saleCount, monthlyCount = 12, periodMonths = 12) => ({
  market: { key, label: key },
  population: { eligible_sale_count: saleCount },
  statistics: calculateMarketStudyStatistics({
    monthlySeries: Array.from({ length: monthlyCount }, (_, index) => ({
      period_start: `2025-${String(index + 1).padStart(2, '0')}-01`, median_sale_price: 100 + index,
    })),
    eligibleSaleCount: saleCount, periodMonths,
    congruencyFactors: { living_area: { count: saleCount, cod, cv } },
  }),
});

test('COD/CV consistency outranks larger but more varied study populations', () => {
  const studies = [
    consistencyStudy('radius_1', 21, 27, 250),
    consistencyStudy('radius_2', 24, 30, 1000),
    consistencyStudy('zip', 18, 24, 400),
    consistencyStudy('exploration', 10, 14, 80),
  ];
  const before = JSON.stringify(studies);
  const result = buildMarketTrendRecommendation(studies);
  assert.equal(result.methodology_version, 3);
  assert.deepEqual(result.ranked_studies.map(study => study.key), ['exploration', 'zip', 'radius_1', 'radius_2']);
  assert.deepEqual(result.ranked_studies.map(study => study.reliability_score), [89.3, 82.6, 80.6, 78.7]);
  assert.equal(JSON.stringify(studies), before, 'Ranking does not rewrite evidence');
});

test('sales count and monthly coverage are independent of the consistency score', () => {
  const small = consistencyStudy('small', 10, 14, 20, 2, 36);
  const large = consistencyStudy('large', 10, 14, 1000);
  assert.equal(small.statistics.reliability_score, large.statistics.reliability_score);
  assert.equal(small.statistics.sample_sufficient, false);
  assert.equal(large.statistics.sample_sufficient, true);
  assert.equal(small.statistics.monthly_observation_count, 2);
  assert.equal(large.statistics.monthly_observation_count, 12);
  assert.equal(small.statistics.characteristic_weight_available, 0.4);
  assert.deepEqual(buildMarketTrendRecommendation([
    large, consistencyStudy('tighter', 5, 8, 20, 2),
  ]).ranked_studies.map(study => study.key), ['tighter', 'large']);
});

test('lower dispersion consistently raises the score, including rounded-score ties', () => {
  const tight = consistencyStudy('tight', 10, 14, 50);
  for (const [cod, cv] of [[10.01, 14], [10, 14.01], [100, 140], [1000, 1400]]) {
    const broader = consistencyStudy('broader', cod, cv, 1000);
    assert.ok(tight.statistics.reliability_score >= broader.statistics.reliability_score);
    assert.deepEqual(buildMarketTrendRecommendation([broader, tight]).ranked_studies.map(study => study.key), ['tight', 'broader']);
  }
  assert.equal(consistencyStudy('uniform', 0, 0, 50).statistics.reliability_score, 100);
});

test('unavailable or invalid COD/CV cannot create a perfect score', () => {
  for (const [cod, cv] of [[null, null], [10, null], [null, 14], [Infinity, 14], [10, NaN], [-1, 14], [10, -1]]) {
    const unavailable = consistencyStudy('unavailable', cod, cv, 1000);
    assert.equal(unavailable.statistics.reliability_score, null);
    assert.equal(unavailable.statistics.sample_sufficient, true, 'Sample warning remains independent');
    assert.equal(buildMarketTrendRecommendation([
      unavailable, consistencyStudy('known', 100, 140, 50),
    ]).ranked_studies[0].key, 'known');
  }
  assert.equal(consistencyStudy('empty', 0, 0, 0).statistics.reliability_score, null);
});

test("market recommendation combines mean and median and applies one-percent threshold", () => {
  const analysis = (key, change, score, saleCount = 100) => ({
    market: { key, label: key.toUpperCase() },
    population: { eligible_sale_count: saleCount },
    statistics: {
      annualized_change_percent: change,
      reliability_score: score,
      sample_sufficient: saleCount >= 30,
      composite_cod: 10,
      composite_cv: 12,
    },
  });
  const increasing = buildMarketTrendRecommendation([
    analysis("city", 2, 80),
    analysis("zip", 4, 90),
    analysis("radius_1", 6, 85),
  ]);
  assert.equal(increasing.average_annualized_change_percent, 4);
  assert.equal(increasing.median_annualized_change_percent, 4);
  assert.equal(increasing.recommended_change_percent, 4);
  assert.equal(increasing.conclusion, "increasing");
  assert.equal(increasing.ranked_studies[0].key, "zip");

  const stable = buildMarketTrendRecommendation([
    analysis("city", -0.5, 80),
    analysis("zip", 0.8, 90),
  ]);
  assert.equal(stable.conclusion, "stable");

  const decreasing = buildMarketTrendRecommendation([
    analysis("city", -3, 80),
    analysis("zip", -2, 90),
  ]);
  assert.equal(decreasing.conclusion, "decreasing");
});

test("appraiser-defined area receives sixty percent of market reconciliation", () => {
  const analysis = (key, change, score) => ({
    market: { key, label: key.toUpperCase() },
    population: { eligible_sale_count: 100 },
    statistics: {
      annualized_change_percent: change,
      reliability_score: score,
      sample_sufficient: true,
      composite_cod: 10,
      composite_cv: 12,
    },
  });
  const result = buildMarketTrendRecommendation([
    analysis("custom", 10, 50),
    analysis("city", 0, 75),
    analysis("zip", 0, 25),
  ]);
  assert.equal(result.weighting_method, "appraiser_defined_area_60_percent");
  assert.equal(result.recommended_change_percent, 6);
  assert.equal(
    result.ranked_studies.find((study) => study.key === "custom")
      .reconciliation_weight_percent,
    60,
  );
  assert.equal(
    result.ranked_studies.find((study) => study.key === "city")
      .reconciliation_weight_percent,
    30,
  );
  assert.equal(
    result.ranked_studies.find((study) => study.key === "zip")
      .reconciliation_weight_percent,
    10,
  );
});
