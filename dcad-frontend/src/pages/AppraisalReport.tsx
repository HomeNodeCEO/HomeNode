import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import * as api from "@/lib/api";
import type {
  AppraisalAssignmentFile,
  AssignmentDetailsPayload,
  PropertyComplexityAssessment,
  SaleRow,
} from "@/lib/api";
import type {
  MarketConditionsAnalysis,
  MarketConditionsSeriesPoint,
} from "@/lib/api";
import { fetchDetail } from "@/lib/dcad";
import {
  readAppraisalReportDraft,
  type AppraisalReportComparable,
  type AppraisalReportSalesDraft,
} from "@/lib/appraisalReportDraft";
import {
  readMarketConditionsDraft,
  type MarketConditionsDraft,
  type MarketTrendConclusion,
} from "@/lib/marketConditionsDraft";
import {
  calculateNeighborhoodRepresentativeness,
  neighborhoodBoundaryReadinessErrors,
  neighborhoodLandUseTotal,
  NEIGHBORHOOD_ALL_PROPERTY_ROWS,
  NEIGHBORHOOD_CITY_AVERAGE_ROWS,
  NEIGHBORHOOD_LAND_USE_FIELDS,
  NEIGHBORHOOD_RANGE_ROWS,
} from "@/lib/neighborhoodCharacteristics";
import type { CostApproachDraft } from "@/lib/costApproach";

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
  property_context?: PropertyComplexityAssessment | null;
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

function percent(value: unknown): string {
  const parsed = numberValue(value);
  if (parsed === null) return "Not reported";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(parsed)}%`;
}

function trendConclusionText(value: MarketTrendConclusion): string {
  const labels: Record<MarketTrendConclusion, string> = {
    increasing: "Increasing",
    stable: "Stable",
    decreasing: "Decreasing",
    mixed: "Mixed / transitional",
    insufficient: "Insufficient evidence",
  };
  return labels[value];
}

function neighborhoodChoiceLabel(value: unknown): string {
  const labels: Record<string, string> = {
    urban: "Urban",
    suburban: "Suburban",
    rural: "Rural",
    over_75: "Over 75%",
    "25_to_75": "25-75%",
    under_25: "Under 25%",
    rapid: "Rapid",
    stable: "Stable",
    slow: "Slow",
    increasing: "Increasing",
    declining: "Declining",
    shortage: "Shortage",
    in_balance: "In Balance",
    over_supply: "Over Supply",
    under_3_months: "Under 3 Months",
    "3_to_6_months": "3-6 Months",
    over_6_months: "Over 6 Months",
  };
  return labels[String(value || "")] || text(value);
}

function reportPeriodLabel(value: string | null): string {
  if (!value) return "Unknown";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "2-digit",
  }).format(parsed);
}

function ReportMedianPriceBars({
  points,
}: {
  points: MarketConditionsSeriesPoint[];
}) {
  const visible = points
    .filter((point) => numberValue(point.median_sale_price) !== null)
    .slice(-12);
  const maximum = Math.max(
    ...visible.map((point) => numberValue(point.median_sale_price) || 0),
    1,
  );
  if (!visible.length) {
    return <div className="report-note">Monthly trend data is not available.</div>;
  }
  return (
    <div className="report-market-bars">
      {visible.map((point) => {
        const value = numberValue(point.median_sale_price) || 0;
        return (
          <div
            className="report-market-bar-column"
            key={point.period_start || String(point.sale_count)}
          >
            <span>{money(value)}</span>
            <div
              className="report-market-bar"
              style={{
                height: `${Math.max(8, Math.round((value / maximum) * 88))}px`,
              }}
            />
            <strong>{reportPeriodLabel(point.period_start)}</strong>
            <small>{point.sale_count} sales</small>
          </div>
        );
      })}
    </div>
  );
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
        <span>Page {page} of 8</span>
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
  const requestedAssignmentFileId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const parsed = Number(params.get("assignmentFileId"));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, [location.search]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<AppraisalReportSalesDraft | null>(() =>
    readAppraisalReportDraft(propertyId),
  );
  const [marketDraft, setMarketDraft] = useState<MarketConditionsDraft | null>(
    () => readMarketConditionsDraft(propertyId),
  );
  const [costDraft, setCostDraft] = useState<CostApproachDraft | null>(null);
  const [assignmentFile, setAssignmentFile] = useState<AppraisalAssignmentFile | null>(null);
  const [assignmentLoading, setAssignmentLoading] = useState(Boolean(propertyId));
  const [printBlocker, setPrintBlocker] = useState("");
  const [pdfGenerating, setPdfGenerating] = useState(false);
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
    setMarketDraft(readMarketConditionsDraft(propertyId));
    setCostDraft(null);
  }, [propertyId]);

  useEffect(() => {
    let cancelled = false;
    if (!propertyId) {
      setAssignmentFile(null);
      setAssignmentLoading(false);
      return () => { cancelled = true; };
    }
    setAssignmentLoading(true);
    void api.getAssignmentFiles(propertyId)
      .then(async (response) => {
        if (cancelled) return;
        const selected = requestedAssignmentFileId
          ? response.files.find((file) => file.id === requestedAssignmentFileId) || null
          : response.latest_file;
        const assignment = selected || response.latest_file || null;
        setAssignmentFile(assignment);
        if (!assignment) return;
        const result = await api.getCustomAppraisalWorkfile(propertyId, assignment.id);
        if (cancelled) return;
        setDraft(
          (result.workfile.sections.sales_comparison?.value as AppraisalReportSalesDraft | undefined) ||
            readAppraisalReportDraft(propertyId),
        );
        setMarketDraft(
          (result.workfile.sections.market_conditions?.value as MarketConditionsDraft | undefined) ||
            readMarketConditionsDraft(propertyId),
        );
        setCostDraft(
          (result.workfile.sections.cost_approach?.value as CostApproachDraft | undefined) || null,
        );
      })
      .catch(() => {
        if (!cancelled) setAssignmentFile(null);
      })
      .finally(() => {
        if (!cancelled) setAssignmentLoading(false);
      });
    return () => { cancelled = true; };
  }, [propertyId, requestedAssignmentFileId]);

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
  const costApproachDeveloped = Boolean(costDraft?.developed && costDraft.rounded_indicated_value > 0);
  const indicatedValues = comparables
    .map((comparable) => comparable.indicatedValue)
    .filter((value) => Number.isFinite(value) && value > 0);
  const preliminaryRange =
    indicatedValues.length > 0
      ? `${money(Math.min(...indicatedValues))} to ${money(
          Math.max(...indicatedValues),
        )}`
      : "Not developed";
  const marketAnalyses = marketDraft?.response.analyses || [];
  const primaryMarketAnalysis: MarketConditionsAnalysis | null =
    marketAnalyses.find((analysis) =>
      marketDraft?.reconciliation.reliedUponAreaKeys.includes(
        analysis.market.key,
      ),
    ) ||
    marketAnalyses[0] ||
    null;
  const weightedMarketLabels = marketAnalyses
    .filter((analysis) =>
      marketDraft?.reconciliation.reliedUponAreaKeys.includes(
        analysis.market.key,
      ),
    )
    .map((analysis) => analysis.market.label);
  const neighborhoodDetails: AssignmentDetailsPayload = assignmentFile?.assignment_details || {};
  const assignmentTypeText = (neighborhoodDetails.assignment_types || [])
    .map((value) => value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()))
    .join(", ");
  const neighborhoodBoundaryErrors = neighborhoodBoundaryReadinessErrors(neighborhoodDetails);
  const landUseTotal = neighborhoodLandUseTotal(neighborhoodDetails);
  const neighborhoodRepresentativeness = calculateNeighborhoodRepresentativeness(neighborhoodDetails);
  const propertyContext = detail.property_context || null;

  const downloadServerReport = async () => {
    if (assignmentLoading) {
      setPrintBlocker("Assignment-file checks are still loading. Try again in a moment.");
      return;
    }
    if (!assignmentFile) {
      setPrintBlocker("Create or select an appraisal file before generating the report PDF.");
      return;
    }
    if (neighborhoodBoundaryErrors.length) {
      const message = `PDF E&O check: ${neighborhoodBoundaryErrors.join(" ")}`;
      setPrintBlocker(message);
      window.alert(message);
      return;
    }
    setPrintBlocker("");
    const editorKey = sessionStorage.getItem("homenode-editor-key") || window.prompt("Enter the HomeNode editor key to generate this appraisal PDF:", "")?.trim();
    if (!editorKey) return;
    sessionStorage.setItem("homenode-editor-key", editorKey);
    setPdfGenerating(true);
    try {
      const download = await api.downloadCustomAppraisalReportPdf(propertyId, assignmentFile.id, editorKey);
      const objectUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = download.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The appraisal PDF could not be generated.";
      if (/401|invalid_editor_key/i.test(message)) sessionStorage.removeItem("homenode-editor-key");
      setPrintBlocker(message);
    } finally {
      setPdfGenerating(false);
    }
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
          <a href="/" className="mt-4 inline-flex rounded-md bg-slate-900 px-4 py-2 text-white">
            Return to Property Search
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={`appraisal-report-shell ${neighborhoodBoundaryErrors.length ? "report-print-blocked" : ""}`}>
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
        .report-print-blocker-page { display: none; }
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
        .report-market-bars {
          display: flex;
          align-items: flex-end;
          gap: 6px;
          min-height: 130px;
          padding: 10px 8px 6px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          background: #f8fafc;
        }
        .report-market-bar-column {
          display: flex;
          min-width: 0;
          flex: 1 1 0;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          text-align: center;
        }
        .report-market-bar-column > span {
          margin-bottom: 3px;
          color: #334155;
          font-size: 6px;
          font-weight: 700;
          white-space: nowrap;
        }
        .report-market-bar {
          width: 72%;
          min-width: 12px;
          max-width: 34px;
          border-radius: 3px 3px 0 0;
          background: linear-gradient(to top, #047857, #34d399);
        }
        .report-market-bar-column > strong {
          margin-top: 3px;
          color: #334155;
          font-size: 6px;
          white-space: nowrap;
        }
        .report-market-bar-column > small {
          color: #94a3b8;
          font-size: 5.5px;
          white-space: nowrap;
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
          .report-print-blocked .report-document { display: none !important; }
          .report-print-blocked .report-print-blocker-page {
            display: block !important;
            padding: 0.75in;
            color: #7c2d12;
            font-size: 16px;
            line-height: 1.5;
          }
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
          .report-market-bars,
          .report-market-bar,
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
          <a href={`/report/${encodeURIComponent(propertyId)}`}>Property Report</a>
          <a href={`/ComparableSalesAnalysis?propertyId=${encodeURIComponent(propertyId)}`}>
            Sales Comparison
          </a>
          <button type="button" className="report-print-button" onClick={() => void downloadServerReport()} disabled={pdfGenerating}>
            {neighborhoodBoundaryErrors.length
              ? "Complete Boundary Review"
              : pdfGenerating
                ? "Building PDF..."
                : assignmentFile?.workfile?.status === "signed"
                  ? "Download Signed PDF"
                  : "Download Draft PDF"}
          </button>
        </div>
      </div>

      {(printBlocker || neighborhoodBoundaryErrors.length > 0) ? (
        <div className="mx-auto mt-3 w-[min(8.5in,calc(100%-24px))] rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-950 print:hidden">
          {printBlocker || `PDF E&O check: ${neighborhoodBoundaryErrors.join(" ")}`}
        </div>
      ) : null}
      <div className="report-print-blocker-page">
        <strong>PDF E&amp;O check incomplete.</strong>
        <div>{neighborhoodBoundaryErrors.join(" ")}</div>
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
                <br />
                Prepared For: {text(neighborhoodDetails.lender_client_name)}
                {hasValue(neighborhoodDetails.lender_client_address) ? (
                  <><br />{text(neighborhoodDetails.lender_client_address)}</>
                ) : null}
                <br />
                Assignment Type: {text(assignmentTypeText)}
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
              <Fact label="Occupancy" value={neighborhoodChoiceLabel(neighborhoodDetails.occupancy)} />
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
          <PageHeader page={3} title="Property Context & Complexity" address={address} />
          {propertyContext ? (
            <>
              <section className="report-section">
                <h2 className="report-section-title">Complexity Determination</h2>
                <div className="report-facts">
                  <Fact label="Automatic Recommendation" value={`${propertyContext.automatic_complexity} (${propertyContext.score}/100)`} />
                  <Fact label="Effective Complexity" value={propertyContext.effective_complexity} />
                  <Fact label="Confidence" value={propertyContext.confidence} />
                  <Fact label="Search Profile" value={propertyContext.recommended_search_profile.replaceAll("_", " - ")} />
                  <Fact label="Geography" value={propertyContext.geography.replaceAll("_", " ")} />
                  <Fact label="Peer Properties" value={propertyContext.peer_statistics.peer_count} />
                  <Fact label="Review Status" value={propertyContext.review_status} />
                  <Fact label="Computed" value={dateText(propertyContext.computed_at)} />
                </div>
              </section>

              <section className="report-section">
                <h2 className="report-section-title">Measured Complexity Factors</h2>
                {propertyContext.factors.length ? (
                  <div className="report-table-wrap">
                    <table className="report-table">
                      <thead><tr><th>Factor</th><th>Severity</th><th className="numeric">Points</th><th style={{ width: "55%" }}>Evidence</th></tr></thead>
                      <tbody>
                        {propertyContext.factors.map((factor) => (
                          <tr key={factor.code}>
                            <td>{factor.label}</td>
                            <td>{factor.severity}</td>
                            <td className="numeric">{factor.points}</td>
                            <td>{factor.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="report-note">No measured factor currently raises the automatic complexity score.</div>
                )}
              </section>

              <section className="report-section">
                <h2 className="report-section-title">Location Evidence</h2>
                <div className="report-facts">
                  <Fact label="Parcel Match" value={propertyContext.spatial_context.parcel_match_method} />
                  <Fact label="Site Percentile" value={percent(propertyContext.spatial_context.site_percentile)} />
                  <Fact label="Corner Lot" value={booleanText(propertyContext.spatial_context.corner_lot)} />
                  <Fact label="Road Frontages" value={propertyContext.spatial_context.road_frontages.join(", ")} />
                  <Fact label="Nearest Major Road" value={propertyContext.spatial_context.nearest_major_road ? `${text(propertyContext.spatial_context.nearest_major_road.name)} - ${count(propertyContext.spatial_context.nearest_major_road.distance_feet, " ft.")}` : null} wide />
                  <Fact label="Measured Traffic" value={propertyContext.spatial_context.nearest_high_traffic_road ? `${text(propertyContext.spatial_context.nearest_high_traffic_road.name)} - ${count(propertyContext.spatial_context.nearest_high_traffic_road.annual_average_daily_traffic, " vehicles/day")} at ${count(propertyContext.spatial_context.nearest_high_traffic_road.distance_feet, " ft.")}` : null} wide />
                  <Fact label="Nearest Railroad" value={propertyContext.spatial_context.nearest_railroad ? `${text(propertyContext.spatial_context.nearest_railroad.name)} - ${count(propertyContext.spatial_context.nearest_railroad.distance_feet, " ft.")}` : null} wide />
                  <Fact label="Adjacent External Uses" value={propertyContext.spatial_context.adjacent_influences.length} />
                  <Fact label="Nearby External Uses" value={propertyContext.spatial_context.nearby_influences.length} />
                </div>
              </section>

              <section className="report-section">
                <h2 className="report-section-title">Source Provenance and Freshness</h2>
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead><tr><th>Source</th><th>Status</th><th className="numeric">Records</th><th>Last Successful Refresh</th><th>Vintage</th></tr></thead>
                    <tbody>
                      {propertyContext.source_health.map((source) => (
                        <tr key={source.source_key}>
                          <td>{source.label}</td>
                          <td>{source.serving_stale_data ? "Stale local copy" : source.status}</td>
                          <td className="numeric">{source.row_count.toLocaleString()}</td>
                          <td>{dateText(source.last_success_at)}</td>
                          <td>{text(source.source_vintage)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {(propertyContext.warnings.length || propertyContext.appraiser_notes) ? (
                <section className="report-section">
                  <h2 className="report-section-title">Appraiser Review and Data Notices</h2>
                  <div className="report-note">
                    {propertyContext.appraiser_notes ? <div><strong>Appraiser notes:</strong> {propertyContext.appraiser_notes}</div> : null}
                    {propertyContext.warnings.map((warning) => <div key={warning}>• {warning}</div>)}
                  </div>
                </section>
              ) : null}
            </>
          ) : (
            <section className="report-section">
              <div className="report-note">Property context has not been analyzed for this assignment. Complete the local context review before final delivery.</div>
            </section>
          )}
          <PageFooter generatedAt={generatedAt} />
        </article>

        <article className="report-page">
          <PageHeader page={4} title="Neighborhood Characteristics" address={address} />
          <section className="report-section">
            <div className={`report-note ${neighborhoodBoundaryErrors.length ? "" : "report-status"}`}>
              <strong>{assignmentFile ? `Appraisal file ${assignmentFile.file_number}` : "No appraisal file selected"}.</strong>{" "}
              {neighborhoodBoundaryErrors.length
                ? `E&O review incomplete: ${neighborhoodBoundaryErrors.join(" ")}`
                : "The appraiser-defined neighborhood boundary was reviewed and confirmed for this assignment."}
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Present Land Use</h2>
            <div className="report-table-wrap">
              <table className="report-table">
                <thead><tr>{NEIGHBORHOOD_LAND_USE_FIELDS.map(([, label]) => <th key={label} className="numeric">{label}</th>)}</tr></thead>
                <tbody>
                  <tr>
                    {NEIGHBORHOOD_LAND_USE_FIELDS.map(([field]) => (
                      <td key={field} className="numeric">{percent(neighborhoodDetails[field])}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="report-note" style={{ marginTop: 8 }}>
              Reported land-use total: {landUseTotal === null ? "Not developed" : percent(landUseTotal)}.
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Neighborhood Factors</h2>
            <div className="report-facts">
              <Fact label="Location Type" value={neighborhoodChoiceLabel(neighborhoodDetails.neighborhood_location_type)} />
              <Fact label="Built-Up" value={neighborhoodChoiceLabel(neighborhoodDetails.neighborhood_built_up)} />
              <Fact label="Overall Growth" value={neighborhoodChoiceLabel(neighborhoodDetails.neighborhood_growth)} />
              <Fact label="Market Trend" value={neighborhoodChoiceLabel(neighborhoodDetails.neighborhood_market_trend)} />
              <Fact label="Demand / Supply" value={neighborhoodChoiceLabel(neighborhoodDetails.neighborhood_demand_supply)} />
              <Fact label="Marketing Time" value={neighborhoodChoiceLabel(neighborhoodDetails.neighborhood_marketing_time)} />
              <Fact
                label={`ZIP ${text(neighborhoodDetails.neighborhood_unemployment_zip)} Unemployment`}
                value={percent(neighborhoodDetails.neighborhood_unemployment_pct)}
              />
              <Fact
                label={`${text(neighborhoodDetails.neighborhood_city_unemployment_name, "City")} Unemployment`}
                value={percent(neighborhoodDetails.neighborhood_city_unemployment_pct)}
              />
              <Fact
                label="Unemployment Source"
                value={neighborhoodDetails.neighborhood_unemployment_source
                  ? `${neighborhoodDetails.neighborhood_unemployment_source}, ${text(neighborhoodDetails.neighborhood_unemployment_dataset_year)} ACS 5-Year, variable ${text(neighborhoodDetails.neighborhood_unemployment_variable)}. ZIP and city/place geographies.`
                  : null}
                wide
              />
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Neighborhood Sales and Property Profile</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div className="report-note"><strong>Neighborhood Sales Data (only includes sales)</strong><br />{count(neighborhoodDetails.neighborhood_sale_count)} closed sales in the selected period.</div>
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead><tr><th>Measure</th><th className="numeric">Low</th><th className="numeric">High</th><th className="numeric">Median</th></tr></thead>
                    <tbody>
                      {NEIGHBORHOOD_RANGE_ROWS.map((row) => {
                        const formatter = row.format === "money" ? money : count;
                        return (
                          <tr key={row.label}>
                            <td>{row.label}</td>
                            <td className="numeric">{formatter(neighborhoodDetails[row.low])}</td>
                            <td className="numeric">{formatter(neighborhoodDetails[row.high])}</td>
                            <td className="numeric">{formatter(neighborhoodDetails[row.predominant])}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <div className="report-note"><strong>Neighborhood Profile (All properties, sold and unsold)</strong><br />{count(neighborhoodDetails.neighborhood_all_property_count)} improved one-unit properties in the same boundary.</div>
                <div className="report-table-wrap">
                  <table className="report-table">
                    <thead><tr><th>Measure</th><th className="numeric">Low</th><th className="numeric">High</th><th className="numeric">Median</th></tr></thead>
                    <tbody>
                      {NEIGHBORHOOD_ALL_PROPERTY_ROWS.map((row) => {
                        const formatter = row.format === "money" ? money : count;
                        return (
                          <tr key={row.label}>
                            <td>{row.label}</td>
                            <td className="numeric">{formatter(neighborhoodDetails[row.low])}</td>
                            <td className="numeric">{formatter(neighborhoodDetails[row.high])}</td>
                            <td className="numeric">{formatter(neighborhoodDetails[row.predominant])}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="report-note" style={{ marginTop: 8 }}>
              <strong>Sales Sample Representativeness: {neighborhoodRepresentativeness.score === null ? "Pending" : `${neighborhoodRepresentativeness.score.toFixed(1)}%`} — {neighborhoodRepresentativeness.label}</strong>
              <div style={{ marginTop: 4 }}>{neighborhoodRepresentativeness.narrative}</div>
              <div style={{ marginTop: 4 }}>The score equally compares predominant value/price, value/price per square foot, age, and GLA. CAD market values and MLS sale prices have different valuation bases; the result is a descriptive reasonableness check subject to appraiser review.</div>
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Full-City Average Comparison</h2>
            <div className="report-note">
              The citywide study is a broader comparison and does not replace the appraiser-defined neighborhood ranges.
            </div>
            <div className="report-table-wrap">
              <table className="report-table">
                <thead><tr><th>City</th><th className="numeric">Sales</th>{NEIGHBORHOOD_CITY_AVERAGE_ROWS.map((row) => <th key={row.field} className="numeric">Avg. {row.label}</th>)}</tr></thead>
                <tbody>
                  <tr>
                    <td>{text(neighborhoodDetails.neighborhood_city_name)}</td>
                    <td className="numeric">{count(neighborhoodDetails.neighborhood_city_sale_count)}</td>
                    {NEIGHBORHOOD_CITY_AVERAGE_ROWS.map((row) => (
                      <td key={row.field} className="numeric">
                        {row.format === "money"
                          ? money(neighborhoodDetails[row.field])
                          : count(neighborhoodDetails[row.field])}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="report-note" style={{ marginTop: 8 }}>
              <strong>Median Predominant Value Analysis</strong>
              <div style={{ marginTop: 4 }}>
                {neighborhoodDetails.subject_concluded_value
                  ? `Concluded subject value: ${money(neighborhoodDetails.subject_concluded_value)}; predominant neighborhood value: ${money(neighborhoodDetails.neighborhood_house_price_predominant)}; difference: ${money(Math.abs(Number(neighborhoodDetails.neighborhood_value_difference) || 0))} (${Math.abs(Number(neighborhoodDetails.neighborhood_value_difference_pct) || 0).toFixed(1)}%).`
                  : "The subject value has not yet been concluded; the predominant-value comparison remains pending."}
              </div>
              {neighborhoodDetails.neighborhood_value_conclusion ? (
                <div style={{ marginTop: 4 }}>{String(neighborhoodDetails.neighborhood_value_conclusion)}</div>
              ) : null}
            </div>
          </section>

          <section className="report-section">
            <h2 className="report-section-title">Neighborhood Boundary</h2>
            <div className="report-facts">
              <Fact label="Boundary" value={neighborhoodDetails.neighborhood_boundary_label} wide />
              <Fact label="Source" value={neighborhoodDetails.neighborhood_boundary_source} />
              <Fact label="Market Study Saved" value={dateText(neighborhoodDetails.neighborhood_boundary_saved_at)} />
              <Fact label="North Boundary" value={neighborhoodDetails.neighborhood_boundary_north} />
              <Fact label="East Boundary" value={neighborhoodDetails.neighborhood_boundary_east} />
              <Fact label="South Boundary" value={neighborhoodDetails.neighborhood_boundary_south} />
              <Fact label="West Boundary" value={neighborhoodDetails.neighborhood_boundary_west} />
              <Fact label="Exclusions / Irregular Areas" value={neighborhoodDetails.neighborhood_boundary_exclusions} wide />
              <Fact label="Street Source" value={neighborhoodDetails.neighborhood_boundary_streets_source} wide />
              <Fact label="Appraiser Confirmed" value={neighborhoodDetails.neighborhood_boundary_confirmed ? "Yes" : "No"} />
              <Fact label="Confirmed At" value={dateText(neighborhoodDetails.neighborhood_boundary_confirmed_at)} />
              <Fact
                label="Automated Boundary Confidence"
                value={neighborhoodDetails.neighborhood_boundary_engine_confidence}
              />
              <Fact
                label="Relevant Dataset Confidence"
                value={neighborhoodDetails.neighborhood_relevance_confidence}
              />
              <Fact
                label="Relevant Parcels"
                value={neighborhoodDetails.neighborhood_relevance_included_count}
              />
              <Fact
                label="Excluded Parcels"
                value={neighborhoodDetails.neighborhood_relevance_excluded_count}
              />
              <Fact
                label="Insufficient-Data Review"
                value={neighborhoodDetails.neighborhood_relevance_insufficient_data_count}
              />
            </div>
            {neighborhoodDetails.neighborhood_boundary_engine_disclosure ? (
              <div className="report-note" style={{ marginTop: 8 }}>
                <strong>Boundary and Data-Relevance Distinction</strong>
                <div style={{ marginTop: 4 }}>
                  {String(neighborhoodDetails.neighborhood_boundary_engine_disclosure)}
                </div>
              </div>
            ) : null}
          </section>
          <PageFooter generatedAt={generatedAt} />
        </article>

        <article className="report-page">
          <PageHeader page={5} title="Market Conditions" address={address} />
          {marketDraft && marketAnalyses.length ? (
            <>
              <section className="report-section">
                <div className="report-note">
                  <strong>
                    {marketAnalyses.length} independent market{" "}
                    {marketAnalyses.length === 1 ? "study" : "studies"}.
                  </strong>{" "}
                  The selected areas were analyzed separately and did not limit
                  or alter the comparable-sales inventory. The study covers{" "}
                  {marketDraft.periodMonths} complete calendar months from{" "}
                  {dateText(marketAnalyses[0]?.period.start)} through{" "}
                  {dateText(marketAnalyses[0]?.period.end)}. The analysis-as-of
                  date is {dateText(marketDraft.asOfDate)}.
                </div>
              </section>

              <section className="report-section">
                <h2 className="report-section-title">Geographic Study Comparison</h2>
                <div className="report-table-wrap">
                  <table className="report-table">
                    <colgroup>
                      <col style={{ width: "31%" }} />
                      <col style={{ width: "9%" }} />
                      <col style={{ width: "17%" }} />
                      <col style={{ width: "13%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "15%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Study Area</th>
                        <th className="numeric">Sales</th>
                        <th className="numeric">Median Price</th>
                        <th className="numeric">Median DOM</th>
                        <th className="numeric">Sale/List</th>
                        <th className="numeric">Price/SF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {marketAnalyses.map((analysis) => (
                        <tr key={analysis.market.key}>
                          <td>
                            <strong>{analysis.market.label}</strong>
                            {marketDraft.reconciliation.reliedUponAreaKeys.includes(
                              analysis.market.key,
                            ) && <div>Given appraisal weight</div>}
                          </td>
                          <td className="numeric">
                            {analysis.population.eligible_sale_count.toLocaleString()}
                          </td>
                          <td className="numeric">
                            {money(analysis.summary.median_sale_price)}
                          </td>
                          <td className="numeric">
                            {count(analysis.summary.median_days_on_market)}
                          </td>
                          <td className="numeric">
                            {percent(analysis.summary.median_sale_to_list_ratio)}
                          </td>
                          <td className="numeric">
                            {money(analysis.summary.median_price_per_square_foot)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="report-section">
                <h2 className="report-section-title">
                  Monthly Median Sale Price
                  {primaryMarketAnalysis
                    ? ` - ${primaryMarketAnalysis.market.label}`
                    : ""}
                </h2>
                <ReportMedianPriceBars
                  points={primaryMarketAnalysis?.series.monthly || []}
                />
              </section>

              <section className="report-section">
                <h2 className="report-section-title">Market Reconciliation</h2>
                <div className="report-reconciliation">
                  <div>
                    <span>Market Trend Conclusion</span>
                    <strong>
                      {trendConclusionText(
                        marketDraft.reconciliation.trendConclusion,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Studies Given Weight</span>
                    <strong>
                      {weightedMarketLabels.length
                        ? weightedMarketLabels.join(", ")
                        : "Not selected"}
                    </strong>
                  </div>
                  <div>
                    <span>Total Studies Reviewed</span>
                    <strong>{marketAnalyses.length}</strong>
                  </div>
                </div>
                <div className="report-note" style={{ marginTop: 10 }}>
                  {marketDraft.reconciliation.explanation ||
                    "The appraiser has not yet entered a market reconciliation explanation."}
                </div>
              </section>
            </>
          ) : (
            <section className="report-section">
              <div className="report-note">
                No completed Market Conditions Analysis was saved for this
                subject. Complete the independent city, ZIP, radius, or custom
                area studies from the Sales Comparison Approach page before
                relying on a market-trend conclusion.
              </div>
            </section>
          )}
          <PageFooter generatedAt={generatedAt} />
        </article>

        <article className="report-page">
          <PageHeader page={6} title="Sales Comparison Approach" address={address} />
          <section className="report-section">
            <div className="report-note">
              <strong>{salesSource}.</strong>{" "}
              {draft?.comparables?.length
                ? "The adjustments and indicated values below reflect the saved sales-comparison workspace for this appraisal file."
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
          <PageHeader page={7} title="Income Approach" address={address} />
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
          <PageHeader page={8} title="Cost Approach" address={address} />
          <section className="report-approach-hero">
            <div className="report-status">
              {costApproachDeveloped ? "Developed appraisal approach" : "Preliminary methodology scaffold"}
            </div>
            <h2>{costApproachDeveloped ? "Cost Approach" : "Cost Approach Not Yet Developed"}</h2>
            <p>{costApproachDeveloped
              ? text(costDraft?.summary || costDraft?.methodology)
              : "The appraisal-district land and improvement data are carried into this section as reference points only. Replacement cost new, entrepreneurial incentive, physical depreciation, functional obsolescence, and external obsolescence have not yet been fully developed."}</p>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">
              {costApproachDeveloped ? "Cost Basis and Subject Inputs" : "Available Subject Inputs"}
            </h2>
            <div className="report-facts">
              <Fact label="Cost Data Source" value={costDraft?.source_name} />
              <Fact label="Source Reference" value={costDraft?.source_reference} />
              <Fact label="Cost Effective Date" value={costDraft?.as_of_date} />
              <Fact label="Local Multiplier" value={costDraft?.local_multiplier} />
              <Fact
                label="Main Improvement Area"
                value={count(costDraft?.living_area_sqft || improvement.living_area_sqft || improvement.total_living_area, " sq. ft.")}
              />
              <Fact label="Base Cost / SF" value={money(costDraft?.cost_per_sqft)} />
              <Fact label="Dwelling Base Cost" value={money(costDraft?.dwelling_base_cost)} />
              <Fact label="Other Improvements" value={money(costDraft?.other_improvements_total)} />
            </div>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">Replacement Cost and Accrued Depreciation</h2>
            <div className="report-facts">
              <Fact label="Direct Cost" value={money(costDraft?.direct_cost_before_incentive)} />
              <Fact label="Entrepreneurial Incentive" value={money(costDraft?.entrepreneurial_incentive)} />
              <Fact label="Replacement Cost New" value={money(costDraft?.replacement_cost_new)} />
              <Fact label="Effective Age / Economic Life" value={costDraft ? `${text(costDraft.effective_age)} / ${text(costDraft.economic_life)} years` : "Not reported"} />
              <Fact label="Physical Depreciation" value={money(costDraft?.physical_depreciation)} />
              <Fact label="Functional Obsolescence" value={money(costDraft?.functional_obsolescence)} />
              <Fact label="External Obsolescence" value={money(costDraft?.external_obsolescence)} />
              <Fact label="Depreciated Improvements" value={money(costDraft?.depreciated_improvement_value)} />
            </div>
          </section>
          <section className="report-section">
            <h2 className="report-section-title">Current Conclusion</h2>
            <div className="report-facts">
              <Fact label="Site Value" value={money(costDraft?.site_value)} />
              <Fact label="Site Improvements" value={money(costDraft?.site_improvements_value)} />
              <Fact label="Cost Indication" value={money(costDraft?.rounded_indicated_value)} />
              <Fact label="Reconciliation Weight" value={costDraft ? `${costDraft.weight}%` : "0% in this draft"} />
              <Fact label="Approach Status" value={costApproachDeveloped ? "Developed" : "Not developed"} />
              <Fact label="Review Requirement" value={costApproachDeveloped ? "Appraiser reconciliation required" : "Cost and depreciation data required"} wide />
            </div>
            {costDraft?.methodology ? <p className="report-note">{costDraft.methodology}</p> : null}
          </section>
          <PageFooter generatedAt={generatedAt} />
        </article>
      </main>
    </div>
  );
}
