import { createHash } from "node:crypto";

function deterministicUuid(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const normalized = hex.join("");
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

async function seedValue(fixture, entityId, context, uid, reportFieldId, value) {
  const { namespace, observedAt, pool, sourceReference, workfileId } = fixture;
  const id = deterministicUuid(`${namespace}:value:${entityId || "root"}:${context}:${uid}`);
  await pool.query(
    `INSERT INTO appraisal.uad_field_values (
       id, workfile_id, entity_id, field_context, uad_uid, report_field_id,
       value, source_type, source_reference, source_observed_at,
       is_appraiser_confirmed, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, 'appraiser', $8, $9::timestamptz,
       true, $9::timestamptz, $9::timestamptz
     ) ON CONFLICT DO NOTHING`,
    [id, workfileId, entityId, context, uid, reportFieldId, JSON.stringify(value), sourceReference, observedAt],
  );
  await pool.query(
    `UPDATE appraisal.uad_field_values
        SET report_field_id = $5, value = $6::jsonb, source_type = 'appraiser',
            source_reference = $7, source_observed_at = $8::timestamptz,
            is_appraiser_confirmed = true, updated_at = now()
      WHERE workfile_id = $1 AND entity_id IS NOT DISTINCT FROM $2::uuid
        AND field_context = $3 AND uad_uid = $4`,
    [workfileId, entityId, context, uid, reportFieldId, JSON.stringify(value), sourceReference, observedAt],
  );
}

async function seedCompletionValues(fixture) {
  const rootValues = [
    ["assignment", "1000.0034", "2.000", "Purchase"],
    ["appraiser_inspection", "2400.0080", "2.023", "2026-08-21"],
    ["subject", "0100.0020", "3.004", "Detached"],
    ["subject", "0100.0019", "3.006", 0],
    ["subject", "0100.0033", "3.008", false],
    ["subject", "0100.0054", "3.014", false],
    ["subject", "0100.0047", "3.015", false],
    ["subject", "0300.0010", "3.017", false],
    ["subject_ownership", "0100.0024", "3.019", "FeeSimple"],
    ["subject_ownership", "0100.0034", "3.027", true],
    ["site", "1500.0093", "4.000", { amount: 8400, unit: "SquareFeet" }],
    ["site_zoning", "1500.0125", "4.008", "Legal"],
    ["site_zoning", "1500.0122", "4.009", "SF-7"],
    ["site_zoning", "1500.0123", "4.010", "Single-family residential zoning"],
    ["site_zoning", "1500.0124", "4.014", "The synthetic site is a legal conforming use."],
    ["site_mixed_use", "1500.0034", "4.017", false],
    ["site_access", "1500.0055", "4.020", "PublicStreet"],
    ["site_access", "1500.0054", "4.023", true],
    ["site", "1500.0166", "4.067", true],
    ["site", "1500.0178", "4.099", false],
    ["disaster_mitigation", "3700.0002", "5.000", ["None"]],
    ["energy_green", "2600.0005", "6.000", false],
    ["energy_green", "2600.0004", "6.004", false],
    ["energy_green", "2600.0003", "6.010", false],
    ["sketch", "3300.0002", "7.000", true],
    ["sketch", "3300.0007", "7.001", "AmericanNationalStandardsInstitute"],
    ["scope_of_work", "1000.0027", "Does Not Display", false],
    ["scope_of_work", "1000.0030", "Does Not Display", false],
    ["income_approach_exclusion", "1300.0004", "26.003", ["NotNecessaryForCredibleResults"]],
    ["cost_approach_exclusion", "1300.0002", "26.005", ["NotNecessaryForCredibleResults"]],
    ["reconciliation", "1300.0017", "26.007", 445000],
    ["reconciliation", "1300.0010", "26.009", ["AsIs"]],
    ["reconciliation", "1300.0013", "26.010", 45],
    ["reconciliation", "1300.0012", "26.011", "2026-08-21"],
    ["reconciliation", "1300.0021", "26.019", "The sales comparison approach is the most reliable indicator for this synthetic assignment. Three settled sales bracket the conclusion after market-supported condition, sale-date, site, and finished-area adjustments."],
  ];
  for (const [context, uid, reportFieldId, value] of rootValues) {
    await seedValue(fixture, null, context, uid, reportFieldId, value);
  }

  const entities = await fixture.pool.query(
    `SELECT id, entity_type FROM appraisal.uad_entities
      WHERE workfile_id = $1 ORDER BY ordinal, id`,
    [fixture.workfileId],
  );
  for (const entity of entities.rows) {
    if (entity.entity_type === "site_parcel") {
      await seedValue(fixture, entity.id, "site_parcel", "1500.0023", "4.006", "LandWithDwelling");
      await seedValue(fixture, entity.id, "site_parcel", "1500.0022", "4.007", { amount: 8400, unit: "SquareFeet" });
    }
    if (entity.entity_type === "dwelling") {
      const values = [
        ["0300.0030", "8.004", "Ranch"],
        ["0300.0117", "8.005", "GroundLevel"],
        ["0300.0012", "8.010", false],
        ["0300.0034", "8.011", "SiteBuilt"],
        ["0300.0079", "8.012", false],
        ["0300.0114", "8.046", false],
        ["0300.0088", "8.049", ["ForcedWarmAir"]],
        ["0300.0086", "8.050", ["NaturalGas"]],
        ["0300.0022", "8.051", true],
        ["0300.0084", "8.051", ["Centralized"]],
        ["0300.0116", "8.052", false],
        ["3900.0097", "8.055", false],
      ];
      for (const [uid, reportFieldId, value] of values) {
        await seedValue(fixture, entity.id, "dwelling", uid, reportFieldId, value);
      }
    }
  }
  await fixture.pool.query(
    `DELETE FROM appraisal.uad_field_values
      WHERE workfile_id = $1 AND field_context = 'sales_comparable_dwelling'
        AND uad_uid = '1800.0373'`,
    [fixture.workfileId],
  );
}

async function cloneSalesComparable(fixture, sourceComparableId, ordinal) {
  const tree = await fixture.pool.query(
    `WITH RECURSIVE comparable_tree AS (
       SELECT entity.*, 0 AS depth
         FROM appraisal.uad_entities AS entity
        WHERE entity.workfile_id = $1 AND entity.id = $2
       UNION ALL
       SELECT child.*, parent.depth + 1
         FROM appraisal.uad_entities AS child
         JOIN comparable_tree AS parent ON child.parent_entity_id = parent.id
        WHERE child.workfile_id = $1
     )
     SELECT * FROM comparable_tree ORDER BY depth, entity_type, ordinal, id`,
    [fixture.workfileId, sourceComparableId],
  );
  if (!tree.rows.length) throw new Error("synthetic_sales_comparable_source_missing");
  const entityIds = new Map(tree.rows.map((entity) => [
    entity.id,
    deterministicUuid(`${fixture.namespace}:comparable:${ordinal}:${entity.id}`),
  ]));
  for (const entity of tree.rows) {
    const id = entityIds.get(entity.id);
    const parentEntityId = entity.id === sourceComparableId ? null : entityIds.get(entity.parent_entity_id);
    const entityIdentifier = entity.id === sourceComparableId
      ? `sales-comparable-${ordinal}`
      : `${fixture.namespace.replace(/[^a-z0-9]+/gi, "-")}-comparable-${ordinal}-${entity.entity_identifier}`;
    const label = entity.id === sourceComparableId
      ? `Sales Comparable ${ordinal}`
      : `${entity.label || entity.entity_type} (Comparable ${ordinal})`;
    await fixture.pool.query(
      `INSERT INTO appraisal.uad_entities (
         id, workfile_id, parent_entity_id, entity_type, entity_identifier,
         ordinal, label, data, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $9::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         parent_entity_id = EXCLUDED.parent_entity_id,
         entity_type = EXCLUDED.entity_type,
         entity_identifier = EXCLUDED.entity_identifier,
         ordinal = EXCLUDED.ordinal,
         label = EXCLUDED.label,
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        fixture.workfileId,
        parentEntityId,
        entity.entity_type,
        entityIdentifier,
        entity.id === sourceComparableId ? ordinal : entity.ordinal,
        label,
        JSON.stringify(entity.data || {}),
        fixture.observedAt,
      ],
    );
  }
  const sourceValues = await fixture.pool.query(
    `SELECT * FROM appraisal.uad_field_values
      WHERE workfile_id = $1 AND entity_id = ANY($2::uuid[])
      ORDER BY created_at, id`,
    [fixture.workfileId, [...entityIds.keys()]],
  );
  for (const value of sourceValues.rows) {
    await seedValue(
      fixture,
      entityIds.get(value.entity_id),
      value.field_context,
      value.uad_uid,
      value.report_field_id,
      value.value,
    );
  }
  return entityIds.get(sourceComparableId);
}

async function configureComparableScenario(fixture, comparableId, scenario) {
  const rootValues = [
    ["sales_comparable", "1800.0192", "21.007", scenario.ordinal],
    ["sales_comparable_address", "1800.0001", "22.01.17", scenario.address],
    ["sales_comparable_address", "1800.0003", "22.01.17", "Garland"],
    ["sales_comparable_address", "1800.0005", "22.01.17", "TX"],
    ["sales_comparable_address", "1800.0004", "22.01.17", "75044"],
    ["sales_comparable_listing", "1800.0074", "22.01.20", scenario.listPrice],
    ["sales_comparable_listing", "1800.0075", "22.01.21", "SettledSale"],
    ["sales_comparable_sale", "1800.0272", "22.01.23", scenario.salePrice],
    ["sales_comparable_sale", "1800.0342", "22.01.32", scenario.saleDate],
    ["sales_comparable_property", "1800.0196", "22.11.05", scenario.condition],
    ["sales_comparable_summary", "1800.0312", "22.15.14", scenario.weight],
  ];
  for (const [context, uid, reportFieldId, value] of rootValues) {
    await seedValue(fixture, comparableId, context, uid, reportFieldId, value);
  }
  for (const [context, reportFieldId, amount] of scenario.adjustments) {
    await seedValue(fixture, comparableId, context, "1800.0317", reportFieldId, amount);
  }
  const related = await fixture.pool.query(
    `WITH RECURSIVE comparable_tree AS (
       SELECT id, parent_entity_id, entity_type, ordinal
         FROM appraisal.uad_entities WHERE id = $1 AND workfile_id = $2
       UNION ALL
       SELECT child.id, child.parent_entity_id, child.entity_type, child.ordinal
         FROM appraisal.uad_entities AS child
         JOIN comparable_tree AS parent ON child.parent_entity_id = parent.id
        WHERE child.workfile_id = $2
     )
     SELECT entity.id, entity.entity_type, entity.ordinal,
            adu.value #>> '{}' AS adu_indicator
       FROM comparable_tree AS entity
       LEFT JOIN appraisal.uad_field_values AS adu
         ON adu.workfile_id = $2 AND adu.entity_id = entity.id
        AND adu.field_context = 'sales_comparable_unit' AND adu.uad_uid = '1800.0287'
      WHERE entity.entity_type IN ('sales_comparable_dwelling', 'sales_comparable_unit')
      ORDER BY entity.entity_type, entity.ordinal`,
    [comparableId, fixture.workfileId],
  );
  for (const entity of related.rows) {
    if (entity.entity_type === "sales_comparable_dwelling") {
      await seedValue(fixture, entity.id, "sales_comparable_dwelling", "1800.0185", "22.08.23", scenario.condition);
    }
    if (entity.entity_type === "sales_comparable_unit") {
      await seedValue(fixture, entity.id, "sales_comparable_unit", "1800.0157", "22.09.25", scenario.condition);
      if (entity.adu_indicator === "false") {
        await seedValue(fixture, entity.id, "sales_comparable_unit", "1800.0390", "22.07.30", {
          amount: scenario.finishedArea,
          unit: "SquareFeet",
        });
      }
    }
  }
}

async function seedSalesComparables(fixture) {
  const source = await fixture.pool.query(
    `SELECT id FROM appraisal.uad_entities
      WHERE workfile_id = $1 AND entity_type = 'sales_comparable'
      ORDER BY ordinal, id LIMIT 1`,
    [fixture.workfileId],
  );
  if (!source.rows.length) throw new Error("synthetic_sales_comparable_missing");
  const sourceId = source.rows[0].id;
  const secondId = await cloneSalesComparable(fixture, sourceId, 2);
  const thirdId = await cloneSalesComparable(fixture, sourceId, 3);
  const scenarios = [
    {
      id: sourceId, ordinal: 1, address: "1250 Forest Lane", listPrice: 449000,
      salePrice: 442500, saleDate: "2026-06-25", condition: "C4", finishedArea: 2050,
      weight: "Most",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", "22.11.06", 7500],
        ["sales_comparable_adjustment_sale_date", "22.01.33", -2500],
      ],
    },
    {
      id: secondId, ordinal: 2, address: "1275 Forest Lane", listPrice: 435000,
      salePrice: 430000, saleDate: "2026-05-28", condition: "C4", finishedArea: 1950,
      weight: "Less",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", "22.11.06", 15000],
        ["sales_comparable_adjustment_standard_above", "22.07.31", 5000],
        ["sales_comparable_adjustment_sale_date", "22.01.33", -2500],
      ],
    },
    {
      id: thirdId, ordinal: 3, address: "1310 Forest Lane", listPrice: 461000,
      salePrice: 455000, saleDate: "2026-04-16", condition: "C2", finishedArea: 2200,
      weight: "Less",
      adjustments: [
        ["sales_comparable_adjustment_overall_condition", "22.11.06", -10000],
        ["sales_comparable_adjustment_standard_above", "22.07.31", -5000],
        ["sales_comparable_adjustment_sale_date", "22.01.33", -5000],
      ],
    },
  ];
  for (const scenario of scenarios) await configureComparableScenario(fixture, scenario.id, scenario);
  return scenarios.length;
}

export async function seedSalesRichUadDatabaseFixture(pool, workfileId, {
  namespace = "synthetic-uad-delivery",
  observedAt = "2026-08-21T12:00:00.000Z",
  sourceReference = "synthetic_successful_delivery",
} = {}) {
  const fixture = { namespace, observedAt, pool, sourceReference, workfileId };
  await pool.query(
    `UPDATE appraisal.uad_field_values
        SET source_type = 'appraiser', source_reference = $2,
            source_observed_at = COALESCE(source_observed_at, $3::timestamptz),
            is_appraiser_confirmed = true, updated_at = now()
      WHERE workfile_id = $1`,
    [workfileId, sourceReference, observedAt],
  );
  await seedCompletionValues(fixture);
  const comparableCount = await seedSalesComparables(fixture);
  return { comparable_count: comparableCount, source_reference: sourceReference };
}
