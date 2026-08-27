import { useState } from 'react';
import type { ReactNode } from 'react';

export function CheckboxChoice({
  checked,
  label,
  onChange,
  disabled = false,
  compact = false,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <label className={`flex items-center rounded-lg border font-medium ${
      compact ? 'gap-1.5 px-2 py-1.5 text-xs' : 'gap-2 px-3 py-2 text-sm'
    } ${
      disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'
    } ${
      checked
        ? 'border-blue-400 bg-blue-50 text-blue-900'
        : 'border-slate-200 bg-white text-slate-700'
    }`}>
      <input
        type="checkbox"
        className={`checkbox checkbox-primary ${compact ? 'checkbox-xs' : 'checkbox-sm'}`}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

export function SummarySection({
  title,
  subtitle,
  children,
  onEdit,
  actions,
  manuallyVerified = false,
  compact = false,
  collapsible = false,
  defaultExpanded = true,
  className = '',
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onEdit?: () => void;
  actions?: ReactNode;
  manuallyVerified?: boolean;
  compact?: boolean;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className={`rounded-2xl border border-slate-200 bg-slate-50/70 ${
      compact ? 'p-3 sm:p-4' : 'p-4 sm:p-5'
    } ${className}`}>
      <div className={`${compact ? 'mb-3' : 'mb-4'} flex items-start justify-between gap-3`}>
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
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(!collapsible || expanded) && (actions || (onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              className="btn btn-sm normal-case border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50"
            >
              Edit
            </button>
          ) : null))}
          {collapsible ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className="btn btn-sm normal-case rounded-lg border-slate-950 bg-slate-950 text-white hover:border-black hover:bg-black"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          ) : null}
        </div>
      </div>
      {!collapsible || expanded ? children : null}
    </section>
  );
}

export function SummaryField({
  label,
  value,
  className = '',
}: {
  label: string;
  value?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold text-slate-900">
        {value ?? 'Not reported'}
      </div>
    </div>
  );
}
