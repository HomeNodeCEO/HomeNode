// src/pages/PropertySearch.tsx (resilient to different api.ts versions)
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import * as api from "@/lib/api"; // we'll safely probe for functions at runtime

// MOOLAH_ADD_MV_TYPE_AND_FMT
type ApiSearchRow = {
  account_id: string;
  address?: string | null; // <- NEW: many endpoints return 'address' (core.accounts.address)
  owner: string | null;
  situs_address: string | null;
  latest_market_value?: number | string | null; // <- allow MV from backend if present
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

const DEFAULT_COUNTY_ID = 1;

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
    const title = addr || r.owner || r.account_id;
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
async function requestItems(query: string, limit = 25): Promise<SearchItem[]> {
  // Prefer helper if available
  try {
    // 1) searchItems -> returns SearchItem[]
    const searchItems = (api as any).searchItems;
    if (typeof searchItems === "function") {
      return await searchItems(query, limit);
    }

    // 2) searchByQuery -> returns {results: ApiSearchRow[]}
    const searchByQuery = (api as any).searchByQuery;
    if (typeof searchByQuery === "function") {
      const obj = await searchByQuery(query, limit);
      if (typeof (api as any).toSearchItems === "function") {
        return (api as any).toSearchItems(obj);
      }
      return localToItems(obj);
    }

    // 3) apiSearch -> returns ApiSearchRow[]
    const apiSearch = (api as any).apiSearch;
    if (typeof apiSearch === "function") {
      const arr = await apiSearch(query, limit);
      if (typeof (api as any).toSearchItems === "function") {
        return (api as any).toSearchItems(arr);
      }
      return localToItems(arr);
    }
  } catch (e) {
    console.error("[requestItems] helper call failed:", e);
  }

  // 4) If it's an exact 17-digit account id, return a direct link without hitting API
  if (/^\d{17}$/.test(query)) {
    return [{ id: query, title: query, subtitle: query }];
  }
  // 5) Final fallback: DB search route that supports address or exact account_id
  const url = api.makeUrl('/api/search', { q: query, limit });
  let res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Search HTTP ${res.status}`);
  }
  const data = await res.json();
  if (typeof (api as any).toSearchItems === "function") {
    return (api as any).toSearchItems(data);
  }
  return localToItems(data);
}

export default function PropertySearchPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);


  function normalizeAddress(s: string): string {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // strip punctuation
      .replace(/\s+/g, ' ') // collapse spaces
      .trim();
  }

  // Fetch results only (no navigation); returns fetched items
  async function runSearch(): Promise<SearchItem[]> {
    const query = q.trim();
    if (!query) {
      setResults([]);
      return [];
    }
    setLoading(true);
    setErr(null);
    let items: SearchItem[] = [];
    try {
      items = await requestItems(query, 25);
      setResults(items);
      if (!items || items.length === 0) {
        setErr('No results found');
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
    return items;
  }

  // Explicit navigation: on Search button click, go to first result (same as top tile)
  async function goToTopResult() {
    const items = results.length > 0 ? results : await runSearch();
    if (items && items.length > 0) {
      navigate(`/report/${encodeURIComponent(items[0].id)}`);
    }
  }

  // Debounce typing → search after 300ms idle
  useEffect(() => {
    const t = setTimeout(runSearch, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div style={{ padding: 16, display: "grid", gap: 12 }}>
      {/* Signup CTA */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Link
          to="/signup"
          style={{
            textDecoration: 'none',
            padding: '8px 12px',
            borderRadius: 10,
            border: '1px solid #059669',
            background: '#059669',
            color: 'white',
          }}
        >
          Sign Up Here (No Upfront Cost)
        </Link>
      </div>
      <h1 style={{ margin: 0 }}>Property Search</h1>

      {/* Query + Filters */}
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "1.5fr auto",
          alignItems: "end",
        }}
      >
        <Labeled label="Address / Owner / Account">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. 26272500060150000 or SNOWMASS"
            className="input"
          />
        </Labeled>

        <button type="button" onClick={goToTopResult} className="btn">
          Search
        </button>
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

            return (
              <Link
                key={r.id}
                to={`/report/${encodeURIComponent(r.id)}`}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  border: "1px solid #e5e7eb",
                  borderRadius: 12,
                  padding: 12,
                  display: "grid",
                  gap: 6,
                }}
              >
                {/* Address (primary) */}
                <div style={{ fontWeight: 600 }}>{r.title || "(No address)"}</div>

                {/* Account ID (secondary line) */}
                <div style={{ fontSize: 12, opacity: 0.75 }}>{r.id}</div>

                {/* Market Value (third line) */}
                <div style={{ fontSize: 12, opacity: 0.6 }}>
                  Market Value: {mvDisplay}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && !err && q.trim() && results.length === 0 && (
        <div>No matches.</div>
      )}

      <style>{`
        .input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          outline: none;
        }
        .input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,.15); }
        .btn {
          padding: 10px 14px;
          border-radius: 10px;
          border: 1px solid #111827;
          background: #111827;
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


