import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  AssignmentDetailsPayload,
  ReportManualSectionKey,
} from "@/lib/api";
import {
  ASSIGNMENT_TYPE_OPTIONS,
  HOA_FREQUENCY_OPTIONS,
  OCCUPANCY_OPTIONS,
  assignmentValidationErrors,
  cloneEditorValue,
} from "@/lib/propertyReportAssignment";

type AssignmentDetails = AssignmentDetailsPayload;

export type EditableReportSection = {
  key: ReportManualSectionKey;
  title: string;
};

const ARRAY_ROW_TEMPLATES: Record<string, Record<string, unknown>> = {
  property_activity_history: {
    record_type: "listing",
    activity_date: "",
    listing_id: "",
    mls_status: "",
    list_price: "",
    sale_price: "",
    days_on_market: "",
    buyer_financing: "",
    concessions: "",
    source: "Manual appraisal-file entry",
  },
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
  parties: {
    owner_name: "",
    ownership_pct: "",
  },
};

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

export default function ReportSectionEditor({
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

  const assignment = draft as AssignmentDetails;
  const assignmentTypes = Array.isArray(assignment.assignment_types)
    ? assignment.assignment_types
    : [];
  const assignmentErrors = section.key === "report.assignment_details"
    ? assignmentValidationErrors(assignment)
    : [];

  const checkboxOption = (
    checked: boolean,
    label: string,
    onChange: (checked: boolean) => void,
  ) => (
    <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
      checked
        ? "border-blue-400 bg-blue-50 text-blue-900"
        : "border-slate-200 bg-white text-slate-700"
    }`}>
      <input
        type="checkbox"
        className="checkbox checkbox-sm checkbox-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );

  const assignmentEditor = section.key === "report.assignment_details" ? (
    <div className="space-y-5">
      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Lender / Client</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Lender / Client
            </span>
            <input
              type="text"
              maxLength={500}
              className="input input-bordered mt-1 w-full bg-white"
              value={assignment.lender_client_name || ""}
              onChange={(event) => updateAtPath(["lender_client_name"], event.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Lender / Client Address
            </span>
            <textarea
              maxLength={2000}
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.lender_client_address || ""}
              onChange={(event) => updateAtPath(["lender_client_address"], event.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Planned Unit Development</legend>
        <div className="mt-1 max-w-xs">
          {checkboxOption(Boolean(assignment.pud), "PUD", (checked) =>
            updateAtPath(["pud"], checked),
          )}
        </div>
        {assignment.pud ? (
          <div className="mt-4 space-y-4">
            <label className="block max-w-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Dues Amount
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                className="input input-bordered mt-1 w-full bg-white"
                value={assignment.hoa_dues_amount ?? ""}
                onChange={(event) => updateAtPath(["hoa_dues_amount"], event.target.value)}
                placeholder="Dollar amount"
              />
            </label>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Dues Frequency
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {HOA_FREQUENCY_OPTIONS.map(([value, label]) =>
                  <div key={value}>
                    {checkboxOption(assignment.hoa_frequency === value, label, (checked) =>
                      updateAtPath(["hoa_frequency"], checked ? value : ""),
                    )}
                  </div>
                )}
              </div>
            </div>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                HOA Explanation
              </span>
              <textarea
                className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                value={assignment.hoa_explanation || ""}
                onChange={(event) => updateAtPath(["hoa_explanation"], event.target.value)}
                placeholder="Required when dues are unavailable or the frequency is Other"
              />
            </label>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Occupancy</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {OCCUPANCY_OPTIONS.map(([value, label]) =>
            <div key={value}>
              {checkboxOption(assignment.occupancy === value, label, (checked) =>
                updateAtPath(["occupancy"], checked ? value : ""),
              )}
            </div>
          )}
        </div>
        {assignment.occupancy === "unknown" ? (
          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Unknown Occupancy Explanation
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.occupancy_explanation || ""}
              onChange={(event) => updateAtPath(["occupancy_explanation"], event.target.value)}
            />
          </label>
        ) : null}
      </fieldset>

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">Assignment Type</legend>
        <p className="mb-3 text-xs text-slate-600">Select every type that applies to the assignment.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {ASSIGNMENT_TYPE_OPTIONS.map(([value, label]) =>
            <div key={value}>
              {checkboxOption(assignmentTypes.includes(value), label, (checked) => {
                const next = checked
                  ? [...new Set([...assignmentTypes, value])]
                  : assignmentTypes.filter((item) => item !== value);
                updateAtPath(["assignment_types"], next);
              })}
            </div>
          )}
        </div>
        {assignmentTypes.includes("other") ? (
          <label className="mt-4 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
              Other Assignment Explanation
            </span>
            <textarea
              className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
              value={assignment.assignment_explanation || ""}
              onChange={(event) => updateAtPath(["assignment_explanation"], event.target.value)}
            />
          </label>
        ) : null}
      </fieldset>

      {assignmentErrors.length ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <ul className="list-disc space-y-1 pl-5">
            {assignmentErrors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  ) : null;

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
          {assignmentEditor || Object.entries(draft).map(([key, value]) => (
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
            disabled={saving || assignmentErrors.length > 0}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
