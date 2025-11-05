import { useState } from "react";
import { searchByAddress } from "./lib/api"; // If your '@' alias isn't set, use: ../../lib/dcad
import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";

export default function PropertySearchSection() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function onSearch() {
    if (!q.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const data = await searchByAddress(q, 5);
      setResults(data.results || []);
    } catch (e: any) {
      setErr(e?.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="shadow-lg border-0 bg-white/80 backdrop-blur-sm">
      <CardHeader className="bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-t-lg">
        <CardTitle className="flex items-center gap-3">
          <Search className="w-6 h-6" />
          Property Search
        </CardTitle>
      </CardHeader>

      <CardContent className="p-6 space-y-4">
        <p className="text-slate-600">
          Search by address, account number, or owner name for full details on any property or account
        </p>

        <div className="flex gap-2">
          <Input
            placeholder="Enter address, account number, or owner name..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
            className="flex-1"
          />
          <Button type="button" onClick={onSearch} disabled={loading} className="bg-blue-600 hover:bg-blue-700">
            <Search className="w-4 h-4" />
          </Button>
        </div>

        {err && <div className="p-3 rounded bg-red-50 text-red-700 text-sm">{err}</div>}

        {Boolean(results.length) && (
          <div className="mt-2 space-y-3">
            {results.map((r, i) => {
              const a = r.summary || r;
              return (
                <Card key={i}>
                  <CardContent className="pt-4">
                    <div className="font-medium">{a.address}</div>
                    <div className="text-sm text-slate-600">
                      {a.city} · Owner: {a.owner || "—"} · Total Value: {a.total_value || "—"} · Type: {a.type || "—"}
                    </div>
                    <div className="mt-2 flex gap-3">
                      {a.detail_url && (
                        <a className="underline" href={a.detail_url} target="_blank" rel="noreferrer">
                          DCAD Page
                        </a>
                      )}
                      {a.account_id && (
                        <Link
                          className="underline"
                          to={`/PropertyReport?account_id=${encodeURIComponent(a.account_id)}`}
                        >
                          Open in Property Report
                        </Link>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
