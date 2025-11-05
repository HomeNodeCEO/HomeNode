import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { fetchDetail } from "@/lib/dcad";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PropertyForm, type FieldSpec } from "@/components/PropertyForm";

type Property = {
  account_number?: string;

  // valuation
  market_value?: number | "";
  taxable_value?: number | "";
  land_value?: number | "";
  improvement_value?: number | "";

  // characteristics
  owner_name?: string;
  square_footage?: number | "";
  bedroom_count?: number | "";
  bath_count?: number | "";
  garage_bay_count?: number | "";
  land_acreage?: number | "";
  zoning?: string;
  classification?: string;
  year_built?: number | "";
  effective_year_built?: number | "";
  last_inspection_year?: number | "";
  solar_panels?: boolean;
  functional_obsolescence?: boolean;
};

export default function PropertyDetails() {
  const location = useLocation();
  const presetAccount = useMemo(() => new URLSearchParams(location.search).get("account_id") || "", [location.search]);

  const [property, setProperty] = useState<Property>({ account_number: presetAccount });
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState<any>(null);
  const hasAutoImported = useRef(false);

  // Map API JSON -> our Property fields (adjust paths to match your JSON)
  function mapDetailToProperty(detail: any): Property {
    return {
      account_number: property.account_number,
      owner_name: detail?.owner?.name ?? "",

      market_value: toNum(detail?.current_year?.market_value),
      taxable_value: toNum(detail?.current_year?.taxable_value),
      land_value: toNum(detail?.value_summary?.land_value ?? detail?.improvements?.land_value),
      improvement_value: toNum(detail?.value_summary?.improvement_value ?? detail?.improvements?.improvement_value),

      square_footage: toNum(detail?.characteristics?.living_area_sqft),
      bedroom_count: toNum(detail?.characteristics?.bedrooms),
      bath_count: toNum(detail?.characteristics?.baths),
      garage_bay_count: toNum(detail?.characteristics?.garage_bays),
      land_acreage: toNum(detail?.land?.acreage),
      zoning: detail?.zoning ?? "",
      classification: detail?.classification ?? "",
      year_built: toNum(detail?.characteristics?.year_built),
      effective_year_built: toNum(detail?.characteristics?.effective_year_built),
      last_inspection_year: toNum(detail?.inspection?.last_year),
      solar_panels: !!detail?.features?.solar_panels,
      functional_obsolescence: !!detail?.condition?.functional_obsolescence,
    };
  }
  function toNum(v: any): number | "" {
    const n = Number(v);
    return Number.isFinite(n) ? n : "";
    // keeps "" if null/undefined/NaN so inputs stay blank instead of "0"
  }

  async function importFromDCAD() {
    if (!property.account_number) { alert("Enter an Account ID first."); return; }
    setLoading(true);
    try {
      const resp = await fetchDetail(property.account_number);
      setRaw(resp);
      const mapped = mapDetailToProperty(resp?.detail);
      setProperty(prev => ({ ...prev, ...mapped }));
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Import failed");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!hasAutoImported.current && property.account_number) {
      hasAutoImported.current = true;
      importFromDCAD();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property.account_number]);

  // ----- Schema fields (add to these anytime) -----
  const valuationFields: FieldSpec[] = [
    { key: "market_value", label: "Market Value", type: "currency" },
    { key: "taxable_value", label: "Taxable Value", type: "currency" },
    { key: "land_value", label: "Land Value", type: "currency" },
    { key: "improvement_value", label: "Improvement Value", type: "currency" },
  ];

  const specFields: FieldSpec[] = [
    { key: "square_footage", label: "Square Footage", type: "number" },
    { key: "bedroom_count", label: "Bedroom Count", type: "number" },
    { key: "bath_count", label: "Bath Count", type: "decimal", step: 0.1 },
    { key: "garage_bay_count", label: "Garage Bay Count", type: "number" },
    { key: "land_acreage", label: "Land Acreage", type: "decimal", step: 0.01 },
    { key: "zoning", label: "Zoning", type: "text" },
    { key: "classification", label: "Classification", type: "text" },
    { key: "year_built", label: "Actual Year Built", type: "year" },
    { key: "effective_year_built", label: "Effective Year Built", type: "year" },
    { key: "last_inspection_year", label: "Last Inspection Year", type: "year" },
    {
      key: "solar_panels",
      label: "Solar Panels",
      type: "select",
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      fromState: (v) => (v ? "yes" : "no"),
      toState: (raw) => raw === "yes",
    },
    {
      key: "functional_obsolescence",
      label: "Functional Obsolescence",
      type: "select",
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      fromState: (v) => (v ? "yes" : "no"),
      toState: (raw) => raw === "yes",
      full: true,
    },
  ];

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Top */}
      <div className="flex items-center justify-between">
        <Link to="/" className="text-sm underline">← Back</Link>
        <h1 className="text-2xl font-bold text-slate-900">Property Details</h1>
        <div />
      </div>

      {/* Import */}
      <Card>
        <CardHeader><CardTitle>Import from DCAD</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-[160px_1fr_auto] items-center">
          <label className="text-sm font-medium text-slate-700">Account ID</label>
          <Input
            placeholder="Enter DCAD Account ID"
            value={property.account_number || ""}
            onChange={(e) => setProperty(p => ({ ...p, account_number: e.target.value }))}
          />
          <Button onClick={importFromDCAD} disabled={loading || !property.account_number}>
            {loading ? "Importing..." : "Import"}
          </Button>
        </CardContent>
      </Card>

      {/* New schema-driven cards */}
      <PropertyForm
        property={property as any}
        setProperty={setProperty as any}
        sections={[
          { title: "Valuation", fields: valuationFields },
          { title: "Property Specifications", fields: specFields },
        ]}
      />

      {/* Raw JSON for mapping */}
      <details className="mt-2">
        <summary className="cursor-pointer">Show raw API JSON</summary>
        <pre className="whitespace-pre-wrap bg-slate-50 p-3 rounded-md text-sm">
{JSON.stringify(raw, null, 2)}
        </pre>
      </details>
    </div>
  );
}
