/** A Tarrant import's namespaced HomeNode key is not the county Property ID.
 * Never recover an APN by stripping its prefix/zero padding. A native ID can
 * come from an explicit county identifier or from a subject-matched CAD PDF. */
export function isInternalTarrantAccount(context, value) {
  const county = context?.canonicalIdentity?.county ?? context?.county;
  return typeof county === 'string' && /^TARRANT(?: COUNTY)?$/i.test(county.trim())
    && typeof value === 'string' && value === context?.accountId && /^TA\d{15}$/.test(value);
}

export function countyParcelIdentity(context) {
  const value = context?.assessorParcelNumber || context?.canonicalIdentity?.assessorParcelNumber || context?.accountId;
  return isInternalTarrantAccount(context, value) ? null : value;
}
