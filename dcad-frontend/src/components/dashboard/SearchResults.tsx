// src/components/SearchResults.tsx
// MOOLAH_SEARCH_RESULTS_COMPONENT
import { useEffect, useMemo, useState } from "react";
import { apiSearch, toSearchItems, type SearchItem } from "@/lib/api"; // uses your existing mappers
import { Link } from "react-router-dom";

/** Simple USD formatter for market values shown on tiles */
const fmtUSD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

type Props = {
  /** Current search text */
  query: string;
  /** Optional: max results to show */
  limit?: number;
};

export default function SearchResults({ query, limit = 25 }: Props) {
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const q = (query || "").trim();

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!q) {
        setItems([]);
        return;
      }
      setLoading(true);
      try {
        // Use your existing search; returns array of rows
        const rows = await apiSearch(q, limit);
        // Map rows -> tiles using your existing mapper
        const mapped = toSearchItems(rows);
        if (!cancelled) setItems(mapped);
      } catch (e) {
        if (!cancelled) setItems([]);
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [q, limit]);

  if (!q) return null;
  if (loading) return <div className="p-3 text-sm text-slate-500">Searching…</div>;
  if (items.length === 0) return <div className="p-3 text-sm text-slate-500">No matches</div>;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {items.map((it) => {
        const addr = it.title;                           // from toSearchItems: situs_address || owner || account_id
        const ownerAndId = it.subtitle;                  // "Owner · 17-char id" or just id
        // If your API includes latest_market_value on search rows, show it here.
        const mv = (it.raw as any)?.latest_market_value;
        const mvDisplay = mv != null && mv !== "" ? fmtUSD.format(Number(String(mv).replace(/[,$\s]/g, ""))) : "—";

        // Link target: adjust to your route (e.g., /property/:countyId/:accountId).
        // If you don't have countyId here, you can link by account only (e.g., /property/0/:id)
        const accountId = it.id;
        const href = `/property/0/${encodeURIComponent(accountId)}`;

        return (
          <Link
            key={it.id}
            to={href}
            className="block rounded-xl border border-slate-200 bg-white p-3 hover:shadow-sm transition"
          >
            <div className="text-sm font-semibold text-slate-900 line-clamp-2">{addr}</div>
            <div className="text-xs text-slate-600 mt-1">{ownerAndId}</div>
            <div className="mt-2 text-xs text-slate-500">Market Value</div>
            <div className="text-base font-bold">{mvDisplay}</div>
          </Link>
        );
      })}
    </div>
  );
}
