import express from "express";

function pickMarketValueKey(row) {
  const keys = Object.keys(row || {});
  const lowerCase = (value) => String(value || "").toLowerCase();
  const score = (key) => {
    const value = lowerCase(key);
    let result = 0;
    if (value.includes("market") || value.includes("mkt")) result += 3;
    if (value.includes("total") || value.includes("tot")) result += 2;
    if (value.includes("value") || value.includes("val")) result += 2;
    if (["market_value", "total_market", "total_value"].includes(value)) result += 5;
    return result;
  };
  const candidates = keys
    .filter((key) => key !== "tax_year" && key !== "account_id")
    .sort((left, right) => score(right) - score(left));
  return candidates[0];
}

function mapMarketValues(rows) {
  const key = pickMarketValueKey(rows[0]);
  if (!key) return rows.map((row) => ({ tax_year: row.tax_year, market_value: null }));
  return rows.map((row) => ({ tax_year: row.tax_year, market_value: row[key] }));
}

export function createMarketValueHistoryRouter({
  pool,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("market_value_history_pool_required");
  }

  const router = express.Router();

  /** Return market value history rows ordered by tax year descending. */
  router.get("/api/accounts/:id/market_value_history", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing_id" });
    try {
      try {
        const { rows } = await pool.query(
          `SELECT * FROM core.market_value_history WHERE account_id = $1 ORDER BY tax_year DESC`,
          [id],
        );
        if (rows && rows.length) return res.json(mapMarketValues(rows));
        return res.json([]);
      } catch (error) {
        if (error && error.code !== "42P01") throw error;
        const { rows } = await pool.query(
          `SELECT * FROM core.market_values WHERE account_id = $1 ORDER BY tax_year DESC`,
          [id],
        );
        if (rows && rows.length) return res.json(mapMarketValues(rows));
        return res.json([]);
      }
    } catch (error) {
      logger.error?.(error);
      return res.status(500).json({ error: error?.message || "history_failed" });
    }
  });

  return router;
}
