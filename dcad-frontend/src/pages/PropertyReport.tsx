import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { fetchDetail } from "@/lib/dcad";
import {
  getAccountPhotos,
  getRelatedParcels,
  updatePropertyReportSections,
  type ReportManualSectionKey,
  type RelatedParcelsResponse,
} from "@/lib/api";

type DcadOwner = {
  owner_name?: string;
  mailing_address?: string;
};

type DcadValueSummary = {
  certified_year?: number | string;
  improvement_value?: string | number;
  land_value?: string | number;
  market_value?: string | number;
  capped_value?: string | number;
};

type DcadMainImprovement = {
  building_class?: string;
  year_built?: string | number;
  effective_year_built?: string | number;
  actual_age?: string | number;
  desirability?: string;
  living_area_sqft?: string | number;
  total_living_area?: string | number;
  total_area_sqft?: string | number;
  percent_complete?: string | number;
  stories?: number | string;
  construction_type?: string;
  foundation?: string;
  roof_type?: string;
  roof_material?: string;
  exterior_material?: string;
  basement?: boolean | string;
  heating?: string;
  air_conditioning?: string;
  bedroom_count?: string | number;
  bath_count?: string | number;
  baths_full?: string | number;
  baths_half?: string | number;
  kitchens?: string | number;
  wetbars?: string | number;
  fireplaces?: string | number;
  sprinkler?: boolean | string;
  spa?: boolean | string;
  pool?: boolean | string;
  sauna?: boolean | string;
  fence_type?: string;
  number_units?: string | number;
};

type DcadLandRow = {
  number?: string | number;
  state_code?: string;
  zoning?: string;
  frontage_ft?: string | number;
  depth_ft?: string | number;
  area_sqft?: string | number;
  pricing_method?: string;
  unit_price?: string | number;
  market_adjustment_pct?: string | number;
  adjusted_price?: string | number;
  ag_land?: string;
};

type DcadImprovementRow = {
  number?: string | number;
  improvement_type?: string;
  construction?: string;
  floor?: string;
  exterior_wall?: string;
  area_sqft?: string | number;
  value?: string | number;
  year_built?: string | number;
};

type DcadExemptionRow = {
  taxing_jurisdiction?: string;
  homestead_exemption?: string | number;
  disabled_vet?: string | number;
  taxable_value?: string | number;
};

type DcadExemptionsMap = {
  city?: DcadExemptionRow;
  school?: DcadExemptionRow;
  county?: DcadExemptionRow;
  college?: DcadExemptionRow;
  hospital?: DcadExemptionRow;
  special_district?: DcadExemptionRow;
};

type DcadSaleHistoryRow = {
  source_record_id?: string | number;
  listing_id?: string;
  closing_date?: string;
  sale_price?: string | number;
  days_on_market?: string | number;
  buyer_financing?: string;
  mls_status?: string;
  record_type?: string;
};

type DcadHousingProfile = {
  structural_style?: string;
  housing_type?: string;
  attachment_type?: string;
  architectural_style?: string;
  profile_source?: string;
};

type DcadDetail = {
  tax_year?: number;
  property_location?: {
    address?: string;
    neighborhood?: string;
    mapsco?: string;
    city?: string;
    postal_code?: string;
    county?: string;
    subdivision?: string;
  };
  owner?: DcadOwner;
  value_summary?: DcadValueSummary;
  main_improvement?: DcadMainImprovement;
  housing_profile?: DcadHousingProfile;
  additional_improvements?: DcadImprovementRow[];
  land_detail?: DcadLandRow[];
  exemptions?: DcadExemptionsMap;
  legal_description?: {
    lines?: string[];
    deed_transfer_date?: string;
  };
  sales_history?: DcadSaleHistoryRow[];
  homestead_yes?: boolean;
  photos?: string[];
  report_manual_values?: Partial<Record<ReportManualSectionKey, unknown>>;
};

type EditableReportSection = {
  key: ReportManualSectionKey;
  title: string;
};

const EDITABLE_REPORT_SECTIONS: EditableReportSection[] = [
  { key: "report.subject_identification", title: "Subject Identification" },
  { key: "report.exemptions", title: "Current Exemptions" },
  { key: "report.sales_history", title: "Sales History" },
  { key: "report.property_characteristics", title: "Property Characteristics" },
  { key: "report.land_details", title: "Land Details and Zoning" },
  { key: "report.appraisal_values", title: "Appraisal District Values" },
];

const ARRAY_ROW_TEMPLATES: Record<string, Record<string, unknown>> = {
  sales_history: {
    closing_date: "",
    listing_id: "",
    sale_price: "",
    days_on_market: "",
    buyer_financing: "",
  },
  land_detail: {
    number: "",
    state_code: "",
    zoning: "",
    frontage_ft: "",
    depth_ft: "",
    area_sqft: "",
    pricing_method: "",
    adjusted_price: "",
  },
  additional_improvements: {
    improvement_type: "",
    construction: "",
    floor: "",
    exterior_wall: "",
    area_sqft: "",
    value: "",
    year_built: "",
  },
};

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function displayValue(value: unknown, fallback = "Not reported"): string {
  return hasValue(value) ? String(value) : fallback;
}

function parseNumber(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const parsed =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value: unknown): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Not reported";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(parsed);
}

function formatNumber(value: unknown, suffix = ""): string {
  const parsed = parseNumber(value);
  if (parsed === null) return "Not reported";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(parsed)}${suffix}`;
}

function formatDate(value: unknown): string {
  if (!hasValue(value)) return "Not reported";
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatReportedBoolean(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (!hasValue(value)) return "Not reported";
  const normalized = String(value).trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(normalized)) return "Yes";
  if (["no", "n", "false", "0"].includes(normalized)) return "No";
  return String(value);
}

function formatBaths(improvement?: DcadMainImprovement): string {
  const full = parseNumber(improvement?.baths_full);
  const half = parseNumber(improvement?.baths_half);
  if (full !== null || half !== null) {
    return `${full ?? 0} full / ${half ?? 0} half`;
  }
  return displayValue(improvement?.bath_count);
}

function SummarySection({
  title,
  subtitle,
  children,
  onEdit,
  manuallyVerified = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onEdit?: () => void;
  manuallyVerified?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
              {title}
            </h2>
            {manuallyVerified ? (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-blue-800">
                Manually verified
              </span>
            ) : null}
          </div>
          {subtitle ? <p className="mt-1 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        {onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
          >
            Edit
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function SummaryField({
  label,
  value,
  className = "",
}: {
  label: string;
  value?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold text-slate-900">
        {value ?? "Not reported"}
      </div>
    </div>
  );
}

function editorLabel(key: string): string {
  const overrides: Record<string, string> = {
    mls_status: "MLS Status",
    listing_id: "MLS Number",
    area_sqft: "Area (Sq. Ft.)",
    living_area_sqft: "Living Area (Sq. Ft.)",
    total_area_sqft: "Total Area (Sq. Ft.)",
    postal_code: "ZIP Code",
    baths_full: "Full Baths",
    baths_half: "Half Baths",
    homestead_yes: "Homestead",
  };
  return overrides[key] || key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cloneEditorValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}

function editorValueAtPath(
  root: Record<string, unknown>,
  path: Array<string | number>,
): unknown {
  let cursor: unknown = root;
  path.forEach((segment) => {
    if (Array.isArray(cursor) && typeof segment === "number") {
      cursor = cursor[segment];
    } else if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[String(segment)];
    } else {
      throw new Error("Invalid report editor field path");
    }
  });
  return cursor;
}

function ReportSectionEditor({
  section,
  initialValue,
  saving,
  onCancel,
  onSave,
}: {
  section: EditableReportSection;
  initialValue: Record<string, unknown>;
  saving: boolean;
  onCancel: () => void;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    cloneEditorValue(initialValue),
  );

  useEffect(() => {
    setDraft(cloneEditorValue(initialValue));
  }, [initialValue, section.key]);

  const updateAtPath = (path: Array<string | number>, nextValue: unknown) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const parent = editorValueAtPath(next, path.slice(0, -1));
      const finalSegment = path[path.length - 1];
      if (Array.isArray(parent) && typeof finalSegment === "number") {
        parent[finalSegment] = nextValue;
      } else if (parent && typeof parent === "object") {
        (parent as Record<string, unknown>)[String(finalSegment)] = nextValue;
      }
      return next;
    });
  };

  const removeArrayItem = (path: Array<string | number>, index: number) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const cursor = editorValueAtPath(next, path);
      if (Array.isArray(cursor)) cursor.splice(index, 1);
      return next;
    });
  };

  const addArrayItem = (path: Array<string | number>, key: string) => {
    setDraft((current) => {
      const next = cloneEditorValue(current);
      const cursor = editorValueAtPath(next, path);
      if (Array.isArray(cursor)) {
        cursor.push(cloneEditorValue(ARRAY_ROW_TEMPLATES[key] || {}));
      }
      return next;
    });
  };

  const renderValue = (
    value: unknown,
    path: Array<string | number>,
    key: string,
  ): ReactNode => {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === "string")) {
        return (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              {editorLabel(key)}
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-24 w-full bg-white"
              value={value.join("\n")}
              onChange={(event) =>
                updateAtPath(path, event.target.value.split("\n").filter(Boolean))
              }
            />
          </label>
        );
      }
      return (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-800">{editorLabel(key)}</div>
            <button
              type="button"
              onClick={() => addArrayItem(path, key)}
              className="btn btn-xs normal-case border-blue-300 bg-white text-blue-800"
            >
              Add record
            </button>
          </div>
          {value.length ? value.map((item, index) => (
            <div key={index} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">Record {index + 1}</span>
                <button
                  type="button"
                  onClick={() => removeArrayItem(path, index)}
                  className="btn btn-ghost btn-xs normal-case text-rose-700"
                >
                  Remove
                </button>
              </div>
              {renderValue(item, [...path, index], `${key}_${index + 1}`)}
            </div>
          )) : (
            <div className="text-xs text-slate-500">No records. Select Add record to create one.</div>
          )}
        </div>
      );
    }
    if (value && typeof value === "object") {
      return (
        <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-slate-800">
            {editorLabel(key)}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => (
              <div
                key={childKey}
                className={Array.isArray(childValue) || (childValue && typeof childValue === "object")
                  ? "sm:col-span-2"
                  : ""}
              >
                {renderValue(childValue, [...path, childKey], childKey)}
              </div>
            ))}
          </div>
        </fieldset>
      );
    }
    if (typeof value === "boolean") {
      return (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            {editorLabel(key)}
          </span>
          <select
            className="select select-bordered mt-1 w-full bg-white"
            value={value ? "true" : "false"}
            onChange={(event) => updateAtPath(path, event.target.value === "true")}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      );
    }
    if (key === "attachment_type") {
      return (
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Attachment Type
          </span>
          <select
            className="select select-bordered mt-1 w-full bg-white"
            value={value == null ? "unknown" : String(value)}
            onChange={(event) => updateAtPath(path, event.target.value)}
          >
            <option value="detached">Detached</option>
            <option value="attached">Attached</option>
            <option value="mixed">Mixed</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      );
    }
    const isLongText = ["legal_text", "mailing_address", "notes"].includes(key);
    return (
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          {editorLabel(key)}
        </span>
        {isLongText ? (
          <textarea
            className="textarea textarea-bordered mt-1 w-full bg-white"
            value={value == null ? "" : String(value)}
            onChange={(event) => updateAtPath(path, event.target.value)}
          />
        ) : (
          <input
            type={key.includes("date") ? "date" : typeof value === "number" ? "number" : "text"}
            className="input input-bordered mt-1 w-full bg-white"
            value={value == null ? "" : String(value)}
            onChange={(event) =>
              updateAtPath(
                path,
                typeof value === "number" && event.target.value !== ""
                  ? Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )}
      </label>
    );
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-950">Edit {section.title}</h2>
            <p className="mt-1 text-xs text-slate-600">
              Saved values override the report display and are retained with revision history.
            </p>
          </div>
          <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm" disabled={saving}>
            Close
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto p-5">
          {Object.entries(draft).map(([key, value]) => (
            <div key={key}>{renderValue(value, [key], key)}</div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
          <button type="button" onClick={onCancel} className="btn btn-ghost normal-case" disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="btn normal-case border-blue-600 bg-blue-600 text-white hover:bg-blue-700"
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddressHero({
  detail,
  accountId,
  onReload,
}: {
  detail: DcadDetail | null;
  accountId?: string;
  onReload: () => Promise<void>;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [relatedParcelSearchVersion, setRelatedParcelSearchVersion] = useState(0);
  const [relatedParcels, setRelatedParcels] = useState<RelatedParcelsResponse | null>(null);
  const [relatedParcelsLoading, setRelatedParcelsLoading] = useState(false);
  const [relatedParcelsError, setRelatedParcelsError] = useState("");
  const [editingSection, setEditingSection] = useState<EditableReportSection | null>(null);
  const [savingSection, setSavingSection] = useState(false);
  const photos = useMemo(
    () => (detail?.photos || []).filter((photo) => Boolean(photo?.trim())),
    [detail?.photos],
  );
  const detailLoaded = Boolean(detail);
  const exactAddress = detail?.property_location?.address?.trim() || "";

  useEffect(() => {
    if (photoIndex >= photos.length) setPhotoIndex(0);
  }, [photoIndex, photos.length]);

  useEffect(() => {
    let cancelled = false;
    setRelatedParcels(null);
    setRelatedParcelsError("");
    if (!accountId?.trim() || !detailLoaded) {
      setRelatedParcelsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setRelatedParcelsLoading(true);
    void getRelatedParcels(accountId, exactAddress || undefined)
      .then((response) => {
        if (!cancelled) setRelatedParcels(response);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRelatedParcelsError(
            error instanceof Error ? error.message : "The related-parcel check was unavailable.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setRelatedParcelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, detailLoaded, exactAddress, relatedParcelSearchVersion]);

  const address = displayValue(detail?.property_location?.address, "Property address unavailable");
  const neighborhood = displayValue(detail?.property_location?.neighborhood);
  const subdivision = displayValue(detail?.property_location?.subdivision);
  const county = displayValue(detail?.property_location?.county);
  const ownerName = displayValue(detail?.owner?.owner_name);
  const ownerMailing = displayValue(detail?.owner?.mailing_address);
  const legalLines = detail?.legal_description?.lines?.filter((line) => Boolean(line?.trim())) || [];
  const legalDescription = legalLines.length
    ? legalLines.join("\n")
    : "No legal description is available for this parcel.";
  const deedTransferDate = detail?.legal_description?.deed_transfer_date;
  const improvement = detail?.main_improvement;
  const housing = detail?.housing_profile;
  const landRows = detail?.land_detail || [];
  const additionalImprovements = detail?.additional_improvements || [];
  const salesHistory = detail?.sales_history || [];
  const values = detail?.value_summary;

  const editableSectionValue = (sectionKey: ReportManualSectionKey): Record<string, unknown> => {
    switch (sectionKey) {
      case "report.subject_identification":
        return {
          property_location: {
            address: detail?.property_location?.address || "",
            neighborhood: detail?.property_location?.neighborhood || "",
            city: detail?.property_location?.city || "",
            postal_code: detail?.property_location?.postal_code || "",
            county: detail?.property_location?.county || "",
            subdivision: detail?.property_location?.subdivision || "",
          },
          owner: {
            owner_name: detail?.owner?.owner_name || "",
            mailing_address: detail?.owner?.mailing_address || "",
          },
          legal_description: {
            lines: detail?.legal_description?.lines || [],
            deed_transfer_date: detail?.legal_description?.deed_transfer_date || "",
          },
        };
      case "report.exemptions":
        {
          const emptyExemption = () => ({
            taxing_jurisdiction: "",
            homestead_exemption: "",
            disabled_vet: "",
            taxable_value: "",
          });
        return {
          homestead_yes: Boolean(detail?.homestead_yes),
          exemptions: {
            city: cloneEditorValue(detail?.exemptions?.city || emptyExemption()),
            school: cloneEditorValue(detail?.exemptions?.school || emptyExemption()),
            county: cloneEditorValue(detail?.exemptions?.county || emptyExemption()),
            college: cloneEditorValue(detail?.exemptions?.college || emptyExemption()),
            hospital: cloneEditorValue(detail?.exemptions?.hospital || emptyExemption()),
            special_district: cloneEditorValue(
              detail?.exemptions?.special_district || emptyExemption(),
            ),
          },
        };
        }
      case "report.sales_history":
        return { sales_history: cloneEditorValue(detail?.sales_history || []) };
      case "report.property_characteristics":
        return {
          main_improvement: {
            living_area_sqft: detail?.main_improvement?.living_area_sqft || "",
            total_area_sqft: detail?.main_improvement?.total_area_sqft || "",
            bedroom_count: detail?.main_improvement?.bedroom_count || "",
            bath_count: detail?.main_improvement?.bath_count || "",
            baths_full: detail?.main_improvement?.baths_full || "",
            baths_half: detail?.main_improvement?.baths_half || "",
            stories: detail?.main_improvement?.stories || "",
            year_built: detail?.main_improvement?.year_built || "",
            effective_year_built: detail?.main_improvement?.effective_year_built || "",
            actual_age: detail?.main_improvement?.actual_age || "",
            building_class: detail?.main_improvement?.building_class || "",
            desirability: detail?.main_improvement?.desirability || "",
            construction_type: detail?.main_improvement?.construction_type || "",
            foundation: detail?.main_improvement?.foundation || "",
            exterior_material: detail?.main_improvement?.exterior_material || "",
            roof_type: detail?.main_improvement?.roof_type || "",
            roof_material: detail?.main_improvement?.roof_material || "",
            heating: detail?.main_improvement?.heating || "",
            air_conditioning: detail?.main_improvement?.air_conditioning || "",
            fireplaces: detail?.main_improvement?.fireplaces || "",
            kitchens: detail?.main_improvement?.kitchens || "",
            wetbars: detail?.main_improvement?.wetbars || "",
            pool: detail?.main_improvement?.pool ?? "",
            sprinkler: detail?.main_improvement?.sprinkler ?? "",
            fence_type: detail?.main_improvement?.fence_type || "",
          },
          housing_profile: {
            structural_style: detail?.housing_profile?.structural_style || "",
            housing_type: detail?.housing_profile?.housing_type || "",
            attachment_type: detail?.housing_profile?.attachment_type || "unknown",
            architectural_style: detail?.housing_profile?.architectural_style || "",
          },
          additional_improvements: cloneEditorValue(detail?.additional_improvements || []),
        };
      case "report.land_details":
        return { land_detail: cloneEditorValue(detail?.land_detail || []) };
      case "report.appraisal_values":
        return {
          value_summary: {
            certified_year: detail?.value_summary?.certified_year || "",
            market_value: detail?.value_summary?.market_value || "",
            capped_value: detail?.value_summary?.capped_value || "",
            improvement_value: detail?.value_summary?.improvement_value || "",
            land_value: detail?.value_summary?.land_value || "",
          },
        };
    }
  };

  const saveEditedSection = async (value: Record<string, unknown>) => {
    if (!editingSection || !accountId) return;
    let editorKey = sessionStorage.getItem("homenode-editor-key") || "";
    if (!editorKey) {
      editorKey = window.prompt("Enter the HomeNode editor key to save verified changes:") || "";
      if (!editorKey) return;
      sessionStorage.setItem("homenode-editor-key", editorKey);
    }
    setSavingSection(true);
    try {
      await updatePropertyReportSections(
        accountId,
        { [editingSection.key]: value },
        editorKey,
      );
      await onReload();
      setEditingSection(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The report changes could not be saved.";
      if (/401|invalid_editor_key/i.test(message)) {
        sessionStorage.removeItem("homenode-editor-key");
      }
      window.alert(message);
    } finally {
      setSavingSection(false);
    }
  };

  const sectionEditProps = (key: ReportManualSectionKey) => ({
    onEdit: () => {
      const section = EDITABLE_REPORT_SECTIONS.find((item) => item.key === key);
      if (section) setEditingSection(section);
    },
    manuallyVerified: Boolean(detail?.report_manual_values?.[key]),
  });

  const exemptionOrder: Array<[keyof DcadExemptionsMap, string]> = [
    ["city", "City"],
    ["school", "School"],
    ["county", "County"],
    ["college", "College"],
    ["hospital", "Hospital"],
    ["special_district", "Special District"],
  ];
  const exemptionRows = exemptionOrder
    .map(([key, fallbackLabel]) => ({
      key,
      fallbackLabel,
      row: detail?.exemptions?.[key],
    }))
    .filter(({ row }) =>
      Boolean(row && Object.values(row).some((value) => hasValue(value))),
    );
  const exemptJurisdictionCount = exemptionRows.filter(
    ({ row }) => (parseNumber(row?.homestead_exemption) || 0) > 0,
  ).length;
  const homestead = detail?.homestead_yes || exemptJurisdictionCount > 0;

  const totalLandArea = landRows.reduce(
    (sum, row) => sum + (parseNumber(row.area_sqft) || 0),
    0,
  );
  const primaryZoning =
    landRows.map((row) => row.zoning).find((value) => hasValue(value)) || "Not reported";

  const protestUrl = accountId
    ? `/signup?accountId=${encodeURIComponent(accountId)}${
        hasValue(detail?.owner?.owner_name)
          ? `&ownerName=${encodeURIComponent(String(detail?.owner?.owner_name))}`
          : ""
      }`
    : "/signup";

  const canSlide = photos.length > 1;
  const showPreviousPhoto = () =>
    setPhotoIndex((current) => (current - 1 + photos.length) % photos.length);
  const showNextPhoto = () =>
    setPhotoIndex((current) => (current + 1) % photos.length);

  return (
    <div
      className="card overflow-hidden rounded-2xl bg-white shadow-lg"
      style={{ backgroundColor: "#ffffff" }}
    >
      <figure className="relative h-64 bg-slate-100 sm:h-72">
        {photos.length ? (
          <img
            src={photos[photoIndex]}
            alt={`${address} property`}
            className="h-full w-full select-none object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-500">
            <svg
              className="mb-3 h-14 w-14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5 10.5V20h14v-9.5" />
              <path d="M9 20v-6h6v6" />
            </svg>
            <span className="text-sm font-medium">Property photo unavailable</span>
          </div>
        )}

        {canSlide ? (
          <>
            <button
              type="button"
              onClick={showPreviousPhoto}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <button
              type="button"
              onClick={showNextPhoto}
              aria-label="Next image"
              className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-white/90 text-slate-800 shadow-lg hover:bg-white"
            >
              <span aria-hidden="true">›</span>
            </button>
            <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5 rounded-full bg-black/40 px-3 py-2">
              {photos.map((_, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => setPhotoIndex(index)}
                  aria-label={`Go to image ${index + 1}`}
                  className={`h-2.5 w-2.5 rounded-full border border-white ${
                    index === photoIndex ? "bg-white" : "bg-white/40"
                  }`}
                />
              ))}
            </div>
          </>
        ) : null}
      </figure>

      <div className="card-body bg-white p-4 sm:p-6" style={{ backgroundColor: "#ffffff" }}>
        <header className="border-b border-slate-200 pb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{address}</h1>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
            <span>
              Neighborhood Code: <strong className="text-slate-800">{neighborhood}</strong>
            </span>
            <span>
              Zoning: <strong className="text-slate-800">{primaryZoning}</strong>
            </span>
          </div>
        </header>

        <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
                  Same-Address CAD Parcel Check
                </h2>
                {relatedParcels?.review_required ? (
                  <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                    Review related parcels
                  </span>
                ) : null}
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">
                HomeNode checks the official DCAD parcel map in the background for other accounts at
                this exact situs address. Results remain separate and are never merged automatically.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm normal-case border-amber-300 bg-white text-slate-800 hover:border-amber-400 hover:bg-amber-100"
              disabled={relatedParcelsLoading || !accountId}
              onClick={() => setRelatedParcelSearchVersion((current) => current + 1)}
            >
              {relatedParcelsLoading ? "Checking DCAD..." : "Check Again"}
            </button>
          </div>

          {relatedParcelsError ? (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              The live DCAD parcel check could not be completed: {relatedParcelsError}
            </div>
          ) : null}

          {relatedParcels && relatedParcels.live_query_status !== "complete" ? (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-100 p-3 text-sm text-amber-950">
              The official DCAD live check is {relatedParcels.live_query_status.replace(/_/g, " ")}.
              Local exact-address matches are shown below, but this item remains flagged for manual
              parcel review.
            </div>
          ) : null}

          {relatedParcels && !relatedParcelsLoading ? (
            relatedParcels.parcels.length ? (
              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                {relatedParcels.parcels.map((parcel) => (
                  <div
                    key={parcel.account_id}
                    className={`rounded-xl border bg-white p-3 ${
                      parcel.is_subject ? "border-slate-200" : "border-amber-300"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-950">
                          {parcel.site_address || parcel.address || relatedParcels.query_address}
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-slate-600">
                          {parcel.account_id}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {parcel.is_subject ? (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                            Current subject
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
                            Additional parcel
                          </span>
                        )}
                        {!parcel.in_database ? (
                          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
                            Not in database
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600 sm:grid-cols-4">
                      <div>
                        <span className="block text-slate-500">Living Area</span>
                        <strong className="text-slate-800">
                          {parcel.living_area_sqft
                            ? `${new Intl.NumberFormat("en-US").format(parcel.living_area_sqft)} sq. ft.`
                            : "Land / not reported"}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Land Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.land_value)}</strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Improvement Value</span>
                        <strong className="text-slate-800">
                          {formatMoney(parcel.improvement_value)}
                        </strong>
                      </div>
                      <div>
                        <span className="block text-slate-500">Total Value</span>
                        <strong className="text-slate-800">{formatMoney(parcel.total_value)}</strong>
                      </div>
                    </div>
                    {parcel.legal_description ? (
                      <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-600">
                        {parcel.legal_description}
                      </p>
                    ) : null}
                    {!parcel.is_subject && parcel.in_database ? (
                      <Link
                        to={`/report/${encodeURIComponent(parcel.account_id)}`}
                        className="mt-3 inline-flex text-xs font-semibold text-blue-700 hover:text-blue-900 hover:underline"
                      >
                        Open this parcel’s report →
                      </Link>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                No same-address parcel was returned by the official DCAD parcel map. Keep this item
                under manual review if the situs address is missing or incomplete.
              </p>
            )
          ) : null}
        </section>

        <div className="mt-5 space-y-5">
          <SummarySection
            title="Subject Identification"
            subtitle="Parcel, ownership, and recorded legal information"
            {...sectionEditProps("report.subject_identification")}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryField label="Parcel / Account Number" value={displayValue(accountId)} />
              <SummaryField label="County" value={county} />
              <SummaryField label="Subdivision" value={subdivision} />
              <SummaryField label="Latest Deed Transfer" value={formatDate(deedTransferDate)} />
              <SummaryField label="Owner Name" value={ownerName} className="sm:col-span-2" />
              <SummaryField
                label="Owner Mailing Address"
                value={ownerMailing}
                className="sm:col-span-2"
              />
              <SummaryField
                label="Legal Description"
                value={<span className="whitespace-pre-line">{legalDescription}</span>}
                className="sm:col-span-2 lg:col-span-4"
              />
            </div>
          </SummarySection>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <SummarySection
              title="Current Exemptions"
              subtitle={`Tax year ${displayValue(values?.certified_year || detail?.tax_year)}`}
              {...sectionEditProps("report.exemptions")}
            >
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                    homestead
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-200 text-slate-700"
                  }`}
                >
                  Homestead: {homestead ? "Yes" : "No"}
                </span>
                {exemptJurisdictionCount > 0 ? (
                  <span className="text-sm text-slate-600">
                    Exemption recorded in{" "}
                    <strong className="text-slate-900">{exemptJurisdictionCount}</strong>{" "}
                    taxing unit{exemptJurisdictionCount === 1 ? "" : "s"}.
                  </span>
                ) : null}
              </div>

              {exemptionRows.length ? (
                <div className="overflow-x-auto">
                  <table className="table table-sm w-full">
                    <thead>
                      <tr>
                        <th>Taxing Unit</th>
                        <th className="text-right">Homestead</th>
                        <th className="text-right">Taxable Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exemptionRows.map(({ key, fallbackLabel, row }) => (
                        <tr key={key}>
                          <td>{displayValue(row?.taxing_jurisdiction, fallbackLabel)}</td>
                          <td className="text-right">
                            {formatMoney(row?.homestead_exemption)}
                          </td>
                          <td className="text-right">{formatMoney(row?.taxable_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  No current exemption records were returned for this parcel.
                </p>
              )}
            </SummarySection>

            <SummarySection
              title="Sales History"
              subtitle="Linked closed-sale records and deed-transfer history"
              {...sectionEditProps("report.sales_history")}
            >
              {salesHistory.length ? (
                <div className="overflow-x-auto">
                  <table className="table table-sm w-full">
                    <thead>
                      <tr>
                        <th>Sale Date</th>
                        <th>MLS</th>
                        <th className="text-right">Sale Price</th>
                        <th className="text-right">DOM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {salesHistory.slice(0, 8).map((sale, index) => (
                        <tr key={sale.source_record_id || `${sale.listing_id}-${index}`}>
                          <td>{formatDate(sale.closing_date)}</td>
                          <td>{displayValue(sale.listing_id, "—")}</td>
                          <td className="text-right">{formatMoney(sale.sale_price)}</td>
                          <td className="text-right">
                            {displayValue(sale.days_on_market, "—")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-800">
                    No linked MLS sale records
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    The latest recorded deed transfer is {formatDate(deedTransferDate)}.
                  </p>
                </div>
              )}
            </SummarySection>
          </div>

          <SummarySection
            title="Property Characteristics"
            subtitle="Auto-populated appraisal-district and verified MLS characteristics"
            {...sectionEditProps("report.property_characteristics")}
          >
            <div className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3 lg:grid-cols-5">
              <SummaryField
                label="Living Area"
                value={formatNumber(
                  improvement?.living_area_sqft || improvement?.total_living_area,
                  " sq. ft.",
                )}
              />
              <SummaryField
                label="Total Area"
                value={formatNumber(improvement?.total_area_sqft, " sq. ft.")}
              />
              <SummaryField label="Bedrooms" value={displayValue(improvement?.bedroom_count)} />
              <SummaryField label="Bathrooms" value={formatBaths(improvement)} />
              <SummaryField label="Stories" value={displayValue(improvement?.stories)} />
              <SummaryField label="Year Built" value={displayValue(improvement?.year_built)} />
              <SummaryField
                label="Effective Year"
                value={displayValue(improvement?.effective_year_built)}
              />
              <SummaryField label="Actual Age" value={displayValue(improvement?.actual_age)} />
              <SummaryField
                label="Building Class"
                value={displayValue(improvement?.building_class)}
              />
              <SummaryField
                label="Desirability"
                value={displayValue(improvement?.desirability)}
              />
              <SummaryField
                label="Housing Type"
                value={displayValue(housing?.housing_type)}
              />
              <SummaryField
                label="Attachment"
                value={displayValue(housing?.attachment_type)}
              />
              <SummaryField
                label="Architectural Style"
                value={displayValue(housing?.architectural_style)}
              />
              <SummaryField
                label="Construction"
                value={displayValue(improvement?.construction_type)}
              />
              <SummaryField label="Foundation" value={displayValue(improvement?.foundation)} />
              <SummaryField
                label="Exterior"
                value={displayValue(improvement?.exterior_material)}
              />
              <SummaryField
                label="Roof"
                value={[
                  improvement?.roof_type,
                  improvement?.roof_material,
                ]
                  .filter(hasValue)
                  .join(" · ") || "Not reported"}
              />
              <SummaryField label="Heating" value={displayValue(improvement?.heating)} />
              <SummaryField label="Air Conditioning" value={displayValue(improvement?.air_conditioning)} />
              <SummaryField
                label="Fireplaces"
                value={displayValue(improvement?.fireplaces)}
              />
              <SummaryField label="Kitchens" value={displayValue(improvement?.kitchens)} />
              <SummaryField label="Wet Bars" value={displayValue(improvement?.wetbars)} />
              <SummaryField label="Pool" value={formatReportedBoolean(improvement?.pool)} />
              <SummaryField
                label="Sprinkler"
                value={formatReportedBoolean(improvement?.sprinkler)}
              />
              <SummaryField label="Fence" value={displayValue(improvement?.fence_type)} />
            </div>

            {additionalImprovements.length ? (
              <div className="mt-5 border-t border-slate-200 pt-4">
                <h3 className="text-sm font-semibold text-slate-800">Additional Improvements</h3>
                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {additionalImprovements.map((row, index) => (
                    <div
                      key={`${row.number || index}-${row.improvement_type || "improvement"}`}
                      className="rounded-xl border border-slate-200 bg-white p-3"
                    >
                      <div className="text-sm font-semibold text-slate-900">
                        {displayValue(row.improvement_type, `Improvement ${index + 1}`)}
                      </div>
                      <div className="mt-1 text-xs leading-5 text-slate-600">
                        {[row.construction, row.floor, row.exterior_wall]
                          .filter(hasValue)
                          .join(" · ") || "Construction details not reported"}
                        <br />
                        {formatNumber(row.area_sqft, " sq. ft.")}
                        {hasValue(row.year_built)
                          ? ` · Built ${displayValue(row.year_built)}`
                          : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </SummarySection>

          <SummarySection
            title="Land Details and Zoning"
            subtitle={`${landRows.length} land record${landRows.length === 1 ? "" : "s"} returned`}
            {...sectionEditProps("report.land_details")}
          >
            <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <SummaryField label="Primary Zoning" value={primaryZoning} />
              <SummaryField
                label="Total Land Area"
                value={totalLandArea ? formatNumber(totalLandArea, " sq. ft.") : "Not reported"}
              />
              <SummaryField label="Land Value" value={formatMoney(values?.land_value)} />
            </div>

            {landRows.length ? (
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="table table-sm w-full">
                  <thead>
                    <tr>
                      <th>Use / State Code</th>
                      <th>Zoning</th>
                      <th className="text-right">Area</th>
                      <th className="text-right">Frontage × Depth</th>
                      <th>Pricing</th>
                      <th className="text-right">Adjusted Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {landRows.map((row, index) => (
                      <tr key={row.number || index}>
                        <td>{displayValue(row.state_code)}</td>
                        <td>{displayValue(row.zoning)}</td>
                        <td className="text-right">
                          {formatNumber(row.area_sqft, " sq. ft.")}
                        </td>
                        <td className="text-right">
                          {parseNumber(row.frontage_ft) !== null ||
                          parseNumber(row.depth_ft) !== null
                            ? `${formatNumber(row.frontage_ft, " ft.")} × ${formatNumber(
                                row.depth_ft,
                                " ft.",
                              )}`
                            : "Not reported"}
                        </td>
                        <td>{displayValue(row.pricing_method)}</td>
                        <td className="text-right">{formatMoney(row.adjusted_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                No land detail records were returned for this parcel.
              </p>
            )}
          </SummarySection>

          <SummarySection
            title="Appraisal District Values"
            subtitle={`Certified tax year ${displayValue(
              values?.certified_year || detail?.tax_year,
            )}`}
            {...sectionEditProps("report.appraisal_values")}
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <SummaryField label="Market Value" value={formatMoney(values?.market_value)} />
              <SummaryField
                label="Assessed / Capped Value"
                value={formatMoney(values?.capped_value || values?.market_value)}
              />
              <SummaryField label="Improvement Value" value={formatMoney(values?.improvement_value)} />
              <SummaryField label="Land Value" value={formatMoney(values?.land_value)} />
            </div>
          </SummarySection>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-2 border-t border-slate-200 pt-5 sm:grid-cols-2 xl:grid-cols-5">
          <Link
            to={
              accountId
                ? `/ComparableSalesAnalysis?propertyId=${encodeURIComponent(accountId)}`
                : "#"
            }
            aria-label="Sales Comparison Approach"
            aria-disabled={!accountId}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-emerald-600 bg-emerald-600 text-white hover:border-emerald-700 hover:bg-emerald-700"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Sales Comparison Approach
          </Link>
          <button
            type="button"
            disabled
            title="Cost Approach is coming soon"
            aria-label="Cost Approach coming soon"
            className="btn normal-case rounded-md border-slate-200 bg-slate-200 px-4 py-2 text-slate-500"
          >
            Cost Approach
          </button>
          <button
            type="button"
            disabled
            title="Income Approach is coming soon"
            aria-label="Income Approach coming soon"
            className="btn normal-case rounded-md border-slate-200 bg-slate-200 px-4 py-2 text-slate-500"
          >
            Income Approach
          </button>
          <Link
            to={protestUrl}
            aria-label="Property Tax Protest"
            className="btn normal-case rounded-md border-blue-600 bg-blue-600 px-4 py-2 text-white hover:border-blue-700 hover:bg-blue-700"
          >
            Property Tax Protest
          </Link>
          <Link
            to={
              accountId
                ? `/AppraisalReport?propertyId=${encodeURIComponent(accountId)}`
                : "#"
            }
            aria-label="Full Appraisal PDF"
            aria-disabled={!accountId}
            className={`btn normal-case rounded-md px-4 py-2 ${
              accountId
                ? "border-slate-900 bg-slate-900 text-white hover:border-slate-950 hover:bg-slate-950"
                : "pointer-events-none border-slate-200 bg-slate-200 text-slate-500"
            }`}
          >
            Full Appraisal PDF
          </Link>
        </div>
      </div>
      {editingSection ? (
        <ReportSectionEditor
          section={editingSection}
          initialValue={editableSectionValue(editingSection.key)}
          saving={savingSection}
          onCancel={() => setEditingSection(null)}
          onSave={saveEditedSection}
        />
      ) : null}
    </div>
  );
}

export default function PropertyReport() {
  const location = useLocation();
  const { accountId: routeAccountId } = useParams<{ accountId?: string }>();

  const presetAccount = useMemo(() => {
    if (routeAccountId) return routeAccountId;
    const params = new URLSearchParams(location.search);
    return params.get("account_id") || params.get("account") || "";
  }, [location.search, routeAccountId]);

  const [account, setAccount] = useState(presetAccount);
  const [detail, setDetail] = useState<DcadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const hasAutoImported = useRef(false);
  const loadRequestId = useRef(0);

  async function importFromDatabase() {
    if (!account) {
      window.alert("Enter an Account ID first.");
      return;
    }
    const requestedAccount = account.trim();
    const requestId = ++loadRequestId.current;
    setLoading(true);
    try {
      const response = await fetchDetail(requestedAccount);
      if (requestId !== loadRequestId.current) return;
      setDetail(response?.detail ?? null);

      // The account payload is complete without MLS media. Load any future
      // photo gallery in the background and never hold back the report.
      void getAccountPhotos(requestedAccount)
        .then((photoResponse) => {
          if (requestId !== loadRequestId.current) return;
          const photos = photoResponse?.photos
            ?.map((photo) => photo?.media_url)
            .filter((url): url is string => Boolean(url?.trim())) || [];
          if (!photos.length) return;
          setDetail((current) => (current ? { ...current, photos } : current));
        })
        .catch((error) => {
          console.warn("Property photos were unavailable", error);
        });
    } catch (error: unknown) {
      if (requestId !== loadRequestId.current) return;
      console.error(error);
      window.alert(error instanceof Error ? error.message : "Import failed");
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!hasAutoImported.current && account) {
      hasAutoImported.current = true;
      void importFromDatabase();
    }
    // The account is intentionally imported only once when the routed report opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  return (
    <div className="min-h-screen bg-base-200">
      <div className="navbar bg-base-100 shadow-sm">
        <div className="container mx-auto px-4">
          <div className="flex w-full items-center justify-between">
            <span className="text-xl font-semibold">Property Report</span>
            <Link to="/" className="btn btn-ghost btn-sm normal-case">
              ← Close Report
            </Link>
          </div>
        </div>
      </div>

      <main className="container mx-auto space-y-4 px-4 py-4">
        <div className="card rounded-2xl bg-base-100 shadow-sm">
          <div className="card-body p-4">
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <label htmlFor="property-account-id" className="text-sm font-medium opacity-70">
                Account ID
              </label>
              <input
                id="property-account-id"
                className="input input-bordered w-full sm:w-64"
                placeholder="e.g. 26272500060150000"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary normal-case"
                onClick={() => void importFromDatabase()}
                disabled={loading || !account}
              >
                {loading ? "Loading..." : "Load Report"}
              </button>
            </div>
          </div>
        </div>

        <AddressHero detail={detail} accountId={account} onReload={importFromDatabase} />
      </main>
    </div>
  );
}
