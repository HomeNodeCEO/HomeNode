import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES = Object.freeze([
  'detached_single_family', 'townhouse', 'condominium', 'duplex', 'apartment', 'mobile_home', 'manufactured_home',
]);
export const CUSTOM_COHORT_RECORDED_HOUSING_STATES = Object.freeze(['observed', 'missing', 'unknown', 'partial', 'conflicting']);
export const CUSTOM_COHORT_RECORDED_HOUSING_ORIGINS = Object.freeze([
  'saved_subject', 'retained_subject_public', 'current_subject_cad', 'retained_current_cad',
]);
export const CUSTOM_COHORT_RECORDED_HOUSING_BASIS = 'retained_current_housing_observations';
export const CUSTOM_COHORT_RECORDED_HOUSING_LIMITS = Object.freeze({
  accounts: 50000, source_records: 100000, source_chunks: 1000, groups: 129,
  cad_literal_utf8_bytes: 4096, subject_literal_utf8_bytes: 8192, input_literal_utf8_bytes: 32000000,
  membership_work: 2000000, output_utf8_bytes: 12000000,
});
export const CUSTOM_COHORT_RECORDED_HOUSING_LIMITATIONS = Object.freeze([
  'recorded_categories_not_verified_property_classifications', 'current_observations_not_historical_housing_population',
  'numeric_cad_class_and_structure_codes_not_interpreted', 'mobile_and_manufactured_homes_not_equated',
  'all_accounts_and_all_retained_parcel_observations_required', 'no_majority_or_first_parcel_resolution',
  'subject_profile_provenance_and_confidence_not_verification', 'no_cross_source_subject_housing_merge',
  'no_completion_unit_interest_or_market_eligibility_inferred', 'no_source_rights_or_report_apply_authority',
]);
// Source-specific legacy categories, not numeric GIS CLASSCD or building-quality
// STRCLASS codes. Official cross-reference effective tax year2022 (07/22):
// https://www.dallascad.org/ViewPDFs.aspx?id=%5C%5CDCAD.ORG%5CWEB%5CWEBDATA%5CWEBFORMS%5COther%5CPTAD_PROP_CLASS.pdf&type=1
// A11's detached meaning is explicit in the official 2025 SFR summary (07/22/2025):
// https://www.dallascad.org/ViewPDFs.aspx?id=%5C%5CDCAD.ORG%5CWEB%5CWEBDATA%5CWEBFORMS%5CAVG+HOUSE+VAL%5C2025AvgValSFR.pdf&type=1
export const LEGACY = { A11: 'detached_single_family', A12: 'townhouse', A13: 'condominium',
  A20: 'mobile_home', B11: 'apartment', B12: 'duplex' };
export const CAD_DESCRIPTIONS = { 'SINGLE FAMILY RESIDENCES': 'detached_single_family', 'SFR - TOWNHOUSES': 'townhouse',
  'SFR - CONDOMINIUMS': 'condominium', 'MOBILE HOME ON OWNERS LAND': 'mobile_home',
  'MFR - APARTMENTS': 'apartment', 'MFR - DUPLEXES': 'duplex' };
export const LABELS = {
  'SINGLE FAMILY DETACHED': 'detached_single_family', 'SINGLE DETACHED': 'detached_single_family',
  'DETACHED SINGLE FAMILY': 'detached_single_family', 'DETACHED SINGLE FAMILY RESIDENCE': 'detached_single_family',
  TOWNHOUSE: 'townhouse', TOWNHOME: 'townhouse', CONDOMINIUM: 'condominium', 'CONDOMINIUM UNIT': 'condominium',
  CONDO: 'condominium', DUPLEX: 'duplex', APARTMENT: 'apartment', APARTMENTS: 'apartment',
  'MOBILE HOME': 'mobile_home', 'MANUFACTURED HOME': 'manufactured_home',
};
export const ALTERNATIVES = ['MIXED', 'MIXED/REVIEW', 'MIXED USE', 'MIXED USE DEVELOPMENT', 'CONDO/TOWNHOME',
  'CONDO / TOWNHOME', 'CONDOMINIUM/TOWNHOUSE', 'ATTACHED/DUPLEX', 'ATTACHED / DUPLEX',
  'ATTACHED OR 1/2 DUPLEX', '1/2 DUPLEX', 'HALF DUPLEX', 'SINGLE DETACHED, ATTACHED', 'SINGLE DETACHED/ATTACHED'];
export const UNKNOWN = ['UNKNOWN', 'OTHER', 'UNASSIGNED', 'N/A', 'NOT KNOWN'];
const DEFINITION = freeze({
  id: 'custom-recorded-housing-v1', revision: 1, mapping_version: 4,
  basis: CUSTOM_COHORT_RECORDED_HOUSING_BASIS, authority: 'not_established',
  normalization: 'whole_value_trim_and_case_only_no_substring_or_numeric_code_inference',
  cad_county: 'DALLAS', legacy_codes: LEGACY, cad_descriptions: CAD_DESCRIPTIONS, explicit_labels: LABELS,
  alternatives: ALTERNATIVES, unknown_markers: UNKNOWN,
  subject_detached_pair: { labels: ['SINGLE FAMILY', 'SINGLE FAMILY RESIDENCE'], attachment: 'DETACHED' },
  subject_precedence: 'saved_then_retained_public_then_subject_CAD;only_absent_observations_fall_back;no_cross_source_merge',
  subject_primary_label: 'housing_type_then_structural_style_if_absent;explicit_null_blank_unknown_blocks_fallback',
  supplementary_fields: 'unknown_codes_and_descriptions_do_not_override_exact_known_labels;recognized_conflicts_and_explicit_alternatives_block',
  parcel_aggregation: 'every_retained_parcel;known_plus_unresolved_partial;conflicts_never_choose_majority',
  categories: CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES, states: CUSTOM_COHORT_RECORDED_HOUSING_STATES,
  limitations: CUSTOM_COHORT_RECORDED_HOUSING_LIMITATIONS,
});

// Legacy definitions remain byte-identical. The county alias is a new
// interpretation, selected only by a verified original capture marker.
const COMBINED_DEFINITION = freeze({ ...DEFINITION,
  id: 'custom-recorded-housing-v2', revision: 2, mapping_version: 5 });
const COUNTY_DEFINITION = freeze({ ...DEFINITION,
  id: 'custom-recorded-housing-v3', revision: 3,
  cad_county_aliases: ['DALLAS', 'DALLAS COUNTY'] });
const COMBINED_COUNTY_DEFINITION = freeze({ ...COUNTY_DEFINITION,
  id: 'custom-recorded-housing-v4', revision: 4, mapping_version: 5 });
function bundle(definition, housingVersion) {
  const canonical = canonicalAssessmentJson(definition), ref = prepareNeighborhoodCohortBlob(canonical);
  return freeze({ housing_version: housingVersion,
    profile_ref: { id: definition.id, revision: definition.revision, content_sha256: ref.content_sha256 },
    definition_blob: { ref, canonical_json: canonical } });
}
const INTERPRETATIONS = freeze({
  '4:1': bundle(DEFINITION, 1), '5:1': bundle(COMBINED_DEFINITION, 1),
  '4:2': bundle(COUNTY_DEFINITION, 2), '5:2': bundle(COMBINED_COUNTY_DEFINITION, 2),
});
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_recorded_housing_${reason}`), {
    code: 'CUSTOM_COHORT_RECORDED_HOUSING_INVALID', reason,
  });
}
/** Version1 remains the default and exact original interpretation. Version2
 * must be selected from the owner-verified retained housing marker, not a
 * mapping-number upgrade or current server default during replay. */
export function getCustomCohortRecordedHousingInterpretation(mappingVersion, housingVersion = 1) {
  check(mappingVersion === 4 || mappingVersion === 5, 'mapping_profile');
  check(housingVersion === 1 || housingVersion === 2, 'housing_version');
  return INTERPRETATIONS[`${mappingVersion}:${housingVersion}`];
}
export function getCustomCohortRecordedHousingProfile(mappingVersion, housingVersion = 1) {
  return getCustomCohortRecordedHousingInterpretation(mappingVersion, housingVersion).profile_ref;
}
export const CUSTOM_COHORT_RECORDED_HOUSING_PROFILE = getCustomCohortRecordedHousingProfile(4);
export const CUSTOM_COHORT_COMBINED_RECORDED_HOUSING_PROFILE = getCustomCohortRecordedHousingProfile(5);
export const CUSTOM_COHORT_COUNTY_RECORDED_HOUSING_PROFILE = getCustomCohortRecordedHousingProfile(4, 2);
export const CUSTOM_COHORT_COMBINED_COUNTY_RECORDED_HOUSING_PROFILE = getCustomCohortRecordedHousingProfile(5, 2);

