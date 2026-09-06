// Synthetic originals and literal expected profile states. No candidate import.
export const target = {
  organization_id: '10000000-0000-4000-8000-000000000001',
  report_file_id: '10000000-0000-4000-8000-000000000002', workflow_type: 'custom_appraisal',
  assignment_file_id: '9223372036854775807', account_id: '0000123456789',
  appraisal_case_id: '10000000-0000-4000-8000-000000000003',
  subject_snapshot_id: '10000000-0000-4000-8000-000000000004', snapshot_version: 1,
};
export const sectionKeys = ['report.land_details', 'report.property_characteristics', 'report.subject_identification'];
export const pg = text => ({ state: 'present', pg_text: text });
export const sectionRow = (key, text) => ({ assignment_file_id: target.assignment_file_id,
  section_key: key, section_value: pg(text), revision: 1, last_applied_session_id: null,
  last_applied_by_user_id: null, created_at: '2024-01-01 00:00:00.000001+00', updated_at: '2024-01-02 00:00:00.000002+00' });
export function inputs() {
  return { target: structuredClone(target), sections: sectionKeys.map(section_key => ({ section_key, row_state: 'absent', row: null })),
    snapshot: { id: target.subject_snapshot_id, appraisal_case_id: target.appraisal_case_id,
      snapshot_version: 1, parent_snapshot_id: null, source_report_file_id: null, verification_status: 'captured',
      effective_date: null, inspection_date: null, subject_data: pg('{"custom_property_snapshot":{}}'),
      source_manifest: pg('{}'), checksum_sha256: null, created_by_user_id: null, created_at: '2024-01-01 00:00:00.000001+00' } };
}
export const argumentsOf = input => [JSON.stringify(input.target), JSON.stringify(input.sections), JSON.stringify(input.snapshot)];
export function setSection(input, index, text) {
  input.sections[index] = { section_key: sectionKeys[index], row_state: 'present', row: sectionRow(sectionKeys[index], text) };
  return input;
}
export function setPublic(input, value, extras = {}) {
  input.snapshot.subject_data = pg(JSON.stringify({ ...extras, custom_property_snapshot: value }));
  return input;
}
export const absent = () => ({ state: 'absent', value: null });
export const nullCell = () => ({ state: 'json_null', value: null });
export const present = value => ({ state: 'present', value });
export const absentRows = () => ({ state: 'absent', entries: [] });
export const emptyRows = () => ({ state: 'present', entries: [] });
export const legalAbsent = () => ({ state: 'absent', text: null, object: null });
export const emptyMain = () => ({ year_built: absent(), living_area_sqft: absent(), total_living_area: absent(),
  total_area_sqft: absent(), number_units: absent(), percent_complete: absent(), basement: absent() });
export const emptyHousing = () => ({ structural_style: absent(), housing_type: absent(), attachment_type: absent(),
  architectural_style: absent(), profile_source: absent(), source_name: absent(), source_url: absent(),
  source_record_reference: absent(), observed_at: absent(), confidence: absent() });
export const emptyAccount = () => ({ account_id: absent(), address: absent(), city: absent(), state: absent(),
  postal_code: absent(), county: absent(), legal_description: absent() });
export const emptyLocation = () => ({ address: absent(), city: absent(), state: absent(), postal_code: absent(), county: absent() });
export function emptyMaterial() {
  return { material_input_version: 1, workflow_type: 'custom_appraisal', report_file_id: target.report_file_id,
    assignment_file_id: target.assignment_file_id, account_id: target.account_id,
    profile_id: 'custom-neighborhood-physical-stock-inputs-v1', profile_revision: '1',
    assignment_sections: { subject_identification: { storage_state: 'absent', projection: null },
      property_characteristics: { storage_state: 'absent', projection: null }, land_details: { storage_state: 'absent', projection: null } },
    retained_public: { account: absent(), legal: absent(), improvement: absent(), housing_profile: absent(),
      land: absentRows(), additional_improvements: absentRows() }, accepted_evidence: [] };
}
export function emptyObjectSections(material = emptyMaterial()) {
  material.assignment_sections.subject_identification = { storage_state: 'object', projection: {
    property_location: absent(), legal_description: legalAbsent() } };
  material.assignment_sections.property_characteristics = { storage_state: 'object', projection: {
    main_improvement: absent(), housing_profile: absent(), additional_improvements: absentRows() } };
  material.assignment_sections.land_details = { storage_state: 'object', projection: { land_detail: absentRows() } };
  return material;
}
export function richFixture() {
  const input = inputs();
  setSection(input, 0, '{"land_detail":[{"number":0,"line_number":"0","state_code":"A1","area_sqft":0},{"number":0,"line_number":"0","state_code":"A1","area_sqft":0}],"unused":1e999999}');
  setSection(input, 1, '{"main_improvement":{"year_built":1990.0,"living_area_sqft":0,"total_living_area":"0","total_area_sqft":null,"number_units":1,"percent_complete":"100","basement":false},"housing_profile":{"structural_style":"R","housing_type":"S","attachment_type":"D","architectural_style":"C","profile_source":"claimed","source_name":"N","source_url":"https://example.invalid/a","source_record_reference":"R1","observed_at":"literal time","confidence":0},"additional_improvements":[{"number":null,"improvement_type":"shed","area_sqft":"10","year_built":2000}]}');
  setSection(input, 2, '{"property_location":{"address":"  A  ","city":"","state":null,"postal_code":"00000","county":"C"},"legal_description":{"legal_description":"L","lines":["line",null,"line",""]}}');
  setPublic(input, { account: { account_id: target.account_id, address: 'B', legal_description: 'account L' },
    legal: { legal_description: 'public L' }, improvement: { year_built: 1989, living_area_sqft: 2000 },
    housing_profile: { housing_type: 'public S', confidence: '1' }, land: [],
    additional_improvements: [{ number: 'A', improvement_type: 'garage', area_sqft: 100, year_built: '1995' }] });
  const material = emptyObjectSections();
  const landFields = () => ({ number: present(0), line_number: present('0'), state_code: present('A1'), area_sqft: present(0) });
  material.assignment_sections.land_details.projection.land_detail = { state: 'present', entries: [
    { ordinal: '0', fields: landFields() }, { ordinal: '1', fields: landFields() }] };
  material.assignment_sections.property_characteristics.projection = {
    main_improvement: present({ year_built: present(1990), living_area_sqft: present(0), total_living_area: present('0'),
      total_area_sqft: nullCell(), number_units: present(1), percent_complete: present('100'), basement: present(false) }),
    housing_profile: present({ structural_style: present('R'), housing_type: present('S'), attachment_type: present('D'),
      architectural_style: present('C'), profile_source: present('claimed'), source_name: present('N'),
      source_url: present('https://example.invalid/a'), source_record_reference: present('R1'),
      observed_at: present('literal time'), confidence: present(0) }),
    additional_improvements: { state: 'present', entries: [{ ordinal: '0', fields: {
      number: nullCell(), improvement_type: present('shed'), area_sqft: present('10'), year_built: present(2000) } }] },
  };
  material.assignment_sections.subject_identification.projection = {
    property_location: present({ address: present('  A  '), city: present(''), state: nullCell(), postal_code: present('00000'), county: present('C') }),
    legal_description: { state: 'object', text: null, object: { legal_description: present('L'), lines: {
      state: 'present', entries: ['line', null, 'line', ''].map((text, index) => ({ ordinal: String(index),
        fields: { text: text === null ? nullCell() : present(text) } })) } } },
  };
  material.retained_public.account = present({ ...emptyAccount(), account_id: present(target.account_id), address: present('B'), legal_description: present('account L') });
  material.retained_public.legal = present({ legal_description: present('public L') });
  material.retained_public.improvement = present({ ...emptyMain(), year_built: present(1989), living_area_sqft: present(2000) });
  material.retained_public.housing_profile = present({ ...emptyHousing(), housing_type: present('public S'), confidence: present('1') });
  material.retained_public.land = emptyRows();
  material.retained_public.additional_improvements = { state: 'present', entries: [{ ordinal: '0', fields: {
    number: present('A'), improvement_type: present('garage'), area_sqft: present(100), year_built: present('1995') } }] };
  return { input, material };
}
