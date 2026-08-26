type NumericFieldProps = {
  label: string;
  value: number | null | undefined;
  onChange?: (value: number | null) => void;
  step?: string;
  prefix?: string;
  suffix?: string;
  readOnly?: boolean;
};

export default function NumericField({
  label,
  value,
  onChange,
  step = '1',
  prefix,
  suffix,
  readOnly = false,
}: NumericFieldProps) {
  return (
    <label className="grid gap-1 text-sm text-slate-700">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="flex rounded-md border border-slate-300 bg-white focus-within:border-slate-900">
        {prefix ? <span className="px-3 py-2 text-slate-500">{prefix}</span> : null}
        <input
          type="number"
          min="0"
          step={step}
          readOnly={readOnly}
          className={`min-w-0 flex-1 rounded-md px-3 py-2 outline-none ${readOnly ? 'bg-slate-100 font-semibold' : 'bg-white'}`}
          value={value ?? ''}
          onChange={(event) => onChange?.(event.target.value === '' ? null : Number(event.target.value))}
        />
        {suffix ? <span className="px-3 py-2 text-slate-500">{suffix}</span> : null}
      </div>
    </label>
  );
}
