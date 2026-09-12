import { assessmentEvidenceDigest } from './contract.js';

/** Dense report members reference the FULL immutable preview row already
 * retained under the population source's context binding. Do not duplicate its
 * raw values, parcel IDs and source routing in every publication. The digest
 * binds all of those fields; the exact cells below are the only CAD inputs used
 * by this report profile (calendar age is derived from the retained year).
 * This is not a new source, historical assertion or permission to read it.
 */
export function denseReportedAccountReference(row) {
  const observations = Object.fromEntries(['gla_sqft', 'site_area_sqft', 'year_built'].map(key => {
    const cell = row.observations[key];
    return [key, Object.freeze({ state: cell.state, exact_value: cell.exact_value })];
  }));
  return Object.freeze({ representation_version: 1,
    retained_preview_member_sha256: assessmentEvidenceDigest(row),
    observations: Object.freeze(observations) });
}
