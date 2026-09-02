import express from "express";

import { parseClassFilter } from "../../util/parseClasses.js";

function requireQueryClient(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("property_catalog_query_client_required");
  }
  return pool;
}

export function buildPropertyClassWhere({ classes, county, neighborhoods } = {}) {
  const { exact, lows, highs, labels } = parseClassFilter(String(classes || ""));
  const counties = String(county || "").split(",").map((value) => value.trim()).filter(Boolean);
  const neighborhoodCodes = String(neighborhoods || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const where = [];
  const params = [];
  const classParts = [];

  if (exact.length || lows.length || highs.length) {
    classParts.push(
      `matches_classes_lohi(c.building_class_int, $${params.push(exact)}::int[], $${params.push(lows)}::int[], $${params.push(highs)}::int[])`,
    );
  }
  if (labels.length) {
    classParts.push(
      `UPPER(c.building_class) = ANY($${params.push(labels.map((label) => label.toUpperCase()))}::text[])`,
    );
  }
  if (classParts.length) where.push(`(${classParts.join(" OR ")})`);
  if (counties.length) where.push(`p.county = ANY($${params.push(counties)}::text[])`);
  if (neighborhoodCodes.length) {
    where.push(`p.neighborhood_code = ANY($${params.push(neighborhoodCodes)}::text[])`);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function createPropertyCatalogRouter({ pool, logger = console } = {}) {
  const queryClient = requireQueryClient(pool);
  const router = express.Router();

  router.get("/api/properties/search", async (req, res) => {
    try {
      const { classes = "", limit = "100", county = "", neighborhoods = "" } = req.query;
      const boundedLimit = Math.min(parseInt(limit, 10) || 100, 1000);
      const { whereSql, params } = buildPropertyClassWhere({ classes, county, neighborhoods });
      const sql = `
        SELECT p.account_id, p.county, p.situs_address,
               c.building_class, c.building_class_int
        FROM properties p
        JOIN primary_building_class c USING (account_id)
        ${whereSql}
        ORDER BY p.account_id
        LIMIT $${params.push(boundedLimit)}
      `;
      const { rows } = await queryClient.query(sql, params);
      return res.json({ count: rows.length, rows });
    } catch (error) {
      logger.error?.("[property-catalog] property search failed", error);
      return res.status(500).json({ error: "query_failed" });
    }
  });

  router.get("/api/stats/class-distribution", async (req, res) => {
    try {
      const { classes = "", county = "", neighborhoods = "" } = req.query;
      const { whereSql, params } = buildPropertyClassWhere({ classes, county, neighborhoods });
      const sql = `
        SELECT
          c.building_class       AS class_label,
          c.building_class_int   AS class_code_int,
          COUNT(*)::bigint       AS n
        FROM properties p
        JOIN primary_building_class c USING (account_id)
        ${whereSql}
        GROUP BY c.building_class, c.building_class_int
        ORDER BY n DESC, class_label NULLS LAST
      `;
      const { rows } = await queryClient.query(sql, params);
      return res.json({ count: rows.length, rows });
    } catch (error) {
      logger.error?.("[property-catalog] class distribution failed", error);
      return res.status(500).json({ error: "stats_failed" });
    }
  });

  return router;
}
