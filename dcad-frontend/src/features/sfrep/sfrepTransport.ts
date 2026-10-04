import { reportAddress, reportNeighborhoodName, reportTitleCase, reportZip5 } from '../../lib/propertyReportText.ts';

export const SFREP_FORM_ID = 'FNMA-1004-0911' as const;

export interface SfrepSelection {
  accountId: string;
  assignmentFileId: number;
  documentIds: number[];
  includeDocuments: boolean;
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
  kind: 'reviewed_document' | 'derived_reviewed_document' | 'user_default' | 'saved_report';
  sourceField: string; documentId: number | null; candidateId: number | null;
  documentType?: string | null; rule?: string; sourceValue?: string;
  effectiveDate?: string; effectiveDateSource?: SfrepEffectiveDateSource;
  effectiveDateSourceDocumentId?: number | null; windowStart?: string; windowEnd?: string;
  assignmentFileId?: number; sectionKey?: 'report.subject_identification' | 'report.assignment_details'; revision?: number;
  origin?: 'appraiser_edit' | 'reviewed_document' | 'derived_reviewed_document' | 'user_default' | 'account_reference';
  sourceDocumentId?: number; sourceCandidateId?: number;
  sourceEvidence?: Array<SfrepListingEvidence | SfrepCensusEvidence>;
}
interface SfrepListingEvidence { documentId: number; candidateId: number; sourceField: string; value: string | number }
interface SfrepCensusEvidence {
  sourceTable: 'core.account_census_geographies'; accountId: string; tractCode: string; status: 'matched';
  geoid: string; vintage: string; updatedAt: string;
}
export type SfrepAssumption = {
  fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox'; value: 'true';
  rule: 'user_requested_fee_simple_default'; reason: string;
} | { fieldId: 'PropertyTypePUDCheckBox'; value: 'true' | 'false'; rule: 'user_requested_hoa_workflow_proxy_v1'; reason: string };
export interface SfrepDocument {
  id: number; title: string; file_name: string; file_size_bytes: number; processing_status: string;
}
export type SfrepConflict = { sourceField: string; documentIds: number[]; values: string[] };
export type SfrepOmission = { sourceField: string; documentId: number; candidateId: number | null; reason: string };
export type SfrepNotice = string | SfrepConflict | SfrepOmission;
export interface SfrepPreview {
  ok: true;
  preview_digest: string;
  formId: typeof SFREP_FORM_ID;
  fields: SfrepField[];
  conflicts: SfrepConflict[];
  omitted: SfrepOmission[];
  warnings: string[];
  documents: SfrepDocument[];
  filename: string;
  effectiveDateContext: SfrepEffectiveDateContext;
  assumptions: SfrepAssumption[];
  knownMissing: { fieldId: string; reason: string }[];
  savedReport?: { assignmentFileId: number; assignmentRevision: number; subjectRevision: number; sourceDocumentIds: number[] };
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
const listingRule = 'subject_mls_list_date_within_preceding_12_calendar_months';
const historyRule = 'reviewed_subject_listing_history_template_v1';
const censusRule = 'matched_account_census_tract_v1';
const hoaRule = 'user_requested_hoa_workflow_proxy_v1';
const pudField = 'PropertyTypePUDCheckBox';
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const savedKeys = ['kind', 'sourceField', 'documentId', 'candidateId', 'assignmentFileId', 'sectionKey', 'revision', 'origin'];
const documentKeys = ['kind', 'sourceField', 'documentId', 'candidateId', 'documentType'];
const listingKeys = ['rule', 'sourceValue', 'effectiveDate', 'effectiveDateSource', 'effectiveDateSourceDocumentId', 'windowStart', 'windowEnd'];
const historyKeys = ['rule', 'sourceEvidence', 'effectiveDate', 'effectiveDateSource', 'effectiveDateSourceDocumentId'];
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
  if (!['reviewed_document', 'saved_report'].includes(String(provenance.kind)) || value.type !== 'TextField' || !validText(value.sourceValue)) return false;
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
function validField(value: unknown): value is SfrepField {
  if (!record(value) || !validText(value.sourceField) || !validText(value.fieldId) || !validText(value.value)
    || (value.candidateId !== null && !positiveId(value.candidateId))
    || (value.type !== 'TextField' && value.type !== 'CheckBoxField') || !record(value.provenance)) return false;
  const provenance = value.provenance;
  if (provenance.sourceField !== value.sourceField || provenance.documentId !== value.documentId
    || provenance.candidateId !== value.candidateId || !validFormatting(value, provenance)) return false;
  if (provenance.kind === 'saved_report') {
    if (value.documentId !== null || value.candidateId !== null || !positiveId(provenance.assignmentFileId)
      || !positiveId(provenance.revision) || !['report.subject_identification', 'report.assignment_details'].includes(String(provenance.sectionKey))
      || !['appraiser_edit', 'reviewed_document', 'derived_reviewed_document', 'user_default', 'account_reference'].includes(String(provenance.origin))
      || (provenance.sourceDocumentId !== undefined && !positiveId(provenance.sourceDocumentId))
      || (provenance.sourceCandidateId !== undefined && !positiveId(provenance.sourceCandidateId))
      ) return false;
    if (provenance.origin === 'account_reference') return validCensus(value, provenance);
    if (provenance.origin === 'appraiser_edit') return onlyKeys(provenance, savedKeys);
    if (provenance.origin === 'user_default') return value.sourceField === 'property_rights' && value.fieldId === feeSimpleField
      && value.type === 'CheckBoxField' && value.value === 'true' && provenance.rule === feeSimpleRule
      && onlyKeys(provenance, [...savedKeys, 'rule']);
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
  return provenance.kind === 'derived_reviewed_document' && provenance.documentType === 'mls_sheet'
    && onlyKeys(provenance, [...documentKeys, ...listingKeys])
    && value.sourceField === 'list_date' && value.fieldId === 'CurrentPriorListingYesCheckBox'
    && value.type === 'CheckBoxField' && value.value === 'true' && provenance.rule === listingRule
    && isoDate(provenance.sourceValue) && isoDate(provenance.effectiveDate) && dateSource(provenance.effectiveDateSource)
    && (provenance.effectiveDateSourceDocumentId === null || positiveId(provenance.effectiveDateSourceDocumentId))
    && isoDate(provenance.windowStart) && provenance.windowEnd === provenance.effectiveDate
    && provenance.sourceValue >= provenance.windowStart && provenance.sourceValue <= provenance.windowEnd;
}

export function checkSfrepPreview(value: unknown, selectedDocumentIds?: readonly number[]): SfrepPreview {
  if (!record(value) || value.ok !== true || value.formId !== SFREP_FORM_ID
    || typeof value.preview_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.preview_digest)
    || !validText(value.filename) || !value.filename.toLowerCase().endsWith('.rpti')
    || !Array.isArray(value.fields) || !value.fields.every(validField)
    || new Set(value.fields.map(field => field.fieldId)).size !== value.fields.length
    || !validDateContext(value.effectiveDateContext)
    || !Array.isArray(value.assumptions) || value.assumptions.length > 2_001 || !value.assumptions.every(item => record(item)
      && onlyKeys(item, ['fieldId', 'value', 'rule', 'reason']) && validText(item.reason)
      && ((item.fieldId === feeSimpleField && item.value === 'true' && item.rule === feeSimpleRule)
        || (item.fieldId === pudField && (item.value === 'true' || item.value === 'false') && item.rule === hoaRule)))
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
  const saved = preview.savedReport;
  if (saved !== undefined && (!record(saved) || !positiveId(saved.assignmentFileId) || !positiveId(saved.assignmentRevision)
    || !Number.isSafeInteger(saved.subjectRevision) || saved.subjectRevision < 0 || !Array.isArray(saved.sourceDocumentIds)
    || saved.sourceDocumentIds.length > 50 || !saved.sourceDocumentIds.every(positiveId)
    || new Set(saved.sourceDocumentIds).size !== saved.sourceDocumentIds.length)) throw new Error('The saved HomeNode report reference is invalid.');
  if (preview.fields.some(({ provenance }) => provenance.kind === 'saved_report' && (!saved
    || provenance.assignmentFileId !== saved.assignmentFileId
    || provenance.revision !== (provenance.sectionKey === 'report.subject_identification' ? saved.subjectRevision : saved.assignmentRevision)
    || (provenance.sourceDocumentId !== undefined && !saved.sourceDocumentIds.includes(provenance.sourceDocumentId))
    || provenance.sourceEvidence?.some(source => 'documentId' in source && !saved.sourceDocumentIds.includes(source.documentId))))) {
    throw new Error('The SFREP preview does not match the saved HomeNode report.');
  }
  const date = preview.effectiveDateContext;
  if (preview.fields.filter(field => field.provenance.kind === 'user_default' || field.provenance.origin === 'user_default').length
      !== preview.assumptions.filter(item => item.rule === feeSimpleRule).length
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
    || preview.fields.some(({ provenance }) => (provenance.kind === 'derived_reviewed_document' || provenance.origin === 'derived_reviewed_document')
      && (provenance.effectiveDate !== date.effectiveDate || provenance.effectiveDateSource !== date.source
        || provenance.effectiveDateSourceDocumentId !== date.sourceDocumentId
        || (provenance.rule === listingRule && (provenance.windowStart !== date.windowStart || provenance.windowEnd !== date.windowEnd))))) {
    throw new Error('The SFREP preview provenance is invalid. No export was downloaded.');
  }
  const received = new Set(preview.documents.map(doc => doc.id));
  if (received.size !== preview.documents.length
    || preview.fields.some(field => field.documentId !== null && !received.has(field.documentId))
    || preview.omitted.some(field => !received.has(field.documentId))
    || preview.conflicts.some(conflict => conflict.documentIds.some(id => !received.has(id)))
    || (date.sourceDocumentId !== null && !received.has(date.sourceDocumentId) && !saved?.sourceDocumentIds.includes(date.sourceDocumentId))) {
    throw new Error('The SFREP preview does not match the selected source documents. Preview again.');
  }
  if (selectedDocumentIds) {
    const selected = new Set(selectedDocumentIds);
    if (selected.size !== received.size || received.size !== preview.documents.length
      || [...received].some(id => !selected.has(id))
      || [...preview.fields, ...preview.omitted].some(field => field.documentId !== null && !selected.has(field.documentId))
      || preview.conflicts.some(conflict => conflict.documentIds.some(id => !selected.has(id)))) {
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
      : source.origin === 'user_default' ? 'Saved user-requested default — confirm property rights'
        : source.origin === 'account_reference' ? 'Saved matched account Census reference — not PDF evidence'
          : source.rule === hoaRule ? 'Saved HOA-based PUD workflow assumption — not independent eligibility proof'
            : source.rule === historyRule ? 'Saved listing-history narrative derived from reviewed MLS and contract evidence'
              : source.origin === 'derived_reviewed_document' ? 'Saved MLS listing determination'
          : `Applied from reviewed document ${source.sourceDocumentId}`;
    const formatting = field.formattingRule ? ` Original saved value: ${JSON.stringify(field.sourceValue)}; export ${formattingDescription}.` : '';
    return `${origin}. HomeNode file ${source.assignmentFileId}, ${source.sectionKey === 'report.subject_identification' ? 'Subject' : 'Assignment'} revision ${source.revision}.${formatting}`;
  }
  if (source.kind === 'user_default') return 'User-requested default — not document evidence; confirm property rights.';
  if (source.rule === hoaRule) return `Reviewed MLS HOA status ${JSON.stringify(source.sourceValue)} supplies a PUD workflow assumption, not independent proof of project eligibility. Confirm with the appraiser.`;
  if (source.kind === 'derived_reviewed_document') return `Derived from reviewed MLS listing date ${source.sourceValue}; window ${source.windowStart} to ${source.windowEnd}${source.effectiveDateSource === 'document_upload_date_placeholder' ? ' (placeholder effective date — review)' : ''}.`;
  if (field.formattingRule) {
    return `Reviewed document evidence. Original reviewed value: ${JSON.stringify(field.sourceValue)}. Export formatting: ${formattingDescription}. Source evidence is unchanged.`;
  }
  return 'Reviewed document evidence';
}

interface SubjectItem {
  key: string; label: string; fieldIds: string[]; sourceFields: string[]; note?: string;
}
const SUBJECT_ITEMS: SubjectItem[] = [
  { key: 'street', label: 'Street address', fieldIds: ['StreetAddress'], sourceFields: ['subject_street_address', 'subject_property_address'] },
  { key: 'city', label: 'City', fieldIds: ['City'], sourceFields: ['subject_city', 'subject_property_address'] },
  { key: 'state', label: 'State', fieldIds: ['State'], sourceFields: ['subject_state', 'subject_property_address'] },
  { key: 'zip', label: 'ZIP code', fieldIds: ['ZipCode'], sourceFields: ['subject_zip', 'subject_zip_code', 'subject_property_address'] },
  { key: 'borrower', label: 'Borrower', fieldIds: ['BorrowerName'], sourceFields: ['borrower_name', 'buyer_name'], note: 'A buyer is not automatically the borrower.' },
  { key: 'owner', label: 'Public-record owner', fieldIds: ['OwnerName'], sourceFields: ['owner_name', 'seller_name'], note: 'A seller is not automatically the public-record owner.' },
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
/** Export coverage only: absence never asserts a negative answer or a complete report. */
export function sfrepSubjectChecklist(preview: SfrepPreview): SfrepSubjectChecklistItem[] {
  return SUBJECT_ITEMS.map(item => {
    const fields = preview.fields.filter(field => item.fieldIds.includes(field.fieldId));
    const conflict = preview.conflicts.some(entry => item.sourceFields.includes(entry.sourceField));
    const omissions = preview.omitted.filter(entry => item.sourceFields.includes(entry.sourceField));
    const knownMissing = preview.knownMissing.filter(entry => item.fieldIds.includes(entry.fieldId));
    const assumptions = preview.assumptions.filter(entry => item.fieldIds.includes(entry.fieldId));
    const hasDefault = assumptions.length > 0 || fields.some(field => field.provenance.kind === 'user_default' || field.provenance.origin === 'user_default');
    const hasDerived = fields.some(field => field.provenance.kind === 'derived_reviewed_document' || field.provenance.origin === 'derived_reviewed_document');
    const formattedFields = fields.filter(field => field.formattingRule);
    const needsReview = conflict || omissions.length > 0 || knownMissing.length > 0 || hasDefault || hasDerived || formattedFields.length > 0;
    const status = needsReview ? 'review' : fields.length ? 'included' : 'missing';
    const statusLabel = conflict ? 'Review conflict — not fully exported' : hasDefault ? 'User default — confirm'
      : hasDerived ? 'Derived — review' : formattedFields.length ? 'Formatted — review' : needsReview ? 'Review needed' : fields.length ? 'Included — reviewed' : 'Missing — not exported';
    return { key: item.key, label: item.label, status, statusLabel,
      values: fields.map(field => field.type === 'CheckBoxField' ? CHECKBOX_LABELS[field.fieldId] || field.value : field.value),
      notes: [...new Set([...(item.note ? [item.note] : []), ...knownMissing.map(entry => entry.reason),
        ...assumptions.map(entry => entry.reason), ...fields.filter(field => field.formattingRule
          || field.provenance.origin === 'account_reference' || field.provenance.origin === 'derived_reviewed_document'
          || field.provenance.rule === hoaRule).map(sfrepProvenanceText),
        ...(omissions.length ? [omissions[0].reason] : []), ...(conflict ? ['Resolve the conflicting source evidence before relying on this item.'] : [])])] };
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
    if (!selection.accountId.trim() || !positiveId(selection.assignmentFileId) || !selection.documentIds.length || selection.documentIds.length > 10
      || !selection.documentIds.every(positiveId) || new Set(selection.documentIds).size !== selection.documentIds.length
      || typeof selection.includeDocuments !== 'boolean' || (operation === 'export' && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))) {
      throw new Error('Choose 1–10 documents in a saved assignment and review a fresh preview before exporting.');
    }
    const path = `/api/accounts/${encodeURIComponent(selection.accountId)}/sfrep/${operation}`;
    const response = await requestWithSignal(options, options.urlFor(path), {
      method: 'POST', signal: io.signal, cache: 'no-store',
      headers: { accept: operation === 'preview' ? 'application/json' : 'application/octet-stream',
        'content-type': 'application/json', 'x-homenode-editor-key': io.editorKey },
      body: JSON.stringify({ assignment_file_id: selection.assignmentFileId, document_ids: selection.documentIds,
        include_documents: selection.includeDocuments, form_id: SFREP_FORM_ID,
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
      const checked = checkSfrepPreview(value, selection.documentIds);
      if (checked.savedReport && checked.savedReport.assignmentFileId !== selection.assignmentFileId) {
        throw new Error('The SFREP preview does not match the selected HomeNode file.');
      }
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
