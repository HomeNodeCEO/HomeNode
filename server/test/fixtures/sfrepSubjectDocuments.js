// Entirely synthetic: reusable PDF-to-URAR and native Appraise-It Pro QA input.
export const SFREP_SUBJECT_QA = Object.freeze({
  accountId: '00001234567890000', assignmentFileId: 7001,
  address: '100 Example Dr', city: 'Garland', postalCode: '75041',
  effectiveDate: '2026-10-02', inspectionDate: null,
});
export const SFREP_SUBJECT_DOCUMENTS = Object.freeze([
  { id: 1, type: 'engagement_letter', title: 'Synthetic engagement', lines: [
    'APPRAISAL ENGAGEMENT LETTER', 'SYNTHETIC QA ONLY - NOT AN APPRAISAL',
    'Property Address: 100 Example Dr, Garland, TX 75041',
    'Borrower: Taylor Example', 'Assignment Type: Purchase Transaction',
    'Lender: Example QA Bank', 'Lender Address: 20 Finance Road, Austin, TX 78701',
  ] },
  { id: 2, type: 'mls_sheet', title: 'Synthetic subject MLS', lines: [
    'MULTIPLE LISTING SERVICE', 'SYNTHETIC QA ONLY - NOT AN APPRAISAL',
    'Property Address: 100 Example Dr, Garland, TX 75041',
    'MLS Number: QA123456', 'List Date: 09/24/2026', 'List Price: $300,000',
    'HOA Dues: $120 annually', 'PUD: Yes',
  ] },
  { id: 3, type: 'other', title: 'Synthetic CAD record', lines: [
    'DALLAS CENTRAL APPRAISAL DISTRICT', 'SYNTHETIC QA ONLY - NOT AN APPRAISAL',
    'Property Address: 100 Example Dr, Garland, TX 75041',
    'Account Number: 00001234567890000', 'Owner Name: Morgan Publicrecord',
    'County: Dallas', 'Legal Description: EXAMPLE PARK 4', 'BLK 17 LT 36',
  ] },
  { id: 4, type: 'other', title: 'Synthetic Realist record', lines: [
    'REALIST PROPERTY REPORT', 'SYNTHETIC QA ONLY - NOT AN APPRAISAL',
    'Property Address: 100 Example Dr, Garland, TX 75041',
    'APN: 00001234567890000', 'Tax Year: 2025', 'Total Taxes: $4,321.50',
  ] },
]);
