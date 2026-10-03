import type { DcadDetail } from '@/lib/propertyReportEditableSections';
import { displayValue, formatCensusTract, formatDate, formatOwnershipPercent, reportTitleCase, reportAddress, reportNeighborhoodName } from '@/lib/propertyReportPresentation';
import { SummaryField } from '@/components/PropertyReportControls';

export default function PropertyReportSubjectSummary({
  detail, accountId, ownerParties, ownerName, primaryZoningDisplay,
  censusLookupLoading, censusLookupMessage, onLookUpCensusTract,
}: {
  detail: DcadDetail | null;
  accountId?: string;
  ownerParties: NonNullable<NonNullable<DcadDetail['owner']>['parties']>;
  ownerName: string;
  primaryZoningDisplay: string;
  censusLookupLoading: boolean;
  censusLookupMessage: string;
  onLookUpCensusTract: () => void;
}) {
  const subject = detail?.urar_subject;
  const legalLines = detail?.legal_description?.lines?.filter(line => Boolean(line?.trim())) || [];
  return <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
    <SummaryField label="Assessor Parcel Number (APN)" value={displayValue(subject?.assessor_parcel_number)} />
    <SummaryField label="HomeNode Account Number" value={displayValue(accountId)} />
    <SummaryField label="Borrower" value={displayValue(reportTitleCase(subject?.borrower_name))} />
    <SummaryField label="Real Estate Tax Year" value={displayValue(subject?.tax_year)} />
    <SummaryField label="Real Estate Taxes" value={displayValue(subject?.tax_amount)} />
    <SummaryField label="Property Rights Appraised" value={subject?.property_rights === 'fee_simple' ? 'Fee simple' : subject?.property_rights === 'leasehold' ? 'Leasehold' : 'Unknown / not reported'} />
    <SummaryField label="Offered for Sale in Prior 12 Months" value={subject?.offered_for_sale_prior_12_months === true ? 'Yes' : subject?.offered_for_sale_prior_12_months === false ? 'No' : 'Unknown / not reported'} />
    <SummaryField label="Listing History" value={<span className="whitespace-pre-line">{displayValue(subject?.listing_history_summary)}</span>} className="sm:col-span-2 lg:col-span-4" />
    <SummaryField label="County" value={displayValue(detail?.property_location?.county)} />
    <SummaryField label="Subdivision" value={displayValue(reportNeighborhoodName(detail?.property_location?.subdivision))} />
    <SummaryField label="Ownership Percentage" value={ownerParties.length ? <div className="space-y-0.5">
      {ownerParties.map((party, index) => <div key={`${party.owner_name}-share-${index}`}>{formatOwnershipPercent(party.ownership_pct)}</div>)}
    </div> : 'Share not reported'} />
    <SummaryField label="Zoning Classification" value={primaryZoningDisplay} />
    <SummaryField label="Latest Deed Transfer" value={formatDate(detail?.legal_description?.deed_transfer_date)} />
    <SummaryField label={ownerParties.length > 1 ? 'Owner Names' : 'Owner Name'} value={ownerParties.length ? <div className="space-y-0.5">
      {ownerParties.map((party, index) => <div key={`${party.owner_name}-${index}`}>{displayValue(reportTitleCase(party.owner_name))}</div>)}
    </div> : displayValue(reportTitleCase(ownerName))} />
    <SummaryField label="Census Tract" value={<div>
      <span>{formatCensusTract(detail?.property_location?.census_tract)}</span>
      {detail?.property_location?.census_tract_geoid ? <span className="mt-0.5 block font-mono text-[11px] font-normal text-slate-500">
        GEOID {detail.property_location.census_tract_geoid}
      </span> : null}
      {detail?.property_location?.census_tract_status === 'review_required' ? <span className="mt-1 block text-[11px] font-medium text-amber-700">
        Coordinate/county match needs review
      </span> : null}
      <button type="button" className="btn btn-ghost btn-xs -ml-2 mt-1 normal-case"
        onClick={onLookUpCensusTract} disabled={censusLookupLoading || !accountId}>
        {censusLookupLoading ? 'Looking up...' : detail?.property_location?.census_tract ? 'Refresh tract' : 'Look Up Now'}
      </button>
      {censusLookupMessage ? <span className={`mt-1 block text-[11px] font-medium ${/added/i.test(censusLookupMessage) ? 'text-emerald-700' : 'text-amber-700'}`}>
        {censusLookupMessage}
      </span> : null}
    </div>} />
    <SummaryField label="Owner Mailing Address" value={displayValue(reportAddress(detail?.owner?.mailing_address))} className="sm:col-span-2" />
    <SummaryField label="Legal Description" value={<span className="whitespace-pre-line">{
      legalLines.length ? legalLines.join('\n') : 'No legal description is available for this parcel.'
    }</span>} className="sm:col-span-2" />
  </div>;
}
