import { CUSTOM_MATERIAL_INPUT_PROFILE } from './customMaterialInputs.js';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';

const canonicalJson = canonicalAssessmentJson(CUSTOM_MATERIAL_INPUT_PROFILE);
const ref = prepareNeighborhoodCohortBlob(canonicalJson);
const descriptor = Object.freeze({
  profile_ref: Object.freeze({ id: CUSTOM_MATERIAL_INPUT_PROFILE.id,
    revision: CUSTOM_MATERIAL_INPUT_PROFILE.revision, content_sha256: ref.content_sha256 }),
  definition_blob: Object.freeze({ ref, canonical_json: canonicalJson }),
});

/** Exact installed closed representation definition for later context binding.
 * No caller profile, source grant, permission, persistence or current-head write.
 */
export function getCustomNeighborhoodMaterialProfile() { return descriptor; }
