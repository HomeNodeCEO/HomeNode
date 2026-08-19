import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createUadEntity,
  deleteUadEntity,
  getUadEditor,
  saveUadSection,
  type UadCondition,
  type UadEditorResponse,
  type UadEntity,
  type UadFieldDefinition,
  type UadFieldValue,
  type UadMeasurement,
  type UadSectionKey,
} from "../api";
import UadAssetPanel from "./UadAssetPanel";

interface Props {
  workfileId: string;
  onClose: () => void;
}

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";

const SITE_CAPTIONS = [
  "PropertyAccess", "PropertyPhoto", "SiteInfluence", "View", "SiteCharacteristic",
  "PropertyBoundaries", "Encroachment", "WaterFrontage", "SiteExhibit",
];
const DISASTER_MITIGATION_CAPTIONS = ["DisasterMitigationExhibit"];
const ENERGY_GREEN_CAPTIONS = ["EnergyEfficientAndGreenFeaturesExhibit"];
const SKETCH_REPORT_CAPTIONS = ["SubjectPropertyImprovementSketch", "FloorPlan"];
const SKETCH_SOURCE_CAPTIONS = ["MeasurementSource"];
const SKETCH_IMAGE_ACCEPT = "image/avif,image/bmp,image/gif,image/heic,image/heif,image/jpeg,image/png,image/tiff,image/webp";
const DWELLING_EXTERIOR_CAPTIONS = ["DwellingFront", "DwellingRear", "DwellingExteriorExhibit", "NoncontinuousArea"];
const MANUFACTURED_HOME_GENERAL_CAPTIONS = ["ManufacturedHomeHUDDataPlate", "ManufacturedHomeExhibit"];
const MANUFACTURED_HOME_HUD_LABEL_CAPTIONS = ["ManufacturedHomeHUDCertificationLabel"];
const MANUFACTURED_HOME_PROGRAM_CAPTIONS = ["ManufacturedHomeFinancingProgramEligibilityCertification"];
const UNIT_INTERIOR_GENERAL_CAPTIONS = ["UnitInteriorExhibit"];
const UNIT_INTERIOR_ROOM_CAPTIONS = [
  "Bedroom", "BreakfastRoom", "Den", "DiningRoom", "FamilyRoom", "FullBathroom", "HalfBathroom",
  "Kitchen", "LaundryRoom", "LivingRoom", "Loft", "MediaRoom", "Mudroom", "Other", "RecreationRoom",
  "Sunroom", "UtilityRoom", "WalkInPantry", "Workshop",
];
const UNIT_INTERIOR_FEATURE_CAPTIONS = ["Flooring", "WallsAndCeiling", "OtherInteriorFeature"];
const UNIT_INTERIOR_DEFECT_CAPTIONS = ["UnitInteriorDefect"];
const FUNCTIONAL_OBSOLESCENCE_CAPTIONS = ["FunctionalObsolescenceExhibit"];
const OUTBUILDING_GENERAL_CAPTIONS = [
  "OutbuildingFront", "OutbuildingInterior", "OutbuildingRear", "OutbuildingRoom",
  "ManufacturedHomeFoundation", "OutbuildingExhibit",
];
const OUTBUILDING_DEFECT_CAPTIONS = ["OutbuildingDefect"];
const VEHICLE_STORAGE_GENERAL_CAPTIONS = ["VehicleStorage", "VehicleStorageExhibit"];
const VEHICLE_STORAGE_DEFECT_CAPTIONS = ["VehicleStorageDefect"];
const SUBJECT_AMENITY_GENERAL_CAPTIONS = ["SubjectPropertyAmenitiesExhibit"];
const SUBJECT_AMENITY_CAPTIONS = ["SubjectPropertyAmenity"];
const SUBJECT_AMENITY_DEFECT_CAPTIONS = ["SubjectPropertyAmenityDefect"];
const HIGHEST_BEST_USE_CAPTIONS = ["HighestAndBestUseExhibit"];
const MARKET_CAPTIONS = [
  "AbsorptionRateGraph", "MedianDaysOnMarketGraph", "PercentOfDistressedSalesGraph",
  "PriceTrendGraph", "YearBuiltOfSalesGraph", "MarketAnalysisExhibit",
];
const PROJECT_INFORMATION_GENERAL_CAPTIONS = ["ProjectDeficiency", "ProjectExhibit"];
const PROJECT_AMENITY_CAPTIONS = ["ProjectAmenity"];
const SUBJECT_LISTING_CAPTIONS = ["SubjectListingExhibit"];
const SALES_CONTRACT_CAPTIONS = ["SalesContractExhibit"];
const PRIOR_TRANSFER_CAPTIONS = ["PriorSaleAndTransferHistoryExhibit"];
const SALES_COMPARABLE_PHOTO_CAPTIONS = ["PropertyPhoto"];
const SALES_COMPARISON_EXHIBIT_CAPTIONS = ["SalesComparisonApproachExhibit"];

function displayOption(value: string) {
  if (value === "AmericanNationalStandardsInstitute") return "ANSI";
  if (value === "AmericanMeasurementStandard") return "AMS";
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("REO", "REO");
}

function fieldValueKey(contextKey: string, uid: string, entityId: string | null = null) {
  return `${entityId || "root"}:${contextKey}:${uid}`;
}

function valueIsPresent(value: UadFieldValue | undefined) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return value.amount !== null && value.amount !== undefined && Boolean(value.unit);
  return true;
}

function evaluateCondition(condition: UadCondition | undefined, lookup: (key: string, uidOnly?: boolean) => UadFieldValue | undefined): boolean {
  if (!condition) return true;
  if (condition.all) return condition.all.every((item) => evaluateCondition(item, lookup));
  if (condition.any) return condition.any.some((item) => evaluateCondition(item, lookup));
  if (condition.not) return !evaluateCondition(condition.not, lookup);
  const requestedKey = condition.key || condition.uid;
  const value = requestedKey ? lookup(requestedKey, !condition.key && Boolean(condition.uid)) : undefined;
  if (Object.hasOwn(condition, "equals")) return value === condition.equals;
  if (Object.hasOwn(condition, "notEquals")) return value !== condition.notEquals;
  if (Object.hasOwn(condition, "greaterThan")) {
    const numericValue = typeof value === "object" && value && !Array.isArray(value) ? value.amount : value;
    return Number(numericValue) > Number(condition.greaterThan);
  }
  if (Object.hasOwn(condition, "contains")) return Array.isArray(value) && value.includes(String(condition.contains));
  if (Object.hasOwn(condition, "present")) return valueIsPresent(value) === condition.present;
  return true;
}

export default function UadWorkfileEditor({ workfileId, onClose }: Props) {
  const [editor, setEditor] = useState<UadEditorResponse | null>(null);
  const [activeSection, setActiveSection] = useState<UadSectionKey>("assignment");
  const [draft, setDraft] = useState<Record<string, UadFieldValue>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [entityBusy, setEntityBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const loadEditor = useCallback(async (preservedDraft?: Record<string, UadFieldValue>) => {
    setLoading(true);
    setError(null);
    try {
      const response = await getUadEditor(workfileId);
      setEditor(response);
      const responseDraft = Object.fromEntries(response.values.map((item) => [fieldValueKey(item.context_key, item.uid, item.entity_id), item.value]));
      setDraft(preservedDraft ? { ...responseDraft, ...preservedDraft } : responseDraft);
      setDirty(Boolean(preservedDraft));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD editor could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [workfileId]);

  useEffect(() => { void loadEditor(); }, [loadEditor]);

  const section = editor?.sections.find((item) => item.key === activeSection);
  const allFields = useMemo(
    () => editor?.sections.flatMap((item) => item.groups.flatMap((group) => group.fields)) || [],
    [editor],
  );
  const savedByKey = useMemo(
    () => new Map(editor?.values.map((item) => [fieldValueKey(item.context_key, item.uid, item.entity_id), item]) || []),
    [editor],
  );
  const disasterFeatures = draft[fieldValueKey("disaster_mitigation", "3700.0002")];
  const disasterSectionDisplays = Array.isArray(disasterFeatures) && disasterFeatures.length > 0 && !disasterFeatures.includes("None");
  const energySectionDisplays = ["2600.0005", "2600.0004", "2600.0003"]
    .some((uid) => draft[fieldValueKey("energy_green", uid)] === true);
  const sketchProvided = draft[fieldValueKey("sketch", "3300.0002")];
  const dwellings = editor?.entities.filter((entity) => entity.entity_type === "dwelling") || [];
  const manufacturedDwellings = dwellings.filter((dwelling) => (
    draft[fieldValueKey("dwelling", "0300.0034", dwelling.id)] === "Manufactured"
  ));
  const manufacturedHomeHudLabels = editor?.entities.filter((entity) => entity.entity_type === "manufactured_home_hud_label") || [];
  const manufacturedHomePrograms = editor?.entities.filter((entity) => entity.entity_type === "manufactured_home_financing_program") || [];
  const units = editor?.entities.filter((entity) => entity.entity_type === "unit") || [];
  const unitRooms = editor?.entities.filter((entity) => entity.entity_type === "unit_room") || [];
  const unitInteriorFeatures = editor?.entities.filter((entity) => entity.entity_type === "unit_interior_feature") || [];
  const unitInteriorDefects = editor?.entities.filter((entity) => entity.entity_type === "unit_interior_defect") || [];
  const outbuildings = editor?.entities.filter((entity) => entity.entity_type === "outbuilding") || [];
  const outbuildingDefects = editor?.entities.filter((entity) => entity.entity_type === "outbuilding_defect") || [];
  const vehicleStorages = editor?.entities.filter((entity) => entity.entity_type === "vehicle_storage") || [];
  const vehicleStorageDefects = editor?.entities.filter((entity) => entity.entity_type === "vehicle_storage_defect") || [];
  const subjectAmenities = editor?.entities.filter((entity) => entity.entity_type === "amenity") || [];
  const subjectAmenityDefects = editor?.entities.filter((entity) => entity.entity_type === "amenity_defect") || [];
  const projectAmenities = editor?.entities.filter((entity) => entity.entity_type === "project_amenity") || [];
  const homeownerMaintainsExterior = draft[fieldValueKey("subject", "0100.0046")];
  const nonAduUnits = units.filter((unit) => draft[fieldValueKey("unit", "0700.0089", unit.id)] === false);
  const unclassifiedUnits = units.filter((unit) => {
    const value = draft[fieldValueKey("unit", "0700.0089", unit.id)];
    return value !== true && value !== false;
  });
  const highestBestUseHasNo = ["3100.0004", "3100.0006", "3100.0003", "3100.0005", "3100.0007"]
    .some((uid) => draft[fieldValueKey("highest_best_use", uid)] === false);
  const salesContractExists = draft[fieldValueKey("sales_contract", "0600.0016")];
  const salesComparisonIncluded = draft[fieldValueKey("sales_comparison_scope", "1000.0032")];
  const salesComparables = editor?.entities.filter((entity) => entity.entity_type === "sales_comparable") || [];

  function draftLookup(entityId: string | null) {
    return (requestedKey: string, uidOnly = false): UadFieldValue | undefined => {
      if (uidOnly) {
        const dependency = allFields.find((candidate) => candidate.uid === requestedKey);
        if (!dependency) return undefined;
        return draft[fieldValueKey(dependency.contextKey, dependency.uid, entityId)]
          ?? draft[fieldValueKey(dependency.contextKey, dependency.uid)];
      }
      const [contextKey, uid] = requestedKey.split(":");
      return draft[fieldValueKey(contextKey, uid, entityId)] ?? draft[fieldValueKey(contextKey, uid)];
    };
  }

  function setValue(field: UadFieldDefinition, entityId: string | null, value: UadFieldValue) {
    setDraft((current) => ({ ...current, [fieldValueKey(field.contextKey, field.uid, entityId)]: value }));
    setDirty(true);
    setSavedMessage(null);
  }

  function isVisible(field: UadFieldDefinition, entityId: string | null = null) {
    return evaluateCondition(field.showWhen, draftLookup(entityId));
  }

  function isRequired(field: UadFieldDefinition, entityId: string | null = null) {
    return Boolean(field.required || (field.requiredWhen && evaluateCondition(field.requiredWhen, draftLookup(entityId))));
  }

  function entitiesFor(entityType?: string, entityDataFilter?: Record<string, unknown>) {
    if (!entityType) return [];
    return editor?.entities.filter((entity) => (
      entity.entity_type === entityType
      && (!entityDataFilter || Object.entries(entityDataFilter).every(([key, value]) => entity.data?.[key] === value))
    )) || [];
  }

  async function handleEntityAdd(entityType: string, parentEntityId?: string, data?: Record<string, unknown>) {
    if (entityBusy) return;
    const preservedDraft = dirty ? draft : undefined;
    setEntityBusy(true);
    setError(null);
    try {
      await createUadEntity(workfileId, entityType, parentEntityId, data);
      await loadEditor(preservedDraft);
      setSavedMessage(preservedDraft ? "Record added; your unsaved field changes were retained." : "Record added to the UAD workfile.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The record could not be added.");
    } finally {
      setEntityBusy(false);
    }
  }

  async function handleEntityDelete(entity: UadEntity) {
    if (entityBusy) return;
    if (!window.confirm(`Remove ${entity.label || "this UAD record"}? Its saved field values will also be removed.`)) return;
    const preservedDraft = dirty
      ? Object.fromEntries(Object.entries(draft).filter(([key]) => !key.startsWith(`${entity.id}:`)))
      : undefined;
    setEntityBusy(true);
    setError(null);
    try {
      await deleteUadEntity(workfileId, entity.id);
      await loadEditor(preservedDraft);
      setSavedMessage(preservedDraft
        ? "Record removed; your other unsaved field changes were retained."
        : "Record removed from the UAD workfile and captured in its audit history.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The record could not be removed.");
    } finally {
      setEntityBusy(false);
    }
  }

  async function handleSave() {
    if (!section || saving) return;
    const submitted: Array<{ uid: string; context_key: string; entity_id?: string | null; value: UadFieldValue }> = [];
    const missing: string[] = [];
    for (const group of section.groups) {
      const instances = group.entityType
        ? entitiesFor(group.entityType, group.entityDataFilter).map((entity) => entity.id)
        : [null];
      for (const entityId of instances) {
        for (const field of group.fields) {
          const visible = isVisible(field, entityId);
          if (!visible && !["vehicle_storage", "subject_property_amenities", "market", "project_information", "subject_listing_information", "sales_contract", "prior_sale_transfer_history", "sales_comparison"].includes(activeSection)) continue;
          const key = fieldValueKey(field.contextKey, field.uid, entityId);
          if (visible && isRequired(field, entityId) && !valueIsPresent(draft[key])) missing.push(field.label);
          submitted.push({
            uid: field.uid,
            context_key: field.contextKey,
            entity_id: entityId,
            value: visible ? draft[key] ?? null : null,
          });
        }
      }
    }
    if (missing.length) {
      setError(`Complete ${missing.length} required field${missing.length === 1 ? "" : "s"} before saving this section.`);
      return;
    }

    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      await saveUadSection(workfileId, activeSection, submitted);
      await loadEditor();
      setSavedMessage(`${section.title} saved and added to the workfile audit history.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD section could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function renderControl(field: UadFieldDefinition, entityId: string | null) {
    const key = fieldValueKey(field.contextKey, field.uid, entityId);
    const value = draft[key];
    if (field.dataType === "boolean") {
      return (
        <select className={inputClass} onChange={(event) => setValue(field, entityId, event.target.value === "" ? null : event.target.value === "true")} value={value === true ? "true" : value === false ? "false" : ""}>
          <option value="">Select Yes or No</option><option value="true">Yes</option><option value="false">No</option>
        </select>
      );
    }
    if (field.dataType === "enum") {
      return (
        <select className={inputClass} onChange={(event) => setValue(field, entityId, event.target.value || null)} value={String(value ?? "")}>
          <option value="">Select an option</option>
          {field.options?.map((option) => <option key={option} value={option}>{displayOption(option)}</option>)}
        </select>
      );
    }
    if (field.dataType === "multi_enum") {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {field.options?.map((option) => (
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm" key={option}>
              <input checked={selected.includes(option)} onChange={(event) => setValue(field, entityId, event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))} type="checkbox" />
              {displayOption(option)}
            </label>
          ))}
        </div>
      );
    }
    if (field.dataType === "measurement") {
      const measurement = (typeof value === "object" && !Array.isArray(value) && value ? value : { amount: null, unit: "" }) as UadMeasurement;
      return (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,0.7fr)] gap-2">
          <input className={inputClass} max={field.maximum} min={field.minimum ?? field.minimumExclusive ?? 0} onChange={(event) => setValue(field, entityId, { ...measurement, amount: event.target.value === "" ? null : Number(event.target.value) })} step="any" type="number" value={measurement.amount ?? ""} />
          <select className={inputClass} onChange={(event) => setValue(field, entityId, { ...measurement, unit: event.target.value })} value={measurement.unit}>
            <option value="">Unit</option>{field.units?.map((unit) => <option key={unit} value={unit}>{displayOption(unit)}</option>)}
          </select>
        </div>
      );
    }
    if (field.dataType === "text") {
      return <textarea className={`${inputClass} min-h-24`} maxLength={field.maxLength} onChange={(event) => setValue(field, entityId, event.target.value)} value={String(value ?? "")} />;
    }
    const numeric = field.dataType === "integer" || field.dataType === "percentage" || field.dataType === "currency";
    return (
      <input
        className={inputClass}
        max={field.maximum ?? (field.dataType === "percentage" ? 100 : undefined)}
        maxLength={field.maxLength}
        min={field.minimum ?? (numeric ? 0 : undefined)}
        onChange={(event) => setValue(field, entityId, event.target.value === "" ? null : numeric ? Number(event.target.value) : event.target.value)}
        step={field.dataType === "currency" ? "0.01" : field.dataType === "percentage" ? "any" : undefined}
        type={numeric ? "number" : field.dataType === "date" ? "date" : field.dataType === "month" ? "month" : "text"}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
      />
    );
  }

  function renderFields(fields: UadFieldDefinition[], entityId: string | null) {
    return (
      <div className="mt-2 grid gap-4 md:grid-cols-2">
        {fields.filter((field) => isVisible(field, entityId)).map((field) => {
          const key = fieldValueKey(field.contextKey, field.uid, entityId);
          const saved = savedByKey.get(key);
          const wide = field.dataType === "text" || Boolean(field.maxLength && field.maxLength > 100);
          return (
            <label className={wide ? "md:col-span-2" : ""} key={field.key}>
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">
                {field.label}{isRequired(field, entityId) && <span className="text-red-700" title="Required">*</span>}
              </span>
              <span className="mt-0.5 block text-[11px] text-slate-500">Report field {field.reportFieldId} · UID {field.uid}</span>
              {renderControl(field, entityId)}
              {field.guidance && <span className="mt-1 block text-xs leading-5 text-slate-600">{field.guidance}</span>}
              <span className="mt-1 flex min-h-4 items-center gap-2 text-[11px] text-slate-500">
                {saved && <span className={`rounded-full px-2 py-0.5 ${saved.is_appraiser_confirmed ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"}`}>{saved.is_appraiser_confirmed ? "Appraiser confirmed" : "HomeNode suggestion"}</span>}
                {field.maxLength && <span>{String(draft[key] ?? "").length}/{field.maxLength}</span>}
              </span>
            </label>
          );
        })}
      </div>
    );
  }

  if (loading && !editor) return <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">Loading the UAD workfile editor…</div>;
  if (!editor || !section) return <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900">{error || "The UAD editor is unavailable."}</div>;

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
      <header className="border-b border-slate-200 bg-slate-950 px-5 py-4 text-white">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Active UAD workfile</div>
            <h2 className="mt-1 text-xl font-semibold">{editor.workfile.file_number}</h2>
            <p className="mt-1 text-xs text-slate-300">Revision {editor.workfile.current_revision} · UAD 3.6 · {editor.workfile.specification_release_key}</p>
          </div>
          <button className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800" onClick={onClose} type="button">Close editor</button>
        </div>
      </header>

      <nav className="grid grid-cols-2 border-b border-slate-200 bg-white md:grid-cols-3 xl:grid-cols-5" aria-label="UAD workfile sections">
        {editor.sections.filter((item) => item.applicable !== false).map((item) => {
          const completion = editor.completion[item.key];
          return (
            <button className={`px-3 py-4 text-left transition ${activeSection === item.key ? "border-b-2 border-emerald-700 bg-emerald-50" : "hover:bg-slate-50"}`} key={item.key} onClick={() => setActiveSection(item.key)} type="button">
              <div className="text-sm font-semibold">Section {item.officialSectionNumber}: {item.title}</div>
              <div className="mt-1 text-xs text-slate-500">{completion.completed} of {completion.required} required · {completion.percent}%</div>
            </button>
          );
        })}
      </nav>

      <div className="p-4 sm:p-6">
        <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
          Fields and IDs follow UAD 3.6 Appendix A-1 v1.4 and the Appendix C URAR layout. HomeNode data and automated location evidence remain suggestions until the appraiser saves them.
        </div>
        {activeSection === "site" && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            Site uses repeatable records for parcels, influences, views, utilities, encumbrances, features, and defects. For a Body of Water influence, add each body of water and answer its private-access questions; private access also requires total frontage and a verified Water Frontage photo. These subject facts redisplay in Section 22D without duplicate entry.
          </div>
        )}
        {activeSection === "disaster_mitigation" && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            Select None by itself when the property has no disaster mitigation features. In that case, Section 5 will not display in the final URAR.
          </div>
        )}
        {activeSection === "energy_green" && (
          <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
            Sections for renewable components, certifications, and ratings appear only when the corresponding known-features answer is Yes. Add each known item as its own record.
          </div>
        )}
        {activeSection === "sketch" && (
          <div className="mb-5 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm leading-6 text-violet-950">
            Section 7 always displays. If a sketch or floor plan is provided, upload at least one verified report image and identify the measurement standard. If one is not available, explain why in Sketch Commentary.
          </div>
        )}
        {activeSection === "dwelling_exterior" && (
          <div className="mb-5 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm leading-6 text-cyan-950">
            Section 8 repeats by dwelling. Complete the dwelling details, add the required exterior feature rows when the homeowner maintains the exterior, and keep noncontinuous-area and defect records consistent with their Yes/No answers. A verified front photo is required for every dwelling.
          </div>
        )}
        {activeSection === "manufactured_home" && (
          <div className="mb-5 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm leading-6 text-orange-950">
            Section 9 repeats only for dwellings whose Section 8 Construction Method is Manufactured. Record each skirting material, modification, HUD label, and certification program separately so the workfile can map cleanly into MISMO 3.6.
          </div>
        )}
        {activeSection === "unit_interior" && (
          <div className="mb-5 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm leading-6 text-teal-950">
            Section 10 repeats for every living unit and ADU. Record every level and room, reconcile the area and room counts, add Flooring and Walls and Ceiling features, and attach the required kitchen, bathroom, main-living-area, below-grade, update, ADU, and physical-defect images.
          </div>
        )}
        {activeSection === "functional_obsolescence" && (
          <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-950">
            Select None by itself when there are no apparent functional issues. For any reported issue, explain its effect in the commentary. Section 11 exhibits are optional and may document the analysis when useful.
          </div>
        )}
        {activeSection === "vehicle_storage" && (
          <div className="mb-5 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm leading-6 text-indigo-950">
            Report every vehicle storage type. Select None as the only record when no storage is available. Garage and carport details, driveway space logic, shared-project assignments, defect relationships, and required physical-defect photos follow the official Section 13 rules.
          </div>
        )}
        {activeSection === "subject_property_amenities" && (
          <div className="mb-5 rounded-xl border border-fuchsia-200 bg-fuchsia-50 p-4 text-sm leading-6 text-fuchsia-950">
            Start with Property Amenities Exist. Add each amenity in its official category so the same record can flow into the Sales Comparison Approach later. Amenity images are optional (up to two each); every reported physical defect requires a verified image and is linked to its amenity.
          </div>
        )}
        {activeSection === "overall_quality_condition" && (
          <div className="mb-5 rounded-xl border border-lime-200 bg-lime-50 p-4 text-sm leading-6 text-lime-950">
            Reconcile the overall Q1-Q6 and C1-C6 conclusions from the Section 8 exterior ratings and each non-ADU Section 10 interior rating. For a subject-to appraisal, the overall condition reflects the property as if the required work were satisfactorily completed. UAD 3.6 associates no images with Section 15.
          </div>
        )}
        {activeSection === "highest_best_use" && (
          <div className="mb-5 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm leading-6 text-cyan-950">
            Complete all four tests for the current improvements, or the proposed improvements in a subject-to appraisal, before concluding whether the present or proposed use is highest and best. Automated zoning and land-use screening may support the analysis, but these UAD answers remain appraiser-controlled. Supporting images are optional.
          </div>
        )}
        {activeSection === "highest_best_use" && highestBestUseHasNo && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
            One or more answers is No. Highest and Best Use Commentary is now required and must describe the supporting evidence and reasoning.
          </div>
        )}
        {activeSection === "market" && (
          <div className="mb-5 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm leading-6 text-violet-950">
            Define the market area and search criteria, then report active listings, pending sales, closed sales, price trends, supply, and marketing time. HomeNode's existing market and neighborhood tools can supply reviewable evidence without changing the custom appraisal workfile. Price trend commentary is required unless a verified Price Trend Graph is attached.
          </div>
        )}
        {activeSection === "subject_listing_information" && (
          <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
            Use a minimum one-year lookback. If no current or relevant listing exists, add every source used to reach that conclusion. If listings exist, add each listing separately; settled sales belong in Prior Sale and Transfer History. Existing HomeNode MLS activity remains source-attributed review material and is never treated as appraiser-confirmed merely because it was found automatically.
          </div>
        )}
        {activeSection === "sales_contract" && (
          <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-950">
            The report displays this section only when an active sales contract exists. If the contract was not analyzed, explain the information source, efforts to obtain it, and why it was unavailable. Personal property is excluded from the final opinion of value and must be described in the analysis.
          </div>
        )}
        {activeSection === "prior_sale_transfer_history" && (
          <div className="mb-5 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm leading-6 text-indigo-950">
            Report every relevant subject transfer during the three years before the appraisal effective date. Comparable transfers use a one-year lookback and attach to the same comparable records that will be created in Section 22, so future comparable searching can populate reviewable suggestions without duplicating appraisal data.
          </div>
        )}
        {activeSection === "sales_comparison" && (
          <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
            Sections 22A–22G establish each comparable's official general information, source trail, property-rights details, project or PUD information, Site facts and water frontage, repeatable dwellings, mechanical systems, energy-efficient and green features, Unit(s), typed adjustments, and required verified photo. Bodies of water remain linked to their Site Influence; construction, heating, cooling, and living units remain linked to the exact comparable structure; accessibility features remain linked to the exact unit. Subject energy/green and unit facts redisplay from Sections 6 and 10 without duplicate entry. Unit, ADU, dwelling, and per-structure counts reconcile before completion. Those relationships keep future MISMO XML, mobile evidence, and comparable-search suggestions on one canonical record. Only an appraiser save confirms suggested data for the UAD report.
          </div>
        )}
        {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>}
        {savedMessage && <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{savedMessage}</div>}

        <div className="space-y-5">
          {activeSection === "overall_quality_condition" && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <h3 className="text-base font-semibold text-slate-900">Ratings redisplayed from the workfile</h3>
              <p className="mt-1 text-sm text-slate-600">These values remain editable in their source sections, so Section 15 and the future submission XML cannot drift apart.</p>

              <div className="mt-4">
                <h4 className="text-sm font-semibold text-slate-800">Exterior quality and condition · Section 8</h4>
                {homeownerMaintainsExterior === false && (
                  <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">Not applicable because Section 3 indicates the homeowner is not responsible for exterior maintenance.</div>
                )}
                {homeownerMaintainsExterior !== true && homeownerMaintainsExterior !== false && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">Complete Homeowner Responsible for Exterior Maintenance in Section 3 to determine whether exterior ratings display.</div>
                )}
                {homeownerMaintainsExterior === true && (
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    {dwellings.map((dwelling) => {
                      const quality = draft[fieldValueKey("dwelling", "1600.0005", dwelling.id)];
                      const condition = draft[fieldValueKey("dwelling", "1600.0004", dwelling.id)];
                      const identifier = draft[fieldValueKey("dwelling", "0300.0101", dwelling.id)];
                      return (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3" key={`overall-exterior-${dwelling.id}`}>
                          <div className="text-sm font-semibold text-slate-900">{String(identifier || dwelling.label || `Dwelling ${dwelling.ordinal}`)}</div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            <span className={`rounded-full px-2.5 py-1 font-semibold ${quality ? "bg-blue-100 text-blue-900" : "bg-amber-100 text-amber-900"}`}>Exterior quality 15.002: {String(quality || "Incomplete")}</span>
                            <span className={`rounded-full px-2.5 py-1 font-semibold ${condition ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>Exterior condition 15.007: {String(condition || "Incomplete")}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="mt-5">
                <h4 className="text-sm font-semibold text-slate-800">Interior quality and condition · Section 10 non-ADU units</h4>
                {unclassifiedUnits.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                    Complete the Section 10 ADU answer for {unclassifiedUnits.map((unit) => unit.label || `Unit ${unit.ordinal}`).join(", ")} before saving Section 15.
                  </div>
                )}
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  {nonAduUnits.map((unit) => {
                    const quality = draft[fieldValueKey("unit", "0700.0067", unit.id)];
                    const condition = draft[fieldValueKey("unit", "0700.0066", unit.id)];
                    const identifier = draft[fieldValueKey("unit", "0700.0114", unit.id)];
                    return (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3" key={`overall-interior-${unit.id}`}>
                        <div className="text-sm font-semibold text-slate-900">{String(identifier || unit.label || `Unit ${unit.ordinal}`)}</div>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          <span className={`rounded-full px-2.5 py-1 font-semibold ${quality ? "bg-blue-100 text-blue-900" : "bg-amber-100 text-amber-900"}`}>Interior quality 15.004: {String(quality || "Incomplete")}</span>
                          <span className={`rounded-full px-2.5 py-1 font-semibold ${condition ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>Interior condition 15.009: {String(condition || "Incomplete")}</span>
                        </div>
                      </div>
                    );
                  })}
                  {!nonAduUnits.length && <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No living unit is currently classified as a non-ADU. Verify the Section 10 ADU answers before saving this section.</div>}
                </div>
              </div>
            </section>
          )}
          {section.groups.map((group) => {
            if (!group.entityType) {
              const visibleFields = group.fields.filter((field) => isVisible(field));
              if (!visibleFields.length) return null;
              return (
                <fieldset className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5" key={group.name}>
                  <legend className="px-2 text-base font-semibold text-slate-900">{group.name}</legend>
                  {renderFields(visibleFields, null)}
                </fieldset>
              );
            }
            const entities = entitiesFor(group.entityType, group.entityDataFilter);
            const parentEntityTypes = group.parentEntityTypes
              || (group.parentEntityType ? [group.parentEntityType] : []);
            if (parentEntityTypes.length) {
              const parents = editor?.entities.filter((entity) => parentEntityTypes.includes(entity.entity_type)) || [];
              const visibleParents = parents.filter((parent) => {
                const children = entities.filter((entity) => entity.parent_entity_id === parent.id);
                const enabled = !group.showWhen || evaluateCondition(group.showWhen, draftLookup(parent.id));
                return enabled || children.length > 0;
              });
              if (!visibleParents.length) return null;
              return (
                <fieldset className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5" key={group.name}>
                  <legend className="px-2 text-base font-semibold text-slate-900">{group.name}</legend>
                  <div className="mt-2 space-y-5">
                    {visibleParents.map((parent) => {
                      const children = entities.filter((entity) => entity.parent_entity_id === parent.id);
                      const parentGroupEnabled = !group.showWhen || evaluateCondition(group.showWhen, draftLookup(parent.id));
                      return (
                        <div className="rounded-xl border border-slate-200 p-4" key={parent.id}>
                          <div className="text-sm font-semibold text-slate-900">{parent.label || `${parent.entity_type} ${parent.ordinal}`}</div>
                          <div className="mt-3 space-y-3">
                            {!parentGroupEnabled && children.length > 0 && (
                              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                                Remove the saved record{children.length === 1 ? "" : "s"} below before saving the controlling answer as No.
                              </div>
                            )}
                            {children.map((entity) => (
                              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4" key={entity.id}>
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-sm font-semibold text-slate-900">{entity.label || `${group.name} ${entity.ordinal}`}</div>
                                  <button className="text-xs font-semibold text-red-700 hover:text-red-900 disabled:opacity-50" disabled={entityBusy} onClick={() => void handleEntityDelete(entity)} type="button">Remove</button>
                                </div>
                                {renderFields(group.fields, entity.id)}
                              </div>
                            ))}
                            {!children.length && <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No {group.name.toLowerCase()} added for this structure.</div>}
                            {parentGroupEnabled && group.createEnabled !== false && (
                              <button className="rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50" disabled={entityBusy || children.length >= Number(group.maxItems || Number.POSITIVE_INFINITY)} onClick={() => void handleEntityAdd(group.entityType!, parent.id, group.createData)} type="button">+ {group.addLabel || `Add ${group.name}`}</button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              );
            }
            const groupEnabled = !group.showWhen || evaluateCondition(group.showWhen, draftLookup(null));
            const displayedEntities = groupEnabled
              ? entities.filter((entity) => group.fields.some((field) => isVisible(field, entity.id)))
              : entities;
            if (!groupEnabled && !displayedEntities.length) return null;
            if (!displayedEntities.length && group.createEnabled === false) return null;
            return (
              <fieldset className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5" key={group.name}>
                <legend className="px-2 text-base font-semibold text-slate-900">{group.name}</legend>
                <div className="mt-2 space-y-4">
                  {!groupEnabled && displayedEntities.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                      Remove the saved record{displayedEntities.length === 1 ? "" : "s"} below before saving the corresponding known-features answer as No.
                    </div>
                  )}
                  {displayedEntities.map((entity) => (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4" key={entity.id}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">{entity.label || `${group.name} ${entity.ordinal}`}</div>
                        <button className="text-xs font-semibold text-red-700 hover:text-red-900 disabled:opacity-50" disabled={entityBusy || entities.length <= Number(group.minItems || 0)} onClick={() => void handleEntityDelete(entity)} type="button">Remove</button>
                      </div>
                      {renderFields(group.fields, entity.id)}
                    </div>
                  ))}
                  {!displayedEntities.length && <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No {group.name.toLowerCase()} added.</div>}
                  {groupEnabled && group.createEnabled !== false && <button className="rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50" disabled={entityBusy || displayedEntities.length >= Number(group.maxItems || Number.POSITIVE_INFINITY)} onClick={() => void handleEntityAdd(group.entityType!, undefined, group.createData)} type="button">+ {group.addLabel || `Add ${group.name}`}</button>}
                </div>
              </fieldset>
            );
          })}
          {activeSection === "site" && (
            <UadAssetPanel captionTypes={SITE_CAPTIONS} sectionNumber={4} title="Site photos, exhibits, and supporting files" workfileId={workfileId} />
          )}
          {activeSection === "disaster_mitigation" && disasterSectionDisplays && (
            <UadAssetPanel captionTypes={DISASTER_MITIGATION_CAPTIONS} sectionNumber={5} title="Disaster mitigation exhibits" workfileId={workfileId} />
          )}
          {activeSection === "energy_green" && energySectionDisplays && (
            <UadAssetPanel captionTypes={ENERGY_GREEN_CAPTIONS} sectionNumber={6} title="Energy efficient and green feature exhibits" workfileId={workfileId} />
          )}
          {activeSection === "sketch" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SKETCH_REPORT_CAPTIONS}
              description="Upload the rendered sketch or floor plan image that will display in URAR Section 7. HomeNode accepts the image MIME types permitted by the UAD delivery specification."
              emptyMessage="No verified sketch or floor plan image uploaded yet."
              sectionNumber={7}
              title="Report sketch or floor plan"
              uploadEnabled={sketchProvided === true}
              visibleCaptionTypes={SKETCH_REPORT_CAPTIONS}
              workfileId={workfileId}
            />
          )}
          {activeSection === "sketch" && sketchProvided === true && (
            <UadAssetPanel
              accept="application/json,application/pdf,image/svg+xml"
              captionTypes={SKETCH_SOURCE_CAPTIONS}
              description="Optional source geometry, measurement exports, and supporting diagrams remain in the private workfile for mobile synchronization and future sketch rendering; they do not replace the required report image."
              emptyMessage="No supporting measurement source uploaded."
              sectionNumber={7}
              title="Structured measurement sources"
              visibleCaptionTypes={SKETCH_SOURCE_CAPTIONS}
              workfileId={workfileId}
            />
          )}
          {activeSection === "dwelling_exterior" && dwellings.map((dwelling) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={DWELLING_EXTERIOR_CAPTIONS}
              description="The front photo is required. Rear, noncontinuous-area, and other exterior images may be added as applicable. Files use the same private R2 upload contract planned for the HomeNode mobile capture app."
              emptyMessage="No verified dwelling exterior images uploaded yet."
              entityId={dwelling.id}
              key={dwelling.id}
              sectionNumber={8}
              title={`${dwelling.label || `Dwelling ${dwelling.ordinal}`} photos and exhibits`}
              visibleCaptionTypes={DWELLING_EXTERIOR_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "manufactured_home" && manufacturedDwellings.map((dwelling) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={MANUFACTURED_HOME_GENERAL_CAPTIONS}
              description="Upload the HUD data plate or verification source and any other manufactured-home exhibit. The HUD data plate image is required when the plate is attached."
              emptyMessage="No verified HUD data plate or general manufactured-home exhibits uploaded yet."
              entityId={dwelling.id}
              key={`manufactured-home-${dwelling.id}`}
              sectionNumber={9}
              title={`${dwelling.label || `Dwelling ${dwelling.ordinal}`} HUD data plate and exhibits`}
              visibleCaptionTypes={MANUFACTURED_HOME_GENERAL_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "manufactured_home" && manufacturedHomeHudLabels.map((label) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={MANUFACTURED_HOME_HUD_LABEL_CAPTIONS}
              description="Upload an image of this HUD certification label or its verification source."
              emptyMessage="No verified HUD certification label image uploaded yet."
              entityId={label.id}
              key={`manufactured-home-label-${label.id}`}
              sectionNumber={9}
              title={`${label.label || `HUD certification label ${label.ordinal}`} image`}
              visibleCaptionTypes={MANUFACTURED_HOME_HUD_LABEL_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "manufactured_home" && manufacturedHomePrograms.map((program) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={MANUFACTURED_HOME_PROGRAM_CAPTIONS}
              description="Upload the eligibility or certification image for this manufactured-home financing program."
              emptyMessage="No verified manufactured-home program certification image uploaded yet."
              entityId={program.id}
              key={`manufactured-home-program-${program.id}`}
              sectionNumber={9}
              title={`${program.label || `Certification program ${program.ordinal}`} image`}
              visibleCaptionTypes={MANUFACTURED_HOME_PROGRAM_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "unit_interior" && units.map((unit) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={UNIT_INTERIOR_GENERAL_CAPTIONS}
              description="Optional general interior exhibits attach to this living unit. Room, feature, and defect images are attached to their specific records below so the XML relationship remains explicit."
              emptyMessage="No general unit interior exhibits uploaded."
              entityId={unit.id}
              key={`unit-interior-${unit.id}`}
              sectionNumber={10}
              title={`${unit.label || `Unit ${unit.ordinal}`} interior exhibits`}
              visibleCaptionTypes={UNIT_INTERIOR_GENERAL_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "functional_obsolescence" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={FUNCTIONAL_OBSOLESCENCE_CAPTIONS}
              description="Optional images may support the functional-obsolescence analysis. UAD 3.6 does not require a Section 11 photo."
              emptyMessage="No optional functional-obsolescence exhibits uploaded."
              sectionNumber={11}
              title="Functional obsolescence exhibits"
              workfileId={workfileId}
            />
          )}
          {activeSection === "outbuilding" && outbuildings.map((outbuilding) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={OUTBUILDING_GENERAL_CAPTIONS}
              description="A verified exterior/front photo and interior photo are required for every outbuilding. Rear, room, foundation, and exhibit images may be added when applicable."
              emptyMessage="No verified outbuilding images uploaded yet."
              entityId={outbuilding.id}
              key={`outbuilding-${outbuilding.id}`}
              sectionNumber={12}
              title={`${outbuilding.label || `Outbuilding ${outbuilding.ordinal}`} photos and exhibits`}
              visibleCaptionTypes={OUTBUILDING_GENERAL_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "outbuilding" && outbuildingDefects.map((defect) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={OUTBUILDING_DEFECT_CAPTIONS}
              description="Upload and verify a photo documenting this physical outbuilding defect, damage, or deficiency."
              emptyMessage="No verified outbuilding defect image uploaded yet."
              entityId={defect.id}
              key={`outbuilding-defect-${defect.id}`}
              sectionNumber={12}
              title={`${defect.label || `Outbuilding defect ${defect.ordinal}`} photo`}
              visibleCaptionTypes={OUTBUILDING_DEFECT_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "vehicle_storage" && vehicleStorages.map((vehicleStorage) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={VEHICLE_STORAGE_GENERAL_CAPTIONS}
              description="Optional garage, carport, driveway, or parking images attach directly to this vehicle storage record and display in Vehicle Storage Exhibits."
              emptyMessage="No optional vehicle storage images uploaded."
              entityId={vehicleStorage.id}
              key={`vehicle-storage-${vehicleStorage.id}`}
              sectionNumber={13}
              title={`${vehicleStorage.label || `Vehicle storage ${vehicleStorage.ordinal}`} photos and exhibits`}
              visibleCaptionTypes={VEHICLE_STORAGE_GENERAL_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "vehicle_storage" && vehicleStorageDefects.map((defect) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={VEHICLE_STORAGE_DEFECT_CAPTIONS}
              description="Upload and verify a photo documenting this physical vehicle storage defect, damage, or deficiency."
              emptyMessage="No verified vehicle storage defect image uploaded yet."
              entityId={defect.id}
              key={`vehicle-storage-defect-${defect.id}`}
              sectionNumber={13}
              title={`${defect.label || `Vehicle storage defect ${defect.ordinal}`} photo`}
              visibleCaptionTypes={VEHICLE_STORAGE_DEFECT_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "subject_property_amenities" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SUBJECT_AMENITY_GENERAL_CAPTIONS}
              description="Optional Section 14 exhibits that are not specific to one amenity may be added here. Provide a descriptive caption so the image can be identified in the report."
              emptyMessage="No general subject property amenity exhibits uploaded."
              sectionNumber={14}
              title="Subject property amenities exhibits"
              workfileId={workfileId}
            />
          )}
          {activeSection === "subject_property_amenities" && subjectAmenities.map((amenity) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SUBJECT_AMENITY_CAPTIONS}
              description="Optional images attach directly to this amenity. UAD 3.6 permits up to two report images for each amenity."
              emptyMessage="No optional amenity images uploaded."
              entityId={amenity.id}
              key={`subject-amenity-${amenity.id}`}
              sectionNumber={14}
              title={`${amenity.label || `Amenity ${amenity.ordinal}`} images`}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "subject_property_amenities" && subjectAmenityDefects.map((defect) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SUBJECT_AMENITY_DEFECT_CAPTIONS}
              description="A verified image is required for this physical defect, damage, or deficiency. Up to four images may be attached to the defect."
              emptyMessage="No verified amenity defect image uploaded yet."
              entityId={defect.id}
              key={`subject-amenity-defect-${defect.id}`}
              sectionNumber={14}
              title={`${defect.label || `Amenity defect ${defect.ordinal}`} images`}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "highest_best_use" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={HIGHEST_BEST_USE_CAPTIONS}
              description="Optional photos or images may support the Section 16 analysis. Provide a descriptive caption for every exhibit so it can be identified in the URAR."
              emptyMessage="No optional highest and best use exhibits uploaded."
              sectionNumber={16}
              title="Highest and best use exhibits"
              workfileId={workfileId}
            />
          )}
          {activeSection === "market" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={MARKET_CAPTIONS}
              description="Upload market graphs, a boundary map, search-result support, or another market-analysis exhibit. A verified Price Trend Graph satisfies the graph-or-commentary requirement; every image remains tied only to this UAD workfile."
              emptyMessage="No optional market graphs or exhibits uploaded."
              sectionNumber={17}
              title="Market graphs and exhibits"
              workfileId={workfileId}
            />
          )}
          {activeSection === "project_information" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={PROJECT_INFORMATION_GENERAL_CAPTIONS}
              description="Upload the required photo for an observed physical project deficiency or add another project exhibit. Captions and images remain isolated to this UAD workfile and are ready for mobile capture through the shared R2 upload path."
              emptyMessage="No project deficiency photos or general project exhibits uploaded."
              sectionNumber={18}
              title="Project information exhibits"
              visibleCaptionTypes={PROJECT_INFORMATION_GENERAL_CAPTIONS}
              workfileId={workfileId}
            />
          )}
          {activeSection === "project_information" && projectAmenities.map((amenity) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={PROJECT_AMENITY_CAPTIONS}
              description="Optional photos or images document this common amenity or service and display in Project Information Exhibits."
              emptyMessage="No optional project amenity image uploaded."
              entityId={amenity.id}
              key={`project-amenity-${amenity.id}`}
              sectionNumber={18}
              title={`${amenity.label || `Project amenity ${amenity.ordinal}`} images`}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "subject_listing_information" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SUBJECT_LISTING_CAPTIONS}
              description="Upload optional photos or images relevant to the subject listing analysis. Each exhibit remains isolated to this UAD workfile and requires a descriptive caption."
              emptyMessage="No optional subject listing exhibits uploaded."
              sectionNumber={19}
              title="Subject listing information exhibits"
              visibleCaptionTypes={SUBJECT_LISTING_CAPTIONS}
              workfileId={workfileId}
            />
          )}
          {activeSection === "sales_contract" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SALES_CONTRACT_CAPTIONS}
              description="Upload optional photos or images relevant to the active sales contract. A descriptive caption is required. When no active contract exists, uploads are disabled but saved exhibits remain visible for removal."
              emptyMessage="No optional sales contract exhibits uploaded."
              sectionNumber={20}
              title="Sales contract exhibits"
              uploadEnabled={salesContractExists === true}
              visibleCaptionTypes={SALES_CONTRACT_CAPTIONS}
              workfileId={workfileId}
            />
          )}
          {activeSection === "prior_sale_transfer_history" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={PRIOR_TRANSFER_CAPTIONS}
              description="Upload optional photos or images relevant to the prior sale and transfer analysis. A descriptive caption is required, and each exhibit remains isolated to this UAD workfile."
              emptyMessage="No optional prior sale and transfer history exhibits uploaded."
              sectionNumber={21}
              title="Prior sale and transfer history exhibits"
              visibleCaptionTypes={PRIOR_TRANSFER_CAPTIONS}
              workfileId={workfileId}
            />
          )}
          {activeSection === "sales_comparison" && salesComparables.map((comparable) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SALES_COMPARABLE_PHOTO_CAPTIONS}
              description="A verified property photo is required for every sales comparable. It attaches to this canonical comparable record so mobile capture and the future adjustment grid use the same evidence."
              emptyMessage="No verified comparable property photo uploaded yet."
              entityId={comparable.id}
              key={`sales-comparable-${comparable.id}`}
              sectionNumber={22}
              title={`${comparable.label || `Comparable ${comparable.ordinal}`} property photo`}
              uploadEnabled={salesComparisonIncluded === true}
              visibleCaptionTypes={SALES_COMPARABLE_PHOTO_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "sales_comparison" && (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={SALES_COMPARISON_EXHIBIT_CAPTIONS}
              description="Upload optional photographs, maps, search support, or other images relevant to the Sales Comparison Approach. General exhibits stay at workfile level; comparable property photos attach to the individual comparable above."
              emptyMessage="No optional sales-comparison exhibits uploaded."
              sectionNumber={22}
              title="Sales Comparison Approach exhibits"
              uploadEnabled={salesComparisonIncluded === true}
              visibleCaptionTypes={SALES_COMPARISON_EXHIBIT_CAPTIONS}
              workfileId={workfileId}
            />
          )}
          {activeSection === "unit_interior" && unitRooms.map((room) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={UNIT_INTERIOR_ROOM_CAPTIONS}
              description="Verified images are required for every kitchen and bathroom; bedrooms and primary living, family, and dining areas; and every applicable below-grade area. Other room photos may be added when useful."
              emptyMessage="No verified room image uploaded yet."
              entityId={room.id}
              key={`unit-room-${room.id}`}
              sectionNumber={10}
              title={`${room.label || `Room ${room.ordinal}`} photo`}
              visibleCaptionTypes={UNIT_INTERIOR_ROOM_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "unit_interior" && unitInteriorFeatures.map((feature) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={UNIT_INTERIOR_FEATURE_CAPTIONS}
              description="Optional feature images attach directly to the flooring, walls and ceiling, or other feature record."
              emptyMessage="No feature image uploaded."
              entityId={feature.id}
              key={`unit-feature-${feature.id}`}
              sectionNumber={10}
              title={`${feature.label || `Interior feature ${feature.ordinal}`} image`}
              visibleCaptionTypes={UNIT_INTERIOR_FEATURE_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
          {activeSection === "unit_interior" && unitInteriorDefects.map((defect) => (
            <UadAssetPanel
              accept={SKETCH_IMAGE_ACCEPT}
              captionTypes={UNIT_INTERIOR_DEFECT_CAPTIONS}
              description="Upload and verify a photo documenting this physical defect, damage, or deficiency."
              emptyMessage="No verified defect image uploaded yet."
              entityId={defect.id}
              key={`unit-defect-${defect.id}`}
              sectionNumber={10}
              title={`${defect.label || `Interior defect ${defect.ordinal}`} photo`}
              visibleCaptionTypes={UNIT_INTERIOR_DEFECT_CAPTIONS}
              workfileId={workfileId}
            />
          ))}
        </div>

        <div className="sticky bottom-3 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-300 bg-white/95 p-4 shadow-lg backdrop-blur">
          <div className="text-xs text-slate-600">{dirty ? "Unsaved changes" : "All displayed changes saved"}</div>
          <button className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60" disabled={saving || !dirty} onClick={handleSave} type="button">
            {saving ? "Saving…" : `Save ${section.title}`}
          </button>
        </div>
      </div>
    </section>
  );
}
