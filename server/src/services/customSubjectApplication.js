import { buildSfrepReportExport, canonicalSfrepAssignmentType } from './sfrepReportExport.js';
import { sfrepDocumentPropertyRole, sfrepSubjectContext } from './sfrepSubjectContext.js';
import { validateAssignmentDetails, validateReportManualSection } from '../util/reportManualValues.js';
import { buildCustomSubjectListingHistory } from './customSubjectListingHistory.js';
import { buildCustomSubjectCensus, customSubjectCensusSql } from './customSubjectCensus.js';
import { buildCustomSubjectIdentity, customSubjectLenderPreset } from './customSubjectIdentity.js';

export const CUSTOM_SUBJECT_SECTION = 'report.subject_identification';
export const CUSTOM_SUBJECT_EVIDENCE_SECTION = 'report.subject_evidence';
const descriptor = (key, section, path, ...fieldIds) => Object.freeze({ key, section, path: Object.freeze(path), fieldIds: Object.freeze(fieldIds) });
export const CUSTOM_SUBJECT_FIELD_DESCRIPTORS = Object.freeze([
  descriptor('subject_street_address', 'subject', ['property_location', 'address'], 'StreetAddress'),
  descriptor('subject_city', 'subject', ['property_location', 'city'], 'City'),
  descriptor('subject_state', 'subject', ['property_location', 'state'], 'State'),
  descriptor('subject_zip', 'subject', ['property_location', 'postal_code'], 'ZipCode'),
  descriptor('county', 'subject', ['property_location', 'county'], 'County'),
  descriptor('neighborhood_name', 'subject', ['property_location', 'subdivision'], 'NeighborhoodName'),
  descriptor('census_tract', 'subject', ['property_location', 'census_tract'], 'CensusTract'),
  descriptor('owner_name', 'subject', ['owner', 'owner_name'], 'OwnerName'),
  descriptor('legal_description', 'subject', ['legal_description', 'lines'], 'LegalDescription'),
  descriptor('borrower_name', 'subject', ['urar_subject', 'borrower_name'], 'BorrowerName'),
  descriptor('assessor_parcel_number', 'subject', ['urar_subject', 'assessor_parcel_number'], 'AssessorsParcelNumber'),
  descriptor('tax_year', 'subject', ['urar_subject', 'tax_year'], 'RealEstateTaxYear'),
  descriptor('tax_amount', 'subject', ['urar_subject', 'tax_amount'], 'RealEstateTaxAmount'),
  descriptor('property_rights', 'subject', ['urar_subject', 'property_rights'], 'PropertyRightsAppraisedFeeSimpleCheckBox', 'PropertyRightsAppraisedLeaseholdCheckBox'),
  descriptor('offered_for_sale_prior_12_months', 'subject', ['urar_subject', 'offered_for_sale_prior_12_months'], 'CurrentPriorListingYesCheckBox', 'CurrentPriorListingNoCheckBox'),
  descriptor('listing_history_summary', 'subject', ['urar_subject', 'listing_history_summary'], 'CurrentPriorListingDataSources'),
  descriptor('lender_client_name', 'assignment', ['lender_client_name'], 'LenderClientCompanyName'),
  descriptor('lender_client_address', 'assignment', ['lender_client_address'], 'LenderClientCompanyUnparsedAddress'),
  descriptor('assignment_type', 'assignment', ['assignment_types'], 'AssignmentTypePurchaseCheckBox', 'AssignmentTypeRefinanceCheckBox', 'AssignmentTypeOtherCheckBox', 'AssignmentTypeOtherDescription'),
  descriptor('pud', 'assignment', ['pud'], 'PropertyTypePUDCheckBox'),
  descriptor('hoa_dues_amount', 'assignment', ['hoa_dues_amount'], 'AssessmentAmount'),
  descriptor('hoa_frequency', 'assignment', ['hoa_frequency'], 'AssessmentPerMonthCheckBox', 'AssessmentPerYearCheckBox'),
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const blank = value => value == null || value === '' || (Array.isArray(value) && value.length === 0);
const fail = message => { throw new Error(message); };
const CONTRACT_FIELDS = new Set(['contract_price', 'contract_date', 'contract_closing_date', 'loan_amount',
  'down_payment', 'earnest_money', 'seller_concessions', 'contract_buyer_names', 'contract_seller_names',
  'contract_property_condition', 'contract_repairs', 'contract_analysis_summary', 'subject_under_contract']);

export function readCustomSubjectValue({ subject = {}, assignmentDetails = {} }, key) {
  const field = CUSTOM_SUBJECT_FIELD_DESCRIPTORS.find(item => item.key === key);
  if (!field) return undefined;
  if (key === 'owner_name' && record(subject.owner) && Object.hasOwn(subject.owner, 'parties')) {
    const parties = subject.owner.parties;
    // [] is the explicit marker used when automatic application clears old
    // parties and stores owner_name. A nonempty saved list is authoritative,
    // including a list cleared to blank/invalid names; never revive an old name.
    if (!Array.isArray(parties)) return '';
    if (parties.length) return parties.filter(party => record(party) && typeof party.owner_name === 'string')
      .map(party => party.owner_name.trim()).filter(Boolean).join(' / ');
  }
  let value = field.section === 'subject' ? subject : assignmentDetails;
  for (const part of field.path) value = value?.[part];
  if (key === 'legal_description' && Array.isArray(value)) return value.join('\n');
  if (key === 'assignment_type' && Array.isArray(value) && value.length === 1) return value[0];
  return value;
}

function hasSavedSubjectPath(subject, definition) {
  if (definition.key === 'owner_name' && record(subject.owner) && Object.hasOwn(subject.owner, 'parties')) return true;
  let object = subject;
  for (const part of definition.path) {
    if (!record(object) || !Object.hasOwn(object, part)) return false;
    object = object[part];
  }
  return true;
}

/** All callers re-prove identity from the canonical assignment context. A
 * caller-supplied property_role never authorizes evidence by itself. */
export function projectCustomSubjectDocuments(documents = []) {
  if (!Array.isArray(documents) || documents.length > 50
    || documents.some(document => !Array.isArray(document?.candidates) || document.candidates.length > 200)
    || Buffer.byteLength(JSON.stringify(documents)) > 8 * 1024 * 1024) fail('custom_subject_evidence_limit');
  const scoped = documents.map(document => ({ ...document, id: Number(document.id),
    property_role: sfrepDocumentPropertyRole({ ...document, id: Number(document.id) }) }));
  const subjectContext = { ...sfrepSubjectContext(scoped), feeSimpleDefault: scoped.some(document => document.property_role === 'subject') };
  const mapped = buildSfrepReportExport({ documents: scoped, subjectContext, forReportPersistence: true });
  const fields = [];
  for (const definition of CUSTOM_SUBJECT_FIELD_DESCRIPTORS) {
    const field = mapped.fields.find(item => definition.fieldIds.includes(item.fieldId));
    if (!field) continue;
    let value = field.value;
    if (definition.key === 'pud') value = value === 'true';
    if (definition.key === 'property_rights') value = field.fieldId === 'PropertyRightsAppraisedFeeSimpleCheckBox' ? 'fee_simple' : 'leasehold';
    if (definition.key === 'offered_for_sale_prior_12_months') value = field.fieldId === 'CurrentPriorListingYesCheckBox';
    if (definition.key === 'hoa_frequency') value = field.fieldId === 'AssessmentPerMonthCheckBox' ? 'per_month' : 'per_year';
    const document = scoped.find(item => item.id === field.documentId);
    const candidate = document?.candidates.find(item => Number(item.id) === field.candidateId);
    if (definition.key === 'assignment_type') {
      value = field.fieldId === 'AssignmentTypePurchaseCheckBox' ? 'purchase_transaction'
        : field.fieldId === 'AssignmentTypeRefinanceCheckBox' ? 'refinance'
          : canonicalSfrepAssignmentType(candidate?.confirmed_value ?? candidate?.normalized_value ?? candidate?.raw_value);
      if (!value) continue;
    }
    fields.push({ key: definition.key, value, provenance: field.provenance,
      sourceValue: field.sourceValue ?? candidate?.confirmed_value ?? candidate?.normalized_value ?? candidate?.raw_value ?? null });
  }
  const listing = buildCustomSubjectListingHistory(scoped, subjectContext);
  const derivedWarnings = [...listing.warnings];
  let noHoa = fields.find(field => field.key === 'pud' && field.value === false
    && field.provenance.rule === 'user_requested_hoa_workflow_proxy_v1'
    && /^(none|no)$/i.test(field.provenance.sourceValue));
  // Equivalent PUD=false sources can deduplicate to an explicit PUD field first.
  // Still honor a separately reviewed, identity-proven MLS "None" observation.
  // Keep the exporter's readiness gate explicit here as well: reprocessing can
  // retain confirmed rows, but those stale rows cannot clear dues or conflict.
  if (!noHoa && fields.some(field => field.key === 'pud' && field.value === false)) {
    for (const source of scoped.filter(document => document.property_role === 'subject' && document.document_type === 'mls_sheet'
      && ['reviewed', 'review_required'].includes(document.processing_status))) {
      const candidate = source.candidates.find(item => item.field_key === 'pud' && item.review_status === 'confirmed'
        && (item.document_id == null || Number(item.document_id) === source.id)
        && item.extraction_method === 'urar_subject_mls_sheet_hoa_workflow_proxy'
        && String(item.confirmed_value ?? item.normalized_value) === 'false'
        && String(item.normalized_value) === 'false' && /^(none|no)$/i.test(item.raw_value));
      if (candidate) {
        noHoa = { sourceValue: candidate.raw_value, provenance: { kind: 'reviewed_document', sourceField: 'pud',
          documentId: source.id, candidateId: Number(candidate.id), documentType: source.document_type,
          rule: 'user_requested_hoa_workflow_proxy_v1', sourceValue: candidate.raw_value } };
        break;
      }
    }
  }
  if (noHoa) {
    if (fields.some(field => ['hoa_dues_amount', 'hoa_frequency'].includes(field.key))) {
      for (let index = fields.length - 1; index >= 0; index--) {
        if (['pud', 'hoa_dues_amount', 'hoa_frequency'].includes(fields[index].key)) fields.splice(index, 1);
      }
      mapped.conflicts.push({ sourceField: 'pud', values: ['No HOA', 'Reviewed HOA dues'] });
      derivedWarnings.push('MLS reports no HOA but other reviewed evidence contains dues; review the conflicting sources.');
    } else {
      // Clear only untouched automatic dues through the ordinary merge. A
      // manually entered/corrected amount remains an appraiser decision.
      for (const key of ['hoa_dues_amount', 'hoa_frequency']) fields.push({ key, value: null,
        provenance: { ...noHoa.provenance, sourceField: key, rule: 'reviewed_no_hoa_clears_automatic_dues_v1' },
        sourceValue: noHoa.sourceValue });
    }
  }
  // A reviewed explicit narrative remains authoritative; don't silently replace
  // it with a second, derived proposal for the same saved report leaf.
  if (listing.field && !fields.some(field => field.key === listing.field.key)) fields.push(listing.field);
  const census = buildCustomSubjectCensus(scoped[0]?.subject_context);
  const existingCensus = fields.find(field => field.key === 'census_tract');
  if (census.field && existingCensus && Number(census.field.value) !== Number(existingCensus.value)) {
    fields.splice(fields.indexOf(existingCensus), 1);
    mapped.conflicts.push({ sourceField: 'census_tract', values: [existingCensus.value, census.field.value] });
    derivedWarnings.push('Census tract: reviewed document and matched account lookup disagree; review before applying.');
  } else if (census.field && !existingCensus && !mapped.conflicts.some(conflict => conflict.sourceField === 'census_tract')) {
    fields.push(census.field);
  }
  // The county-backed subject identity is primary. PDF identity still gates
  // document applicability; differences remain visible without replacing CAD.
  for (const canonical of buildCustomSubjectIdentity(scoped[0]?.subject_context)) {
    const index = fields.findIndex(field => field.key === canonical.key);
    if (canonical.key === 'county' && index >= 0
      && String(fields[index].value).trim().replace(/\s+county$/i, '').toLowerCase() !== canonical.value.toLowerCase()) {
      derivedWarnings.push('County: the reviewed document differs from the county record; the county record was retained.');
    }
    if (index >= 0) fields.splice(index, 1);
    fields.push(canonical);
  }
  const lenderPreset = customSubjectLenderPreset(fields);
  if (lenderPreset && !mapped.conflicts.some(conflict => conflict.sourceField === 'lender_client_address')) fields.push(lenderPreset);
  return { fields, warnings: [...mapped.warnings.slice(2), ...derivedWarnings,
    ...new Set(mapped.omitted.map(item => `${item.sourceField} (document ${item.documentId}): ${item.reason}`))],
  conflicts: mapped.conflicts, omitted: mapped.omitted };
}

function writeValue(target, definition, value) {
  let object = definition.section === 'subject' ? target.subject : target.assignmentDetails;
  for (const part of definition.path.slice(0, -1)) {
    if (!record(object[part])) object[part] = {};
    object = object[part];
  }
  object[definition.path.at(-1)] = definition.key === 'legal_description' ? value.split('\n')
    : definition.key === 'assignment_type' ? [value] : value;
  if (definition.key === 'owner_name') target.subject.owner.parties = [];
}

/** Preserve appraiser edits and retain stale receipts so an unavailable source
 * cannot silently turn an automatic value into an appraiser-authored fact. */
export function mergeCustomSubjectApplication({ subject = {}, assignmentDetails = {}, evidence = {}, projection,
  actorUserId = null, reviewer = null, reviewedDocumentId = null, invalidateOnly = false, listingOnly = false } = {}) {
  const result = { subject: structuredClone(subject), assignmentDetails: structuredClone(assignmentDetails),
    evidence: { version: 1, fields: record(evidence.fields) ? structuredClone(evidence.fields) : {}, warnings: [] } };
  const proposals = new Map(projection.fields.map(field => [field.key, field]));
  const warnings = [...projection.warnings];
  for (const definition of CUSTOM_SUBJECT_FIELD_DESCRIPTORS) {
    if (listingOnly && definition.key !== 'listing_history_summary') continue;
    const key = definition.key, proposal = proposals.get(key), prior = result.evidence.fields[key];
    const current = readCustomSubjectValue(result, key);
    if (!proposal || (invalidateOnly && prior?.documentId === reviewedDocumentId)) {
      if (prior) {
        prior.status = 'needs_review';
        warnings.push(`${key}: previously applied evidence is unavailable, rejected, or conflicting. The saved value is preserved and needs review.`);
      }
      continue;
    }
    // Rejection of an unavailable extraction can retire receipts, but cannot
    // apply another source or revalidate any previously stale receipt.
    if (invalidateOnly) continue;
    const explicitlyReviewed = Number.isSafeInteger(reviewedDocumentId) && reviewedDocumentId > 0
      && (proposal.provenance.documentId === reviewedDocumentId || proposal.provenance.kind === 'user_default'
        || proposal.provenance.kind === 'account_reference'
        || proposal.provenance.sourceEvidence?.some(source => source.documentId === reviewedDocumentId));
    if (prior?.status === 'needs_review' && !explicitlyReviewed) {
      warnings.push(`${key}: re-review the source document to refresh the previously stale evidence receipt.`);
      continue;
    }
    // Owner parties are a separate user-editable representation that takes
    // precedence in the report. Do not destroy them on an automatic fill.
    const ownerParties = key === 'owner_name' && Array.isArray(result.subject.owner?.parties) && result.subject.owner.parties.length;
    // A saved Subject blank remains protected during background refresh.
    // Assignment drafts initialize blank client/type fields before any review.
    const savedSubjectPath = definition.section === 'subject' && hasSavedSubjectPath(result.subject, definition);
    // A whole-section save includes unfilled fields. Explicitly confirming new
    // evidence may populate those blanks; background refresh must not. A
    // nonblank edit or a deliberately cleared previously applied value wins.
    const reviewedBlank = explicitlyReviewed && blank(current) && !prior;
    if (ownerParties || (prior && !same(current, prior.value)) || (!prior && ((!reviewedBlank && savedSubjectPath) || !blank(current)))) {
      warnings.push(`${key}: the existing appraiser value was preserved; reviewed evidence did not overwrite it.`);
      continue;
    }
    writeValue(result, definition, proposal.value);
    result.evidence.fields[key] = { value: proposal.value, status: 'current', ...proposal.provenance,
      reviewedSourceValue: proposal.sourceValue, actorUserId, reviewer };
  }
  warnings.push(...projection.conflicts.map(conflict => `${conflict.sourceField}: conflicting reviewed sources were not applied.`));
  result.evidence.warnings = [...new Set(warnings)];
  return { ...result, warnings: result.evidence.warnings };
}

export async function readCustomSubjectDocuments(client, { accountId, assignmentFileId }) {
  const census = await customSubjectCensusSql(client);
  const { rows } = await client.query(
    `SELECT document.id, document.account_id, document.assignment_file_id, document.document_type,
            document.processing_status, document.extraction_summary, document.checksum_sha256,
            (document.uploaded_at AT TIME ZONE 'UTC')::date::text AS upload_date,
            jsonb_build_object('accountId', subject.account_id, 'address', subject.address,
              'city', subject.city, 'postalCode', subject.postal_code,
              'canonicalIdentity', jsonb_build_object('accountId', subject.account_id,
                'address', subject.address, 'city', subject.city, 'postalCode', subject.postal_code,
                'county', subject.county, 'assessorParcelNumber', subject.account_id,
                'state', to_jsonb(subject)->>'state'),
              'effectiveDate', appraisal_case.effective_date::text,
              'inspectionDate', appraisal_case.inspection_date::text,
              'censusGeography', ${census.value}) AS subject_context,
            COALESCE(evidence.candidates, '[]'::json) AS candidates
       FROM app.assignment_documents document
       JOIN app.assignment_files assignment
         ON assignment.id = document.assignment_file_id AND assignment.account_id = document.account_id
       JOIN core.accounts subject ON subject.account_id = assignment.account_id
       ${census.join}
       LEFT JOIN app.report_files report_file
         ON report_file.custom_assignment_file_id = assignment.id
        AND report_file.account_id = assignment.account_id
        AND report_file.organization_id IS NOT DISTINCT FROM assignment.organization_id
        AND report_file.workflow_type = 'custom_appraisal'
       LEFT JOIN app.appraisal_cases appraisal_case
         ON appraisal_case.id = report_file.appraisal_case_id AND appraisal_case.account_id = assignment.account_id
        AND appraisal_case.organization_id IS NOT DISTINCT FROM assignment.organization_id
       LEFT JOIN LATERAL (
         SELECT json_agg(candidate ORDER BY candidate.id) AS candidates FROM (
           SELECT id, document_id, field_key, raw_value, normalized_value, confirmed_value,
                  review_status, page_number, reviewer, reviewed_at, extraction_method
             FROM app.assignment_document_field_candidates
            WHERE document_id = document.id ORDER BY id LIMIT 201
         ) candidate
       ) evidence ON true
      WHERE document.account_id = $1 AND document.assignment_file_id = $2
        AND document.uad_workfile_id IS NULL AND document.tax_protest_file_id IS NULL
      ORDER BY document.id LIMIT 51`,
    [accountId, assignmentFileId],
  );
  for (const row of rows) {
    if (row.account_id !== accountId || Number(row.assignment_file_id) !== assignmentFileId) fail('document_scope_changed');
  }
  return rows;
}

/** Caller holds assignment -> workfile -> source document locks and owns the
 * transaction. This writer deliberately never commits or writes core.accounts. */
export async function persistCustomSubjectApplication(client, { assignmentFile, sourceDocument,
  legacyAssignmentDetails = null, actorUserId = null, reviewer = null, invalidateOnly = false, listingOnly = false }) {
  const assignmentFileId = Number(assignmentFile.id), accountId = assignmentFile.account_id;
  if (Number(sourceDocument.assignment_file_id) !== assignmentFileId || sourceDocument.account_id !== accountId
    || sourceDocument.uad_workfile_id || sourceDocument.tax_protest_file_id) fail('document_scope_changed');
  if (assignmentFile.workfile_status === 'signed') fail('custom_appraisal_workfile_signed');
  if (!invalidateOnly && !['reviewed', 'review_required'].includes(sourceDocument.processing_status)) fail('document_not_processable');
  const documents = await readCustomSubjectDocuments(client, { accountId, assignmentFileId });
  const projection = projectCustomSubjectDocuments(documents);
  const { rows } = await client.query(
    `SELECT section_key, section_value, revision, updated_at
       FROM app.custom_appraisal_sections
      WHERE assignment_file_id = $1 AND section_key = ANY($2::text[])
      ORDER BY section_key FOR UPDATE`,
    [assignmentFileId, [CUSTOM_SUBJECT_SECTION, CUSTOM_SUBJECT_EVIDENCE_SECTION]],
  );
  const sections = new Map(rows.map(row => [row.section_key, row]));
  const oldSubject = sections.get(CUSTOM_SUBJECT_SECTION)?.section_value || {};
  const oldEvidence = sections.get(CUSTOM_SUBJECT_EVIDENCE_SECTION)?.section_value || {};
  const merged = mergeCustomSubjectApplication({ subject: oldSubject,
    assignmentDetails: assignmentFile.assignment_details || {}, evidence: oldEvidence, projection, actorUserId, reviewer,
    reviewedDocumentId: Number(sourceDocument.id), invalidateOnly, listingOnly });
  // Preserve the pre-existing purchase-contract application path. Subject
  // proposals themselves still come exclusively from the reviewed projection.
  if (!invalidateOnly && !listingOnly && legacyAssignmentDetails) {
    for (const [key, value] of Object.entries(legacyAssignmentDetails)) {
      if (CONTRACT_FIELDS.has(key) && !same(value, assignmentFile.assignment_details?.[key])) merged.assignmentDetails[key] = value;
    }
  }
  validateAssignmentDetails(merged.assignmentDetails, { requireCompletion: false });
  validateReportManualSection(CUSTOM_SUBJECT_SECTION, merged.subject);
  const assignmentChanged = !same(merged.assignmentDetails, assignmentFile.assignment_details || {});
  let revision = Number(assignmentFile.revision);
  if (assignmentChanged) {
    revision += 1;
    await client.query(
      `UPDATE app.assignment_files
          SET assignment_details = $1::jsonb, reviewer = $2, revision = $3, updated_at = now()
        WHERE id = $4`,
      [JSON.stringify(merged.assignmentDetails), reviewer, revision, assignmentFileId],
    );
    await client.query(
      `INSERT INTO app.assignment_file_history (
         assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [assignmentFileId, accountId, assignmentFile.file_number, JSON.stringify(merged.assignmentDetails), reviewer, revision],
    );
  }
  const saved = {};
  let sectionChanged = false;
  for (const [key, value] of [[CUSTOM_SUBJECT_SECTION, merged.subject], [CUSTOM_SUBJECT_EVIDENCE_SECTION, merged.evidence]]) {
    const previous = sections.get(key);
    // No empty Subject section is manufactured for unrelated evidence.
    if (!previous && key === CUSTOM_SUBJECT_SECTION && !Object.keys(value).length) continue;
    let row = previous;
    if (!same(previous?.section_value, value)) {
      sectionChanged = true;
      const valueJson = JSON.stringify(value);
      const result = await client.query(
        `INSERT INTO app.custom_appraisal_sections (
           assignment_file_id, section_key, section_value, revision,
           last_applied_session_id, last_applied_by_user_id
         ) VALUES ($1,$2,$3::jsonb,1,NULL,$4)
         ON CONFLICT (assignment_file_id, section_key) DO UPDATE SET
           section_value = EXCLUDED.section_value,
           revision = app.custom_appraisal_sections.revision + 1,
           last_applied_session_id = NULL,
           last_applied_by_user_id = EXCLUDED.last_applied_by_user_id,
           updated_at = now()
         RETURNING section_key, section_value, revision, updated_at`,
        [assignmentFileId, key, valueJson, actorUserId],
      );
      row = result.rows[0];
      if (!row) fail('custom_subject_section_save_failed');
      await client.query(
        `INSERT INTO app.custom_appraisal_section_history (
           assignment_file_id, section_key, section_value, revision,
           inspection_session_id, actor_user_id, proposal_id, changed_path
         ) VALUES ($1,$2,$3::jsonb,$4,NULL,$5,NULL,ARRAY[$2]::text[])`,
        [assignmentFileId, key, valueJson, Number(row.revision), actorUserId],
      );
    }
    saved[key] = { value: row.section_value, revision: Number(row.revision), last_applied_session_id: null, updated_at: row.updated_at };
  }
  return { applied: assignmentChanged || sectionChanged, account_id: accountId, assignment_file_id: assignmentFileId,
    revision, assignment_details: merged.assignmentDetails, custom_appraisal_sections: saved, warnings: merged.warnings };
}
