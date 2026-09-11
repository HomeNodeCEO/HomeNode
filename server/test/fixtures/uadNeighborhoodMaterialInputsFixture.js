// Literal UAD contract inputs/oracles. No production projector/catalog imports.
export const id = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
export const IDs = { organization: id(1), report: id(2), workfile: id(3), appraisalCase: id(4), snapshot: id(5),
  setup: id(6), property: id(10), dwelling: id(11), unit: id(12), parcel: id(13), areaSource: id(14) };
export const RELEASE = 'uad-3.6-2026-08-13-h1.5';
export const CAPTURE = '2026-09-06T09:00:00.123456Z';
export const EMPTY_PROVENANCE = { source_type: 'appraiser', source_reference: null,
  source_observed_at: null, is_appraiser_confirmed: false };
export const compare = (a, b) => a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
export function sortRaw(raw) {
  raw.field_rows.sort((a, b) => compare(a.field_context, b.field_context) || compare(a.uad_uid, b.uad_uid)
    || compare(a.entity_id, b.entity_id) || compare(a.id, b.id));
  raw.entity_rows.sort((a, b) => compare(a.entity_type, b.entity_type) || compare(a.id, b.id));
  return raw;
}
export function entity(entityType, entityId, parentId = null) {
  return { id: entityId, workfile_id: IDs.workfile, parent_entity_id: parentId, entity_type: entityType,
    entity_identifier: `fixture-${entityId}`, ordinal: 1, label: null,
    data: { state: 'present', pg_text: '{}' }, created_at: CAPTURE, updated_at: CAPTURE };
}
export function rawField(context, uid, value, entityId = null, rowNumber = 100) {
  return { id: id(rowNumber), workfile_id: IDs.workfile, entity_id: entityId, uad_uid: uid, field_context: context,
    report_field_id: null, value: { state: value === null ? 'json_null' : 'present', pg_text: JSON.stringify(value) },
    source_type: 'appraiser', source_reference: null, source_observed_at: null, confidence: null,
    is_appraiser_confirmed: false, is_override: false, override_reason: null, updated_by_user_id: null,
    created_at: CAPTURE, updated_at: CAPTURE };
}
export function rawWorkflow() {
  return sortRaw({ raw_workflow_version: 1,
    source_basis: { repository: 'HomeNodeCEO/HomeNode', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    extractor_ref: { id: 'synthetic-uninstalled', revision: '1', content_sha256: 'c'.repeat(64) },
    setup_operation_id: IDs.setup, captured_at: CAPTURE,
    target: { organization_id: IDs.organization, report_file_id: IDs.report, workflow_type: 'uad_3_6',
      workfile_id: IDs.workfile, account_id: 'SYNTHETIC-UAD-0001', appraisal_case_id: IDs.appraisalCase,
      subject_snapshot_id: IDs.snapshot, snapshot_version: 1 },
    workfile_state: { specification_release_key: RELEASE, current_revision: 1, status: 'draft' },
    field_rows: [], entity_rows: [entity('property', IDs.property), entity('dwelling', IDs.dwelling, IDs.property),
      entity('unit', IDs.unit, IDs.dwelling), entity('site_parcel', IDs.parcel, IDs.property),
      entity('unit_area_data_source', IDs.areaSource, IDs.unit)] });
}

// [context, UID, exact entity, actual type, literal valid stored value]. These
// can be representable yet physically inapplicable; no study readiness claim.
export const SAMPLES = [
  ['subject_address', '0100.0007', null, 'string', '  Synthetic subject  '],
  ['subject_address', '0100.0008', null, 'string', 'A'],
  ['subject_address', '0100.0009', null, 'string', 'Garland'],
  ['subject_address', '0100.0011', null, 'postal_code', '75044-1234'],
  ['subject_address', '0100.0012', null, 'state', 'TX'],
  ['subject_address', '1200.0052', null, 'enum', 'Unit'],
  ['subject_legal', '0100.0067', null, 'text', 'Synthetic legal description'],
  ['subject', '0100.0019', null, 'integer', 0],
  ['subject', '0100.0020', null, 'enum', 'Detached'],
  ['subject', '0100.0021', null, 'integer', 1],
  ['subject', '0100.0022', null, 'integer', 1],
  ['subject', '0100.0047', null, 'boolean', false],
  ['subject', '0300.0010', null, 'boolean', false],
  ['subject', '0300.0066', null, 'enum', 'Complete'],
  ['subject', '2500.0168', null, 'enum', 'Condominium'],
  ['site', '1500.0020', null, 'enum', 'Road'],
  ['site', '1500.0021', null, 'string', ''],
  ['site', '1500.0093', null, 'measurement', { amount: 6000, unit: 'SquareFeet' }],
  ['site', '1500.0094', null, 'integer', 1],
  ['site', '1500.0095', null, 'boolean', true],
  ['dwelling', '0300.0011', IDs.dwelling, 'year', '1998'],
  ['dwelling', '0300.0012', IDs.dwelling, 'boolean', false],
  ['dwelling', '0300.0034', IDs.dwelling, 'enum', 'SiteBuilt'],
  ['dwelling', '0300.0035', IDs.dwelling, 'string', ''],
  ['dwelling', '0300.0063', IDs.dwelling, 'integer', 1],
  ['unit', '0700.0089', IDs.unit, 'boolean', false],
  ['unit', '0700.0140', IDs.unit, 'measurement', { amount: 1250, unit: 'SquareFeet' }],
  ['unit', '0700.0141', IDs.unit, 'measurement', { amount: 0, unit: 'SquareFeet' }],
  ['unit', '0700.0142', IDs.unit, 'measurement', { amount: 0, unit: 'SquareFeet' }],
  ['unit', '0700.0143', IDs.unit, 'measurement', { amount: 0, unit: 'SquareFeet' }],
  ['unit', '0700.0144', IDs.unit, 'measurement', { amount: 0, unit: 'SquareFeet' }],
  ['unit', '1800.0398', IDs.unit, 'measurement', { amount: 0, unit: 'SquareFeet' }],
  ['unit_area_data_source', '0700.0125', IDs.areaSource, 'enum', 'PhysicalMeasurement'],
  ['unit_area_data_source', '0700.0126', IDs.areaSource, 'string', ''],
  ['site_parcel', '1500.0022', IDs.parcel, 'measurement', { amount: 6000, unit: 'SquareFeet' }],
  ['site_parcel', '1500.0023', IDs.parcel, 'enum', 'LandWithDwelling'],
  ['site_parcel', '1500.0024', IDs.parcel, 'string', ''],
  ['site_parcel', '1500.0027', IDs.parcel, 'string', 'SYNTHETIC-PARCEL'],
];
const sortedSamples = () => [...SAMPLES].sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]) || compare(a[2], b[2]));
export function fullWorkflow() {
  const raw = rawWorkflow();
  raw.field_rows = SAMPLES.map(([context, uid, entityId, , value], index) => rawField(context, uid, value, entityId, 100 + index));
  return sortRaw(raw);
}
export function expectedMaterial(mode = 'absent') {
  return { material_input_version: 1, workflow_type: 'uad_3_6', report_file_id: IDs.report, workfile_id: IDs.workfile,
    account_id: 'SYNTHETIC-UAD-0001', specification_release_key: RELEASE,
    profile_id: 'uad-neighborhood-physical-stock-inputs-v1', profile_revision: '1',
    field_observations: sortedSamples().map(([context_key, uid, entity_id, , value]) => ({
      field_ref: { entity_id, context_key, uid }, state: mode === 'present' ? 'present' : mode,
      value: mode === 'present' ? value : null, provenance: mode === 'absent' ? null : { ...EMPTY_PROVENANCE },
    })),
    entity_rosters: [
      { entity_type: 'dwelling', members: [{ entity_id: IDs.dwelling, parent_entity_id: IDs.property, data_projection: {} }] },
      { entity_type: 'outbuilding', members: [] },
      { entity_type: 'property', members: [{ entity_id: IDs.property, parent_entity_id: null, data_projection: {} }] },
      { entity_type: 'site_parcel', members: [{ entity_id: IDs.parcel, parent_entity_id: IDs.property, data_projection: {} }] },
      { entity_type: 'unit', members: [{ entity_id: IDs.unit, parent_entity_id: IDs.dwelling, data_projection: {} }] },
      { entity_type: 'unit_area_data_source', members: [{ entity_id: IDs.areaSource, parent_entity_id: IDs.unit, data_projection: {} }] },
    ], accepted_evidence: [] };
}
export const STORED_SOURCES = ['homenode', 'public_record', 'mls', 'document', 'measurement', 'calculated', 'appraiser', 'imported'];
export const AREA_SOURCES = ['AssessorRecord', 'BuilderOrDeveloper', 'CondominiumQuestionnaire', 'CooperativeBoard',
  'CooperativeQuestionnaire', 'CostService', 'CostSurvey', 'DataAggregator', 'Deed', 'ExteriorInspection',
  'HomeownersAssociation', 'InteriorInspection', 'LandSurvey', 'Lender', 'MLS', 'Other', 'PhysicalMeasurement',
  'PlansAndSpecifications', 'PlatMap', 'PreviousAppraisalFile', 'PropertyDataReport', 'PropertyManagementCompany',
  'PropertyOwner', 'PropertyTenant', 'RealEstateAgent', 'ThreeDimensionalScan', 'Zoning'];
