import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getUadEditor,
  saveUadSection,
  type UadEditorResponse,
  type UadFieldDefinition,
  type UadFieldValue,
} from "../api";

interface Props {
  workfileId: string;
  onClose: () => void;
}

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";

function displayOption(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("REO", "REO");
}

function fieldValueKey(contextKey: string, uid: string) {
  return `${contextKey}:${uid}`;
}

function valueIsPresent(value: UadFieldValue | undefined) {
  return value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);
}

export default function UadWorkfileEditor({ workfileId, onClose }: Props) {
  const [editor, setEditor] = useState<UadEditorResponse | null>(null);
  const [activeSection, setActiveSection] = useState<"assignment" | "subject">("assignment");
  const [draft, setDraft] = useState<Record<string, UadFieldValue>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const loadEditor = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getUadEditor(workfileId);
      setEditor(response);
      setDraft(Object.fromEntries(response.values.map((item) => [fieldValueKey(item.context_key, item.uid), item.value])));
      setDirty(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD editor could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [workfileId]);

  useEffect(() => {
    void loadEditor();
  }, [loadEditor]);

  const section = editor?.sections.find((item) => item.key === activeSection);
  const allFields = useMemo(
    () => editor?.sections.flatMap((item) => item.groups.flatMap((group) => group.fields)) || [],
    [editor],
  );
  const savedByKey = useMemo(
    () => new Map(editor?.values.map((item) => [fieldValueKey(item.context_key, item.uid), item]) || []),
    [editor],
  );

  function setValue(field: UadFieldDefinition, value: UadFieldValue) {
    setDraft((current) => ({ ...current, [field.key]: value }));
    setDirty(true);
    setSavedMessage(null);
  }

  function isVisible(field: UadFieldDefinition) {
    if (!field.showWhen) return true;
    const dependency = allFields.find((candidate) => candidate.section === field.section && candidate.uid === field.showWhen?.uid);
    return dependency ? draft[dependency.key] === field.showWhen.equals : true;
  }

  async function handleSave() {
    if (!section || saving) return;
    const fields = section.groups.flatMap((group) => group.fields).filter(isVisible);
    const missing = fields.filter((field) => field.required && !valueIsPresent(draft[field.key]));
    if (missing.length) {
      setError(`Complete ${missing.length} required field${missing.length === 1 ? "" : "s"} before saving this section.`);
      return;
    }

    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      await saveUadSection(
        workfileId,
        activeSection,
        fields.map((field) => ({
          uid: field.uid,
          context_key: field.contextKey,
          value: draft[field.key] ?? null,
        })),
      );
      await loadEditor();
      setSavedMessage(`${section.title} saved and added to the workfile audit history.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The UAD section could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function renderControl(field: UadFieldDefinition) {
    const value = draft[field.key];
    if (field.dataType === "boolean") {
      return (
        <select
          className={inputClass}
          onChange={(event) => setValue(field, event.target.value === "" ? null : event.target.value === "true")}
          value={value === true ? "true" : value === false ? "false" : ""}
        >
          <option value="">Select Yes or No</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    }
    if (field.dataType === "enum") {
      return (
        <select className={inputClass} onChange={(event) => setValue(field, event.target.value || null)} value={String(value ?? "")}>
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
              <input
                checked={selected.includes(option)}
                onChange={(event) => setValue(field, event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))}
                type="checkbox"
              />
              {displayOption(option)}
            </label>
          ))}
        </div>
      );
    }
    if (field.dataType === "text") {
      return (
        <textarea
          className={`${inputClass} min-h-24`}
          maxLength={field.maxLength}
          onChange={(event) => setValue(field, event.target.value)}
          value={String(value ?? "")}
        />
      );
    }
    return (
      <input
        className={inputClass}
        maxLength={field.maxLength}
        min={field.dataType === "integer" ? 0 : undefined}
        onChange={(event) => setValue(field, event.target.value === "" ? null : field.dataType === "integer" ? Number(event.target.value) : event.target.value)}
        type={field.dataType === "integer" ? "number" : field.dataType === "date" ? "date" : "text"}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
      />
    );
  }

  if (loading && !editor) {
    return <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">Loading the UAD workfile editor…</div>;
  }
  if (!editor || !section) {
    return <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900">{error || "The UAD editor is unavailable."}</div>;
  }

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

      <nav className="grid grid-cols-2 border-b border-slate-200 bg-white" aria-label="UAD workfile sections">
        {editor.sections.map((item) => {
          const completion = editor.completion[item.key];
          return (
            <button
              className={`px-4 py-4 text-left transition ${activeSection === item.key ? "border-b-2 border-emerald-700 bg-emerald-50" : "hover:bg-slate-50"}`}
              key={item.key}
              onClick={() => setActiveSection(item.key)}
              type="button"
            >
              <div className="text-sm font-semibold">Section {item.officialSectionNumber}: {item.title}</div>
              <div className="mt-1 text-xs text-slate-500">{completion.completed} of {completion.required} required · {completion.percent}%</div>
            </button>
          );
        })}
      </nav>

      <div className="p-4 sm:p-6">
        <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
          Fields and IDs follow the official UAD 3.6 Appendix A delivery specification and Appendix C URAR layout. HomeNode-prefilled values remain unconfirmed until you save this section.
        </div>
        {error && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>}
        {savedMessage && <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{savedMessage}</div>}

        <div className="space-y-5">
          {section.groups.map((group) => {
            const visibleFields = group.fields.filter(isVisible);
            if (!visibleFields.length) return null;
            return (
              <fieldset className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5" key={group.name}>
                <legend className="px-2 text-base font-semibold text-slate-900">{group.name}</legend>
                <div className="mt-2 grid gap-4 md:grid-cols-2">
                  {visibleFields.map((field) => {
                    const saved = savedByKey.get(field.key);
                    const wide = field.dataType === "text" || field.maxLength && field.maxLength > 100;
                    return (
                      <label className={wide ? "md:col-span-2" : ""} key={field.key}>
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800">
                          {field.label}
                          {field.required && <span className="text-red-700" title="Required">*</span>}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-slate-500">Report field {field.reportFieldId} · UID {field.uid}</span>
                        {renderControl(field)}
                        <span className="mt-1 flex min-h-4 items-center gap-2 text-[11px] text-slate-500">
                          {saved && <span className={`rounded-full px-2 py-0.5 ${saved.is_appraiser_confirmed ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"}`}>{saved.is_appraiser_confirmed ? "Appraiser confirmed" : "HomeNode prefill"}</span>}
                          {field.maxLength && <span>{String(draft[field.key] ?? "").length}/{field.maxLength}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>

        <div className="sticky bottom-3 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-300 bg-white/95 p-4 shadow-lg backdrop-blur">
          <div className="text-xs text-slate-600">{dirty ? "Unsaved changes" : "All displayed changes saved"}</div>
          <button
            className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving || !dirty}
            onClick={handleSave}
            type="button"
          >
            {saving ? "Saving…" : `Save ${section.title}`}
          </button>
        </div>
      </div>
    </section>
  );
}
