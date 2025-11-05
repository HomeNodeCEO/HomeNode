// src/pages/PropertyDetail.tsx
import { useEffect, useState } from "react";
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
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message || e));
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

  return (
    <Page chrome>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>{data.situs_address}</h1>
        <Link to=".." style={{ textDecoration: "none" }}>&larr; Back</Link>
      </div>

      <div style={{ fontSize: 14, opacity: 0.8, marginTop: 4 }}>
        Account {data.account_id} · County {data.county_id}
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr", maxWidth: 800 }}>
        <Row k="Year Built" v={data.year_built ?? "—"} />
        <Row k="Stories" v={data.stories_display ?? "—"} />
        <Row k="Baths" v={data.bath_count_display ?? "—"} />
        <Row k="Beds" v={data.bedroom_count ?? "—"} />
        <Row k="Living Area (sf)" v={data.living_area_sqft ?? "—"} />
        <Row k="Total Living (sf)" v={data.total_living_area ?? "—"} />
        <Row k="Pool" v={data.pool_display ?? "—"} />
        <Row k="Basement" v={data.basement_display ?? "—"} />
        <Row k="Construction" v={data.construction_type_display ?? "—"} />
        <Row k="A/C" v={data.air_conditioning_display ?? "—"} />
        <Row k="Heating" v={data.heating_display ?? "—"} />
        <Row k="Foundation" v={data.foundation_display ?? "—"} />
        <Row k="Roof Material" v={data.roof_material_display ?? "—"} />
        <Row k="Roof Type" v={data.roof_type_display ?? "—"} />
        <Row k="Exterior" v={data.exterior_material_display ?? "—"} />
        <Row k="Fence" v={data.fence_type_display ?? "—"} />
        <Row k="Units" v={data.number_units ?? "—"} />
      </div>
    </Page>
  );
}

function Row({ k, v }: { k: string; v: string | number | boolean }) {
  return (
    <>
      <div style={{ opacity: 0.7 }}>{k}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{String(v)}</div>
    </>
  );
}

function Page({ children, chrome = true }: { children: any; chrome?: boolean }) {
  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      {chrome && <div style={{ fontSize: 12, opacity: 0.6 }}>Property Detail</div>}
      {children}
    </div>
  );
}
