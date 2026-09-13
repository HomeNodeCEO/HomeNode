import type { CheckedPocketCatalog, CheckedRecordedPocket } from './customCohortPocketCatalog';

export interface CustomCohortSubdivisionFamily {
  readonly id: string;
  readonly label: string;
  readonly county: string;
  readonly basis: 'explicit_phase_name' | 'candidate_numbered_name' | 'standalone';
  readonly pocket_ids: readonly string[];
  readonly member_count: number;
}

export interface CustomCohortSubdivisionFamilies {
  readonly profile_version: 1;
  readonly context_ref: CheckedPocketCatalog['binding']['context_ref'];
  readonly families: readonly CustomCohortSubdivisionFamily[];
  readonly family_id_by_pocket_id: Readonly<Record<string, string>>;
}

const KNOWN_COUNTIES = new Set(['collin', 'dallas', 'denton', 'ellis', 'johnson',
  'kaufman', 'parker', 'rockwall', 'tarrant', 'wise']);
const UNKNOWN = new Set(['unknown', 'unassigned', 'n/a', 'none', 'not available']);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const normalized = (value: string) => value.trim().replace(/\s+/gu, ' ').toLowerCase();
const ensure: (condition: unknown) => asserts condition = condition => {
  if (!condition) throw new TypeError('Invalid recorded subdivision family input');
};
const positiveSuffix = /^[1-9][0-9]{0,2}$/; // Explicitly bounded 1..999; no zero padding or guessed roman numerals.
const roadName = /\b(?:route|rte|highway|hwy|interstate|freeway|fwy|turnpike|expressway|expy|u\.?s\.?|ih|fm|rm|sh|sr|cr|street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|court|ct|circle|cir|trail|trl|parkway|pkwy)\b/iu;
const unsupportedMarker = /\b(?:phase|ph|section|sec|unit|addition|addn|replat)\b/iu;

type ParsedName = { base: string; key: string; suffix: number;
  basis: Exclude<CustomCohortSubdivisionFamily['basis'], 'standalone'> };
type Candidate = { pocket: CheckedRecordedPocket; countyKey: string | null; parsed: ParsedName | null };

function countyKey(value: string): string | null {
  const key = normalized(value);
  if (!key || UNKNOWN.has(key)) return null;
  const known = key.replace(/ county$/, '');
  if (UNKNOWN.has(known)) return null;
  // Only the same enumerated DFW County-suffix equivalence already offered by
  // the checked catalog's review helper. Other county strings stay exact.
  return KNOWN_COUNTIES.has(known) ? `known:${known}` : `exact:${value}`;
}

function parsedName(label: string): ParsedName | null {
  const value = label.trim().replace(/\s+/gu, ' ');
  if (!value || UNKNOWN.has(normalized(value)) || roadName.test(value)) return null;
  const explicit = /^(.*\S) (?:PHASE|PH) ([0-9]+)$/iu.exec(value);
  const numbered = explicit ?? /^(.*\S) ([0-9]+)$/u.exec(value);
  if (!numbered || !positiveSuffix.test(numbered[2])) return null;
  const base = numbered[1], key = normalized(base);
  // Do not peel a second suffix, treat a numbered road as a phase, or turn an
  // unsupported SECTION/UNIT syntax into an apparently simple numbered family.
  if (!/\p{L}/u.test(base) || UNKNOWN.has(key) || unsupportedMarker.test(base)
    || /(?:^|\s)[0-9]+$/u.test(base) || /\bI[ -][0-9]+\b/iu.test(base)) return null;
  return { base, key, suffix: Number(numbered[2]),
    basis: explicit ? 'explicit_phase_name' : 'candidate_numbered_name' };
}

/** Transient review-only names over an already checked complete catalog. Local
 * IDs are anchored to an original leaf, not a new digest, source grant or legal
 * subdivision identity. No accounts, labels, saved IDs or selection are changed.
 * Even explicit PHASE names remain recorded-name evidence, not verified plats.
 */
export function buildCustomCohortSubdivisionFamilies(catalog: CheckedPocketCatalog): CustomCohortSubdivisionFamilies {
  ensure(catalog && (catalog.catalog_version === 1 || catalog.catalog_version === 2)
    && (catalog.status === 'review_only' || catalog.status === 'incomplete'));
  const ref = catalog.binding.context_ref;
  const context_ref = Object.freeze({ context_id: ref.context_id, context_revision: ref.context_revision, context_sha256: ref.context_sha256 });
  const result = (families: readonly CustomCohortSubdivisionFamily[]) => Object.freeze({
    profile_version: 1 as const, context_ref, families: Object.freeze(families),
    family_id_by_pocket_id: Object.freeze(Object.fromEntries(families.flatMap(family =>
      family.pocket_ids.map(id => [id, family.id])))),
  });
  // The old full unresolved catalog remains the fallback. Never derive a family
  // from a prefix or reinterpret unresolved accounts as a named subdivision.
  if (catalog.status === 'incomplete') return result([]);
  ensure(Array.isArray(catalog.pockets) && catalog.pockets.length <= (catalog.catalog_version === 2 ? 1024 : 128));
  const ids = new Set<string>(), accounts = new Set<string>();
  const candidates: Candidate[] = catalog.pockets.map(pocket => {
    ensure(typeof pocket.id === 'string' && pocket.id.startsWith('recorded-cad:') && pocket.id.length <= 200 && !ids.has(pocket.id));
    ids.add(pocket.id);
    for (const value of [pocket.label, pocket.county]) ensure(typeof value === 'string' && value.length <= 512);
    ensure(Number.isSafeInteger(pocket.member_count) && pocket.member_count >= 0 && pocket.member_count <= 50_000
      && Array.isArray(pocket.account_ids) && pocket.account_ids.length === pocket.member_count);
    for (const id of pocket.account_ids) {
      ensure(typeof id === 'string' && id.length > 0 && id.length <= 100 && !accounts.has(id) && accounts.size < 50_000);
      accounts.add(id);
    }
    return { pocket, countyKey: countyKey(pocket.county), parsed: pocket.member_count ? parsedName(pocket.label) : null };
  });
  ensure(accounts.size === catalog.coverage.assigned_account_count
    && Number.isSafeInteger(catalog.unassigned.member_count) && catalog.unassigned.member_count >= 0
    && accounts.size + catalog.unassigned.member_count === catalog.coverage.discovery_member_count
    && catalog.coverage.discovery_member_count <= 50_000);
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.countyKey === null) continue;
    if (candidate.parsed) {
      const key = JSON.stringify([candidate.countyKey, candidate.parsed.key]);
      const members = buckets.get(key) ?? [];
      members.push(candidate); buckets.set(key, members);
    }
  }
  const families: CustomCohortSubdivisionFamily[] = [], assigned = new Set<string>();
  function add(members: readonly Candidate[], basis: CustomCohortSubdivisionFamily['basis']) {
    const ordered = [...members].sort((a, b) => basis === 'standalone' ? compare(a.pocket.id, b.pocket.id)
      : a.parsed!.suffix - b.parsed!.suffix || compare(a.pocket.id, b.pocket.id));
    const anchor = [...members].sort((a, b) => compare(a.pocket.id, b.pocket.id))[0];
    const display = [...members].sort((a, b) => compare(a.pocket.label, b.pocket.label) || compare(a.pocket.id, b.pocket.id))[0];
    const family = Object.freeze({ id: `subdivision-family-v1:${basis}:${anchor.pocket.id}`,
      label: basis === 'standalone' ? display.pocket.label : display.parsed!.base,
      county: [...members].map(item => item.pocket.county).sort(compare)[0], basis,
      pocket_ids: Object.freeze(ordered.map(item => item.pocket.id)),
      member_count: members.reduce((sum, item) => sum + item.pocket.member_count, 0) });
    families.push(family);
    for (const item of members) { ensure(!assigned.has(item.pocket.id)); assigned.add(item.pocket.id); }
  }
  for (const members of buckets.values()) {
    const bases = new Set(members.map(item => item.parsed!.basis)), suffixes = new Set(members.map(item => item.parsed!.suffix));
    // Mixed explicit/bare forms and repeated suffixes make the whole candidate
    // family ambiguous. An unqualified base remains its own standalone leaf;
    // it is never assumed to be another phase or absorbed into this family.
    if (members.length < 2 || bases.size !== 1 || suffixes.size !== members.length) continue;
    add(members, members[0].parsed!.basis);
  }
  for (const candidate of candidates) if (!assigned.has(candidate.pocket.id)) add([candidate], 'standalone');
  ensure(assigned.size === catalog.pockets.length);
  families.sort((a, b) => compare(normalized(a.county), normalized(b.county))
    || compare(normalized(a.label), normalized(b.label)) || compare(a.id, b.id));
  return result(families);
}

/** Click-time lookup only; callers rendering every parcel can index families by
 * their local IDs once. Unknown/unassigned IDs have no derived named family. */
export function customCohortSubdivisionFamilyForPocket(model: CustomCohortSubdivisionFamilies,
  pocketId: string): CustomCohortSubdivisionFamily | null {
  if (!Object.hasOwn(model.family_id_by_pocket_id, pocketId)) return null;
  const id = model.family_id_by_pocket_id[pocketId];
  return model.families.find(family => family.id === id) ?? null;
}
