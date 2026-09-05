// Entirely synthetic physical/membership evidence. No source or appraisal authority.
const SCOPE = Object.freeze({ organization_id: '11111111-1111-4111-8111-111111111111',
  appraisal_case_id: '22222222-2222-4222-8222-222222222222',
  subject_snapshot_id: '33333333-3333-4333-8333-333333333333', account_id: 'SYNTHETIC-S' });
const REF = id => ({ source_id: 'SYNTHETIC-SOURCE', source_revision: '1', record_id: id, record_revision: '1' });
const metadata = id => ({ ref: REF(id), scope: { ...SCOPE }, retrieved_at: '2024-06-30T12:00:00.000Z',
  recorded_at: '2024-06-30T12:00:00.000Z', validity: { status: 'supported', from: '2020-01-01', to: null,
    historical_availability: 'known_at_effective_date' } });
export function syntheticRankingPhysicalRecord(propertyId, facts, id = `physical:${propertyId}`) {
  return { kind: 'physical_facts', ...metadata(id), property_id: propertyId,
    facts: { housing_type: 'single_family_detached', year_built: 2004, gla: 2000, site_area: 8000, ...facts } };
}
export function addSyntheticRankingMember(input, pocketId, propertyId, facts = {}) {
  let property = input.properties.find(row => row.id === propertyId);
  if (!property) {
    const physical = syntheticRankingPhysicalRecord(propertyId, facts);
    input.records.push(physical); property = { id: propertyId, physical_record_refs: [{ ...physical.ref }] };
    input.properties.push(property);
  }
  let pocket = input.pockets.find(row => row.id === pocketId);
  if (!pocket) { pocket = { id: pocketId, revision: '1', membership_completeness: 'complete', members: [] }; input.pockets.push(pocket); }
  const membership = { kind: 'pocket_membership', ...metadata(`member:${pocketId}:${propertyId}`), property_id: propertyId,
    pocket_id: pocketId, pocket_revision: pocket.revision, included: true };
  input.records.push(membership); pocket.members.push({ property_id: propertyId, membership_record_refs: [{ ...membership.ref }] });
  return { property, pocket, membership };
}
export function neighborhoodPocketRankingPolicyFixture(variant = 'base') {
  const subject = syntheticRankingPhysicalRecord('S', {});
  const input = { ranking_version: 1, policy_version: 'physical-stock-v1-experimental', scope: { ...SCOPE },
    effective_date: '2024-06-30', knowledge_cutoff: '2024-07-01T00:00:00.000Z',
    units: { year_built: 'year', gla: 'ft2', site_area: 'ft2' }, subject_property_id: 'S',
    capture: { id: 'SYNTHETIC-CAPTURE', revision: '1', scope: { ...SCOPE }, effective_date: '2024-06-30',
      knowledge_cutoff: '2024-07-01T00:00:00.000Z', completeness: 'complete' },
    properties: [{ id: 'S', physical_record_refs: [{ ...subject.ref }] }], pockets: [], records: [subject] };
  addSyntheticRankingMember(input, 'A', 'A1'); addSyntheticRankingMember(input, 'A', 'A2');
  const expected = { order: ['A'], A: { low: 1, high: 1, support: 1, disposition: 'recommended' } };
  if (variant === 'minimal') return { input, expected };
  if (variant !== 'base') throw new TypeError('unknown_synthetic_ranking_fixture_variant');
  addSyntheticRankingMember(input, 'B', 'B1', { year_built: 2014, gla: 2500, site_area: 12000 });
  addSyntheticRankingMember(input, 'B', 'B2', { year_built: 2014, gla: 2500, site_area: 12000 });
  addSyntheticRankingMember(input, 'C', 'C1', { site_area: null });
  addSyntheticRankingMember(input, 'D', 'D000');
  for (let index = 1; index < 100; index++) addSyntheticRankingMember(input, 'D', `D${String(index).padStart(3, '0')}`, { housing_type: 'condominium_unit' });
  Object.assign(expected, { order: ['A', 'C', 'B', 'D'],
    B: { low: 0.5, high: 0.5, support: 1, disposition: 'not_recommended' },
    C: { low: 0.8, high: 1, support: 0.8, disposition: 'recommended' },
    D: { low: 0.01, high: 0.01, support: 1, compatible: 1, incompatible: 99, disposition: 'not_recommended' } });
  return { input, expected };
}
