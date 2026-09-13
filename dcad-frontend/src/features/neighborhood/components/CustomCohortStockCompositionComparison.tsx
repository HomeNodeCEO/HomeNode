import type { CompositionCoverage, StockCompositionComparison } from '../customCohortStockCompositionComparison';

interface Props { comparison: StockCompositionComparison }
type AvailableComparison = Extract<StockCompositionComparison, { status: 'available' }>;
const number = (value: number) => value.toLocaleString('en-US');
const leafCount = (count: number) => `${number(count)} recorded ${count === 1 ? 'leaf' : 'leaves'}`;
const overlapText = (value: number) => value > 99.9 && value < 100 ? '>99.9%'
  : value > 0 && value < 0.1 ? '<0.1%' : `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const reasonCopy: Record<string, string> = {
  context_mismatch: 'The captured observations do not belong to the same view.',
  grouping_mismatch: 'The recorded review grouping is not compatible with this comparison.',
  catalog_incomplete: 'The complete captured group roster is unavailable.',
  composition_unavailable: 'This capture does not have a supported distribution view.',
  profile_mismatch: 'The distribution method is not compatible with this comparison.',
  original_membership_mismatch: 'The captured observations do not match the account roster.',
  inspection_union_mismatch: 'The inspected group does not match the captured review grouping.',
  selection_union_mismatch: 'The current selection does not match the captured group roster.',
  family_mismatch: 'The subdivision review group cannot be matched to the captured roster.',
  subject_reference_unavailable: 'The subject has no recorded reference group in this captured view.',
  subject_reference_ambiguous: 'A unique recorded reference group for the subject is unavailable.',
  subject_reference_empty: 'The subject’s recorded reference group has no captured accounts.',
  account_limit: 'The captured account count exceeds this distribution view’s capacity.',
  group_limit: 'The recorded group count exceeds this distribution view’s capacity.',
  housing_interpretation_unavailable: 'The housing-type interpretation is unavailable.',
  output_byte_limit: 'The distributions could not fit within this view’s size limit.',
};
const unavailableReason = (reason: string | null) => reason && Object.hasOwn(reasonCopy, reason)
  ? reasonCopy[reason] : 'The captured observations needed for this comparison are unavailable.';
const coverageText = (coverage: CompositionCoverage | null) => coverage
  ? `${number(coverage.observed)} observed · ${number(coverage.partial)} partial · ${number(coverage.unknown)} unknown / ${number(coverage.total)} accounts`
  : 'Reference coverage unavailable';
const origins: Record<string, string> = { saved_subject: 'Saved subject',
  retained_subject_public: 'Retained public subject evidence', current_subject_cad: 'Current subject CAD' };
const states: Record<string, string> = { observed: 'Observed', partial: 'Partial', missing: 'Missing', invalid: 'Invalid',
  conflicting: 'Conflicting', json_null: 'Recorded as blank', ambiguous_rows: 'Ambiguous source rows', unknown: 'Unknown' };
const housing: Record<string, string> = { detached_single_family: 'Detached single-family', townhouse: 'Townhouse',
  condominium: 'Condominium', duplex: 'Duplex', apartment: 'Apartment', mobile_home: 'Mobile home', manufactured_home: 'Manufactured home' };

function population(comparison: AvailableComparison, kind: 'inspected' | 'selected') {
  const value = comparison[kind], label = kind === 'inspected' ? 'Inspected' : 'Current selected union';
  return <section aria-label={`${label} property distribution`} className="mt-3">
    <h5 className="font-medium">{label}{kind === 'inspected' ? `: ${value.label}` : ''}</h5>
    <p>{number(value.member_count)} accounts · {leafCount(value.pocket_ids.length)}</p>
    {!value.member_count && <p className="mt-1">No accounts in this {kind === 'selected' ? 'selection' : 'inspected group'}; overlap is unavailable.</p>}
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left">
        <caption className="text-left">{label} compared with the subject’s reference group</caption>
        <thead><tr><th scope="col" className="p-1">Field</th><th scope="col" className="p-1">Binned overlap</th>
          <th scope="col" className="p-1">{label} coverage</th><th scope="col" className="p-1">Reference coverage</th></tr></thead>
        <tbody>{value.fields.map(field => <tr key={field.key}>
          <th scope="row" className="p-1 font-medium">{field.label}</th>
          <td className="p-1 tabular-nums">{value.member_count > 0 && comparison.reference.status === 'available' && field.overlap_percent !== null
            ? overlapText(field.overlap_percent) : 'Unavailable'}</td>
          <td className="p-1 tabular-nums">{coverageText(field.coverage)}</td>
          <td className="p-1 tabular-nums">{coverageText(field.reference_coverage)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

/** Read-only display of the admitted comparison; native details owns toggling. */
export default function CustomCohortStockCompositionComparison({ comparison }: Props) {
  return <details className="rounded-lg border border-violet-200 p-3 text-xs" aria-label="Property distribution comparison">
    <summary className="cursor-pointer font-medium">Property distribution comparison</summary>
    {comparison.status === 'unavailable' ? <p className="mt-2">Comparison unavailable. {unavailableReason(comparison.reason)}</p> : <>
      {comparison.reference.status === 'available' ? <p className="mt-2">Reference: {comparison.reference.label} · {number(comparison.reference.member_count ?? 0)} accounts
        {' '}· {leafCount(comparison.reference.pocket_ids.length)}. The subject’s recorded subdivision review group within this capture.</p>
        : <p className="mt-2">Reference unavailable. {unavailableReason(comparison.reference.reason)}</p>}
      {population(comparison, 'inspected')}
      {population(comparison, 'selected')}
      <section aria-label="Copied subject values" className="mt-3">
        <h5 className="font-medium">Copied subject values</h5>
        <p>Existing resolved subject observations, copied with their origin; no values are inferred from this comparison.</p>
        <dl className="mt-2 space-y-1">{comparison.subject.map(cell => <div key={cell.label}>
          <dt className="font-medium">{cell.label}</dt>
          <dd>{cell.state === 'observed' && cell.value !== null
            ? `${typeof cell.value === 'number' ? cell.unit === 'ft²'
              ? cell.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(cell.value)
              : housing[cell.value] ?? 'Unavailable'}${cell.unit ? ` ${cell.unit}` : ''}`
            : 'Unavailable'} · {states[cell.state] ?? 'Unknown'} · Origin: {origins[cell.origin] ?? 'Unavailable'}</dd>
        </div>)}</dl>
      </section>
    </>}
    <p className="mt-3">Descriptive binned overlap only—not calibrated reliability or a measure of sales representativeness.
      {' '}A 100% overlap means the same bin proportions, not that every property is the same.</p>
    <p className="mt-2">Numeric overlap includes observed and partial values in the bins. Housing-type overlap uses observed categories only;
      {' '}partial and unknown records are not included in housing category counts. Unknown coverage includes missing, invalid or conflicting observations.
      {' '}Counts describe exact captured account unions, not averages of phase medians. This panel does not change the selection.</p>
  </details>;
}
