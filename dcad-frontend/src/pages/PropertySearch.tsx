// src/pages/PropertySearch.tsx (resilient to different api.ts versions)
import { useEffect, useRef, useState } from "react";
import * as api from "@/lib/api"; // we'll safely probe for functions at runtime
import SalesReconciliationQueue from "@/components/SalesReconciliationQueue";
import ReportTypeChooser, {
  type ReportTypeChooserSubject,
} from "@/components/ReportTypeChooser";

// MOOLAH_ADD_MV_TYPE_AND_FMT
type ApiSearchRow = {
  account_id: string;
  address?: string | null; // <- NEW: many endpoints return 'address' (core.accounts.address)
  street_name?: string | null;
  city?: string | null;
  postal_code?: string | null;
  search_match?: "exact_account" | "exact_address" | "address_prefix" | "same_street" | "city_prefix" | null;
  owner: string | null;
  situs_address: string | null;
  latest_market_value?: number | string | null; // <- allow MV from backend if present
  data_quality_status?: string | null;
  data_quality_flags?: string[] | null;
  canonical_account_id?: string | null;
  requested_account_id?: string | null;
  resolved_from_legacy?: boolean;
};

type SearchItem = {
  id: string;
  title: string;
  subtitle?: string;
  raw?: ApiSearchRow;
};

// simple USD formatter for MV display
const fmtUSD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Normalize any search response into rows */
function normalizeRows(input: unknown): ApiSearchRow[] {
  if (Array.isArray(input)) return input as ApiSearchRow[];
  if (input && typeof input === "object") {
    const obj = input as any;
    if (Array.isArray(obj.results)) return obj.results as ApiSearchRow[];
    if (Array.isArray(obj.rows)) return obj.rows as ApiSearchRow[];
  }
  return [];
}

/** Map rows to UI items (fallback if api.toSearchItems isn't available) */
function localToItems(input: unknown): SearchItem[] {
  const rows = normalizeRows(input);
  return rows.map((r) => {
    // Prefer canonical 'address' if backend returns it; fallback to 'situs_address', then owner/id
    const addr = (r as any).address ?? r.situs_address ?? null;
    const title = api.formatSearchTileAddress(addr, r.city);
    const subtitle = r.owner ? `${r.owner} · ${r.account_id}` : r.account_id;
    return {
      id: r.account_id,
      title,
      subtitle,
      raw: r,
    };
  });
}

/** Unified DB-backed search with graceful fallbacks */
async function requestItems(query: string, city: string, limit = 25): Promise<SearchItem[]> {
  const cityFilter = city.trim();
  if (cityFilter) {
    const url = api.makeUrl('/api/search', {
      q: query.trim() || undefined,
      city: cityFilter,
      limit,
    });
    const data = await api.fetchJSON<unknown>(url);
    if (typeof (api as any).toSearchItems === "function") {
      return (api as any).toSearchItems(data);
    }
    return localToItems(data);
  }

  // Use the current typed API helper. Older dynamic helper probes caused
  // Rollup to request exports that no longer exist and could leave search
  // unavailable at runtime after an otherwise successful production build.
  try {
    const rows = await api.apiSearch(query, limit);
    return api.toSearchItems(rows);
  } catch (e) {
    console.error("[requestItems] helper call failed:", e);
    // An exact Dallas account remains directly navigable during a transient
    // search outage. Do not immediately repeat the same failed API call: that
    // amplified rate-limit incidents and delayed recovery on the home screen.
    if (/^\d{17}$/.test(query)) {
      return [{ id: query, title: query, subtitle: query }];
    }
    throw e;
  }
}

export default function PropertySearchPage() {
  const [q, setQ] = useState("");
  const [city, setCity] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedReportSubject, setSelectedReportSubject] = useState<ReportTypeChooserSubject | null>(null);
  const searchRequestRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);


  function normalizeAddress(s: string): string {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // strip punctuation
      .replace(/\s+/g, ' ') // collapse spaces
      .trim();
  }

  // Fetch results only (no navigation); returns fetched items
  async function runSearch(query = q.trim(), cityQuery = city.trim()): Promise<SearchItem[]> {
    const requestId = ++searchRequestRef.current;
    if (!query && !cityQuery) {
      setResults([]);
      setErr(null);
      setLoading(false);
      return [];
    }
    setLoading(true);
    setErr(null);
    let items: SearchItem[] = [];
    try {
      items = await requestItems(query, cityQuery, 50);
      if (requestId === searchRequestRef.current) {
        setResults(items);
        if (!items || items.length === 0) {
          setErr('No results found');
        }
      }
    } catch (e: any) {
      if (requestId === searchRequestRef.current) {
        setErr(String(e?.message || e));
      }
    } finally {
      if (requestId === searchRequestRef.current) {
        setLoading(false);
      }
    }
    return items;
  }

  // Enter/Search opens an exact account or address. Broad street searches stay
  // on this page and show the same-street, same-city result tiles.
  async function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    const query = q.trim();
    const cityQuery = city.trim();
    const items = await runSearch(query, cityQuery);
    if (!items.length) return;

    const exactFromApi = items.find((item) =>
      item.raw?.search_match === "exact_account" || item.raw?.search_match === "exact_address"
    );
    const normalizedQueryAddress = query ? normalizeAddress(query.split(",", 1)[0]) : "";
    const exactByAddress = query ? items.find((item) =>
      normalizeAddress(item.raw?.address || item.raw?.situs_address || "") === normalizedQueryAddress
    ) : undefined;
    const exact = query
      ? (/^[0-9A-Za-z]{17}$/.test(query) ? items[0] : (exactFromApi || exactByAddress))
      : undefined;

    if (exact) openReportChooser(exact);
  }

  function openReportChooser(item: SearchItem) {
    setSelectedReportSubject({
      accountId: item.id,
      address: api.formatSearchTileAddress(
        item.raw?.address || item.raw?.situs_address || item.title,
        item.raw?.city,
      ),
      ownerName: item.raw?.owner || null,
    });
  }

  // A short debounce keeps autocomplete responsive without applying stale
  // responses when the user continues typing.
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const query = q.trim();
    const cityQuery = city.trim();
    debounceTimerRef.current = setTimeout(() => void runSearch(query, cityQuery), 180);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, city]);

  return (
    <div className="hn-app-shell" style={{ padding: 16, display: "grid", gap: 12 }}>
      <header className="hn-app-header rounded-2xl px-5 py-4">
        <img
          className="hn-home-logo"
          src="/branding/homenode-logo.png"
          alt="HomeNode"
        />
        <div className="hn-eyebrow text-xs">HomeNode workspace</div>
        <h1 style={{ margin: "4px 0 0" }}>Property Search</h1>
      </header>

      {/* Query + Filters */}
      <form
        className="hn-workspace-surface rounded-2xl border p-4"
        onSubmit={submitSearch}
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "end",
        }}
      >
        <div style={{ flex: "1 1 320px" }}>
          <Labeled label="Address / Owner / Account">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="e.g. 1909 SNOWMASS LN or a 17-character account ID"
              className="input"
            />
          </Labeled>
        </div>

        <div style={{ flex: "0 1 220px" }}>
          <Labeled label="City (optional)">
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="e.g. Duncanville"
              className="input"
            />
          </Labeled>
        </div>

        <button type="submit" disabled={loading} className="btn">
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      <div style={{ fontSize: 12, opacity: 0.68 }}>
        Results update as you type. The first field keeps the original address, owner, and account search behavior; the optional City field can be used alone or to narrow those result tiles.
      </div>

      {/* Status */}
      {err && <div style={{ color: "crimson" }}>Error: {err}</div>}
      {loading && <div>Loading…</div>}

      {/* Results */}
      {!loading && !err && (
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))",
          }}
        >
          {results.map((r) => {
            // MOOLAH_TILE_RENDER_PATCH
            const mvRaw = r.raw?.latest_market_value;
            const mvNum =
              mvRaw == null || mvRaw === ""
                ? null
                : Number(String(mvRaw).replace(/[,$\s]/g, ""));
            const mvDisplay =
              mvNum != null && !Number.isNaN(mvNum) ? fmtUSD.format(mvNum) : "—";
            const qualityStatus = String(r.raw?.data_quality_status || "");
            const legacyReview = qualityStatus === "legacy_review";
            const legacyResolved = qualityStatus === "legacy_resolved";
            const refreshQueued = [
              "refresh_queued",
              "incomplete_requeued",
              "recovery_queued",
            ].includes(qualityStatus);

            return (
              <a
                key={r.id}
                href={`/report/${encodeURIComponent(r.id)}`}
                onClick={(event) => {
                  event.preventDefault();
                  openReportChooser(r);
                }}
                className="hn-workspace-surface"
                style={{
                  width: "100%",
                  textAlign: "left",
                  textDecoration: "none",
                  color: "inherit",
                  border: "1px solid var(--hn-border)",
                  borderRadius: 12,
                  padding: 12,
                  display: "grid",
                  gap: 6,
                  background: "var(--hn-surface)",
                  cursor: "pointer",
                }}
              >
                {/* Address (primary) */}
                <div style={{ fontWeight: 600 }}>
                  {api.formatSearchTileAddress(
                    r.raw?.address || r.raw?.situs_address || r.title,
                    r.raw?.city,
                  )}
                </div>

                {(legacyReview || legacyResolved || refreshQueued) && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {legacyReview && (
                      <span style={{
                        width: "fit-content",
                        borderRadius: 999,
                        padding: "2px 8px",
                        background: "#fef3c7",
                        color: "#92400e",
                        fontSize: 11,
                        fontWeight: 600,
                      }}>
                        Legacy account · review
                      </span>
                    )}
                    {legacyResolved && (
                      <span style={{
                        width: "fit-content",
                        borderRadius: 999,
                        padding: "2px 8px",
                        background: "#dcfce7",
                        color: "#166534",
                        fontSize: 11,
                        fontWeight: 600,
                      }}>
                        Legacy account resolved
                      </span>
                    )}
                    {refreshQueued && (
                      <span style={{
                        width: "fit-content",
                        borderRadius: 999,
                        padding: "2px 8px",
                        background: "#dbeafe",
                        color: "#1e40af",
                        fontSize: 11,
                        fontWeight: 600,
                      }}>
                        Data refresh queued
                      </span>
                    )}
                  </div>
                )}

                {/* Account ID (secondary line) */}
                <div style={{ fontSize: 12, opacity: 0.75 }}>{r.id}</div>

                {r.raw?.city && (
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    {r.raw.city}{r.raw.postal_code ? `, TX ${r.raw.postal_code}` : ""}
                  </div>
                )}

                {/* Market Value (third line) */}
                <div style={{ fontSize: 12, opacity: 0.6 }}>
                  Market Value: {mvDisplay}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, fontWeight: 700, color: "var(--hn-violet)" }}>
                  Choose report type
                </div>
              </a>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && !err && q.trim() && results.length === 0 && (
        <div>No matches.</div>
      )}

      <SalesReconciliationQueue />

      <ReportTypeChooser
        subject={selectedReportSubject}
        onClose={() => setSelectedReportSubject(null)}
      />

      <style>{`
        .input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          outline: none;
        }
        .input:focus { border-color: var(--hn-violet); box-shadow: 0 0 0 3px var(--hn-focus); }
        .btn {
          padding: 10px 14px;
          border-radius: 10px;
          border: 1px solid var(--hn-violet);
          background: var(--hn-violet);
          color: white;
          cursor: pointer;
        }
        .btn:hover { filter: brightness(1.05); }
      `}</style>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12, opacity: 0.7 }}>{label}</span>
      {children}
    </label>
  );
}


