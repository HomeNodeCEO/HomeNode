import { NEIGHBORHOOD_COHORT_LOCAL_QUERY_EVIDENCE_LIMITS } from './cohortEvidenceContract.js';
import { DENSE_CAD_CACHE_READER_LIMITS } from './denseCadCapturePolicy.js';

// These pure consumers follow an already owner-admitted retained capture; this
// discriminator is not an alternative to retention/hash/rights validation.
// Legacy v2 observation fixtures predate compact metadata. They cannot opt into
// v3/v4 by relabeling individual rows: both need their original installed metadata.
export function customCohortObservationMappingVersion(acquisition) {
  const raw = acquisition?.compact_metadata_json;
  if (raw === undefined) return 2;
  let metadata;
  try {
    if (typeof raw !== 'string'
      || Buffer.byteLength(raw) > NEIGHBORHOOD_COHORT_LOCAL_QUERY_EVIDENCE_LIMITS.metadata_bytes) throw new Error();
    metadata = JSON.parse(raw);
    if (metadata?.reader_version !== 'local-capture-v3' || ![2, 3, 4].includes(metadata.mapping_version)) throw new Error();
  } catch {
    throw new TypeError('custom_cohort_observation_mapping_metadata_invalid');
  }
  return metadata.mapping_version;
}

export function customCohortObservationProjectionMatches(definition, mappingVersion) {
  return definition?.mapping_version === mappingVersion
    || (mappingVersion === 2 && definition?.mapping_version === undefined);
}

// Capacity only, AFTER the owner has validated original retained metadata and
// rights. Old captures keep the 100k consumer ceiling; dense CAD observations
// may traverse the same declared complete record set their reader retained.
export function customCohortObservationRecordLimit(acquisition) {
  if (customCohortObservationMappingVersion(acquisition) !== 4) return 100_000;
  const records = JSON.parse(acquisition.compact_metadata_json).limits?.records;
  return Number.isSafeInteger(records) && records > 100_000 && records <= DENSE_CAD_CACHE_READER_LIMITS.records
    ? records : 100_000;
}
