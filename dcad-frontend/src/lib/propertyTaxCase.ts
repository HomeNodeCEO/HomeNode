import type { PropertyTaxWorkfileData } from './propertyTaxWorkspace.ts';

export type PropertyTaxDistrictCode = 'tx-dallas-cad';
export type PropertyTaxGround = 'market_value' | 'unequal_appraisal';
export type PropertyTaxFilingMethod = 'ufile' | 'mail' | 'dropbox' | 'in_person';
export type EvidenceRequestDeliveryMethod = 'mail' | 'portal' | 'in_person' | 'other_documented';

export interface PropertyTaxDistrictConfiguration {
  version: string;
  districtCode: PropertyTaxDistrictCode;
  districtName: string;
  state: 'TX';
  taxYear: number;
  supportedPropertyUse: 'single_family_residential';
  valuationDate: string;
  realPropertyNoticeMailDate: string;
  publishedRealPropertyProtestDeadline: string;
  filingMethods: readonly PropertyTaxFilingMethod[];
  prohibitedFilingMethods: readonly string[];
  evidenceDeliveryDaysBeforeHearing: number;
  ufile: {
    acceptedFileExtensions: readonly string[];
    maximumBytesPerFile: number;
    aggregateLimitNeedsAnnualVerification: boolean;
  };
  officialSources: {
    annualNotice: string;
    ufileGuide: string;
    evidenceStatute: string;
    documentationStandards: string;
  };
}

export const DALLAS_RESIDENTIAL_2026 = Object.freeze({
  version: 'dcad-residential-2026.1',
  districtCode: 'tx-dallas-cad',
  districtName: 'Dallas Central Appraisal District',
  state: 'TX',
  taxYear: 2026,
  supportedPropertyUse: 'single_family_residential',
  valuationDate: '2026-01-01',
  realPropertyNoticeMailDate: '2026-04-14',
  publishedRealPropertyProtestDeadline: '2026-05-15',
  filingMethods: ['ufile', 'mail', 'dropbox', 'in_person'],
  prohibitedFilingMethods: ['email', 'fax'],
  evidenceDeliveryDaysBeforeHearing: 14,
  ufile: {
    acceptedFileExtensions: ['.pdf', '.jpg', '.xls', '.xlsx'],
    maximumBytesPerFile: 8 * 1024 * 1024,
    aggregateLimitNeedsAnnualVerification: true,
  },
  officialSources: {
    annualNotice: 'https://www.dallascad.org/News.aspx?ID=2',
    ufileGuide: 'https://www.esearch.dallascad.org/webForms/UFILEONLINE/UFILE_ONLINE_PROTEST_2026.pdf',
    evidenceStatute: 'https://statutes.capitol.texas.gov/Docs/TX/pdf/TX.41.pdf',
    documentationStandards: 'https://ens.dallascad.org/pdftemplates/Standards_of_Documentation.PDF',
  },
} satisfies PropertyTaxDistrictConfiguration);

export interface PropertyTaxCaseSnapshot {
  districtCode: string;
  propertyUse: string;
  neighborhoodCode: string;
  buildingClass: string;
  historicDistrictName: string;
  noticeDate: string;
  protestDeadline: string;
  marketValueGround: boolean;
  unequalAppraisalGround: boolean;
  protestStatus: string;
  filingMethod: string;
  protestFiledAt: string;
  filingReceiptReference: string;
  hearingDate: string;
  evidenceRequestStatus: string;
  evidenceRequestSentAt: string;
  evidenceRequestMethod: string;
  evidenceRequestProofReference: string;
  districtEvidenceReceivedAt: string;
}

export interface PropertyTaxPacketMilestone {
  key: 'case_setup' | 'protest_filing' | 'evidence_request' | 'district_evidence' | 'packet';
  label: string;
  status: 'complete' | 'attention' | 'waiting' | 'not_started';
  detail: string;
}

export interface PropertyTaxPacketReadiness {
  districtConfiguration: PropertyTaxDistrictConfiguration | null;
  effectiveProtestDeadline: string | null;
  districtEvidenceDueDate: string | null;
  milestones: PropertyTaxPacketMilestone[];
  warnings: string[];
}

function recordAt(source: PropertyTaxWorkfileData, key: string): Record<string, unknown> {
  const value = source[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textAt(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

function booleanAt(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  return value === true || value === 'true' || value === 'yes';
}

export function readPropertyTaxCase(
  workfileData: PropertyTaxWorkfileData | null | undefined,
): PropertyTaxCaseSnapshot {
  const source = workfileData || {};
  const caseData = recordAt(source, 'protest_case');
  const subject = recordAt(source, 'subject');
  return {
    districtCode: textAt(caseData, 'district_code'),
    propertyUse: textAt(caseData, 'property_use'),
    neighborhoodCode: textAt(subject, 'district_neighborhood_code'),
    buildingClass: textAt(subject, 'district_building_class'),
    historicDistrictName: textAt(subject, 'historic_district_name'),
    noticeDate: textAt(caseData, 'notice_date'),
    protestDeadline: textAt(caseData, 'protest_deadline'),
    marketValueGround: booleanAt(caseData, 'market_value_ground'),
    unequalAppraisalGround: booleanAt(caseData, 'unequal_appraisal_ground'),
    protestStatus: textAt(caseData, 'protest_status'),
    filingMethod: textAt(caseData, 'filing_method'),
    protestFiledAt: textAt(caseData, 'protest_filed_at'),
    filingReceiptReference: textAt(caseData, 'filing_receipt_reference'),
    hearingDate: textAt(caseData, 'hearing_date'),
    evidenceRequestStatus: textAt(caseData, 'evidence_request_status'),
    evidenceRequestSentAt: textAt(caseData, 'evidence_request_sent_at'),
    evidenceRequestMethod: textAt(caseData, 'evidence_request_method'),
    evidenceRequestProofReference: textAt(caseData, 'evidence_request_proof_reference'),
    districtEvidenceReceivedAt: textAt(caseData, 'district_evidence_received_at'),
  };
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? parsed
    : null;
}

function formatDateOnly(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function calculateDistrictEvidenceDueDate(
  hearingDate: string,
  daysBeforeHearing = 14,
): string | null {
  const parsed = parseDateOnly(hearingDate);
  if (!parsed || !Number.isInteger(daysBeforeHearing) || daysBeforeHearing < 0) return null;
  parsed.setUTCDate(parsed.getUTCDate() - daysBeforeHearing);
  return formatDateOnly(parsed);
}

export function districtConfigurationFor(
  districtCode: string,
  taxYear: number | null,
): PropertyTaxDistrictConfiguration | null {
  return districtCode === DALLAS_RESIDENTIAL_2026.districtCode
    && taxYear === DALLAS_RESIDENTIAL_2026.taxYear
    ? DALLAS_RESIDENTIAL_2026
    : null;
}

export function buildPropertyTaxPacketReadiness({
  workfileData,
  taxYear,
  neighborhoodCode,
  hasCanonicalFile,
}: {
  workfileData: PropertyTaxWorkfileData | null | undefined;
  taxYear: number | null;
  neighborhoodCode?: string;
  hasCanonicalFile: boolean;
}): PropertyTaxPacketReadiness {
  const caseData = readPropertyTaxCase(workfileData);
  const effectiveNeighborhoodCode = neighborhoodCode?.trim() || caseData.neighborhoodCode;
  const districtConfiguration = districtConfigurationFor(caseData.districtCode, taxYear);
  const warnings: string[] = [];
  const effectiveProtestDeadline = caseData.protestDeadline
    || districtConfiguration?.publishedRealPropertyProtestDeadline
    || null;
  const districtEvidenceDueDate = caseData.hearingDate
    ? calculateDistrictEvidenceDueDate(
        caseData.hearingDate,
        districtConfiguration?.evidenceDeliveryDaysBeforeHearing || 14,
      )
    : null;

  if (hasCanonicalFile && (caseData.districtCode || taxYear) && !districtConfiguration) {
    warnings.push('Automated district rules are currently available only for Dallas single-family residential cases for tax year 2026.');
  }
  if (caseData.protestDeadline && districtConfiguration
      && caseData.protestDeadline !== districtConfiguration.publishedRealPropertyProtestDeadline) {
    warnings.push('The notice-specific protest deadline differs from the published Dallas residential deadline; use the date printed on the notice.');
  }
  if (caseData.evidenceRequestSentAt && !caseData.evidenceRequestProofReference) {
    warnings.push('The evidence request is marked sent but has no delivery proof reference.');
  }
  if (caseData.protestFiledAt && !caseData.filingReceiptReference) {
    warnings.push('The protest is marked filed but has no filing receipt reference.');
  }

  const caseConfigured = Boolean(hasCanonicalFile && districtConfiguration
    && caseData.propertyUse === 'single_family_residential'
    && effectiveNeighborhoodCode);
  const filed = Boolean(caseData.protestFiledAt && caseData.filingMethod);
  const requestSent = Boolean(caseData.evidenceRequestSentAt && caseData.evidenceRequestMethod);
  const evidenceReceived = Boolean(caseData.districtEvidenceReceivedAt);

  return {
    districtConfiguration,
    effectiveProtestDeadline,
    districtEvidenceDueDate,
    warnings,
    milestones: [
      {
        key: 'case_setup',
        label: 'Dallas case setup',
        status: caseConfigured ? 'complete' : hasCanonicalFile ? 'attention' : 'not_started',
        detail: caseConfigured
          ? `Neighborhood ${effectiveNeighborhoodCode} is the initial comparable boundary.`
          : 'Review the district and property use. Missing tax-year or neighborhood values use the latest database context when available and do not block analysis.',
      },
      {
        key: 'protest_filing',
        label: 'Protest filing',
        status: filed ? 'complete' : hasCanonicalFile ? 'attention' : 'not_started',
        detail: filed
          ? `Recorded as filed by ${caseData.filingMethod}.`
          : `File by the notice deadline${effectiveProtestDeadline ? ` (${effectiveProtestDeadline})` : ''}; external submission requires confirmation.`,
      },
      {
        key: 'evidence_request',
        label: '§41.461 evidence request',
        status: requestSent ? 'complete' : filed ? 'attention' : 'waiting',
        detail: requestSent
          ? 'Request delivery is recorded; retain the letter and proof of delivery.'
          : filed ? 'Prepare and send the written request immediately after filing.' : 'Available after the protest filing is recorded.',
      },
      {
        key: 'district_evidence',
        label: 'District evidence',
        status: evidenceReceived ? 'complete' : caseData.hearingDate ? 'attention' : 'waiting',
        detail: evidenceReceived
          ? 'District evidence receipt is recorded and ready for analysis.'
          : districtEvidenceDueDate
            ? `Track delivery against ${districtEvidenceDueDate}, 14 days before the hearing.`
            : 'Waiting for a hearing date or district evidence delivery.',
      },
      {
        key: 'packet',
        label: 'Packet generation',
        status: caseConfigured && filed ? 'attention' : 'waiting',
        detail: caseConfigured && filed
          ? 'Comparable analysis and exhibits are the remaining packet inputs.'
          : 'Requires a configured Dallas case and recorded protest filing.',
      },
    ],
  };
}
