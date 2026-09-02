import type { PropertyTaxProtestFile } from '@/lib/api';
import {
  buildPropertyTaxPacketReadiness,
  DALLAS_RESIDENTIAL_2026,
  type PropertyTaxPacketMilestone,
} from '@/lib/propertyTaxCase';
import {
  resolvePropertyTaxAnalysisContext,
  type PropertyTaxDatabaseDefaults,
} from '@/lib/propertyTaxWorkspace';

function displayDate(value: string | null): string {
  if (!value) return 'Not scheduled';
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function milestoneClass(status: PropertyTaxPacketMilestone['status']): string {
  if (status === 'complete') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  if (status === 'attention') return 'border-amber-200 bg-amber-50 text-amber-950';
  if (status === 'waiting') return 'border-slate-200 bg-slate-50 text-slate-700';
  return 'border-slate-200 bg-white text-slate-600';
}

function statusLabel(status: PropertyTaxPacketMilestone['status']): string {
  if (status === 'complete') return 'Complete';
  if (status === 'attention') return 'Action needed';
  if (status === 'waiting') return 'Waiting';
  return 'Not started';
}

export default function PropertyTaxPacketWorkspace({
  file,
  databaseDefaults,
}: {
  file: PropertyTaxProtestFile | null;
  databaseDefaults: PropertyTaxDatabaseDefaults;
}) {
  const analysisContext = resolvePropertyTaxAnalysisContext(file?.workfile_data, databaseDefaults);
  const readiness = buildPropertyTaxPacketReadiness({
    workfileData: file?.workfile_data,
    taxYear: analysisContext.taxYear,
    neighborhoodCode: analysisContext.neighborhoodCode,
    hasCanonicalFile: Boolean(file),
  });
  const district = readiness.districtConfiguration || DALLAS_RESIDENTIAL_2026;

  return (
    <section className="hn-workspace-surface mt-4 rounded-2xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="hn-eyebrow text-xs tracking-[0.16em]">Dallas residential MVP · configuration {district.version}</div>
          <h2 className="mt-1 text-xl font-semibold">Protest packet workflow</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Case deadlines, comparable analysis, district evidence, and exhibits stay revision-bound to this Property Tax file.
          </p>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-right">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Published 2026 deadline</div>
          <div className="mt-1 text-sm font-semibold text-blue-950">
            {displayDate(readiness.effectiveProtestDeadline || district.publishedRealPropertyProtestDeadline)}
          </div>
          <div className="text-xs text-blue-800">The property notice controls if it differs.</div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-5">
        {readiness.milestones.map((milestone) => (
          <article key={milestone.key} className={`rounded-xl border p-3 ${milestoneClass(milestone.status)}`}>
            <div className="text-[11px] font-semibold uppercase tracking-wide opacity-75">
              {statusLabel(milestone.status)}
            </div>
            <h3 className="mt-1 text-sm font-semibold">{milestone.label}</h3>
            <p className="mt-2 text-xs leading-5 opacity-90">{milestone.detail}</p>
          </article>
        ))}
      </div>

      {readiness.districtEvidenceDueDate && (
        <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-950">
          District evidence tracking date: <strong>{displayDate(readiness.districtEvidenceDueDate)}</strong>, calculated as 14 calendar days before the recorded hearing date.
        </div>
      )}
      {readiness.warnings.map((warning) => (
        <div key={warning} className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {warning}
        </div>
      ))}
      {file && analysisContext.warnings.map((warning) => (
        <div key={warning} className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {warning}
        </div>
      ))}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Comparable selection contract</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            The first search uses the workfile neighborhood or the most recent database neighborhood when available, then applies building class, verified arm&apos;s-length status, and price-independent physical similarity. Missing context remains a review flag and never blocks the analysis.
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">Submission boundary</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            HomeNode will prepare the evidence request and packet, retain delivery proof, and enforce current upload constraints. Filing or sending outside HomeNode will require an owner or authorized-agent confirmation.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <a className="underline hover:text-slate-800" href={district.officialSources.annualNotice} target="_blank" rel="noreferrer">DCAD annual notice</a>
        <a className="underline hover:text-slate-800" href={district.officialSources.ufileGuide} target="_blank" rel="noreferrer">DCAD uFile guide</a>
        <a className="underline hover:text-slate-800" href={district.officialSources.evidenceStatute} target="_blank" rel="noreferrer">Texas Tax Code Chapter 41</a>
      </div>
    </section>
  );
}
