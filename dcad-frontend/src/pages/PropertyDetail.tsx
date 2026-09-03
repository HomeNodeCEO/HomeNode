// src/pages/PropertyDetail.tsx
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchProperty, type PropertyDetail } from "../lib/api";

export default function PropertyDetailPage() {
  const { countyId, accountId } = useParams<{ countyId: string; accountId: string }>();
  const [data, setData] = useState<PropertyDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!countyId || !accountId) return;
      setLoading(true);
      setErr(null);
      try {
        const d = await fetchProperty(countyId, accountId);
        if (!cancelled) setData(d);
      } catch (error: unknown) {
        if (!cancelled) {
          setErr(error instanceof Error ? error.message : "Property detail could not be loaded.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [countyId, accountId]);

  if (loading) return <Page chrome><div>Loading…</div></Page>;
  if (err) return (
    <Page chrome>
      <div style={{ color: "crimson" }}>Error: {err}</div>
      <div style={{ marginTop: 12 }}>
        <Link to="..">Back</Link>
      </div>
    </Page>
  );
  if (!data) return <Page chrome><div>No data.</div></Page>;

  const account = data.account;
  const improvement = data.primary_improvements;

  return (
    <Page chrome>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>{account.address || "Address unavailable"}</h1>
        <Link to=".." style={{ textDecoration: "none" }}>&larr; Back</Link>
      </div>

      <div style={{ fontSize: 14, opacity: 0.8, marginTop: 4 }}>
        Account {account.account_id} · County {account.county || "unavailable"}
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr", maxWidth: 800 }}>
        <Row k="Year Built" v={improvement?.year_built ?? "—"} />
        <Row k="Stories" v={improvement?.stories ?? "—"} />
        <Row k="Baths" v={improvement?.bath_count ?? "—"} />
        <Row k="Beds" v={improvement?.bedroom_count ?? "—"} />
        <Row k="Living Area (sf)" v={improvement?.living_area_sqft ?? "—"} />
        <Row k="Total Living (sf)" v={improvement?.total_living_area ?? "—"} />
        <Row k="Pool" v={displayBoolean(improvement?.pool)} />
        <Row k="Basement" v={displayBoolean(improvement?.basement)} />
        <Row k="Construction" v={improvement?.construction_type ?? "—"} />
        <Row k="A/C" v={improvement?.air_conditioning ?? "—"} />
        <Row k="Heating" v={improvement?.heating ?? "—"} />
        <Row k="Foundation" v={improvement?.foundation ?? "—"} />
        <Row k="Roof Material" v={improvement?.roof_material ?? "—"} />
        <Row k="Roof Type" v={improvement?.roof_type ?? "—"} />
        <Row k="Exterior" v={improvement?.exterior_material ?? "—"} />
        <Row k="Fence" v={improvement?.fence_type ?? "—"} />
        <Row k="Units" v={improvement?.number_units ?? "—"} />
      </div>
    </Page>
  );
}

function displayBoolean(value: boolean | null | undefined) {
  return value == null ? "—" : value ? "Yes" : "No";
}

function Row({ k, v }: { k: string; v: string | number | boolean }) {
  return (
    <>
      <div style={{ opacity: 0.7 }}>{k}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{String(v)}</div>
    </>
  );
}

function Page({ children, chrome = true }: { children: ReactNode; chrome?: boolean }) {
  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      {chrome && <div style={{ fontSize: 12, opacity: 0.6 }}>Property Detail</div>}
      {children}
    </div>
  );
}
