import { useEffect } from "react";

import {
  reportDestination,
  type HomeNodeReportType,
} from "@/lib/reportDestinations";

export type ReportTypeChooserSubject = {
  accountId: string;
  address: string;
  ownerName?: string | null;
};

type Props = {
  subject: ReportTypeChooserSubject | null;
  onClose: () => void;
};

const REPORT_OPTIONS: Array<{
  type: HomeNodeReportType;
  title: string;
  description: string;
  accent: string;
}> = [
  {
    type: "custom-appraisal",
    title: "Custom Appraisal",
    description: "Open the existing Property Report and custom appraisal workfile.",
    accent: "border-blue-200 bg-blue-50 hover:border-blue-400 hover:bg-blue-100",
  },
  {
    type: "uad-3.6",
    title: "UAD 3.6",
    description: "Start the structured UAD 3.6 appraisal workspace for this property.",
    accent: "border-emerald-200 bg-emerald-50 hover:border-emerald-400 hover:bg-emerald-100",
  },
  {
    type: "property-tax-protest",
    title: "Property Tax Protest",
    description: "Open the property-tax evidence and protest-report workspace.",
    accent: "border-amber-200 bg-amber-50 hover:border-amber-400 hover:bg-amber-100",
  },
];

export default function ReportTypeChooser({ subject, onClose }: Props) {
  useEffect(() => {
    if (!subject) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, subject]);

  if (!subject) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        aria-labelledby="report-type-title"
        aria-modal="true"
        className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              New report
            </div>
            <h2 id="report-type-title" className="mt-1 text-2xl font-semibold text-slate-950">
              Choose a report type
            </h2>
            <p className="mt-2 text-sm font-medium text-slate-800">{subject.address}</p>
            <p className="mt-0.5 text-xs text-slate-500">Account {subject.accountId}</p>
          </div>
          <button
            aria-label="Close report type chooser"
            className="rounded-full border border-slate-200 px-3 py-1.5 text-lg leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {REPORT_OPTIONS.map((option) => (
            <a
              key={option.type}
              className={`block rounded-xl border p-4 text-left no-underline transition ${option.accent}`}
              href={reportDestination(option.type, subject)}
            >
              <span className="block text-base font-semibold text-slate-950">{option.title}</span>
              <span className="mt-2 block text-sm leading-5 text-slate-600">{option.description}</span>
            </a>
          ))}
        </div>

        <p className="mt-4 text-xs text-slate-500">
          The selected workspace will use this property as the report subject.
        </p>
      </section>
    </div>
  );
}
