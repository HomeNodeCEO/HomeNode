// src/pages/PropertyReport.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { fetchDetail } from "@/lib/dcad";

/* =========================
   Types (relaxed for speed)
   ========================= */
type DcadOwner = {
  owner_name?: string;
  mailing_address?: string;
  owner_type?: string;
  ownership_pct?: string;
  mineral_rights?: string;
  deed_type?: string;
  purchase_price?: string;
  grantor?: string;
  notes?: string;
  multi_owner?: {
    owner_name?: string;
    mailing_address?: string;
    owner_type?: string;
    ownership_pct?: string;
  }[];
};

type DcadValueSummary = {
  certified_year?: number | string;
  improvement_value?: string | number;
  land_value?: string | number;
  market_value?: string | number;
  capped_value?: string | number;
  tax_agent?: string;
  revaluation_year?: string;
  previous_revaluation_year?: string;
};

type DcadMainImprovement = {
  building_class?: string;
  year_built?: string | number;
  effective_year_built?: string | number;
  actual_age?: string | number;
  desirability?: string;
  living_area_sqft?: string | number;
  total_area_sqft?: string | number;
  percent_complete?: string | number;
  stories?: number | string;
  stories_text?: string;
  depreciation_pct?: string;
  construction_type?: string;
  foundation?: string;
  roof_type?: string;
  roof_material?: string;
  exterior_material?: string;
  basement?: string;
  heating?: string;
  air_conditioning?: string;
  baths_full?: string | number;
  baths_half?: string | number;
  kitchens?: string | number;
  wet_bars?: string | number;
  fireplaces?: string | number;
  sprinkler?: string;
  deck?: string;
  spa?: string;
  pool?: string;
  sauna?: string;
};

type DcadLandRow = {
  number?: string;
  state_code?: string;
  zoning?: string;
  frontage_ft?: string;
  depth_ft?: string;
  area_sqft?: string;
  pricing_method?: string;
  unit_price?: string;
  market_adjustment_pct?: string;
  adjusted_price?: string;
  ag_land?: string;
};

type DcadImprovementRow = {
  number?: string;
  improvement_type?: string;
  construction?: string;
  floor?: string;
  exterior_wall?: string;
  area_sqft?: string;
};

type DcadExemptionsMap = {
  city?: { taxing_jurisdiction?: string; homestead_exemption?: string; taxable_value?: string };
  school?: { taxing_jurisdiction?: string; homestead_exemption?: string; taxable_value?: string };
  county?: { taxing_jurisdiction?: string; homestead_exemption?: string; taxable_value?: string };
  college?: { taxing_jurisdiction?: string; homestead_exemption?: string; taxable_value?: string };
  hospital?: { taxing_jurisdiction?: string; homestead_exemption?: string; taxable_value?: string };
  special_district?: { taxing_jurisdiction?: string; homestead_exemption?: string; taxable_value?: string };
};

type DcadHistory = {
  owner_history?: {
    year?: number;
    owner?: string;
    legal_description?: string[];
    deed_transfer_date?: string;
  }[];
  market_value?: {
    year?: number;
    improvement?: string;
    land?: string;
    total_market?: string;
    homestead_capped?: string;
  }[];
  taxable_value?: {
    year?: number;
    city?: string;
    isd?: string;
    county?: string;
    college?: string;
    hospital?: string;
    special_district?: string;
  }[];
  history_url?: string;
};

type DcadLegal = {
  lines?: string[];
  deed_transfer_date?: string;
};

type DcadExemptionDetails = {
  applicant_name?: string;
  ownership_pct?: string;
  homestead_date?: string;
  homestead_pct?: string;
  other?: string;
  other_pct?: string;
  other_disabled_date?: string;
  disabled_person?: string;
  disabled_pct?: string;
  tax_deferred?: string;
  transferred?: string;
  defer?: string;
  capped_homestead?: string;
  market_value?: string;
  details_url?: string;
};

type DcadDetail = {
  tax_year?: number;
  property_location?: {
    address?: string;
    neighborhood?: string;
    mapsco?: string;
    city?: string;
  };
  owner?: DcadOwner;
  value_summary?: DcadValueSummary;
  main_improvement?: DcadMainImprovement;
  additional_improvements?: DcadImprovementRow[];
  land_detail?: DcadLandRow[];
  exemptions?: DcadExemptionsMap;
  history?: DcadHistory;
  legal_description?: DcadLegal;
  exemption_details?: DcadExemptionDetails;
  arb_hearing?: { hearing_info?: string };
  estimated_taxes_total?: string;
  photos?: string[];
};

/* ==============
   Shared Utils
   ============== */
function nonEmpty(v: any): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

function LabelValue({ label, value }: { label: string; value?: any }) {
  const show = nonEmpty(value) ? String(value) : "—";
  return (
    <div className="flex flex-col">
      <div className="text-xs opacity-60">{label}</div>
      <div className="text-sm">{show}</div>
    </div>
  );
}

function SectionCard({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card bg-base-100 shadow-sm rounded-2xl ${className}`}>
      <div className="card-body p-4">
        <div className="text-base font-semibold mb-2">{title}</div>
        {children}
      </div>
    </div>
  );
}

/* =========================================================================
   AddressHero (carousel + top row + full-width 2x3 stat grid with icons)
   ========================================================================= */
function AddressHero({ detail, accountId }: { detail: DcadDetail | null; accountId?: string }) {
  const [idx, setIdx] = useState(0);

  const photos = useMemo<string[]>(() => {
    const fromApi = (detail as any)?.photos as string[] | undefined;
    if (fromApi && fromApi.length > 0) return fromApi;
    return [
      "https://images.unsplash.com/photo-1568605114967-8130f3a36994?q=80&w=2100&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?q=80&w=2100&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1580587771525-78b9dba3b914?q=80&w=2100&auto=format&fit=crop",
    ];
  }, [detail]);

  const canSlide = photos.length > 1;
  const goPrev = () => setIdx((p) => (p - 1 + photos.length) % photos.length);
  const goNext = () => setIdx((p) => (p + 1) % photos.length);

  // Prefer nested property_location.address, but gracefully fallback to common backend fields
  const resolveAddress = (d: any): string => {
    const a =
      d?.property_location?.address ??
      d?.address ??
      d?.situs_address ??
      d?.property_location?.situs_address ??
      d?.location_address ??
      "";
    return typeof a === "string" ? a.trim() : String(a || "").trim();
  };
  const address = resolveAddress(detail) || "—";
  const neighborhood = detail?.property_location?.neighborhood || "";
  const mapsco = detail?.property_location?.mapsco || "";

  const jurisdictions = ["County", "School", "City", "Hospital", "Other"];

  // ---- money helpers (local) ----
  const currency = (n: number | null | undefined) =>
    typeof n === "number"
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        }).format(n)
      : "—";

  const parseMoney = (s?: string | number | null): number | null => {
    if (s === null || s === undefined) return null;
    if (typeof s === "number") return s;
    const cleaned = String(s).replace(/[^0-9.-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  // Prefer the raw JSON string if present; otherwise format the parsed number.
  const showMoney = (raw?: string | number | null): string => {
    if (raw === null || raw === undefined || raw === "") return "—";
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(n)) return currency(n as number);
    return String(raw);
  };

  const v = detail?.value_summary;
  const marketValNum = parseMoney(v?.market_value);
  const assessValNum = parseMoney(v?.capped_value) ?? marketValNum;
  const improvementValNum = parseMoney(v?.improvement_value);
  const landValNum = parseMoney(v?.land_value);
  const cappedLossNum =
    marketValNum != null && assessValNum != null ? Math.max(0, marketValNum - assessValNum) : null;

  const taxAgent = v?.tax_agent || "-";

  // Owner name for CTA (used to prefill signup form when navigating)
  const ownerNameForCta = useMemo(() => {
    const o: any = (detail as any)?.owner || {};
    const fromOwner = o?.owner_name || o?.name || '';
    const fromMulti = Array.isArray(o?.multi_owner) && o.multi_owner.length
      ? (o.multi_owner[0]?.owner_name || o.multi_owner[0]?.name || '')
      : '';
    const fromHistory = Array.isArray((detail as any)?.history?.owner_history) && (detail as any).history.owner_history.length
      ? ((detail as any).history.owner_history[0]?.owner || '')
      : '';
    return String(fromOwner || fromMulti || fromHistory || '').trim();
  }, [detail]);

  /* ---------- Icon primitives (inline SVGs) ---------- */
  const IconBox = ({
    children,
    colorClass,
    colorStyle,
  }: {
    children: ReactNode;
    colorClass?: string;
    colorStyle?: React.CSSProperties;
  }) => (
    <div
      className={`flex items-center justify-center rounded-md border shrink-0 ${colorClass || ""}`}
      style={{
        backgroundColor: "#e2e8f0", // icon square fill
        borderColor: "#e2e8f0", // icon square outline
        height: "2.5rem",
        width: "2.5rem",
        ...(colorStyle || {}),
      }}
    >
      {children}
    </div>
  );

  const DollarIcon = () => <span className="font-bold text-lg leading-none">$</span>;

  const CourthouseIcon = () => (
    <svg
      viewBox="0 0 24 24"
      className="w-6 h-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 10h18" />
      <path d="M5 10 12 6l7 4" />
      <path d="M6 10v8M12 10v8M18 10v8" />
      <path d="M9 18h6" />
    </svg>
  );

  const TrendingDownIcon = () => (
    <svg
      viewBox="0 0 24 24"
      className="w-6 h-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 16l-6-6-4 4-6-6" />
      <path d="M21 16h-6v-6" />
    </svg>
  );

  const BuildingIcon = () => (
    <svg
      viewBox="0 0 24 24"
      className="w-6 h-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="3" width="12" height="18" rx="1" />
      <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M12 21v-4" />
    </svg>
  );

  const MapPinIcon = () => (
    <svg
      viewBox="0 0 24 24"
      className="w-6 h-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s-7-5.5-7-10a7 7 0 1 1 14 0c0 4.5-7 10-7 10z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );

  const PersonTieIcon = () => (
    <svg
      viewBox="0 0 24 24"
      className="w-6 h-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="7" r="3" />
      <path d="M6 21v-3a6 6 0 0 1 12 0v3" />
      <path d="M12 10l1 2-1 2-1-2 1-2z" />
    </svg>
  );

  // Tile with #f4f7fa bg, subtle border, shadow, icon on left, CTA on right
  const StatBox = ({
    label,
    value,
    cta,
    icon,
  }: {
    label: string;
    value: string;
    cta: string;
    icon: ReactNode;
  }) => (
    <div
      className="rounded-lg border shadow p-3"
      style={{ backgroundColor: "#f4f7fa", borderColor: "#d7e1ea" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {icon}
          <div className="min-w-0">
            <div className="text-xl uppercase tracking-wide opacity-60 font-medium">
              {label}
            </div>
            <div className="text-xl font-semibold mt-0.5 truncate">{value}</div>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm normal-case rounded-md px-4 py-2 bg-green-600 border-green-600 text-white hover:bg-green-700 hover:border-green-700"
        >
          {cta}
        </button>
      </div>
    </div>
  );

  return (
    <div className="card bg-white shadow-lg overflow-hidden rounded-2xl" style={{ backgroundColor: "#ffffff" }}>
      {/* Slider */}
      <figure className="relative">
        <img src={photos[idx]} alt="Property" className="w-full h-60 object-cover select-none" draggable={false} />
        {canSlide && (
          <>
            <button
              type="button"
              onClick={goPrev}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-gray-300/95 hover:bg-gray-400 text-gray-800 flex items-center justify-center shadow-lg border border-gray-400/70 ring-1 ring-gray-400/40 backdrop-blur-[1px] focus:outline-none focus:ring-2 focus:ring-white/90"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button
              type="button"
              onClick={goNext}
              aria-label="Next image"
              className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 rounded-full bg-gray-300/95 hover:bg-gray-400 text-gray-800 flex items-center justify-center shadow-lg border border-gray-400/70 ring-1 ring-gray-400/40 backdrop-blur-[1px] focus:outline-none focus:ring-2 focus:ring-white/90"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
            </button>
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 rounded-full bg-black/30 px-3 py-1.5 flex gap-1.5 backdrop-blur-[1px]">
              {photos.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setIdx(i)}
                  aria-label={`Go to image ${i + 1}`}
                  className={
                    "h-2.5 w-2.5 rounded-full border transition " +
                    (i === idx ? "bg-gray-300 border-gray-200" : "bg-white/70 hover:bg-white border-white/80")
                  }
                />
              ))}
            </div>
          </>
        )}
      </figure>

      {/* Body */}
      <div className="card-body p-4 bg-white" style={{ backgroundColor: "#ffffff" }}>
        {/* Top row: LEFT (address + chips) | RIGHT (actions) */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          {/* LEFT */}
          <div className="flex-1">
            <div className="text-xl font-semibold">{address}</div>
            <div className="text-sm opacity-70">
              {neighborhood && <span>Neighborhood: {neighborhood}</span>}
              {neighborhood && mapsco ? <span> · </span> : null}
              {mapsco && <span>MAPSCO: {mapsco}</span>}
            </div>

            {/* Jurisdiction chips */}
            <div className="mt-3 flex flex-wrap gap-2">
              {jurisdictions.map((label) => (
                <button
                  key={label}
                  type="button"
                  className="inline-flex items-center rounded-full px-3 py-1.5 text-sm font-medium bg-blue-100 text-blue-800 border border-blue-200 hover:bg-blue-200 transition"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* RIGHT */}
          <div className="flex items-center gap-2 self-start md:self-auto">
            <Link
              to={accountId ? `/signup?accountId=${encodeURIComponent(accountId)}${ownerNameForCta ? `&ownerName=${encodeURIComponent(ownerNameForCta)}` : ''}` : '/signup'}
              aria-label="Sign up (No upfront cost)"
              className="btn normal-case px-4 py-2 rounded-md bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700 hover:border-emerald-700"
            >
              Sign Up Here (No Upfront Cost)
            </Link>
            <Link
              to={accountId ? `/ComparableSalesAnalysis?propertyId=${encodeURIComponent(accountId)}` : "#"}
              aria-label="Generate Protest Packet"
              className="btn normal-case px-5 py-2 rounded-md bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700 hover:border-emerald-700"
            >
              Generate Protest Packet
            </Link>
            <button
              type="button"
              aria-label="Open change log"
              className="btn normal-case px-5 py-2 rounded-md bg-blue-700 border-blue-700 text-white hover:bg-blue-800 hover:border-blue-800"
            >
              Change Log
            </button>
            <button
              type="button"
              aria-label="Generate PDF"
              className="btn normal-case px-5 py-2 rounded-md bg-red-600 border-red-600 text-white hover:bg-red-700 hover:border-red-700"
            >
              Generate PDF
            </button>
          </div>
        </div>

        {/* FULL-WIDTH 2x3 stats grid (with icons & colors) */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <StatBox
            label="Market Value"
            value={showMoney(v?.market_value)}
            cta="Sales"
            icon={
              <IconBox colorClass="text-green-700">
                <DollarIcon />
              </IconBox>
            }
          />

          <StatBox
            label="Assessed Value"
            value={showMoney(v?.capped_value ?? v?.market_value)}
            cta="History"
            icon={
              <IconBox colorClass="text-blue-700">
                <CourthouseIcon />
              </IconBox>
            }
          />

          <StatBox
            label="Land Value"
            value={showMoney(v?.land_value)}
            cta="Sales"
            icon={
              <IconBox colorClass="text-orange-600">
                <MapPinIcon />
              </IconBox>
            }
          />

          <StatBox
            label="Improvement Value"
            value={showMoney(v?.improvement_value)}
            cta="Cost"
            icon={
              <IconBox colorClass="text-purple-700">
                <BuildingIcon />
              </IconBox>
            }
          />

          <StatBox
            label="Cap Loss"
            value={showMoney(cappedLossNum)}
            cta="Detail"
            icon={
              <IconBox colorClass="text-red-700">
                <TrendingDownIcon />
              </IconBox>
            }
          />

          <StatBox
            label="Tax Agent"
            value={taxAgent}
            cta="Data"
            icon={
              <IconBox colorStyle={{ color: "#8b4513" }}>
                <PersonTieIcon />
              </IconBox>
            }
          />
        </div>
      </div>
    </div>
  );
}

/* ==================
   Ownership Card
   ================== */
function OwnerAndLegal({ detail }: { detail: DcadDetail | null }) {
  const owner = (detail?.owner || {}) as DcadOwner;
  const legal = detail?.legal_description;

  // ---- helpers ----
  const show = (v?: any) =>
    v === null || v === undefined || String(v).trim() === "" ? "—" : String(v);

  // Trim ISO timestamps to YYYY-MM-DD (keep existing date format, drop time/zone)
  const dateOnly = (v: any) => {
    if (v === null || v === undefined) return v;
    const s = String(v);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : s;
  };

  const YesNoPill = ({ yes }: { yes: boolean | null | undefined }) => (
    <span
      className={
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium " +
        (yes ? "bg-gray-900 text-white" : "bg-gray-200 text-gray-700")
      }
    >
      {yes ? "Yes" : "No"}
    </span>
  );

  // Homestead: infer from exemption details or exemptions map
  const homesteadYes =
    !!(detail?.exemption_details?.homestead_date || detail?.exemption_details?.homestead_pct) ||
    !!(
      detail?.exemptions &&
      Object.values(detail.exemptions).some(
        (r: any) => r?.homestead_exemption && String(r.homestead_exemption).trim() !== ""
      )
    );

  // Agricultural use: heuristic based on land_detail
  const agUseYes = !!detail?.land_detail?.some((r) => {
    const v = (r.ag_land || r.state_code || "").toString().toLowerCase();
    return v.includes("ag");
  });

  // Optional/mineral rights field if present
  const mineralRights = owner?.mineral_rights || "—";

  // Deed / ownership details
  const deedDate =
    legal?.deed_transfer_date ||
    detail?.history?.owner_history?.find((h) => !!h.deed_transfer_date)?.deed_transfer_date ||
    "—";
  const deedType = owner?.deed_type || "—";
  const purchasePrice = owner?.purchase_price || "—";
  const grantor = owner?.grantor || "—";

  // Current owner
  const ownerName = show(owner?.owner_name);
  const ownerMailing = show(
    owner?.mailing_address || (owner as any)?.mailing || (owner as any)?.address
  );
  const ownerType = show(owner?.owner_type || "Individual");
  const ownerPct = show(owner?.ownership_pct || "100%");

  // Additional owners
  const others: Array<any> = Array.isArray(owner?.multi_owner) ? owner.multi_owner! : [];

  return (
    <SectionCard title="Ownership Information">
      {/* Two-column layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Current Owner */}
        <div>
          <div className="text-sm font-semibold mb-2">Current Owner</div>
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-[170px,1fr] gap-3">
              <div className="opacity-70">Name &amp; Mailing Address:</div>
              <div>
                <div className="font-medium">{ownerName}</div>
                <div className="font-semibold">{ownerMailing}</div>
              </div>
            </div>
            <div className="grid grid-cols-[170px,1fr] gap-3">
              <div className="opacity-70">Owner Type:</div>
              <div>{ownerType}</div>
            </div>
            <div className="grid grid-cols-[170px,1fr] gap-3">
              <div className="opacity-70">Ownership %:</div>
              <div className="font-semibold">{ownerPct}</div>
            </div>
          </div>
        </div>

        {/* Ownership Details */}
        <div>
          <div className="text-sm font-semibold mb-2">Ownership Details</div>
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-[170px,1fr] gap-3">
              <div className="opacity-70">Deed Date:</div>
              <div className="font-semibold">{show(dateOnly(deedDate))}</div>
            </div>
            <div className="grid grid-cols-[170px,1fr] gap-3">
              <div className="opacity-70">Deed Type:</div>
              <div className="font-semibold">{show(deedType)}</div>
            </div>
            <div className="grid grid-cols-[170px,1fr] gap-3">
              <div className="opacity-70">Purchase Price:</div>
              <div className="font-semibold">{show(purchasePrice)}</div>
            </div>
            <div className="grid grid-cols-[170px,1fr] gap-3">
              <div className="opacity-70">Grantor:</div>
              <div className="font-semibold">{show(grantor)}</div>
            </div>
          </div>
        </div>

        {/* Additional Info */}
        <div className="md:col-span-1">
          <div className="text-sm font-semibold mb-2">Additional Info</div>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[170px,1fr] items-center gap-3">
              <div className="opacity-70">Homestead:</div>
              <YesNoPill yes={homesteadYes} />
            </div>
            <div className="grid grid-cols-[170px,1fr] items-center gap-3">
              <div className="opacity-70">Agricultural Use:</div>
              <YesNoPill yes={agUseYes} />
            </div>
            <div className="grid grid-cols-[170px,1fr] items-center gap-3">
              <div className="opacity-70">Mineral Rights:</div>
              <div className="font-semibold">{show(mineralRights)}</div>
            </div>
            <div className="grid grid-cols-[170px,1fr] items-start gap-3">
              <div className="opacity-70">Legal Description:</div>
              <div className="font-semibold whitespace-pre-wrap">
                {legal?.lines?.length ? legal.lines.join("\n") : "—"}
              </div>
            </div>
          </div>
        </div>

        {/* Additional Owners */}
        <div className="md:col-span-1">
          <div className="text-sm font-semibold mb-2">Additional Owners</div>
          {others.length ? (
            <div className="space-y-3">
              {others.map((o, i) => {
                const name = show(o?.owner_name);
                const mailing = show(o?.mailing_address || o?.mailing || o?.address);
                const type = show(o?.owner_type);
                const pct = show(o?.ownership_pct);
                return (
                  <div key={i} className="rounded-lg border border-base-200 p-3">
                    <div className="grid grid-cols-[170px,1fr] gap-3 text-sm">
                      <div className="opacity-70">Owner Name &amp; Mailing Address:</div>
                      <div>
                        <div className="font-medium">{name}</div>
                        <div className="font-semibold">{mailing}</div>
                      </div>
                      <div className="opacity-70">Owner Type:</div>
                      <div>{type}</div>
                      <div className="opacity-70">Ownership %:</div>
                      <div className="font-semibold">{pct}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm opacity-70">No additional owners.</div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="border-t mt-4 pt-4" />

      {/* Notes row */}
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-semibold">Notes</div>
        <button
          type="button"
          className="btn btn-ghost btn-sm normal-case"
          aria-label="Edit notes"
          title="Edit notes"
        >
          <svg
            viewBox="0 0 24 24"
            className="w-4 h-4 mr-1"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
          Edit
        </button>
      </div>
      <div className="mt-2 text-sm opacity-80">
        {show(owner?.notes || (detail as any)?.notes)}
      </div>

      <div className="border-t mt-4" />
    </SectionCard>
  );
}

/* (Value Summary card removed; information shown in Address Hero) */

function PropertySpecs({ detail }: { detail: DcadDetail | null }) {
  const m = detail?.main_improvement as any;
  // Default Total Room Count: bedroom count + 3, with fallbacks for bedroom source
  const bedsRaw = m?.bedroom_count ?? (detail as any)?.bedroom_count ?? (detail as any)?.characteristics?.bedrooms;
  const bedsNum = typeof bedsRaw === 'string' ? Number(String(bedsRaw).replace(/[^0-9.-]/g, '')) : Number(bedsRaw);
  const totalRoomCount = Number.isFinite(bedsNum) ? bedsNum + 3 : undefined;
  return (
    <SectionCard title="Property Specifications">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <LabelValue label="Year Built" value={m?.year_built} />
        <LabelValue label="Effective Year" value={m?.effective_year_built} />
        <LabelValue label="Living Area (sqft)" value={m?.living_area_sqft} />
        <LabelValue label="Total Area (sqft)" value={m?.total_area_sqft} />
        <LabelValue label="Stories" value={m?.stories_text || m?.stories} />
        <LabelValue label="Baths (Full)" value={m?.baths_full} />
        <LabelValue label="Baths (Half)" value={m?.baths_half} />
        <LabelValue label="Kitchens" value={m?.kitchens} />
        <LabelValue label="Fireplaces" value={m?.fireplaces} />
        <LabelValue label="Heating" value={m?.heating} />
        <LabelValue label="A/C" value={m?.air_conditioning} />
        <LabelValue label="Exterior" value={m?.exterior_material} />
        <LabelValue label="Roof Type" value={m?.roof_type} />
        <LabelValue label="Roof Material" value={m?.roof_material} />
        <LabelValue label="Foundation" value={m?.foundation} />
        <LabelValue label="Construction" value={m?.construction_type} />
        {/* Additional fields requested */}
        <LabelValue label="Building Class" value={m?.building_class} />
        <LabelValue label="Percent Complete" value={m?.percent_complete} />
        <LabelValue label="Depreciation" value={(m as any)?.depreciation || (m as any)?.depreciation_pct} />
        <LabelValue label="Wet Bars" value={(m as any)?.wetbars ?? (m as any)?.wet_bars} />
        <LabelValue label="Sprinkler" value={m?.sprinkler} />
        <LabelValue label="Deck" value={m?.deck} />
        <LabelValue label="Spa" value={m?.spa} />
        <LabelValue label="Pool" value={m?.pool} />
        <LabelValue label="Sauna" value={m?.sauna} />
        <LabelValue label="Total Room Count" value={totalRoomCount} />
      </div>
    </SectionCard>
  );
}

function LandDetails({ rows }: { rows: DcadLandRow[] | undefined }) {
  return (
    <SectionCard title="Land Details">
      {rows?.length ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>#</th>
                <th>State Code</th>
                <th>Zoning</th>
                <th>Frontage (ft)</th>
                <th>Depth (ft)</th>
                <th>Area (sqft)</th>
                <th>Pricing Method</th>
                <th>Unit Price</th>
                <th>Adj. Price</th>
                <th>Market Adj.</th>
                <th>Ag Land</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.number || i + 1}</td>
                  <td>{r.state_code || "—"}</td>
                  <td>{r.zoning || "—"}</td>
                  <td>{r.frontage_ft || "—"}</td>
                  <td>{r.depth_ft || "—"}</td>
                  <td>{r.area_sqft || "—"}</td>
                  <td>{r.pricing_method || "—"}</td>
                  <td>{r.unit_price || "—"}</td>
                  <td>{r.adjusted_price || "—"}</td>
                  <td>{r.market_adjustment_pct || "—"}</td>
                  <td>{r.ag_land || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-sm opacity-70">No land details.</div>
      )}
    </SectionCard>
  );
}

function AdditionalImprovements({ rows }: { rows: DcadImprovementRow[] | undefined }) {
  return (
    <SectionCard title="Additional Improvements">
      {rows?.length ? (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>Construction</th>
                <th>Floor</th>
                <th>Exterior Wall</th>
                <th>Area (sqft)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.number || i + 1}</td>
                  <td>{r.improvement_type || "—"}</td>
                  <td>{r.construction || "—"}</td>
                  <td>{r.floor || "—"}</td>
                  <td>{r.exterior_wall || "—"}</td>
                  <td>{r.area_sqft || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-sm opacity-70">No additional improvements.</div>
      )}
    </SectionCard>
  );
}

function ExemptionsCard({ ex }: { ex?: DcadExemptionsMap }) {
  const order: (keyof DcadExemptionsMap)[] = [
    "city",
    "school",
    "county",
    "college",
    "hospital",
    "special_district",
  ];

  return (
    <SectionCard title="Exemptions (Current Year)">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {order.map((key) => {
          const row = ex?.[key];
          return (
            <div key={key} className="rounded-xl border border-base-200 p-3">
              <div className="text-sm font-medium mb-1">
                {row?.taxing_jurisdiction || key.replace(/_/g, ' ').toUpperCase()}
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm">
                <LabelValue label="Homestead Exemption" value={row?.homestead_exemption} />
                <LabelValue label="Taxable Value" value={row?.taxable_value} />
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function ExemptionDetailsCard({ d }: { d?: DcadExemptionDetails }) {
  if (!d) return null;
  return (
    <SectionCard title="Exemption Details">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <LabelValue label="Applicant" value={d.applicant_name} />
        <LabelValue label="Ownership %" value={d.ownership_pct} />
        <LabelValue label="Homestead Date" value={d.homestead_date} />
        <LabelValue label="Homestead %" value={d.homestead_pct} />
        <LabelValue label="Other" value={d.other} />
        <LabelValue label="Other %" value={d.other_pct} />
        <LabelValue label="Disabled Person" value={d.disabled_person} />
        <LabelValue label="Disabled %" value={d.disabled_pct} />
        <LabelValue label="Tax Deferred" value={d.tax_deferred} />
        <LabelValue label="Transferred" value={d.transferred} />
        <LabelValue label="Defer" value={d.defer} />
        <LabelValue label="Capped Homestead" value={d.capped_homestead} />
        <LabelValue label="Market Value" value={d.market_value} />
      </div>
    </SectionCard>
  );
}

function HistoryCard({ history }: { history?: DcadHistory }) {
  if (!history) return null;

  return (
    <SectionCard title="History">
      <div className="space-y-6">
        {/* Owner History */}
        <div>
          <div className="text-sm font-medium mb-2">Owner History</div>
          {history.owner_history?.length ? (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Owner</th>
                    <th>Legal Description</th>
                    <th>Deed Transfer</th>
                  </tr>
                </thead>
                <tbody>
                  {history.owner_history.map((h, i) => (
                    <tr key={i}>
                      <td>{h.year ?? "—"}</td>
                      <td className="whitespace-pre-wrap">{h.owner || "—"}</td>
                      <td className="whitespace-pre-wrap">
                        {h.legal_description?.length ? h.legal_description.join("\n") : "—"}
                      </td>
                      <td>{h.deed_transfer_date || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm opacity-70">No owner history.</div>
          )}
        </div>

        {/* Market Value History */}
        <div>
          <div className="text-sm font-medium mb-2">Market Value by Year</div>
          {history.market_value?.length ? (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Improvement</th>
                    <th>Land</th>
                    <th>Total Market</th>
                    <th>Homestead Capped</th>
                  </tr>
                </thead>
                <tbody>
                  {history.market_value.map((h, i) => (
                    <tr key={i}>
                      <td>{h.year ?? "—"}</td>
                      <td>{h.improvement || "—"}</td>
                      <td>{h.land || "—"}</td>
                      <td>{h.total_market || "—"}</td>
                      <td>{h.homestead_capped || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm opacity-70">No market value history.</div>
          )}
        </div>

        {/* Taxable Value History */}
        <div>
          <div className="text-sm font-medium mb-2">Taxable Value by Year</div>
          {history.taxable_value?.length ? (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>City</th>
                    <th>ISD</th>
                    <th>County</th>
                    <th>College</th>
                    <th>Hospital</th>
                    <th>Special District</th>
                  </tr>
                </thead>
                <tbody>
                  {history.taxable_value.map((h, i) => (
                    <tr key={i}>
                      <td>{h.year ?? "—"}</td>
                      <td>{h.city || "—"}</td>
                      <td>{h.isd || "—"}</td>
                      <td>{h.county || "—"}</td>
                      <td>{h.college || "—"}</td>
                      <td>{h.hospital || "—"}</td>
                      <td>{h.special_district || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm opacity-70">No taxable value history.</div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function OwnershipHistoryCard({ history }: { history?: DcadHistory }) {
  const rows = history?.owner_history || [];
  if (!rows || rows.length === 0) return null;
  return (
    <SectionCard title="Ownership History">
      <div className="overflow-auto" style={{ maxHeight: 280 }}>
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Year</th>
              <th>Owner</th>
              <th>Legal Description</th>
              <th>Deed Transfer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h: any, i: number) => {
              const year = h.year ?? h.observed_year ?? '�?"';
              const owner = h.owner ?? (Array.isArray(h.owner_lines) ? h.owner_lines.join("\n") : '�?"');
              const legal = Array.isArray(h.legal_description) ? h.legal_description.join("\n")
                           : Array.isArray(h.legal_description_lines) ? h.legal_description_lines.join("\n")
                           : '�?"';
              const deed = h.deed_transfer_date ?? h.deed_transfer_date_iso ?? h.deed_transfer_date_raw ?? '�?"';
              return (
                <tr key={i}>
                  <td>{year}</td>
                  <td className="whitespace-pre-wrap">{owner}</td>
                  <td className="whitespace-pre-wrap">{legal}</td>
                  <td>{deed}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function MarketValueHistoryCard({ history }: { history?: DcadHistory }) {
  const rows = history?.market_value || [];
  if (!rows || rows.length === 0) return null;
  return (
    <SectionCard title="Market Value History">
      <div className="overflow-auto" style={{ maxHeight: 280 }}>
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Year</th>
              <th>Improvement</th>
              <th>Land</th>
              <th>Total Market</th>
              <th>Homestead Capped</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((mv, i) => (
              <tr key={i}>
                <td>{mv.year ?? "?"}</td>
                <td>{mv.improvement ?? "?"}</td>
                <td>{mv.land ?? "?"}</td>
                <td>{mv.total_market ?? "?"}</td>
                <td>{mv.homestead_capped ?? "?"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function TaxableValueHistoryCard({ history }: { history?: DcadHistory }) {
  const rows = history?.taxable_value || [];
  if (!rows || rows.length === 0) return null;
  return (
    <SectionCard title="Taxable Value History">
      <div className="overflow-auto" style={{ maxHeight: 280 }}>
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Year</th>
              <th>City</th>
              <th>ISD</th>
              <th>County</th>
              <th>College</th>
              <th>Hospital</th>
              <th>Special District</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tv, i) => (
              <tr key={i}>
                <td>{tv.year ?? "?"}</td>
                <td>{tv.city ?? "?"}</td>
                <td>{tv.isd ?? "?"}</td>
                <td>{tv.county ?? "?"}</td>
                <td>{tv.college ?? "?"}</td>
                <td>{tv.hospital ?? "?"}</td>
                <td>{tv.special_district ?? "?"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function ExemptionHistoryCard({ history }: { history?: DcadHistory }) {
  const years = history?.exemptions || [] as any[];
  if (!years || years.length === 0) return null;

  // Flatten into rows: (year, category, taxing_jurisdiction, homestead_exemption, taxable_value)
  const rows: Array<{year: number|string, category: string, tj: string, he: string, tv: string}> = [];
  const order = ["city","school","county","college","hospital","special_district"];
  for (const y of years) {
    const ex = (y as any).exemptions || {};
    for (const cat of order) {
      const r = ex[cat];
      if (r) {
        rows.push({
          year: (y as any).year ?? "?",
          category: cat,
          tj: r.taxing_jurisdiction ?? "?",
          he: r.homestead_exemption ?? "?",
          tv: r.taxable_value ?? "?",
        });
      } else {
        // include empty row to show absence explicitly
        rows.push({ year: (y as any).year ?? "?", category: cat, tj: "?", he: "?", tv: "?" });
      }
    }
  }

  return (
    <SectionCard title="Exemption History">
      <div className="overflow-auto" style={{ maxHeight: 280 }}>
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Year</th>
              <th>Category</th>
              <th>Taxing Jurisdiction</th>
              <th>Homestead Exemption</th>
              <th>Taxable Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.year}</td>
                <td>{r.category}</td>
                <td>{r.tj}</td>
                <td>{r.he}</td>
                <td>{r.tv}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function ArbAndTaxes({ detail }: { detail: DcadDetail | null }) {
  const hearing = detail?.arb_hearing?.hearing_info;
  const estTotal = detail?.estimated_taxes_total;
  const et = (detail as any)?.estimated_taxes as any | undefined;
  const hasTable = !!et;

  if (!hearing && !estTotal && !hasTable) return null;

  const order = ["city", "school", "county", "college", "hospital", "special_district"];
  const rows = order.map((k) => ({ key: k, ...(et?.[k] || {}) }));

  return (
    <SectionCard title="ARB & Estimated Taxes">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
        <LabelValue label="ARB Hearing" value={hearing} />
        <LabelValue label="Estimated Taxes (Total)" value={estTotal} />
      </div>

      {hasTable && (
        <div className="overflow-auto" style={{ maxHeight: 280 }}>
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Jurisdiction</th>
                <th>Taxing Unit</th>
                <th>Rate per $100</th>
                <th>Taxable Value</th>
                <th>Estimated Taxes</th>
                <th>Tax Ceiling</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{String(r.key).replace(/_/g, ' ')}</td>
                  <td>{r.taxing_unit ?? '?'}</td>
                  <td>{r.tax_rate_per_100 ?? '?'}</td>
                  <td>{r.taxable_value ?? '?'}</td>
                  <td>{r.estimated_taxes ?? '?'}</td>
                  <td>{r.tax_ceiling ?? '?'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/* =====
   Page
   ===== */
export default function PropertyReport() {
  const location = useLocation();
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>();

  const presetAccount = useMemo(() => {
    if (routeAccountId) return routeAccountId;
    const p = new URLSearchParams(location.search);
    return p.get("account_id") || p.get("account") || "";
  }, [location.search, routeAccountId]);

  const [account, setAccount] = useState(presetAccount);
  const [detail, setDetail] = useState<DcadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState<any>(null);
  const hasAutoImported = useRef(false);

  async function importFromDCAD() {
    if (!account) {
      alert("Enter an Account ID first.");
      return;
    }
    setLoading(true);
    try {
      const resp = await fetchDetail(account);
      setRaw(resp);
      setDetail(resp?.detail ?? null);
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Import failed");
    } finally {
      setLoading(false);
    }
  }

  // Auto-import once if account is present in the URL
  useEffect(() => {
    if (!hasAutoImported.current && account) {
      hasAutoImported.current = true;
      importFromDCAD();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  return (
    <div className="min-h-screen bg-base-200">
      {/* Top bar */}
      <div className="navbar bg-base-100 shadow-sm">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3">
              <span className="text-xl font-semibold">Property Report</span>
            </div>
            <Link to="/" className="btn btn-ghost btn-sm normal-case">
              ← Close Report
            </Link>
          </div>
        </div>
      </div>

      {/* Body container */}
      <div className="container mx-auto px-4 py-4 space-y-4">
        {/* Import helper */}
        <div className="card bg-base-100 rounded-2xl shadow-sm">
          <div className="card-body p-4">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              <label className="text-sm font-medium opacity-70">Account ID</label>
              <input
                className="input input-bordered w-full sm:w-64"
                placeholder="e.g. 26272500060150000"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              />
              <button
                className="btn btn-primary normal-case"
                onClick={importFromDCAD}
                disabled={loading || !account}
              >
                {loading ? "Importing..." : "Import"}
              </button>
            </div>
          </div>
        </div>

        {/* Address hero (full width) */}
        <AddressHero detail={detail} accountId={account} />

        {/* Ownership (full width) */}
        <OwnerAndLegal detail={detail} />

        {/* Ownership History (full width, scrollable) */}
        <OwnershipHistoryCard history={detail?.history} />

        {/* Value Summary removed (duplicated by Address Hero) */}

        {/* Specs (full width) */}
        <PropertySpecs detail={detail} />

        {/* Land + Additional Improvements */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <LandDetails rows={detail?.land_detail} />
          {(() => {
            const src = (detail?.additional_improvements || []) as any[];
            const normalized = src.map((r, i) => ({
              number: r.number ?? r.imp_num ?? i + 1,
              improvement_type: r.improvement_type ?? r.imp_type ?? '',
              construction: r.construction ?? '',
              floor: r.floor ?? r.floor_type ?? '',
              exterior_wall: r.exterior_wall ?? r.ext_wall ?? '',
              area_sqft: r.area_sqft ?? r.area_size ?? '',
            }));
            return <AdditionalImprovements rows={normalized as any} />;
          })()}
        </div>

        {/* Exemptions map */}
        <ExemptionsCard ex={detail?.exemptions} />

        {/* Exemption details */}
        <ExemptionDetailsCard d={detail?.exemption_details} />

        {/* Exemption History */}
        <ExemptionHistoryCard history={detail?.history} />

        {/* Market Value History */}
        <MarketValueHistoryCard history={detail?.history} />

        {/* Taxable Value History */}
        <TaxableValueHistoryCard history={detail?.history} />

        {/* ARB + Estimated taxes */}
        <ArbAndTaxes detail={detail} />

        {/* Raw JSON to help mapping while we wire the rest */}
        <details className="mt-2">
          <summary className="cursor-pointer">Show raw API JSON</summary>
          <pre className="whitespace-pre-wrap bg-base-100 p-3 rounded-xl text-xs">
{JSON.stringify(raw, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}



