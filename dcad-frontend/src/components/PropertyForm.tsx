import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dispatch, SetStateAction } from "react";

export type PropertyState = Record<string, any>;

export type FieldType =
  | "text"
  | "number"
  | "decimal"
  | "currency"
  | "select"
  | "year";

export type Option = { label: string; value: string };

export type FieldSpec = {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  step?: number;
  min?: number;
  max?: number;
  options?: Option[];
  disabledUntilData?: boolean;
  toState?: (raw: string) => any;
  fromState?: (v: any) => string | number;
  full?: boolean;
};

export function PropertyForm({
  property,
  setProperty,
  sections,
}: {
  property: PropertyState;
  setProperty: Dispatch<SetStateAction<PropertyState>>;
  sections: { title: string; fields: FieldSpec[] }[];
}) {
  return (
    <div className="space-y-6">
      {sections.map((section, idx) => (
        <Card key={idx}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {section.fields.map((f) => (
                <div key={f.key} className={f.full ? "sm:col-span-2" : ""}>
                  <label className="text-sm font-medium text-slate-700">{f.label}</label>
                  <Field
                    spec={f}
                    value={readValue(property, f)}
                    onChange={(next) => setProperty((prev) => ({ ...prev, [f.key]: next }))}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function readValue(state: PropertyState, spec: FieldSpec) {
  const v = state?.[spec.key];
  return spec.fromState ? spec.fromState(v) : v ?? "";
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: any;
  onChange: (v: any) => void;
}) {
  const disabled = !!spec.disabledUntilData && (value === undefined || value === null || value === "");

  if (spec.type === "select") {
    const val = (value ?? "").toString();
    return (
      <Select value={val} onValueChange={(v) => onChange(v)}>
        <SelectTrigger>
          <SelectValue placeholder={spec.placeholder || "Select"} />
        </SelectTrigger>
        <SelectContent>
          {(spec.options || []).map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (spec.type === "currency") {
    const display = typeof value === "number" ? value.toString() : (value ?? "");
    return (
      <Input
        type="number"
        step={spec.step ?? 1}
        min={spec.min}
        max={spec.max}
        placeholder={spec.placeholder}
        disabled={disabled}
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          const num = raw === "" ? "" : Number(raw);
          onChange(Number.isFinite(num as number) ? num : "");
        }}
      />
    );
  }

  if (spec.type === "decimal") {
    const display = value ?? "";
    return (
      <Input
        type="number"
        step={spec.step ?? 0.01}
        min={spec.min}
        max={spec.max}
        placeholder={spec.placeholder}
        disabled={disabled}
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          const num = raw === "" ? "" : Number(raw);
          onChange(Number.isFinite(num as number) ? num : "");
        }}
      />
    );
  }

  if (spec.type === "number" || spec.type === "year") {
    const display = value ?? "";
    return (
      <Input
        type="number"
        step={spec.step ?? 1}
        min={spec.min}
        max={spec.max}
        placeholder={spec.placeholder}
        disabled={disabled}
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          const num = raw === "" ? "" : Number(raw);
          onChange(Number.isFinite(num as number) ? num : "");
        }}
      />
    );
  }

  return (
    <Input
      type="text"
      placeholder={spec.placeholder}
      disabled={disabled}
      value={value ?? ""}
      onChange={(e) => onChange(spec.toState ? spec.toState(e.target.value) : e.target.value)}
    />
  );
}
