import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import * as api from "@/lib/api";
import type { SaleRow } from "@/lib/api";
import { fetchDetail } from "@/lib/dcad";
import {
  readAppraisalReportDraft,
  type AppraisalReportComparable,
  type AppraisalReportSalesDraft,
} from "@/lib/appraisalReportDraft";

type Detail = {
  tax_year?: string | number;
  property_location?: {
    address?: string;
    neighborhood?: string;
    city?: string;
    postal_code?: string;
    county?: string;
    subdivision?: string;
  };
  owner?: {
    owner_name?: string;
    mailing_address?: string;
  };
  value_summary?: {
    certified_year?: string | number;
    improvement_value?: string | number;
    land_value?: string | number;
    market_value?: string | number;
    capped_value?: string | number;
  };
  main_improvement?: Record<string, unknown>;
  housing_profile?: Record<string, unknown>;
  additional_improvements?: Array<Record<string, unknown>>;
  land_detail?: Array<Record<string, unknown>>;
  exemptions?: Record<string, Record<string, unknown>>;
  legal_description?: {
    lines?: string[];
    deed_transfer_date?: string;
  };
  sales_history?: Array<Record<string, unknown>>;
  homestead_yes?: boolean;
  photos?: string[];
};

const EMPTY_ADJUSTMENTS = {
  concessions: 0,
  time: 0,
  roomCount: 0,
  livingArea: 0,
  garage: 0,
  pool: 0,
  condition: 0,
  quality: 0,
};

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function text(value: unknown, fallback = "Not reported"): string {
  return hasValue(value) ? String(value) : fallback;
}

function numberValue(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: unknown): string {
  const parsed = numberValue(value);
  if (parsed === null) return "Not reported";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(parsed);
}

function count(value: unknown, suffix = ""): string {
  const parsed = numberValue(value);
  if (parsed === null) return "Not reported";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(parsed)}${suffix}`;
}

function dateText(value: unknown): string {
  if (!hasValue(value)) return "Not reported";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function booleanText(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (!hasValue(value)) return "Not reported";
  const normalized = String(value).trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(normalized)) return "Yes";
  if (["false", "f", "no", "n", "0"].includes(normalized)) return "No";
  return String(value);
}

function saleAddress(sale: SaleRow): string {
  return (
    [sale.address, sale.city, sale.state, sale.zip].filter(hasValue).join(", ") ||
    sale.primary_account_id ||
    "Address not reported"
  );
}

function signedMoney(value: number): string {
  if (!value) return "$0";
  return `${value > 0 ? "+" : "-"}${money(Math.abs(value))}`;
}

function Fact({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: unknown;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "report-fact report-fact-wide" : "report-fact"}>
      <div className="report-label">{label}</div>
      <div className="report-value">{text(value)}</div>
    </div>
  );
}

function PageHeader({
  page,
  title,
  address,
}: {
  page: number;
  title: string;
  address: string;
}) {
  return (
    <header className="report-page-header">
      <div>
        <div className="report-brand">HomeNode Appraisal Report</div>
        <div className="report-page-title">{title}</div>
      </div>
      <div className="report-page-meta">
        <strong>Draft</strong>
        <span>{address}</span>
        <span>Page {page} of 5</span>
      </div>
    </header>
  );
}

function PageFooter({ generatedAt }: { generatedAt: string }) {
  return (
    <footer className="report-page-footer">
      <span>Preliminary appraisal workfile - review required</span>
      <span>Generated {generatedAt}</span>
    </footer>
  );
}

function recommendedComparable(sale: SaleRow): AppraisalReportComparable {
  const salePrice = numberValue(sale.sale_price) || 0;
  return {
    sale,
    condition: "",
    quality: "",
    netAdjustment: 0,
    grossAdjustment: 0,
    indicatedValue: salePrice,
    adjustments: { ...EMPTY_ADJUSTMENTS },
  };
}

export default function AppraisalReport() {
  const location = useLocation();
  const propertyId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return (params.get("propertyId") || params.get("accountId") || "").trim();
  }, [location.search]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<AppraisalReportSalesDraft | null>(() =>
    readAppraisalReportDraft(propertyId),
  );
  const [recommended, setRecommended] = useState<AppraisalReportComparable[]>([]);
  const [loading, setLoading] = useState(Boolean(propertyId));
  const [salesLoading, setSalesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generatedAt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date()),
    [],
  );

  useEffect(() => {
    setDraft(readAppraisalReportDraft(propertyId));
  }, [propertyId]);

  useEffect(() => {
    let cancelled = false;
    if (!propertyId) {
      setError("No property account ID was provided.");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);
    void fetchDetail(propertyId)
      .then((response) => {
        if (!cancelled) setDetail((response?.detail ?? null) as Detail | null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Property data could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  useEffect(() => {
    let cancelled = false;
    if (!propertyId || draft?.comparables?.length) {
      setRecommended([]);
      return () => {
        cancelled = true;
      };
    }
    setSalesLoading(true);
    void api
      .getComparableRecommendations({
        subjectAccountId: propertyId,
        limit: 6,
      })
      .then((response) => {
        if (cancelled) return;
        const sales =
          response.recommended_sales?.length > 0
            ? response.recommended_sales
            : response.sales || [];
        setRecommended(sales.slice(0, 6).map(recommendedComparable));
      })
      .catch(() => {
        if (!cancelled) setRecommended([]);
      })
      .finally(() => {
        if (!cancelled) setSalesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft, propertyId]);

  useEffect(() => {
    const previous = document.title;
    document.title = propertyId
      ? `Draft Appraisal Report - ${propertyId}`
      : "Draft Appraisal Report";
    return () => {
      document.title = previous;
    };
  }, [propertyId]);

  const address = text(
    detail?.property_location?.address || draft?.subject?.address,
    "Property address unavailable",
  );
  const improvement = detail?.main_improvement || {};
  const housing = detail?.housing_profile || {};
  const values = detail?.value_summary || {};
  const landRows = detail?.land_detail || [];
  const additionalImprovements = detail?.additional_improvements || [];
  const legalLines = detail?.legal_description?.lines?.filter((line) => line.trim()) || [];
  const exemptions = Object.entries(detail?.exemptions || {}).filter(([, row]) => Boolean(row));
  const comparables = draft?.comparables?.length ? draft.comparables : recommended;
  const salesSource = draft?.comparables?.length
    ? "Current saved sales-comparison workspace"
    : "Automatic preliminary top-ranked recommendations";
  const landArea = landRows.reduce(
    (total, row) => total + (numberValue(row.area_sqft) || 0),
    0,
  );
  const primaryZoning =
    landRows.find((row) => hasValue(row.zoning))?.zoning || "Not reported";
  const photo = detail?.photos?.find((url) => url.trim());
  const bathDisplay =
    hasValue(improvement.baths_full) || hasValue(improvement.baths_half)
      ? `${text(improvement.baths_full, "0")} full / ${text(
          improvement.baths_half,
          "0",
        )} half`
      : text(improvement.bath_count);
  const totalExemptionJurisdictions = exemptions.filter(
    ([, row]) => (numberValue(row.homestead_exemption) || 0) > 0,
  ).length;
  const opinionOfValue = draft?.opinionOfValue ?? null;
  const indicatedValues = comparables
    .map((comparable) => comparable.indicatedValue)
    .filter((value) => Number.isFinite(value) && value > 0);
  const preliminaryRange =
    indicatedValues.length > 0
      ? `${money(Math.min(...indicatedValues))} to ${money(
          Math.max(...indicatedValues),
        )}`
      : "Not developed";

  const printReport = () => {
    window.setTimeout(() => window.print(), 100);
  };

  if (loading) {
    return <div className="min-h-screen bg-slate-100 p-8 text-slate-700">Building report...</div>;
  }

  if (error || !detail) {
    return (
      <div className="min-h-screen bg-slate-100 p-8">
        <div className="mx-auto max-w-2xl rounded-2xl bg-white p-6 shadow">
          <h1 className="text-xl font-semibold">Appraisal report unavailable</h1>
          <p className="mt-2 text-slate-600">{error || "Property data was not returned."}</p>
          <Link to="/" className="mt-4 inline-flex rounded-md bg-slate-900 px-4 py-2 text-white">
            Return to Property Search
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="appraisal-report-shell">
      <style>{`
        .appraisal-report-shell {
          min-height: 100vh;
          background: #e2e8f0;
          color: #0f172a;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .report-toolbar {
          position: sticky;
          top: 0;
          z-index: 30;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 20px;
          background: rgba(255, 255, 255, 0.96);
          border-bottom: 1px solid #cbd5e1;
          box-shadow: 0 3px 12px rgba(15, 23, 42, 0.08);
        }
        .report-toolbar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
        .report-toolbar a, .report-toolbar button {
          border-radius: 7px;
          border: 1px solid #cbd5e1;
          background: white;
          color: #334155;
          padding: 8px 13px;
          font-size: 13px;
          font-weight: 650;
          text-decoration: none;
          cursor: pointer;
        }
        .report-toolbar .report-print-button {
          border-color: #2563eb;
          background: #2563eb;
          color: white;
        }
        .report-document {
          width: min(8.5in, calc(100% - 32px));
          margin: 24px auto 60px;
        }
        .report-page {
          box-sizing: border-box;
          min-height: 10.2in;
          margin-bottom: 22px;
          padding: 0.48in 0.5in 0.36in;
          background: white;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.15);
          display: flex;
          flex-direction: column;
        }
        .report-page-header {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          padding-bottom: 12px;
          border-bottom: 2px solid #0f766e;
        }
        .report-brand {
          color: #0f766e;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .report-page-title {
          margin-top: 3px;
          color: #0f172a;
          font-size: 21px;
          font-weight: 750;
        }
        .report-page-meta {
          display: grid;
          justify-items: end;
          align-content: start;
          gap: 2px;
          color: #64748b;
          font-size: 9px;
        }
        .report-page-meta strong {
          color: #b45309;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }
        .report-cover {
          display: grid;
          grid-template-columns: 1.2fr 0.8fr;
          gap: 18px;
          margin-top: 18px;
          padding: 18px;
          border-radius: 10px;
          background: #f0fdfa;
          border: 1px solid #99f6e4;
        }
        .report-cover-address {
          font-size: 23px;
          font-weight: 800;
          line-height: 1.12;
        }
        .report-cover-subtitle {
          margin-top: 7px;
          color: #475569;
          font-size: 11px;
          line-height: 1.45;
        }
        .report-cover-photo {
          min-height: 126px;
          border-radius: 8px;
          overflow: hidden;
          background: #dbe4ee;
          display: grid;
          place-items: center;
          color: #64748b;
          font-size: 10px;
          font-weight: 650;
        }
        .report-cover-photo img { width: 100%; height: 100%; object-fit: cover; }
        .report-section {
          margin-top: 15px;
          break-inside: avoid;
        }
        .report-section-title {
          margin: 0 0 8px;
          color: #0f172a;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }
        .report-facts {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px 14px;
          padding: 12px;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
          background: #f8fafc;
        }
        .report-fact-wide { grid-column: span 2; }
        .report-label {
          color: #64748b;
          font-size: 7.5px;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .report-value {
          margin-top: 2px;
          color: #0f172a;
          font-size: 9.5px;
          font-weight: 650;
          line-height: 1.28;
          overflow-wrap: anywhere;
        }
        .report-note {
          padding: 10px 12px;
          border-left: 3px solid #0f766e;
          background: #f8fafc;
          color: #475569;
          font-size: 9.5px;
          line-height: 1.45;
        }
        .report-table-wrap {
          overflow: hidden;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
        }
        .report-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
          font-size: 8.5px;
        }
        .report-table th {
          padding: 6px;
          background: #e2e8f0;
          color: #334155;
          text-align: left;
          font-size: 7px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .report-table td {
          padding: 6px;
          border-top: 1px solid #e2e8f0;
          vertical-align: top;
          line-height: 1.28;
          overflow-wrap: anywhere;
        }
        .report-table .numeric { text-align: right; white-space: nowrap; }
        .report-status {
          display: inline-flex;
          border-radius: 999px;
          padding: 4px 8px;
          background: #fef3c7;
          color: #92400e;
          font-size: 8px;
          font-weight: 800;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .report-approach-hero {
          margin-top: 22px;
          padding: 22px;
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          background: linear-gradient(135deg, #f8fafc, #eef2ff);
        }
        .report-approach-hero h2 {
          margin: 10px 0 5px;
          font-size: 22px;
        }
        .report-approach-hero p {
          max-width: 6.6in;
          margin: 0;
          color: #475569;
          font-size: 10.5px;
          line-height: 1.55;
        }
        .report-input-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 18px;
        }
        .report-input-card {
          min-height: 74px;
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          background: white;
        }
        .report-input-card strong { display: block; font-size: 9.5px; }
        .report-input-card span {
          display: block;
          margin-top: 4px;
          color: #64748b;
          font-size: 8.5px;
          line-height: 1.4;
        }
        .report-reconciliation {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-top: 12px;
        }
        .report-reconciliation > div {
          padding: 10px;
          border-radius: 8px;
          background: #ecfdf5;
          border: 1px solid #a7f3d0;
        }
        .report-reconciliation strong { display: block; font-size: 12px; }
        .report-reconciliation span { color: #047857; font-size: 7.5px; text-transform: uppercase; }
        .report-page-footer {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-top: auto;
          padding-top: 10px;
          border-top: 1px solid #e2e8f0;
          color: #94a3b8;
          font-size: 7.5px;
        }
        @media (max-width: 760px) {
          .report-toolbar { align-items: flex-start; flex-direction: column; }
          .report-document { width: min(100% - 16px, 8.5in); margin-top: 8px; }
          .report-page { min-height: auto; padding: 24px 18px; }
          .report-cover { grid-template-columns: 1fr; }
          .report-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .report-table { min-width: 680px; }
          .report-table-wrap { overflow-x: auto; }
        }
        @media print {
          @page { size: Letter portrait; margin: 0; }
          html, body, #root { margin: 0 !important; padding: 0 !important; background: white !important; }
          .appraisal-report-shell { background: white !important; }
          .report-toolbar { display: none !important; }
          .report-document { width: auto; margin: 0; }
          .report-page {
            width: 8.5in;
            height: 11in;
            min-height: 11in;
            margin: 0;
            padding: 0.48in 0.5in 0.36in;
            box-shadow: none;
            overflow: hidden;
            break-after: page;
            page-break-after: always;
          }
          .report-page:last-child {
            break-after: auto;
            page-break-after: auto;
          }
          .report-table-wrap { overflow: hidden; }
          .report-cover,
          .report-note,
          .report-facts,
          .report-approach-hero,
          .report-input-card,
          .report-reconciliation > div {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
        }
      `}</style>

      <div className="report-toolbar">
        <div>
          <strong>Draft Full Appraisal Report</strong>
          <div className="text-xs text-slate-500">{address}</div>
        </div>
        <div className="report-toolbar-actions">
          <Link to={`/report/${encodeURIComponent(propertyId)}`}>Property Report</Link>
          <Link to={`/ComparableSalesAnalysis?propertyId=${encodeURIComponent(propertyId)}`}>
            Sales Comparison
          </Link>
          <button type="button" className="report-print-button" onClick={printReport}>
            Print / Save as PDF
          </button>
        </div>
      </div>

      <main className="report-document">
        <article className="report-page">
          <PageHeader page={1} title="Property Report" address={address} />
          <section className="report-cover">
            <div>
              <div className="report-status">Draft appraisal report</div>
              <div className="report-cover-address">{address}</div>
              <div className="report-cover-subtitle">
                {[
                  detail.property_location?.city,
                  detail.property_location?.county
                    ? `${detail.property_location.county} County`
                    : null,
                  detail.property_location?.postal_code,
                ]
                  .filter(hasValue)
                  .join(" | ")}
                <br />
                Parcel / Account: {propertyId}
                <br />
                Neighborhood: {text(detail.property_location?.neighborhood)}
              </div>
            </div>
            <div className="report-cover-photo">
              {photo ? <img src={photo} alt={`${address} property`} /> : "Property photo unavailable"}
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Subject Identification</h2>
            <div className="report-facts">
              <Fact label="Parcel / Account Number" value={propertyId} />
              <Fact label="County" value={detail.property_location?.county} />
              <Fact label="Subdivision" value={detail.property_location?.subdivision} />
              <Fact
                label="Latest Deed Transfer"
                value={dateText(detail.legal_description?.deed_transfer_date)}
              />
              <Fact label="Owner Name" value={detail.owner?.owner_name} wide />
              <Fact label="Owner Mailing Address" value={detail.owner?.mailing_address} wide />
              <Fact
                label="Legal Description"
                value={legalLines.length ? legalLines.join(" ") : "Not reported"}
                wide
              />
              <Fact label="Primary Zoning" value={primaryZoning} wide />
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Appraisal District Values</h2>
            <div className="report-facts">
              <Fact label="Certified Tax Year" value={values.certified_year || detail.tax_year} />
              <Fact label="Market Value" value={money(values.market_value)} />
              <Fact
                label="Assessed / Capped Value"
                value={money(values.capped_value || values.market_value)}
              />
              <Fact label="Improvement Value" value={money(values.improvement_value)} />
              <Fact label="Land Value" value={money(values.land_value)} />
              <Fact
                label="Homestead"
                value={detail.homestead_yes || totalExemptionJurisdictions > 0 ? "Yes" : "No"}
              />
              <Fact
                label="Exemption Taxing Units"
                value={totalExemptionJurisdictions}
              />
              <Fact
                label="Linked MLS Sales"
                value={detail.sales_history?.length || 0}
              />
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Current Exemptions</h2>
            {exemptions.length ? (
              <div className="report-table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Taxing Unit</th>
                      <th className="numeric">Homestead</th>
                      <th className="numeric">Taxable Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exemptions.map(([key, row]) => (
                      <tr key={key}>
                        <td>{text(row.taxing_jurisdiction, key.replaceAll("_", " "))}</td>
                        <td className="numeric">{money(row.homestead_exemption)}</td>
                        <td className="numeric">{money(row.taxable_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="report-note">No current exemption rows were returned.</div>
            )}
          </section>
          <PageFooter generatedAt={generatedAt} />
        </article>

        <article className="report-page">
          <PageHeader page={2} title="Property Characteristics" address={address} />
          <section className="report-section">
            <h2 className="report-section-title">Building Characteristics</h2>
            <div className="report-facts">
              <Fact
                label="Living Area"
                value={count(
                  improvement.living_area_sqft || improvement.total_living_area,
                  " sq. ft.",
                )}
              />
              <Fact label="Total Area" value={count(improvement.total_area_sqft, " sq. ft.")} />
              <Fact label="Bedrooms" value={improvement.bedroom_count} />
              <Fact label="Bathrooms" value={bathDisplay} />
              <Fact label="Stories" value={improvement.stories} />
              <Fact label="Year Built" value={improvement.year_built} />
              <Fact label="Effective Year" value={improvement.effective_year_built} />
              <Fact label="Actual Age" value={improvement.actual_age} />
              <Fact label="Building Class" value={improvement.building_class} />
              <Fact label="Desirability" value={improvement.desirability} />
              <Fact label="Housing Type" value={housing.housing_type} />
              <Fact label="Attachment" value={housing.attachment_type} />
              <Fact label="Architectural Style" value={housing.architectural_style} wide />
              <Fact label="Construction" value={improvement.construction_type} />
              <Fact label="Foundation" value={improvement.foundation} />
              <Fact label="Exterior" value={improvement.exterior_material} />
              <Fact
                label="Roof"
                value={[improvement.roof_type, improvement.roof_material]
                  .filter(hasValue)
                  .join(" / ")}
              />
              <Fact label="Heating" value={improvement.heating} />
              <Fact label="Air Conditioning" value={improvement.air_conditioning} />
              <Fact label="Fireplaces" value={improvement.fireplaces} />
              <Fact label="Kitchens" value={improvement.kitchens} />
              <Fact label="Wet Bars" value={improvement.wetbars} />
              <Fact label="Pool" value={booleanText(improvement.pool)} />
              <Fact label="Sprinkler" value={booleanText(improvement.sprinkler)} />
              <Fact label="Fence" value={improvement.fence_type} />
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Land Details and Zoning</h2>
            <div className="report-facts">
              <Fact label="Primary Zoning" value={primaryZoning} wide />
              <Fact label="Total Land Area" value={landArea ? count(landArea, " sq. ft.") : null} />
              <Fact label="Land Value" value={money(values.land_value)} />
            </div>
            {landRows.length ? (
              <div className="report-table-wrap" style={{ marginTop: 10 }}>
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Use / State Code</th>
                      <th>Zoning</th>
                      <th className="numeric">Area</th>
                      <th className="numeric">Frontage x Depth</th>
                      <th>Pricing</th>
                      <th className="numeric">Adjusted Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {landRows.map((row, index) => (
                      <tr key={text(row.number, String(index))}>
                        <td>{text(row.state_code)}</td>
                        <td>{text(row.zoning)}</td>
                        <td className="numeric">{count(row.area_sqft, " sq. ft.")}</td>
                        <td className="numeric">
                          {hasValue(row.frontage_ft) || hasValue(row.depth_ft)
                            ? `${count(row.frontage_ft, " ft.")} x ${count(
                                row.depth_ft,
                                " ft.",
                              )}`
                            : "Not reported"}
                        </td>
                        <td>{text(row.pricing_method)}</td>
                        <td className="numeric">{money(row.adjusted_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Additional Improvements</h2>
            {additionalImprovements.length ? (
              <div className="report-table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Improvement</th>
                      <th>Construction</th>
                      <th>Floor / Exterior</th>
                      <th className="numeric">Area</th>
                      <th className="numeric">Year Built</th>
                    </tr>
                  </thead>
                  <tbody>
                    {additionalImprovements.map((row, index) => (
                      <tr key={text(row.number, String(index))}>
                        <td>{text(row.improvement_type)}</td>
                        <td>{text(row.construction)}</td>
                        <td>{[row.floor, row.exterior_wall].filter(hasValue).join(" / ")}</td>
                        <td className="numeric">{count(row.area_sqft, " sq. ft.")}</td>
                        <td className="numeric">{text(row.year_built)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="report-note">No additional improvement rows were returned.</div>
            )}
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Subject Sales History</h2>
            {detail.sales_history?.length ? (
              <div className="report-table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Sale Date</th>
                      <th>MLS</th>
                      <th className="numeric">Sale Price</th>
                      <th className="numeric">Days on Market</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.sales_history.slice(0, 5).map((sale, index) => (
                      <tr key={text(sale.source_record_id, String(index))}>
                        <td>{dateText(sale.closing_date)}</td>
                        <td>{text(sale.listing_id)}</td>
                        <td className="numeric">{money(sale.sale_price)}</td>
                        <td className="numeric">{text(sale.days_on_market)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="report-note">
                No linked MLS sale records were returned. The latest recorded deed transfer is{" "}
                {dateText(detail.legal_description?.deed_transfer_date)}.
              </div>
            )}
          </section>
          <PageFooter generatedAt={generatedAt} />
        </article>

        <article className="report-page">
          <PageHeader page={3} title="Sales Comparison Approach" address={address} />
          <section className="report-section">
            <div className="report-note">
              <strong>{salesSource}.</strong>{" "}
              {draft?.comparables?.length
                ? "The adjustments and indicated values below reflect the most recently saved sales-comparison workspace in this browser."
                : "No saved grid was found, so this rough report uses the current top-ranked sales with zero adjustments. Open the Sales Comparison page to select, rate, and adjust the final comparables."}
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Subject Reference</h2>
            <div className="report-facts">
              <Fact label="Subject" value={address} wide />
              <Fact
                label="Living Area"
                value={count(
                  draft?.subject?.livingArea ||
                    improvement.living_area_sqft ||
                    improvement.total_living_area,
                  " sq. ft.",
                )}
              />
              <Fact
                label="Beds / Baths"
                value={`${text(
                  draft?.subject?.bedrooms || improvement.bedroom_count,
                )} / ${bathDisplay}`}
              />
              <Fact label="Condition" value={draft?.subject?.condition} />
              <Fact label="Quality" value={draft?.subject?.quality} />
              <Fact label="Neighborhood" value={detail.property_location?.neighborhood} />
              <Fact label="CAD Market Value" value={money(values.market_value)} />
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Comparable Sales Grid</h2>
            {salesLoading ? (
              <div className="report-note">Loading preliminary comparable recommendations...</div>
            ) : comparables.length ? (
              <div className="report-table-wrap">
                <table className="report-table">
                  <colgroup>
                    <col style={{ width: "4%" }} />
                    <col style={{ width: "29%" }} />
                    <col style={{ width: "11%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "12%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Comparable</th>
                      <th>Sale Date</th>
                      <th className="numeric">Sale Price</th>
                      <th className="numeric">GLA</th>
                      <th>Condition / Quality</th>
                      <th className="numeric">Net Adj.</th>
                      <th className="numeric">Indicated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparables.slice(0, 6).map((comparable, index) => (
                      <tr
                        key={String(
                          comparable.sale.source_record_id ||
                            comparable.sale.listing_id ||
                            index,
                        )}
                      >
                        <td>{index + 1}</td>
                        <td>
                          <strong>{saleAddress(comparable.sale)}</strong>
                          <br />
                          MLS {text(comparable.sale.listing_id, "Not reported")}
                        </td>
                        <td>{dateText(comparable.sale.closing_date)}</td>
                        <td className="numeric">{money(comparable.sale.sale_price)}</td>
                        <td className="numeric">
                          {count(
                            comparable.sale.mls_living_area ||
                              comparable.sale.cad_living_area_sqft,
                            " sf",
                          )}
                        </td>
                        <td>
                          {text(comparable.condition, "Unrated")} /{" "}
                          {text(comparable.quality, "Unrated")}
                        </td>
                        <td className="numeric">
                          {signedMoney(comparable.netAdjustment)}
                        </td>
                        <td className="numeric">{money(comparable.indicatedValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="report-note">
                No comparable sales are available in the current report draft.
              </div>
            )}
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Adjustment Summary</h2>
            <div className="report-reconciliation">
              <div>
                <span>Indicated Range</span>
                <strong>{preliminaryRange}</strong>
              </div>
              <div>
                <span>Sales Comparison Opinion</span>
                <strong>{opinionOfValue ? money(opinionOfValue) : "Not reconciled"}</strong>
              </div>
              <div>
                <span>Selected Comparables</span>
                <strong>{comparables.length}</strong>
              </div>
            </div>
            <div className="report-note" style={{ marginTop: 10 }}>
              {draft?.adjustmentNotes ||
                "No market-supported adjustment methodology has been saved for this preliminary report."}
            </div>
          </section>
          <PageFooter generatedAt={generatedAt} />
        </article>

        <article className="report-page">
          <PageHeader page={4} title="Income Approach" address={address} />
          <section className="report-approach-hero">
            <div className="report-status">Preliminary methodology scaffold</div>
            <h2>Income Approach Not Yet Developed</h2>
            <p>
              This rough report reserves the income-approach section in the correct appraisal
              sequence. No rental income, vacancy, operating expense, gross-rent multiplier, or
              capitalization-rate assumptions have been entered, so no income indication is
              reported.
            </p>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">Inputs Required for Development</h2>
            <div className="report-input-grid">
              <div className="report-input-card">
                <strong>Market Rent</strong>
                <span>Comparable rental transactions, lease terms, concessions, and unit mix.</span>
              </div>
              <div className="report-input-card">
                <strong>Vacancy and Collection Loss</strong>
                <span>Market-supported stabilized vacancy and collection assumptions.</span>
              </div>
              <div className="report-input-card">
                <strong>Operating Expenses</strong>
                <span>Taxes, insurance, maintenance, management, utilities, and reserves.</span>
              </div>
              <div className="report-input-card">
                <strong>Capitalization Method</strong>
                <span>Direct capitalization rate or gross-rent multiplier supported by sales.</span>
              </div>
            </div>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">Current Conclusion</h2>
            <div className="report-facts">
              <Fact label="Approach Status" value="Not developed" />
              <Fact label="Income Indication" value="Not reported" />
              <Fact label="Reconciliation Weight" value="0% in this draft" />
              <Fact label="Review Requirement" value="Income data required" />
            </div>
          </section>
          <PageFooter generatedAt={generatedAt} />
        </article>

        <article className="report-page">
          <PageHeader page={5} title="Cost Approach" address={address} />
          <section className="report-approach-hero">
            <div className="report-status">Preliminary methodology scaffold</div>
            <h2>Cost Approach Not Yet Developed</h2>
            <p>
              The appraisal-district land and improvement data are carried into this section as
              reference points only. Replacement cost new, entrepreneurial incentive, physical
              depreciation, functional obsolescence, and external obsolescence have not yet been
              developed.
            </p>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">Available Subject Inputs</h2>
            <div className="report-facts">
              <Fact label="CAD Land Value" value={money(values.land_value)} />
              <Fact
                label="Main Improvement Area"
                value={count(
                  improvement.living_area_sqft || improvement.total_living_area,
                  " sq. ft.",
                )}
              />
              <Fact label="Year Built" value={improvement.year_built} />
              <Fact label="Effective Year" value={improvement.effective_year_built} />
              <Fact label="Construction" value={improvement.construction_type} />
              <Fact label="Building Class" value={improvement.building_class} />
              <Fact
                label="Additional Improvements"
                value={additionalImprovements.length}
              />
              <Fact label="CAD Improvement Value" value={money(values.improvement_value)} />
            </div>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">Inputs Required for Development</h2>
            <div className="report-input-grid">
              <div className="report-input-card">
                <strong>Replacement Cost New</strong>
                <span>Current cost-service rate, local multiplier, and indirect costs.</span>
              </div>
              <div className="report-input-card">
                <strong>Site Value Support</strong>
                <span>Comparable land sales or an allocation/extraction analysis.</span>
              </div>
              <div className="report-input-card">
                <strong>Accrued Depreciation</strong>
                <span>Physical deterioration, effective age, and remaining economic life.</span>
              </div>
              <div className="report-input-card">
                <strong>Obsolescence</strong>
                <span>Market evidence for functional and external obsolescence, if any.</span>
              </div>
            </div>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">Current Conclusion</h2>
            <div className="report-facts">
              <Fact label="Approach Status" value="Not developed" />
              <Fact label="Cost Indication" value="Not reported" />
              <Fact label="Reconciliation Weight" value="0% in this draft" />
              <Fact label="Review Requirement" value="Cost and depreciation data required" />
            </div>
          </section>
          <PageFooter generatedAt={generatedAt} />
        </article>
      </main>
    </div>
  );
}
