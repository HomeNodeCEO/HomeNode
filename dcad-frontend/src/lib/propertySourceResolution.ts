function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === 'string' && !value.trim());
}

export function isDallasCounty(county: unknown): boolean {
  return String(county ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+COUNTY$/, '') === 'DALLAS';
}

/**
 * Preserve the established Dallas County CAD-first grid behavior exactly.
 * Other counties use licensed MLS/Trestle first and CAD only when that field
 * is absent. A valid zero or false is never treated as missing.
 */
export function resolveComparableCharacteristic<T>({
  county,
  trestle,
  cad,
}: {
  county: unknown;
  trestle: T | null | undefined;
  cad: T | null | undefined;
}): T | null {
  const candidates = isDallasCounty(county) ? [cad, trestle] : [trestle, cad];
  return (candidates.find(hasValue) as T | undefined) ?? null;
}

