import { reportAddress, reportNeighborhoodName, reportTitleCase, reportZip5 } from '../../lib/propertyReportText.ts';

export const SFREP_FORM_ID = 'FNMA-1004-0911' as const;
export const SFREP_2055_FORM_ID = 'FNMA-2055-0911' as const;
export type SfrepFormId = typeof SFREP_FORM_ID | typeof SFREP_2055_FORM_ID;
const supportedFormId = (value: unknown): value is SfrepFormId => value === SFREP_FORM_ID || value === SFREP_2055_FORM_ID;

export interface SfrepSelection {
  accountId: string;
  assignmentFileId: number;
  documentIds: number[];
  includeDocuments: boolean;
  includePhotos?: boolean;
  formId?: SfrepFormId;
}
export interface SfrepField {
  sourceField: string; fieldId: string; value: string; documentId: number | null; candidateId: number | null;
  type: 'TextField' | 'CheckBoxField';
  provenance: SfrepProvenance;
  sourceValue?: string;
  formattingRule?: 'uad_whole_dollars_half_up' | 'single_line_legal_description' | 'single_line_owner_name'
    | 'subject_title_case' | 'zip5_display' | 'title_case_subdivision_without_numeric_phase' | 'title_case_single_line_owner_name';
}
export type SfrepEffectiveDateSource = 'inspection_date' | 'assignment_effective_date' | 'document_upload_date_placeholder';
export interface SfrepEffectiveDateContext {
  effectiveDate: string | null; source: SfrepEffectiveDateSource | null; sourceDocumentId: number | null;
  windowStart: string | null; windowEnd: string | null; calendarMonths: 12; isPlaceholder: boolean;
}
export interface SfrepProvenance {
  kind: 'reviewed_document' | 'derived_reviewed_document' | 'user_default' | 'saved_report' | 'account_reference';
  sourceField: string; documentId: number | null; candidateId: number | null;
  documentType?: string | null; rule?: string; sourceValue?: string;
  effectiveDate?: string; effectiveDateSource?: SfrepEffectiveDateSource;
  effectiveDateSourceDocumentId?: number | null; windowStart?: string; windowEnd?: string;
  assignmentFileId?: number; sectionKey?: 'report.subject_identification' | 'report.assignment_details' | 'market_conditions'; revision?: number;
  origin?: 'appraiser_edit' | 'reviewed_document' | 'derived_reviewed_document' | 'user_default' | 'account_reference';
  sourceDocumentId?: number; sourceCandidateId?: number;
  sourceEvidence?: Array<SfrepListingEvidence | SfrepCensusEvidence | SfrepCountyEvidence>;
}
interface SfrepListingEvidence { documentId: number; candidateId: number; sourceField: string; value: string | number }
interface SfrepCountyEvidence {
  sourceTable: 'core.accounts'; accountId: string;
  sourceField: 'address' | 'city' | 'postal_code' | 'county' | 'account_id' | 'state'; value: string;
}
interface SfrepCensusEvidence {
  sourceTable: 'core.account_census_geographies'; accountId: string; tractCode: string; status: 'matched';
  geoid: string; vintage: string; updatedAt: string;
}
export type SfrepAssumption = {
  fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox'; value: 'true';
  rule: 'user_requested_fee_simple_default'; reason: string;
} | { fieldId: 'PropertyTypePUDCheckBox'; value: 'true' | 'false'; rule: 'user_requested_hoa_workflow_proxy_v1'; reason: string }
  | { fieldId: 'State'; value: 'TX'; rule: 'user_requested_texas_state_default_v1'; reason: string };
export interface SfrepDocument {
  id: number; title: string; file_name: string; file_size_bytes: number; processing_status: string;
}
export type SfrepConflict = { sourceField: string; documentIds: number[]; values: string[] };
export interface SfrepPhoto {
  id: string; label: string; category: string; roomLabel: string | null; caption: string | null;
  position: number; revision: number; status: string; included: boolean;
  verifiedAt: string | null; variant: 'display' | 'original' | null;
  byteSize: number | null; fileName: string | null; reason: string | null; view_url?: string | null;
}
export type SfrepOmission = { sourceField: string; documentId: number; candidateId: number | null; reason: string };
export type SfrepNotice = string | SfrepConflict | SfrepOmission;
export interface SfrepPreview {
  ok: true;
  preview_digest: string;
  formId: SfrepFormId;
  fields: SfrepField[];
  conflicts: SfrepConflict[];
  omitted: SfrepOmission[];
  warnings: string[];
  documents: SfrepDocument[];
  photos?: SfrepPhoto[];
  filename: string;
  effectiveDateContext: SfrepEffectiveDateContext;
  assumptions: SfrepAssumption[];
  knownMissing: { fieldId: string; reason: string }[];
  savedReport?: { assignmentFileId: number; assignmentRevision: number; subjectRevision: number; marketRevision?: number; sourceDocumentIds: number[] };
}
interface TransportOptions {
  request: (url: string, init: RequestInit) => Promise<Response>;
  urlFor: (path: string) => string;
}
interface RequestOptions { signal: AbortSignal; editorKey: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const cancelled = () => new DOMException('SFREP request cancelled', 'AbortError');
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw cancelled(); };
const stop = (response: Response) => { void response.body?.cancel().catch(() => {}); };
const feeSimpleField = 'PropertyRightsAppraisedFeeSimpleCheckBox';
const feeSimpleRule = 'user_requested_fee_simple_default';
const texasStateRule = 'user_requested_texas_state_default_v1';
const listingRule = 'subject_mls_list_date_within_preceding_12_calendar_months';
const historyRule = 'reviewed_subject_listing_history_template_v1';
const censusRule = 'matched_account_census_tract_v1';
const countyRule = 'canonical_county_subject_identity_v1';
const lenderAddressRule = 'user_requested_lender_address_v1';
const hoaRule = 'user_requested_hoa_workflow_proxy_v1';
const contractRule = 'reviewed_1004_contract_terms_template_v1';
const sellerOwnerRule = 'seller_vs_cad_owner_name_v1';
const pudField = 'PropertyTypePUDCheckBox';
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const savedKeys = ['kind', 'sourceField', 'documentId', 'candidateId', 'assignmentFileId', 'sectionKey', 'revision', 'origin'];
const countyFallbackKeys = ['kind', 'sourceField', 'documentId', 'candidateId', 'assignmentFileId', 'revision', 'rule', 'sourceEvidence'];
const documentKeys = ['kind', 'sourceField', 'documentId', 'candidateId', 'documentType'];
const listingKeys = ['rule', 'sourceValue', 'effectiveDate', 'effectiveDateSource', 'effectiveDateSourceDocumentId', 'windowStart', 'windowEnd'];
const historyKeys = ['rule', 'sourceEvidence', 'effectiveDate', 'effectiveDateSource', 'effectiveDateSourceDocumentId'];
const boundedText = (text: unknown, max: number): text is string => validText(text) && text.length <= max
  && text.trim() === text && !Array.from(text).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const dateSource = (value: unknown): value is SfrepEffectiveDateSource =>
  value === 'inspection_date' || value === 'assignment_effective_date' || value === 'document_upload_date_placeholder';
function isoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validDateContext(value: unknown): value is SfrepEffectiveDateContext {
  if (!record(value) || value.calendarMonths !== 12 || typeof value.isPlaceholder !== 'boolean') return false;
  if (value.effectiveDate === null) return value.source === null && value.sourceDocumentId === null
    && value.windowStart === null && value.windowEnd === null && value.isPlaceholder === false;
  if (!isoDate(value.effectiveDate) || !dateSource(value.source)
    || (value.sourceDocumentId !== null && !positiveId(value.sourceDocumentId))
    || value.windowEnd !== value.effectiveDate || !isoDate(value.windowStart)
    || value.isPlaceholder !== (value.source === 'document_upload_date_placeholder')
    || (value.isPlaceholder && !positiveId(value.sourceDocumentId))) return false;
  const [year, month, day] = value.effectiveDate.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return value.windowStart === `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}
function validFormatting(value: Record<string, unknown>, provenance: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, 'sourceValue') && !Object.hasOwn(value, 'formattingRule')) return true;
  if (!['reviewed_document', 'saved_report', 'account_reference'].includes(String(provenance.kind)) || value.type !== 'TextField' || !validText(value.sourceValue)) return false;
  if (provenance.kind === 'account_reference' && (provenance.rule !== countyRule || value.sourceValue !== value.value)) return false;
  const source = value.sourceValue.trim();
  // Composite reviewed addresses retain the whole original source. Saved
  // components are independently editable and must never be split/refilled.
  let presentationSource = source;
  let presentationField = value.sourceField;
  if (provenance.kind === 'reviewed_document' && ['subject_property_address', 'subject_street_address'].includes(String(value.sourceField))) {
    const parts = source.match(/^([^,\r\n]+),\s*([A-Za-z][A-Za-z .'-]*?)(?:,\s*|\s+)([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    const index = ['StreetAddress', 'City', 'State', 'ZipCode'].indexOf(String(value.fieldId));
    if (parts && index >= 0) {
      presentationSource = parts[index + 1].trim();
      presentationField = ['subject_street_address', 'subject_city', 'subject_state', 'subject_zip'][index];
    } else if (value.fieldId === 'StreetAddress') presentationField = 'subject_street_address';
  }
  if (value.formattingRule === 'subject_title_case') {
    const destination = { subject_street_address: 'StreetAddress', subject_city: 'City', borrower_name: 'BorrowerName',
      lender_client_address: 'LenderClientCompanyUnparsedAddress' };
    if (!Object.hasOwn(destination, String(presentationField)) || destination[presentationField as keyof typeof destination] !== value.fieldId) return false;
    return value.value === (['StreetAddress', 'LenderClientCompanyUnparsedAddress'].includes(String(value.fieldId))
      ? reportAddress(presentationSource) : reportTitleCase(presentationSource));
  }
  if (value.formattingRule === 'zip5_display') return ['subject_zip', 'subject_zip_code'].includes(String(presentationField))
    && value.fieldId === 'ZipCode' && /^\d{5}(?:-?\d{4})?$/.test(presentationSource) && value.value === reportZip5(presentationSource);
  if (value.formattingRule === 'title_case_subdivision_without_numeric_phase') return ['neighborhood_name', 'subdivision_name'].includes(String(value.sourceField))
    && value.fieldId === 'NeighborhoodName' && value.value === reportNeighborhoodName(source);
  if (value.formattingRule === 'title_case_single_line_owner_name') return ['owner_name', 'record_owner_name'].includes(String(value.sourceField))
    && value.fieldId === 'OwnerName' && value.value === reportTitleCase(source).replace(/[ \t\r\n]*[\t\r\n][ \t\r\n]*/g, ' ').trim();
  if (value.formattingRule === 'single_line_legal_description') return value.sourceField === 'legal_description'
    && value.fieldId === 'LegalDescription' && source.length > 0
    && value.value === source.replace(/[ \t\r\n]*[\t\r\n][ \t\r\n]*/g, ' ').trim();
  if (value.formattingRule === 'single_line_owner_name') return ['owner_name', 'record_owner_name'].includes(String(value.sourceField))
    && value.fieldId === 'OwnerName' && source.length > 0
    && value.value === source.replace(/[ \t\r\n]*[\t\r\n][ \t\r\n]*/g, ' ').trim();
  if (value.formattingRule !== 'uad_whole_dollars_half_up'
    || !((value.fieldId === 'RealEstateTaxAmount' && ['tax_amount', 'real_estate_tax_amount'].includes(String(value.sourceField)))
      || (value.fieldId === 'AssessmentAmount' && value.sourceField === 'hoa_dues_amount'))
    || !/^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(source)) return false;
  const [whole, fraction = ''] = source.replace(/[$,\s]/g, '').split('.');
  const significantWhole = whole.replace(/^0+(?=\d)/, '');
  if (significantWhole.length > 12) return false;
  return value.value === String(BigInt(significantWhole) + (Number(fraction.padEnd(2, '0')) >= 50 ? 1n : 0n));
}
function validCensus(value: Record<string, unknown>, provenance: Record<string, unknown>): boolean {
  if (value.sourceField !== 'census_tract' || value.fieldId !== 'CensusTract' || value.type !== 'TextField'
    || provenance.sectionKey !== 'report.subject_identification' || provenance.rule !== censusRule
    || !onlyKeys(provenance, [...savedKeys, 'rule', 'sourceEvidence'])
    || !Array.isArray(provenance.sourceEvidence) || provenance.sourceEvidence.length !== 1) return false;
  const source = provenance.sourceEvidence[0];
  const bounded = (text: unknown, max: number): text is string => validText(text) && text.length <= max
    && text.trim() === text && !Array.from(text).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  return record(source) && onlyKeys(source, ['sourceTable', 'accountId', 'tractCode', 'status', 'geoid', 'vintage', 'updatedAt'])
    && source.sourceTable === 'core.account_census_geographies' && bounded(source.accountId, 32) && source.status === 'matched'
    && typeof source.tractCode === 'string' && /^\d{6}$/.test(source.tractCode) && source.tractCode !== '000000'
    && typeof source.geoid === 'string' && /^\d{11}$/.test(source.geoid) && source.geoid.endsWith(source.tractCode)
    && bounded(source.vintage, 128) && bounded(source.updatedAt, 64) && isoDate(source.updatedAt.slice(0, 10))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(source.updatedAt)
    && Number.isFinite(Date.parse(source.updatedAt)) && value.value === `${Number(source.tractCode.slice(0, 4))}.${source.tractCode.slice(4)}`;
}
function validCountyIdentity(value: Record<string, unknown>, provenance: Record<string, unknown>): boolean {
  const destinations = {
    subject_street_address: ['StreetAddress', 'address'], subject_city: ['City', 'city'],
    subject_zip: ['ZipCode', 'postal_code'], county: ['County', 'county'],
    assessor_parcel_number: ['AssessorsParcelNumber', 'account_id'], subject_state: ['State', 'state'],
  };
  if (!Object.hasOwn(destinations, String(value.sourceField)) || value.type !== 'TextField'
    || provenance.rule !== countyRule
    || (provenance.kind === 'saved_report'
      ? provenance.sectionKey !== 'report.subject_identification' || !onlyKeys(provenance, [...savedKeys, 'rule', 'sourceEvidence'])
      : provenance.kind !== 'account_reference' || !onlyKeys(provenance, countyFallbackKeys))
    || !Array.isArray(provenance.sourceEvidence) || provenance.sourceEvidence.length !== 1) return false;
  const [fieldId, column] = destinations[value.sourceField as keyof typeof destinations];
  const source = provenance.sourceEvidence[0];
  if (value.fieldId !== fieldId || !record(source) || !onlyKeys(source, ['sourceTable', 'accountId', 'sourceField', 'value'])
    || source.sourceTable !== 'core.accounts' || !boundedText(source.accountId, 32)
    || source.sourceField !== column || !boundedText(source.value, 500)) return false;
  const raw = source.value;
  if (column === 'address') return value.value === reportAddress(raw);
  if (column === 'city') return value.value === reportTitleCase(raw);
  if (column === 'county') return value.value === reportTitleCase(raw.replace(/\s+county$/i, ''));
  if (column === 'postal_code') return /^\d{5}(?:-?\d{4})?$/.test(raw) && value.value === reportZip5(raw);
  if (column === 'state') return 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' ').includes(raw.toUpperCase())
    && value.value === raw.toUpperCase();
  return raw === source.accountId && value.value === raw;
}
function validLenderPreset(value: Record<string, unknown>, provenance: Record<string, unknown>): boolean {
  if (value.sourceField !== 'lender_client_address' || value.fieldId !== 'LenderClientCompanyUnparsedAddress'
    || value.type !== 'TextField' || value.value !== '585 S Blvd E, Pontiac, MI 48341'
    || provenance.sectionKey !== 'report.assignment_details' || provenance.rule !== lenderAddressRule
    || !onlyKeys(provenance, [...savedKeys, 'sourceDocumentId', 'sourceCandidateId', 'rule', 'sourceValue', 'sourceEvidence'])
    || !positiveId(provenance.sourceDocumentId) || !positiveId(provenance.sourceCandidateId)
    || !boundedText(provenance.sourceValue, 100) || !/^united\s+wholesale\s+mortgage$/i.test(provenance.sourceValue)
    || !Array.isArray(provenance.sourceEvidence) || provenance.sourceEvidence.length !== 1) return false;
  const source = provenance.sourceEvidence[0];
  return record(source) && onlyKeys(source, ['documentId', 'candidateId', 'sourceField', 'value'])
    && source.documentId === provenance.sourceDocumentId && source.candidateId === provenance.sourceCandidateId
    && source.sourceField === 'lender_client_name' && source.value === provenance.sourceValue;
}
function validHistory(value: Record<string, unknown>, provenance: Record<string, unknown>): boolean {
  const sourceFields = ['mls_number', 'list_date', 'original_list_price', 'days_on_market', 'contract_date', 'listing_price_history'];
  const evidence = provenance.sourceEvidence;
  if (value.sourceField !== 'listing_history_summary' || value.fieldId !== 'CurrentPriorListingDataSources'
    || value.type !== 'TextField' || !validText(value.value) || value.value.length > 4_000
    || provenance.sectionKey !== 'report.subject_identification' || provenance.rule !== historyRule
    || !onlyKeys(provenance, [...savedKeys, 'sourceDocumentId', 'sourceCandidateId', ...historyKeys])
    || !positiveId(provenance.sourceCandidateId) || !isoDate(provenance.effectiveDate) || !dateSource(provenance.effectiveDateSource)
    || (provenance.effectiveDateSourceDocumentId !== null && !positiveId(provenance.effectiveDateSourceDocumentId))
    || !Array.isArray(evidence) || evidence.length < 6 || evidence.length > 10_000) return false;
  if (!evidence.every(entry => record(entry) && onlyKeys(entry, ['documentId', 'candidateId', 'sourceField', 'value'])
    && positiveId(entry.documentId) && positiveId(entry.candidateId) && sourceFields.includes(String(entry.sourceField))
    && ((validText(entry.value) && entry.value.length <= 8_000) || (typeof entry.value === 'number' && Number.isFinite(entry.value))))) return false;
  return new Set(evidence.map(entry => `${entry.documentId}:${entry.candidateId}`)).size === evidence.length
    && sourceFields.every(key => evidence.some(entry => entry.sourceField === key))
    && evidence.some(entry => entry.sourceField === 'list_date' && entry.documentId === provenance.sourceDocumentId
      && entry.candidateId === provenance.sourceCandidateId);
}
function validHoa(value: Record<string, unknown>, provenance: Record<string, unknown>): boolean {
  // The extractor also permits positive labeled dues with a separately
  // reviewed period. That period is not serialized in this PUD receipt (and
  // quarterly amounts are deliberately not exported), so the raw proof can
  // legitimately be amount-only. Never treat arbitrary HOA text as affirmative.
  const raw = provenance.sourceValue;
  const dues = typeof raw === 'string' ? raw.match(/^(\$?\s*(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.\d{1,2})?)(?:\s*(?:\/|per\s+)?(?:monthly|month|mo|quarterly|quarter|qtr|annually|annual|yearly|year|yr))?$/i) : null;
  const amount = dues?.[1].replace(/[$,\s]/g, '');
  const positiveDues = amount !== undefined && amount.split('.')[0].replace(/^0+(?=\d)/, '').length <= 12 && Number(amount) > 0;
  return value.sourceField === 'pud' && value.fieldId === pudField && value.type === 'CheckBoxField' && value.value === 'true'
    && provenance.rule === hoaRule && typeof raw === 'string' && (/^(mandatory|yes|required)$/i.test(raw) || positiveDues);
}
function validContractNarrative(value: Record<string, unknown>, provenance: Record<string, unknown>): boolean {
  if (value.sourceField !== 'contract_analysis_summary' || value.fieldId !== 'AnalyzedContractDescription'
    || value.type !== 'TextField' || provenance.documentType !== 'purchase_contract'
    || provenance.rule !== contractRule || !onlyKeys(provenance, [...documentKeys, 'rule', 'sourceEvidence'])
    || !Array.isArray(provenance.sourceEvidence) || provenance.sourceEvidence.length !== 6) return false;
  const terms = new Map<string, string>();
  for (const item of provenance.sourceEvidence) {
    if (!record(item) || !onlyKeys(item, ['documentId', 'candidateId', 'sourceField', 'value'])
      || item.documentId !== value.documentId || !positiveId(item.candidateId)
      || typeof item.sourceField !== 'string' || typeof item.value !== 'string' || terms.has(item.sourceField)) return false;
    terms.set(item.sourceField, item.value);
  }
  const keys = ['contract_date', 'contract_price', 'earnest_money', 'down_payment', 'loan_amount', 'seller_concessions'];
  if (keys.some(key => !terms.has(key)) || provenance.candidateId !== provenance.sourceEvidence.find(item => item.sourceField === 'contract_date')?.candidateId) return false;
  const date = terms.get('contract_date')!;
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date) || !isoDate(`${date.slice(6)}-${date.slice(0, 2)}-${date.slice(3, 5)}`)) return false;
  const amounts = keys.slice(1).map(key => terms.get(key)!);
  if (amounts.some(amount => !/^(?:0|[1-9]\d{0,8})\.\d{2}$/.test(amount))) return false;
  const [price, earnest, cash, loan, concessions] = amounts.map(Number);
  if (Math.abs(cash + loan - price) > 0.01) return false;
  const dollars = (amount: number) => `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount)}`;
  const suffix = `;Contract dated ${date}, purchase price of ${dollars(price)}, earnest money ${dollars(earnest)}, cash at close ${dollars(cash)}, new loan ${dollars(loan)}, with ${dollars(concessions)} in concessions`;
  return ['Arms length sale', 'Non-arms length sale', 'Sale type requires appraiser review']
    .some(prefix => value.value === prefix + suffix);
}
const neighborhoodCheckboxes = ['LocationUrbanCheckBox', 'LocationSuburbanCheckBox', 'LocationRuralCheckBox',
  'PropertyValuesIncreasingCheckBox', 'PropertyValuesStableCheckBox', 'PropertyValuesDecliningCheckBox',
  'BuiltUpOver75CheckBox', 'BuiltUp2575CheckBox', 'BuiltUpUnder25CheckBox', 'GrowthRapidCheckBox', 'GrowthStableCheckBox', 'GrowthSlowCheckBox',
  'DemandSupplyShortageCheckBox', 'DemandSupplyInBalanceCheckBox', 'DemandSupplyOverSupplyCheckBox',
  'MarketingTimeUnder3MonthsCheckBox', 'MarketingTime36MonthsCheckBox', 'MarketingTimeOver6MonthsCheckBox'];
const neighborhoodNumbers = ['SingleFamilyHousingPriceLowAmount', 'SingleFamilyHousingPriceHighAmount', 'SingleFamilyHousingPricePredominantAmount',
  'SingleFamilyHousingAgeLow', 'SingleFamilyHousingAgeHigh', 'SingleFamilyHousingAgePredominant'];
const neighborhoodPercentages = ['LandUseOneUnitPercentage', 'LandUse24UnitPercentage', 'LandUseMultiFamilyPercentage', 'LandUseCommercialPercentage', 'LandUseOtherPercentage'];
function validNeighborhoodField(value: Record<string, unknown>) {
  if (typeof value.value !== 'string' || value.value.length > 16000) return false;
  if (value.type === 'CheckBoxField') return neighborhoodCheckboxes.includes(String(value.fieldId)) && value.value === 'true';
  if (value.type !== 'TextField') return false;
  if (neighborhoodNumbers.includes(String(value.fieldId))) return /^(?:0|[1-9]\d{0,8})$/.test(value.value);
  if (neighborhoodPercentages.includes(String(value.fieldId))) return /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.value) && Number(value.value) <= 100;
  return ['NeighborhoodDescription', 'NeighborhoodBoundaries', 'MarketConditions'].includes(String(value.fieldId));
}
function validField(value: unknown): value is SfrepField {
  if (!record(value) || !validText(value.sourceField) || !validText(value.fieldId) || !validText(value.value)
    || (value.candidateId !== null && !positiveId(value.candidateId))
    || (value.type !== 'TextField' && value.type !== 'CheckBoxField') || !record(value.provenance)) return false;
  const provenance = value.provenance;
  if (provenance.sourceField !== value.sourceField || provenance.documentId !== value.documentId
    || provenance.candidateId !== value.candidateId || !validFormatting(value, provenance)) return false;
  if (value.sourceField === 'neighborhood' && !validNeighborhoodField(value)) return false;
  if (provenance.kind === 'account_reference') return value.documentId === null && value.candidateId === null
    && positiveId(provenance.assignmentFileId) && positiveId(provenance.revision) && validCountyIdentity(value, provenance);
  if (provenance.kind === 'saved_report') {
    if (provenance.sectionKey === 'market_conditions') return value.sourceField === 'neighborhood'
      && value.documentId === null && value.candidateId === null && positiveId(provenance.assignmentFileId)
      && positiveId(provenance.revision) && provenance.origin === 'appraiser_edit' && onlyKeys(provenance, savedKeys)
      && validNeighborhoodField(value);
    if (value.documentId !== null || value.candidateId !== null || !positiveId(provenance.assignmentFileId)
      || !positiveId(provenance.revision) || !['report.subject_identification', 'report.assignment_details'].includes(String(provenance.sectionKey))
      || !['appraiser_edit', 'reviewed_document', 'derived_reviewed_document', 'user_default', 'account_reference'].includes(String(provenance.origin))
      || (provenance.sourceDocumentId !== undefined && !positiveId(provenance.sourceDocumentId))
      || (provenance.sourceCandidateId !== undefined && !positiveId(provenance.sourceCandidateId))
      ) return false;
    if (provenance.origin === 'account_reference') return validCensus(value, provenance) || validCountyIdentity(value, provenance);
    if (provenance.origin === 'appraiser_edit') return onlyKeys(provenance, savedKeys);
    if (provenance.origin === 'user_default') return validLenderPreset(value, provenance)
      || (value.sourceField === 'property_rights' && value.fieldId === feeSimpleField
        && value.type === 'CheckBoxField' && value.value === 'true' && provenance.rule === feeSimpleRule
        && onlyKeys(provenance, [...savedKeys, 'rule']))
      || (value.sourceField === 'subject_state' && value.fieldId === 'State' && value.type === 'TextField'
        && value.value === 'TX' && provenance.rule === texasStateRule
        && provenance.sectionKey === 'report.subject_identification'
        && onlyKeys(provenance, [...savedKeys, 'rule']));
    if (provenance.origin === 'derived_reviewed_document' && provenance.rule === sellerOwnerRule) {
      const checkbox = value.sourceField === 'seller_matches_public_records'
        && ['SellerOwnerPublicYesCheckBox', 'SellerOwnerPublicNoCheckBox'].includes(value.fieldId)
        && value.type === 'CheckBoxField' && value.value === 'true';
      const dataSource = value.sourceField === 'seller_match_data_source'
        && value.fieldId === 'ContractDataSources' && value.type === 'TextField' && value.value === 'CAD';
      return (checkbox || dataSource) && provenance.sectionKey === 'report.assignment_details'
        && onlyKeys(provenance, [...savedKeys, 'rule']);
    }
    if (!positiveId(provenance.sourceDocumentId)) return false;
    if (provenance.origin === 'reviewed_document') return provenance.rule === undefined
      ? onlyKeys(provenance, [...savedKeys, 'sourceDocumentId', 'sourceCandidateId'])
      : onlyKeys(provenance, [...savedKeys, 'sourceDocumentId', 'sourceCandidateId', 'rule', 'sourceValue']) && validHoa(value, provenance);
    if (provenance.rule === historyRule) return validHistory(value, provenance);
    return value.sourceField === 'offered_for_sale_prior_12_months' && value.fieldId === 'CurrentPriorListingYesCheckBox'
      && onlyKeys(provenance, [...savedKeys, 'sourceDocumentId', 'sourceCandidateId', ...listingKeys])
      && value.type === 'CheckBoxField' && value.value === 'true' && provenance.rule === listingRule
      && isoDate(provenance.sourceValue) && isoDate(provenance.effectiveDate) && dateSource(provenance.effectiveDateSource)
      && (provenance.effectiveDateSourceDocumentId === null || positiveId(provenance.effectiveDateSourceDocumentId))
      && isoDate(provenance.windowStart) && provenance.windowEnd === provenance.effectiveDate
      && provenance.sourceValue >= provenance.windowStart && provenance.sourceValue <= provenance.windowEnd;
  }
  if (provenance.kind === 'user_default') return value.sourceField === 'property_rights'
    && value.fieldId === feeSimpleField && value.type === 'CheckBoxField' && value.value === 'true'
    && value.documentId === null && value.candidateId === null && provenance.rule === feeSimpleRule
    && Object.keys(provenance).every(key => ['kind', 'sourceField', 'documentId', 'candidateId', 'rule'].includes(key));
  if (!positiveId(value.documentId) || (provenance.documentType !== null && !validText(provenance.documentType))) return false;
  if (provenance.kind === 'reviewed_document') return provenance.rule === undefined ? onlyKeys(provenance, documentKeys)
    : provenance.documentType === 'mls_sheet' && onlyKeys(provenance, [...documentKeys, 'rule', 'sourceValue']) && validHoa(value, provenance);
  if (provenance.kind === 'derived_reviewed_document' && provenance.rule === contractRule) return validContractNarrative(value, provenance);
  return provenance.kind === 'derived_reviewed_document' && provenance.documentType === 'mls_sheet'
    && onlyKeys(provenance, [...documentKeys, ...listingKeys])
    && value.sourceField === 'list_date' && value.fieldId === 'CurrentPriorListingYesCheckBox'
    && value.type === 'CheckBoxField' && value.value === 'true' && provenance.rule === listingRule
    && isoDate(provenance.sourceValue) && isoDate(provenance.effectiveDate) && dateSource(provenance.effectiveDateSource)
    && (provenance.effectiveDateSourceDocumentId === null || positiveId(provenance.effectiveDateSourceDocumentId))
    && isoDate(provenance.windowStart) && provenance.windowEnd === provenance.effectiveDate
    && provenance.sourceValue >= provenance.windowStart && provenance.sourceValue <= provenance.windowEnd;
}

function validPhoto(value: unknown): value is SfrepPhoto {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const photoText = (text: unknown) => typeof text === 'string' && text.length <= 2000;
  const nullableText = (text: unknown) => text === null || photoText(text);
  if (!record(value) || !onlyKeys(value, ['id', 'label', 'category', 'roomLabel', 'caption', 'position', 'revision',
    'status', 'included', 'verifiedAt', 'variant', 'byteSize', 'fileName', 'reason', 'view_url'])
    || typeof value.id !== 'string' || !uuid.test(value.id) || !validText(value.label) || !photoText(value.label)
    || !photoText(value.category) || !nullableText(value.roomLabel) || !nullableText(value.caption)
    || !positiveId(value.position) || !positiveId(value.revision) || !boundedText(value.status, 64)
    || typeof value.included !== 'boolean' || !nullableText(value.reason)
    || (value.verifiedAt !== null && (typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))))) return false;
  if (value.included ? value.status !== 'verified' || !value.verifiedAt
    || !['display', 'original'].includes(String(value.variant)) || !positiveId(value.byteSize)
    || typeof value.fileName !== 'string' || !new RegExp(`^photo-${value.id.toLowerCase()}\\.(jpg|png)$`).test(value.fileName)
    || value.reason !== null
    : value.variant !== null || value.byteSize !== null || value.fileName !== null || !validText(value.reason)) return false;
  if (value.view_url != null) {
    if (!value.included || typeof value.view_url !== 'string' || value.view_url.length > 12000) return false;
    try { const url = new URL(value.view_url); if (url.protocol !== 'https:' || url.username || url.password) return false; }
    catch { return false; }
  }
  return true;
}

export function sfrepCanExport(preview: SfrepPreview, includeDocuments: boolean): boolean {
  return preview.fields.length > 0 || (includeDocuments && preview.documents.length > 0)
    || Boolean(preview.photos?.some(photo => photo.included));
}

export function checkSfrepPreview(value: unknown, selectedDocumentIds?: readonly number[], expectedFormId: SfrepFormId = SFREP_FORM_ID): SfrepPreview {
  if (!record(value) || value.ok !== true || !supportedFormId(expectedFormId) || value.formId !== expectedFormId
    || typeof value.preview_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.preview_digest)
    || !validText(value.filename) || !value.filename.toLowerCase().endsWith('.rpti')
    || !Array.isArray(value.fields) || !value.fields.every(validField)
    || new Set(value.fields.map(field => field.fieldId)).size !== value.fields.length
    || !validDateContext(value.effectiveDateContext)
    || !Array.isArray(value.assumptions) || value.assumptions.length > 2_001 || !value.assumptions.every(item => record(item)
      && onlyKeys(item, ['fieldId', 'value', 'rule', 'reason']) && validText(item.reason)
      && ((item.fieldId === feeSimpleField && item.value === 'true' && item.rule === feeSimpleRule)
        || (item.fieldId === pudField && (item.value === 'true' || item.value === 'false') && item.rule === hoaRule)
        || (item.fieldId === 'State' && item.value === 'TX' && item.rule === texasStateRule)))
    || !Array.isArray(value.knownMissing) || !value.knownMissing.every(item => record(item) && validText(item.fieldId) && validText(item.reason))
    || !Array.isArray(value.conflicts) || !value.conflicts.every(conflict => record(conflict)
      && validText(conflict.sourceField) && Array.isArray(conflict.documentIds) && conflict.documentIds.every(positiveId)
      && Array.isArray(conflict.values) && conflict.values.every(item => typeof item === 'string'))
    || !Array.isArray(value.omitted) || !value.omitted.every(item => record(item)
      && typeof item.sourceField === 'string' && positiveId(item.documentId)
      && (item.candidateId === null || positiveId(item.candidateId)) && validText(item.reason))
    || !Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === 'string')
    || !Array.isArray(value.documents) || !value.documents.every(doc => record(doc)
      && positiveId(doc.id) && typeof doc.title === 'string' && validText(doc.file_name)
      && typeof doc.file_size_bytes === 'number' && doc.file_size_bytes >= 0 && validText(doc.processing_status))) {
    throw new Error('The SFREP preview response is invalid. No export was downloaded.');
  }
  const preview = value as unknown as SfrepPreview;
  if (preview.photos !== undefined && (!Array.isArray(preview.photos) || preview.photos.length > 100
    || !preview.photos.every(validPhoto) || new Set(preview.photos.map(photo => photo.id)).size !== preview.photos.length)) {
    throw new Error('The SFREP photo preview is invalid. Preview again before exporting.');
  }
  const saved = preview.savedReport;
  if (saved !== undefined && (!record(saved) || !positiveId(saved.assignmentFileId) || !positiveId(saved.assignmentRevision)
    || (saved.marketRevision !== undefined && !positiveId(saved.marketRevision))
    || !Number.isSafeInteger(saved.subjectRevision) || saved.subjectRevision < 0 || !Array.isArray(saved.sourceDocumentIds)
    || saved.sourceDocumentIds.length > 50 || !saved.sourceDocumentIds.every(positiveId)
    || new Set(saved.sourceDocumentIds).size !== saved.sourceDocumentIds.length)) throw new Error('The saved HomeNode report reference is invalid.');
  if (preview.fields.some(({ provenance }) => (provenance.kind === 'saved_report' || provenance.kind === 'account_reference') && (!saved
    || provenance.assignmentFileId !== saved.assignmentFileId
    || provenance.revision !== (provenance.sectionKey === 'market_conditions' ? saved.marketRevision
      : provenance.sectionKey === 'report.subject_identification' ? saved.subjectRevision : saved.assignmentRevision)
    || (provenance.sourceDocumentId !== undefined && !saved.sourceDocumentIds.includes(provenance.sourceDocumentId))
    || provenance.sourceEvidence?.some(source => 'documentId' in source && !saved.sourceDocumentIds.includes(source.documentId))))) {
    throw new Error('The SFREP preview does not match the saved HomeNode report.');
  }
  const sellerOwnerFields = preview.fields.filter(field => [
    'SellerOwnerPublicYesCheckBox', 'SellerOwnerPublicNoCheckBox', 'ContractDataSources',
  ].includes(field.fieldId));
  if (sellerOwnerFields.length && (sellerOwnerFields.length !== 2
    || !sellerOwnerFields.some(field => field.fieldId === 'ContractDataSources' && field.value === 'CAD')
    || !preview.fields.some(field => field.fieldId === 'OwnerName'))) {
    throw new Error('The SFREP seller-owner source is incomplete. Preview again.');
  }
  const date = preview.effectiveDateContext;
  if (preview.fields.filter(field => field.provenance.rule === feeSimpleRule).length
      !== preview.assumptions.filter(item => item.rule === feeSimpleRule).length
    || preview.fields.filter(field => field.provenance.rule === texasStateRule).length
      !== preview.assumptions.filter(item => item.rule === texasStateRule).length
    || (saved && new Set(preview.assumptions.map(item => item.rule)).size !== preview.assumptions.length)
    || preview.fields.some(field => field.provenance.rule === hoaRule && !preview.assumptions.some(item => item.rule === hoaRule && item.value === field.value))
    || preview.assumptions.some(item => item.rule === hoaRule && item.value === 'true'
      // Direct projection deduplicates equal PUD values but retains every HOA
      // assumption. An earlier explicit source can own the surviving checkbox;
      // canonical saved receipts still require their exact HOA rule.
      && !preview.fields.some(field => field.fieldId === pudField && field.type === 'CheckBoxField' && field.value === item.value
        && (field.provenance.rule === hoaRule || (!saved && field.provenance.kind === 'reviewed_document'
          && field.provenance.rule === undefined && ['pud', 'is_pud', 'property_type'].includes(field.sourceField))))
      && ![...preview.conflicts, ...preview.omitted].some(entry => ['pud', 'is_pud', 'property_type'].includes(entry.sourceField)))
    || (preview.assumptions.some(item => item.rule === hoaRule && item.value === 'false')
      && (preview.fields.some(field => field.fieldId === pudField)
        // Direct false candidates remain as omissions/conflicts. Saved false
        // projection suppresses them before those lists are built; its retained
        // advisory prompts review, not a negative PUD assertion or checkbox.
        || (!saved && ![...preview.omitted, ...preview.conflicts].some(entry => entry.sourceField === 'pud'))))
    || preview.fields.some(({ provenance }) => [listingRule, historyRule].includes(provenance.rule || '')
      && (provenance.effectiveDate !== date.effectiveDate || provenance.effectiveDateSource !== date.source
        || provenance.effectiveDateSourceDocumentId !== date.sourceDocumentId
        || (provenance.rule === listingRule && (provenance.windowStart !== date.windowStart || provenance.windowEnd !== date.windowEnd))))) {
    throw new Error('The SFREP preview provenance is invalid. No export was downloaded.');
  }
  // Reviewed source evidence belongs to this saved assignment even when its
  // original PDF is not chosen as an optional RPTI attachment.
  const workfileSource = (id: number) => Boolean(saved?.sourceDocumentIds.includes(id));
  const workfileField = (field: SfrepField) => field.documentId !== null && workfileSource(field.documentId)
    && ['reviewed_document', 'derived_reviewed_document'].includes(field.provenance.kind);
  const received = new Set(preview.documents.map(doc => doc.id));
  if (received.size !== preview.documents.length
    || preview.fields.some(field => field.documentId !== null && !received.has(field.documentId) && !workfileField(field))
    || preview.omitted.some(field => !received.has(field.documentId) && !workfileSource(field.documentId))
    || preview.conflicts.some(conflict => conflict.documentIds.some(id => !received.has(id) && !workfileSource(id)))
    || (date.sourceDocumentId !== null && !received.has(date.sourceDocumentId) && !workfileSource(date.sourceDocumentId))) {
    throw new Error('The SFREP preview does not match the selected source documents. Preview again.');
  }
  if (selectedDocumentIds) {
    const selected = new Set(selectedDocumentIds);
    if (selected.size !== received.size || received.size !== preview.documents.length
      || [...received].some(id => !selected.has(id))
      || preview.fields.some(field => field.documentId !== null && !selected.has(field.documentId) && !workfileField(field))
      || preview.omitted.some(field => !selected.has(field.documentId) && !workfileSource(field.documentId))
      || preview.conflicts.some(conflict => conflict.documentIds.some(id => !selected.has(id) && !workfileSource(id)))) {
      throw new Error('The SFREP preview does not match the selected source documents. Preview again.');
    }
  }
  return preview;
}

export function sfrepDownloadFilename(value: string): string {
  const name = value.split(/[\\/]/).pop()?.replace(/[<>:"|?*\p{Cc}]/gu, '_').trim() || 'HomeNode-SFREP.rpti';
  return name.toLowerCase().endsWith('.rpti') ? name.slice(0, -5).slice(0, 150) + '.rpti' : 'HomeNode-SFREP.rpti';
}

/** Untrusted diagnostic text is displayed as text, never interpreted as markup. */
export function sfrepNoticeText(notice: SfrepNotice): string {
  if (typeof notice === 'string') return notice;
  const label = notice.sourceField.replace(/_/g, ' ') || 'Document';
  if ('values' in notice) return `${label}: ${notice.values.join(' / ')} (documents ${notice.documentIds.join(', ')})`;
  return `${label}: ${notice.reason.replace(/_/g, ' ')} (document ${notice.documentId})`;
}

export function sfrepProvenanceText(field: SfrepField): string {
  const source = field.provenance;
  const formattingDescription = field.formattingRule === 'uad_whole_dollars_half_up' ? 'rounded to whole dollars, half up (50 cents rounds up)'
    : field.formattingRule === 'zip5_display' ? 'displayed as ZIP5'
      : field.formattingRule === 'title_case_subdivision_without_numeric_phase' ? 'title-cased with the terminal numeric subdivision phase removed'
        : field.formattingRule === 'subject_title_case' ? 'title-cased for display; source identity is unchanged'
          : field.formattingRule === 'title_case_single_line_owner_name' ? 'title-cased with line breaks and tabs replaced by spaces'
            : 'line breaks and tabs replaced by spaces';
  if (source.kind === 'saved_report') {
    const origin = source.origin === 'appraiser_edit' ? 'Saved appraiser entry/correction'
      : source.origin === 'user_default' ? source.rule === lenderAddressRule
        ? 'Saved user-requested lender address preset — not PDF evidence'
        : source.rule === texasStateRule ? 'Texas-only TX default — not verified document evidence'
        : 'Saved user-requested fee-simple default unless changed in HomeNode — not document evidence'
        : source.origin === 'account_reference' ? source.rule === countyRule
          ? 'Saved canonical county-backed subject identity — not PDF evidence'
          : 'Saved matched account Census reference — not PDF evidence'
          : source.rule === hoaRule ? 'Saved HOA-based PUD workflow assumption — not independent eligibility proof'
            : source.rule === historyRule ? 'Saved listing-history narrative derived from reviewed MLS and contract evidence'
              : source.origin === 'derived_reviewed_document' ? 'Saved MLS listing determination'
          : `Applied from reviewed document ${source.sourceDocumentId}`;
    const formatting = field.formattingRule ? ` Original saved value: ${JSON.stringify(field.sourceValue)}; export ${formattingDescription}.` : '';
    return `${origin}. HomeNode file ${source.assignmentFileId}, ${source.sectionKey === 'market_conditions' ? 'Neighborhood / Market' : source.sectionKey === 'report.subject_identification' ? 'Subject' : 'Assignment'} revision ${source.revision}.${formatting}`;
  }
  if (source.kind === 'account_reference') return `Canonical county-backed subject identity — not PDF evidence. HomeNode file ${source.assignmentFileId}, assignment revision ${source.revision}; used because this report leaf has not been saved.`;
  if (source.rule === contractRule) return 'Legacy Contract narrative assembled from six individually reviewed terms in the subject purchase contract. Sale type follows the saved HomeNode appraiser selection, or is marked for review.';
  if (source.kind === 'user_default') return 'User-requested fee-simple default unless changed in HomeNode — not document evidence.';
  if (source.rule === hoaRule) return `Reviewed MLS HOA status ${JSON.stringify(source.sourceValue)} supplies a PUD workflow assumption, not independent proof of project eligibility. Confirm with the appraiser.`;
  if (source.kind === 'derived_reviewed_document') return `Derived from reviewed MLS listing date ${source.sourceValue}; window ${source.windowStart} to ${source.windowEnd}${source.effectiveDateSource === 'document_upload_date_placeholder' ? ' (placeholder effective date — review)' : ''}.`;
  if (field.formattingRule) {
    return `Reviewed document evidence. Original reviewed value: ${JSON.stringify(field.sourceValue)}. Export formatting: ${formattingDescription}. Source evidence is unchanged.`;
  }
  return 'Reviewed document evidence';
}

interface SubjectItem {
  key: string; label: string; fieldIds: string[]; sourceFields: string[]; unmappedPartyFields?: string[]; note?: string;
}
const SUBJECT_ITEMS: SubjectItem[] = [
  { key: 'street', label: 'Street address', fieldIds: ['StreetAddress'], sourceFields: ['subject_street_address', 'subject_property_address'] },
  { key: 'city', label: 'City', fieldIds: ['City'], sourceFields: ['subject_city', 'subject_property_address'] },
  { key: 'state', label: 'State', fieldIds: ['State'], sourceFields: ['subject_state', 'subject_property_address'] },
  { key: 'zip', label: 'ZIP code', fieldIds: ['ZipCode'], sourceFields: ['subject_zip', 'subject_zip_code', 'subject_property_address'] },
  { key: 'borrower', label: 'Borrower', fieldIds: ['BorrowerName'], sourceFields: ['borrower_name'], unmappedPartyFields: ['buyer_name'], note: 'A buyer is not automatically the borrower.' },
  { key: 'owner', label: 'Public-record owner', fieldIds: ['OwnerName'], sourceFields: ['owner_name', 'record_owner_name'], unmappedPartyFields: ['seller_name'], note: 'A seller is not automatically the public-record owner.' },
  { key: 'county', label: 'County', fieldIds: ['County'], sourceFields: ['county'] },
  { key: 'apn', label: 'Assessor parcel number (APN)', fieldIds: ['AssessorsParcelNumber'], sourceFields: ['assessor_parcel_number', 'assessors_parcel_number'] },
  { key: 'tax-year', label: 'Tax year', fieldIds: ['RealEstateTaxYear'], sourceFields: ['tax_year', 'real_estate_tax_year'] },
  { key: 'taxes', label: 'Real estate taxes', fieldIds: ['RealEstateTaxAmount'], sourceFields: ['tax_amount', 'real_estate_tax_amount'] },
  { key: 'neighborhood', label: 'Neighborhood', fieldIds: ['NeighborhoodName'], sourceFields: ['neighborhood_name', 'subdivision_name'] },
  { key: 'census', label: 'Census tract', fieldIds: ['CensusTract'], sourceFields: ['census_tract'] },
  { key: 'pud', label: 'PUD status', fieldIds: ['PropertyTypePUDCheckBox'], sourceFields: ['pud', 'is_pud', 'property_type'], note: 'HOA dues or membership do not establish PUD eligibility; an HOA-based workflow default needs appraiser confirmation. An omitted checkbox is not No.' },
  { key: 'property-rights', label: 'Property rights / fee simple', fieldIds: [feeSimpleField, 'PropertyRightsAppraisedLeaseholdCheckBox'], sourceFields: ['property_rights', 'property_rights_appraised'] },
  { key: 'assignment', label: 'Assignment type', fieldIds: ['AssignmentTypePurchaseCheckBox', 'AssignmentTypeRefinanceCheckBox', 'AssignmentTypeOtherCheckBox', 'AssignmentTypeOtherDescription'], sourceFields: ['assignment_type'] },
  { key: 'lender', label: 'Lender / client', fieldIds: ['LenderClientCompanyName'], sourceFields: ['lender_client_name'] },
  { key: 'lender-address', label: 'Lender / client address', fieldIds: ['LenderClientCompanyUnparsedAddress'], sourceFields: ['lender_client_address'] },
  { key: 'listing', label: 'Offered for sale in prior 12 months', fieldIds: ['CurrentPriorListingYesCheckBox', 'CurrentPriorListingNoCheckBox'], sourceFields: ['list_date', 'offered_for_sale_prior_12_months', 'subject_offered_for_sale_prior_12_months'], note: 'No MLS evidence is not a No answer. Review listing details and the effective-date window.' },
  { key: 'listing-history', label: 'Listing history', fieldIds: ['CurrentPriorListingDataSources'], sourceFields: ['listing_history_summary'] },
];
const CHECKBOX_LABELS: Record<string, string> = {
  [feeSimpleField]: 'Fee simple', PropertyRightsAppraisedLeaseholdCheckBox: 'Leasehold',
  AssignmentTypePurchaseCheckBox: 'Purchase transaction', AssignmentTypeRefinanceCheckBox: 'Refinance',
  AssignmentTypeOtherCheckBox: 'Other assignment',
  CurrentPriorListingYesCheckBox: 'Yes', CurrentPriorListingNoCheckBox: 'No', PropertyTypePUDCheckBox: 'PUD checked',
};
export interface SfrepSubjectChecklistItem {
  key: string; label: string; status: 'included' | 'review' | 'missing'; statusLabel: string;
  values: string[]; notes: string[];
}
function formattingNeedsReview(field: SfrepField): boolean {
  if (!field.formattingRule || ['subject_title_case', 'zip5_display'].includes(field.formattingRule)) return false;
  if (field.formattingRule === 'title_case_single_line_owner_name') return /[\t\r\n]/.test(field.sourceValue?.trim() || '');
  if (field.formattingRule === 'title_case_subdivision_without_numeric_phase') return /\s+\d+$/.test(field.sourceValue?.trim() || '');
  return true;
}
/** Export coverage only: absence never asserts a negative answer or a complete report. */
export function sfrepSubjectChecklist(preview: SfrepPreview): SfrepSubjectChecklistItem[] {
  return SUBJECT_ITEMS.map(item => {
    const fields = preview.fields.filter(field => item.fieldIds.includes(field.fieldId));
    const unmappedPartyFields = item.unmappedPartyFields || [];
    const hasMappedParty = unmappedPartyFields.length > 0 && fields.some(field => item.sourceFields.includes(field.sourceField));
    const conflict = preview.conflicts.some(entry => item.sourceFields.includes(entry.sourceField) || unmappedPartyFields.includes(entry.sourceField));
    // Excluding buyer/seller evidence is not a gap in an independently mapped
    // borrower/owner. Keep the raw omissions and all real role conflicts intact.
    const omissions = preview.omitted.filter(entry => item.sourceFields.includes(entry.sourceField)
      || (!hasMappedParty && unmappedPartyFields.includes(entry.sourceField)));
    const knownMissing = preview.knownMissing.filter(entry => item.fieldIds.includes(entry.fieldId));
    const assumptions = preview.assumptions.filter(entry => item.fieldIds.includes(entry.fieldId));
    const requestedDefault = fields.some(field => [feeSimpleRule, lenderAddressRule, texasStateRule].includes(field.provenance.rule || ''));
    const countyIdentity = fields.some(field => field.provenance.rule === countyRule);
    const hasDefault = assumptions.some(assumption => assumption.rule !== feeSimpleRule);
    const hasDerived = fields.some(field => field.provenance.kind === 'derived_reviewed_document' || field.provenance.origin === 'derived_reviewed_document');
    const formattedFields = fields.filter(formattingNeedsReview);
    const needsReview = conflict || omissions.length > 0 || knownMissing.length > 0 || hasDefault || hasDerived || formattedFields.length > 0;
    const status = needsReview ? 'review' : fields.length ? 'included' : 'missing';
    const statusLabel = conflict ? 'Review conflict — not fully exported' : hasDefault ? 'User default — confirm'
      : hasDerived ? 'Derived — review' : formattedFields.length ? 'Formatted — review' : needsReview ? 'Review needed'
        : requestedDefault ? 'Included — user default' : countyIdentity ? 'Included — county record'
          : fields.length ? 'Included — reviewed' : 'Missing — not exported';
    return { key: item.key, label: item.label, status, statusLabel,
      values: fields.map(field => field.type === 'CheckBoxField' ? CHECKBOX_LABELS[field.fieldId] || field.value : field.value),
      notes: [...new Set([...(item.note && !hasMappedParty ? [item.note] : []), ...knownMissing.map(entry => entry.reason),
        ...assumptions.filter(entry => entry.rule !== feeSimpleRule).map(entry => entry.reason), ...fields.filter(field => field.formattingRule
          || [feeSimpleRule, lenderAddressRule, texasStateRule, countyRule].includes(field.provenance.rule || '')
          || field.provenance.origin === 'account_reference' || field.provenance.origin === 'derived_reviewed_document'
          || field.provenance.rule === hoaRule).map(sfrepProvenanceText),
        ...(omissions.length ? [omissions[0].reason] : []), ...(conflict ? ['Resolve the conflicting source evidence before relying on this item.'] : [])])] };
  });
}

/** The legacy Contract section is separate from the Subject checklist. An
 * uploaded PDF with unreviewed terms is not treated as an analyzed contract. */
export function sfrepContractChecklist(preview: SfrepPreview): SfrepSubjectChecklistItem[] {
  const items = [
    { key: 'contract-analyzed', label: 'Contract analyzed', fieldId: 'AnalyzedContractYesCheckBox' },
    { key: 'contract-date', label: 'Contract date', fieldId: 'ContractDate' },
    { key: 'contract-price', label: 'Purchase price', fieldId: 'SalePriceAmount' },
    { key: 'seller-owner', label: 'Seller is owner of public record', fieldId: 'SellerOwnerPublicYesCheckBox' },
    { key: 'contract-analysis', label: 'Contract analysis and terms', fieldId: 'AnalyzedContractDescription' },
    { key: 'contract-assistance', label: 'Seller concessions', fieldId: 'BorrowerFinancialAssistanceNoCheckBox' },
  ];
  return items.map(item => {
    const field = preview.fields.find(entry => entry.fieldId === item.fieldId
      || (item.key === 'contract-assistance' && entry.fieldId === 'BorrowerFinancialAssistanceYesCheckBox')
      || (item.key === 'seller-owner' && entry.fieldId === 'SellerOwnerPublicNoCheckBox'));
    const missing = preview.knownMissing.filter(entry => entry.fieldId === item.fieldId);
    const status = field ? item.key === 'contract-analysis' && field.value.startsWith('Sale type requires appraiser review;') ? 'review' : 'included' : 'missing';
    return { key: item.key, label: item.label, status, statusLabel: status === 'included' ? 'Included — reviewed' : status === 'review' ? 'Review sale type' : 'Missing — not exported',
      values: field ? [field.type === 'CheckBoxField' ? field.fieldId === 'BorrowerFinancialAssistanceYesCheckBox'
        ? 'Yes — review amount in contract narrative' : field.fieldId === 'BorrowerFinancialAssistanceNoCheckBox'
          || field.fieldId === 'SellerOwnerPublicNoCheckBox' ? 'No'
            : field.fieldId === 'SellerOwnerPublicYesCheckBox' ? 'Yes' : 'Checked' : field.value] : [],
      notes: [...missing.map(entry => entry.reason),
        ...(item.key === 'seller-owner' && field ? ['Data source: CAD'] : []),
        ...(status === 'review' ? ['Select arms-length status in HomeNode before relying on this narrative.'] : [])] };
  });
}

/** Cancellation also settles promptly if authentication is still waiting for a token. */
function requestWithSignal(options: TransportOptions, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkSignal(signal); return options.request(url, init); }).then(response => {
      if (settled) { stop(response); return; }
      settled = true; signal.removeEventListener('abort', abort);
      if (signal.aborted) { stop(response); reject(cancelled()); } else resolve(response);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<Blob> {
  checkSignal(signal);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) { stop(response); throw new Error('The SFREP response is too large.'); }
  if (!response.body) throw new Error('The SFREP response is empty.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    checkSignal(signal);
    while (true) {
      const part = await reader.read(); checkSignal(signal);
      if (part.done) { done = true; break; }
      size += part.value.byteLength;
      if (size > limit) throw new Error('The SFREP response is too large.');
      chunks.push(part.value);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) abort();
    reader.releaseLock();
  }
}

export function createSfrepTransport(options: TransportOptions) {
  async function post(selection: SfrepSelection, operation: 'preview' | 'export', io: RequestOptions, digest?: string) {
    checkSignal(io.signal);
    const formId = selection.formId ?? SFREP_FORM_ID;
    if (!selection.accountId.trim() || !positiveId(selection.assignmentFileId) || selection.documentIds.length > 10
      || !selection.documentIds.every(positiveId) || new Set(selection.documentIds).size !== selection.documentIds.length
      || typeof selection.includeDocuments !== 'boolean' || !supportedFormId(formId)
      || (selection.includePhotos !== undefined && typeof selection.includePhotos !== 'boolean')
      || (operation === 'export' && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))) {
      throw new Error('Choose a saved assignment and review a fresh preview before exporting.');
    }
    const path = `/api/accounts/${encodeURIComponent(selection.accountId)}/sfrep/${operation}`;
    const response = await requestWithSignal(options, options.urlFor(path), {
      method: 'POST', signal: io.signal, cache: 'no-store',
      headers: { accept: operation === 'preview' ? 'application/json' : 'application/octet-stream',
        'content-type': 'application/json', 'x-homenode-editor-key': io.editorKey },
      body: JSON.stringify({ assignment_file_id: selection.assignmentFileId, document_ids: selection.documentIds,
        include_documents: selection.includeDocuments, form_id: formId,
        ...(selection.includePhotos !== undefined ? { include_photos: selection.includePhotos } : {}),
        ...(operation === 'export' ? { preview_digest: digest } : {}) }),
    }, io.signal);
    if (io.signal.aborted) { stop(response); throw cancelled(); }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok) {
      let message = `SFREP ${operation} failed (HTTP ${response.status}).`;
      if (type === 'application/json') {
        try {
          const error: unknown = JSON.parse(await (await readBody(response, 16_000, io.signal)).text());
          if (record(error) && validText(error.message ?? error.error)) message = String(error.message ?? error.error).slice(0, 500);
          if (record(error) && error.error === 'sfrep_preview_changed') message = 'The source evidence changed after your preview. Preview again and review the updated export.';
          if (record(error) && error.error === 'sfrep_export_busy') message = 'Another SFREP export is being prepared. Wait briefly, then preview again.';
          if (record(error) && error.error === 'sfrep_package_too_large') message = 'The selected documents and photos exceed the 50 MiB export limit. Reduce the attachments, then preview again.';
          if (record(error) && error.error === 'sfrep_photo_integrity_failed') message = 'A photo could not be verified for export. No RPTI was downloaded. Preview again and check its upload status.';
          if (record(error) && error.error === 'sfrep_photo_storage_unavailable') message = 'Photo storage is temporarily unavailable. Your photos remain saved; preview again later.';
        } catch { checkSignal(io.signal); }
      } else stop(response);
      throw new Error(message);
    }
    if (type !== (operation === 'preview' ? 'application/json' : 'application/octet-stream')) {
      stop(response); throw new Error(`Unexpected SFREP ${operation} response. No export was downloaded.`);
    }
    return readBody(response, operation === 'preview' ? 4_000_000 : 51 * 1024 * 1024, io.signal);
  }
  return {
    async preview(selection: SfrepSelection, io: RequestOptions): Promise<SfrepPreview> {
      const value: unknown = JSON.parse(await (await post(selection, 'preview', io)).text());
      checkSignal(io.signal);
      const checked = checkSfrepPreview(value, selection.documentIds, selection.formId ?? SFREP_FORM_ID);
      if (selection.includePhotos === true && checked.photos === undefined) {
        throw new Error('Photo export is not available on this server yet. No photos were silently omitted; try again after the update.');
      }
      if (checked.savedReport && checked.savedReport.assignmentFileId !== selection.assignmentFileId) {
        throw new Error('The SFREP preview does not match the selected HomeNode file.');
      }
      if (checked.fields.some(field => field.provenance.sourceEvidence?.some(source => 'accountId' in source
        && source.accountId !== selection.accountId))) throw new Error('The SFREP preview does not match the selected county account.');
      return checked;
    },
    async export(selection: SfrepSelection, previewDigest: string, io: RequestOptions): Promise<Blob> {
      const blob = await post(selection, 'export', io, previewDigest);
      checkSignal(io.signal);
      if (!blob.size) throw new Error('The SFREP export is empty. No export was downloaded.');
      return blob;
    },
  };
}
