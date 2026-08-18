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

  function entitiesFor(entityType?: string) {
    return entityType ? editor?.entities.filter((entity) => entity.entity_type === entityType) || [] : [];
  }

  async function handleEntityAdd(entityType: string, parentEntityId?: string) {
    if (entityBusy) return;
    const preservedDraft = dirty ? draft : undefined;
    setEntityBusy(true);
    setError(null);
    try {
      await createUadEntity(workfileId, entityType, parentEntityId);
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
    if (dirty) {
      setError("Save this section before removing a repeatable record.");
      return;
    }
    if (!window.confirm(`Remove ${entity.label || "this UAD record"}? Its saved field values will also be removed.`)) return;
    setEntityBusy(true);
    setError(null);
    try {
      await deleteUadEntity(workfileId, entity.id);
      await loadEditor();
      setSavedMessage("Record removed from the UAD workfile and captured in its audit history.");
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
      const instances = group.entityType ? entitiesFor(group.entityType).map((entity) => entity.id) : [null];
      for (const entityId of instances) {
        for (const field of group.fields.filter((candidate) => isVisible(candidate, entityId))) {
          const key = fieldValueKey(field.contextKey, field.uid, entityId);
          if (isRequired(field, entityId) && !valueIsPresent(draft[key])) missing.push(field.label);
          submitted.push({ uid: field.uid, context_key: field.contextKey, entity_id: entityId, value: draft[key] ?? null });
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
          <input className={inputClass} min={field.minimum ?? field.minimumExclusive ?? 0} onChange={(event) => setValue(field, entityId, { ...measurement, amount: event.target.value === "" ? null : Number(event.target.value) })} step="any" type="number" value={measurement.amount ?? ""} />
          <select className={inputClass} onChange={(event) => setValue(field, entityId, { ...measurement, unit: event.target.value })} value={measurement.unit}>
            <option value="">Unit</option>{field.units?.map((unit) => <option key={unit} value={unit}>{displayOption(unit)}</option>)}
          </select>
        </div>
      );
    }
    if (field.dataType === "text") {
      return <textarea className={`${inputClass} min-h-24`} maxLength={field.maxLength} onChange={(event) => setValue(field, entityId, event.target.value)} value={String(value ?? "")} />;
    }
    const numeric = field.dataType === "integer" || field.dataType === "percentage";
    return (
      <input
        className={inputClass}
        max={field.maximum ?? (field.dataType === "percentage" ? 100 : undefined)}
        maxLength={field.maxLength}
        min={field.minimum ?? (numeric ? 0 : undefined)}
        onChange={(event) => setValue(field, entityId, event.target.value === "" ? null : numeric ? Number(event.target.value) : event.target.value)}
        type={numeric ? "number" : field.dataType === "date" ? "date" : "text"}
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
            Site uses repeatable records for parcels, influences, views, utilities, encumbrances, features, and defects. This same entity model is reserved for future comparable-sales and market-analysis integration.
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
        {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>}
        {savedMessage && <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{savedMessage}</div>}

        <div className="space-y-5">
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
            const entities = entitiesFor(group.entityType);
            if (group.parentEntityType) {
              const parents = entitiesFor(group.parentEntityType);
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
                          <div className="text-sm font-semibold text-slate-900">{parent.label || `${group.parentEntityType} ${parent.ordinal}`}</div>
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
                            {!children.length && <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No {group.name.toLowerCase()} added for this dwelling.</div>}
                            {parentGroupEnabled && group.createEnabled !== false && (
                              <button className="rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50" disabled={entityBusy} onClick={() => void handleEntityAdd(group.entityType!, parent.id)} type="button">+ {group.addLabel || `Add ${group.name}`}</button>
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
            const displayedEntities = entities.filter((entity) => group.fields.some((field) => isVisible(field, entity.id)));
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
                  {groupEnabled && group.createEnabled !== false && <button className="rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50" disabled={entityBusy} onClick={() => void handleEntityAdd(group.entityType!)} type="button">+ {group.addLabel || `Add ${group.name}`}</button>}
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
