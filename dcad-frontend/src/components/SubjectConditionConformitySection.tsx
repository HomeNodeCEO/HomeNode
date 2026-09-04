import type { AssignmentDetailsPayload } from "@/lib/api";
import { UAD_CONDITION_RATINGS } from "@/lib/conditionQualityRatings";
import { CheckboxChoice } from "@/components/PropertyReportControls";

type AssignmentDetails = AssignmentDetailsPayload;

const SUBJECT_NONCONFORMITY_OPTIONS = [
  ["under_improvement", "Under-Improvement"],
  ["over_improvement", "Over-Improvement"],
  ["functional_obsolescence", "Functional Obsolescence"],
  ["other", "Other"],
] as const;

type SubjectConditionConformitySectionProps = {
  assignment: AssignmentDetails;
  dirty: boolean;
  saveMessage: string;
  saving: boolean;
  saveDisabled: boolean;
  onChange: <K extends keyof AssignmentDetails>(key: K, value: AssignmentDetails[K]) => void;
  onConformityChange: (value: boolean | null) => void;
  onSave: () => void;
};

export default function SubjectConditionConformitySection({
  assignment,
  dirty,
  saveMessage,
  saving,
  saveDisabled,
  onChange,
  onConformityChange,
  onSave,
}: SubjectConditionConformitySectionProps) {
  return (
    <div className="mt-5 border-t border-slate-200 pt-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-slate-800">
          Subject Condition and Neighborhood Conformity
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Appraiser selections and comments saved with the active appraisal file.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Condition Rating
          </span>
          <select
            className="select select-bordered mt-1 w-full bg-white"
            value={assignment.subject_condition_rating || ""}
            onChange={(event) => onChange("subject_condition_rating", event.target.value)}
          >
            <option value="">Select condition rating</option>
            {UAD_CONDITION_RATINGS.map((rating) => (
              <option key={rating} value={rating}>{rating}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Subject Condition Comments
          </span>
          <textarea
            className="textarea textarea-bordered mt-1 min-h-24 w-full bg-white"
            value={assignment.subject_condition_notes || ""}
            onChange={(event) => onChange("subject_condition_notes", event.target.value)}
            placeholder="Describe the home's condition, updating, maintenance, and other relevant observations."
          />
        </label>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-slate-900">
            Significant Physical Deficiencies
          </legend>
          <p className="mb-3 text-xs leading-5 text-slate-600">
            Do any deficiencies affect the subject&apos;s livability, soundness, or structural integrity?
          </p>
          <div className="flex flex-wrap gap-2">
            <CheckboxChoice
              checked={assignment.significant_physical_deficiencies === true}
              label="Yes"
              onChange={(checked) => onChange("significant_physical_deficiencies", checked ? true : null)}
            />
            <CheckboxChoice
              checked={assignment.significant_physical_deficiencies === false}
              label="No"
              onChange={(checked) => onChange("significant_physical_deficiencies", checked ? false : null)}
            />
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-slate-200 bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-slate-900">Neighborhood Conformity</legend>
          <p className="mb-3 text-xs leading-5 text-slate-600">
            Does the subject conform to the neighborhood?
          </p>
          <div className="flex flex-wrap gap-2">
            <CheckboxChoice
              checked={assignment.subject_conforms_to_neighborhood === true}
              label="Yes"
              onChange={(checked) => onConformityChange(checked ? true : null)}
            />
            <CheckboxChoice
              checked={assignment.subject_conforms_to_neighborhood === false}
              label="No"
              onChange={(checked) => onConformityChange(checked ? false : null)}
            />
          </div>

          {assignment.subject_conforms_to_neighborhood === false ? (
            <label className="mt-4 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Nonconformity Type
              </span>
              <select
                className="select select-bordered mt-1 w-full bg-white"
                value={assignment.subject_nonconformity_type || ""}
                onChange={(event) => onChange("subject_nonconformity_type", event.target.value)}
              >
                <option value="">Select a type</option>
                {SUBJECT_NONCONFORMITY_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          ) : null}

          {assignment.subject_conforms_to_neighborhood === false &&
          assignment.subject_nonconformity_type ? (
            <label className="mt-4 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Explanation
              </span>
              <textarea
                className="textarea textarea-bordered mt-1 min-h-20 w-full bg-white"
                value={assignment.subject_nonconformity_explanation || ""}
                onChange={(event) => onChange("subject_nonconformity_explanation", event.target.value)}
                placeholder="Explain how the subject differs from the neighborhood."
              />
            </label>
          ) : null}
        </fieldset>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-slate-500">
          {saveMessage || (dirty ? "Unsaved assignment changes" : "No unsaved changes")}
        </span>
        <button
          type="button"
          onClick={onSave}
          className="hn-action-primary btn btn-primary btn-sm normal-case rounded-lg shadow-sm"
          disabled={saveDisabled}
        >
          {saving ? "Saving..." : "Save Condition & Conformity"}
        </button>
      </div>
    </div>
  );
}
