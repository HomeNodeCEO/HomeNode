import { readBoundedJsonResponse } from "../util/boundedResponse.js";

const DEFAULT_SCRAPER_STATUS_URL =
  "https://dcad-scraper-with-api.onrender.com/scrape/status";
const MAX_SCRAPER_STATUS_RESPONSE_BYTES = 1024 * 1024;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(number(value) * scale) / scale;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function scraperStatusUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("dcad_scraper_status_url_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("dcad_scraper_status_url_invalid");
  }
  return parsed.toString();
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already rejected; cancellation is best-effort cleanup.
  }
}

function normalizedScraperStatusError(error) {
  const code = String(error?.message || "");
  return /^dcad_scraper_status_(?:http_(?:[1-5]\d\d|unknown)|response_too_large|invalid_response|unavailable)$/.test(code)
    ? code
    : "dcad_scraper_status_unavailable";
}

function isoDate(value) {
  const parsed = new Date(value || 0);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function taskOutcome(task) {
  const fields = [
    "seeded",
    "batches",
    "claimed",
    "completed",
    "matched",
    "retry",
    "reviewRequired",
    "manualReview",
  ];
  return Object.fromEntries(
    fields
      .filter((field) => task?.[field] != null)
      .map((field) => [field, number(task[field])]),
  );
}

function latestTaskSnapshot(runs, taskName) {
  for (const run of runs || []) {
    const task = run?.details?.results?.[taskName];
    if (task?.status) {
      return {
        run_id: run.id,
        run_status: run.status,
        observed_at: isoDate(run.finished_at || run.started_at),
        last_run: taskOutcome(task),
        ...task.status,
      };
    }
  }
  return null;
}

function maintenanceAgeHours(runs, now) {
  const completed = (runs || []).filter((run) => run?.status === "completed");
  const latest = completed.find((run) => run?.job_name === "routine") || completed[0];
  if (!latest) return null;
  const observed = new Date(latest.finished_at || latest.started_at || 0).valueOf();
  if (!Number.isFinite(observed) || observed <= 0) return null;
  return rounded(Math.max(0, now.valueOf() - observed) / 3_600_000, 1);
}

export function summarizeMaintenanceReadiness(recentRuns, {
  now = new Date(),
  staleAfterHours = 36,
} = {}) {
  const runs = Array.isArray(recentRuns) ? recentRuns : [];
  const census = latestTaskSnapshot(runs, "census");
  const locations = latestTaskSnapshot(runs, "locations");
  const influences = latestTaskSnapshot(runs, "influences");
  const ageHours = maintenanceAgeHours(runs, now);
  const actions = [];

  if (ageHours == null || ageHours > staleAfterHours) {
    actions.push({
      code: "scheduled_maintenance_stale",
      severity: "critical",
      message: ageHours == null
        ? "No completed scheduled-maintenance run is available."
        : "The latest completed maintenance run is " + ageHours + " hours old.",
    });
  }

  const locationMissing = number(locations?.coverage?.missing_sale_account_count);
  if (locationMissing > 0) {
    actions.push({
      code: "sale_locations_pending",
      severity: "attention",
      count: locationMissing,
      message: locationMissing.toLocaleString("en-US") +
        " matched sale accounts still need coordinates.",
    });
  }

  const influenceMissing = number(influences?.coverage?.missing_sale_account_count);
  if (influenceMissing > 0 || influences?.migration?.recalculation_in_progress) {
    actions.push({
      code: "sale_influences_pending",
      severity: "attention",
      count: influenceMissing,
      message: influenceMissing.toLocaleString("en-US") +
        " matched sale accounts still need current location-influence measurements.",
    });
  }

  const unmatchedSales = number(influences?.unmatched_sales?.review_required_record_count);
  if (unmatchedSales > 0) {
    actions.push({
      code: "sales_reconciliation_pending",
      severity: "review",
      count: unmatchedSales,
      message: unmatchedSales.toLocaleString("en-US") +
        " MLS records remain in manual account reconciliation.",
    });
  }

  const censusMissingInput = number(census?.coverage?.missing_lookup_input_count);
  if (censusMissingInput > 0) {
    actions.push({
      code: "census_lookup_input_missing",
      severity: "review",
      count: censusMissingInput,
      message: censusMissingInput.toLocaleString("en-US") +
        " accounts need an address or coordinate before Census matching can run.",
    });
  }

  const recentFailures = runs
    .filter((run) => run?.status === "failed")
    .slice(0, 5)
    .map((run) => ({
      run_id: run.id,
      job_name: run.job_name,
      started_at: isoDate(run.started_at),
      error: run.error_message || "scheduled_maintenance_failed",
    }));

  return {
    status: actions.some((item) => item.severity === "critical")
      ? "degraded"
      : actions.length
        ? "attention"
        : "healthy",
    latest_completed_age_hours: ageHours,
    queues: { census, locations, influences },
    recent_failures: recentFailures,
    action_items: actions,
  };
}

export function summarizeDcadScraperStatus(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      status: "unavailable",
      progress: null,
      data_quality: null,
      action_items: [{
        code: "dcad_scraper_status_unavailable",
        severity: "critical",
        message: "The Dallas County scraper status could not be loaded; last-known data remains in use.",
      }],
    };
  }

  const initialTotal = number(payload.initial_missing_count);
  const initialCompleted = number(payload.initial_completed);
  const initialRemaining = number(payload.initial_remaining);
  const quality = payload.data_quality || {};
  const circuitState = String(payload.outage_circuit_state || "unknown");
  const actions = [];

  if (circuitState !== "closed") {
    actions.push({
      code: "dcad_upstream_paused",
      severity: "critical",
      message: "The DCAD outage circuit is " + circuitState +
        "; the scraper is preserving its last successful data while paused.",
    });
  }
  if (initialRemaining > 0) {
    actions.push({
      code: "dcad_initial_scrape_pending",
      severity: "attention",
      count: initialRemaining,
      message: initialRemaining.toLocaleString("en-US") +
        " initially missing Dallas County targets remain.",
    });
  }

  const pendingFields = [
    ["field_repair_pending", "dcad_field_repair_pending", "field-completeness repairs"],
    ["owner_recovery_pending", "dcad_owner_recovery_pending", "owner-name repairs"],
    ["market_value_pending", "dcad_market_value_pending", "market-value rechecks"],
    ["recovery_pending", "dcad_account_recovery_pending", "legacy-account reconciliations"],
  ];
  for (const [key, code, label] of pendingFields) {
    const count = number(quality[key]);
    if (!count) continue;
    actions.push({
      code,
      severity: "attention",
      count,
      message: count.toLocaleString("en-US") + " " + label + " remain queued.",
    });
  }
  const reviewCount = number(quality.needs_review);
  if (reviewCount) {
    actions.push({
      code: "dcad_manual_review_pending",
      severity: "review",
      count: reviewCount,
      message: reviewCount.toLocaleString("en-US") +
        " legacy DCAD accounts require manual review.",
    });
  }

  return {
    status: actions.some((item) => item.severity === "critical")
      ? "degraded"
      : actions.length
        ? "attention"
        : "healthy",
    campaign_key: payload.campaign_key || null,
    phase: payload.phase || null,
    cycle_number: number(payload.cycle_number),
    outage_circuit_state: circuitState,
    progress: {
      initial_total: initialTotal,
      initial_completed: initialCompleted,
      initial_remaining: initialRemaining,
      initial_percent: initialTotal
        ? rounded((initialCompleted / initialTotal) * 100)
        : 100,
      full_cycle_completed: number(payload.cycle_completed),
      full_cycle_remaining: number(payload.cycle_remaining),
    },
    data_quality: quality,
    action_items: actions,
  };
}

export function createCachedScraperStatusLoader({
  url = process.env.DCAD_SCRAPER_STATUS_URL || DEFAULT_SCRAPER_STATUS_URL,
  fetchImpl = fetch,
  ttlMs = Number(process.env.DCAD_SCRAPER_STATUS_CACHE_MS || 300_000),
  timeoutMs = Number(process.env.DCAD_SCRAPER_STATUS_TIMEOUT_MS || 5_000),
  now = () => Date.now(),
} = {}) {
  const statusUrl = scraperStatusUrl(url);
  const cacheTtlMs = boundedInteger(ttlMs, 300_000, 1_000, 3_600_000);
  const requestTimeoutMs = boundedInteger(timeoutMs, 5_000, 250, 60_000);
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  function currentTime() {
    const value = Number(now());
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("dcad_scraper_status_unavailable");
    }
    return value;
  }

  async function refresh() {
    const signal = AbortSignal.timeout(requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(statusUrl, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal,
      });
    } catch {
      throw new Error("dcad_scraper_status_unavailable");
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      const status = Number.isInteger(response?.status)
        && response.status >= 100
        && response.status <= 599
        ? response.status
        : "unknown";
      throw new Error(`dcad_scraper_status_http_${status}`);
    }
    let value;
    try {
      value = await readBoundedJsonResponse(response, {
        maximumBytes: MAX_SCRAPER_STATUS_RESPONSE_BYTES,
        tooLargeCode: "dcad_scraper_status_response_too_large",
        unavailableCode: "dcad_scraper_status_response_unavailable",
      });
    } catch (error) {
      const code = String(error?.message || "");
      if (code === "dcad_scraper_status_response_too_large") throw error;
      if (signal.aborted) throw new Error("dcad_scraper_status_unavailable");
      throw new Error("dcad_scraper_status_invalid_response");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("dcad_scraper_status_invalid_response");
    }
    const observedAt = currentTime();
    cached = value;
    cachedAt = observedAt;
    return {
      source_url: statusUrl,
      fetched_at: new Date(cachedAt).toISOString(),
      stale: false,
      payload: value,
      error: null,
    };
  }

  return async function loadScraperStatus() {
    try {
      const age = currentTime() - cachedAt;
      if (cached && age >= 0 && age < cacheTtlMs) {
        return {
          source_url: statusUrl,
          fetched_at: new Date(cachedAt).toISOString(),
          stale: false,
          payload: cached,
          error: null,
        };
      }
      if (!pending) {
        pending = refresh().finally(() => { pending = null; });
      }
      return await pending;
    } catch (error) {
      return {
        source_url: statusUrl,
        fetched_at: cachedAt ? new Date(cachedAt).toISOString() : null,
        stale: Boolean(cached),
        payload: cached,
        error: normalizedScraperStatusError(error),
      };
    }
  };
}

export const operationalReadinessInternals = Object.freeze({
  MAX_SCRAPER_STATUS_RESPONSE_BYTES,
});

export function buildDataRepairReadiness({
  recentMaintenance = [],
  scraper = null,
  requestPerformance = null,
  now = new Date(),
} = {}) {
  const maintenance = summarizeMaintenanceReadiness(recentMaintenance, { now });
  const scraperSummary = summarizeDcadScraperStatus(scraper?.payload);
  const actionItems = [
    ...scraperSummary.action_items,
    ...maintenance.action_items,
  ];
  const status = actionItems.some((item) => item.severity === "critical")
    ? "degraded"
    : actionItems.length
      ? "attention"
      : "healthy";

  return {
    ok: status !== "degraded",
    generated_at: now.toISOString(),
    status,
    request_performance: requestPerformance,
    maintenance,
    dcad_scraper: {
      source_url: scraper?.source_url || null,
      fetched_at: scraper?.fetched_at || null,
      stale: Boolean(scraper?.stale),
      fetch_error: scraper?.error || null,
      ...scraperSummary,
    },
    action_items: actionItems,
  };
}
