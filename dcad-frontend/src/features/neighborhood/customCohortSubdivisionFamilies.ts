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

export interface CustomCohortSubdivisionPhase {
  /** An original retained leaf ID, never a replacement persisted selection ID. */
  readonly id: string;
  readonly label: string;
  readonly county: string;
  readonly pocket_ids: readonly string[];
  readonly member_count: number;
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

type ParsedName = { base: string; key: string; suffix: number; section: number | null;
  basis: Exclude<CustomCohortSubdivisionFamily['basis'], 'standalone'> };
type Candidate = { pocket: Pick<CheckedRecordedPocket, 'id' | 'label' | 'county' | 'member_count'>;
  countyKey: string | null; parsed: ParsedName | null };

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
  // One explicit nested section is allowed only after an otherwise recognized
  // phase. SECTION alone, repeated nesting and unspaced suffixes stay unknown.
  const section = /^(.*\S) (?:SECTION|SEC) ([0-9]+)$/iu.exec(value);
  if (section && !positiveSuffix.test(section[2])) return null;
  const phase = section ? section[1] : value;
  const explicit = /^(.*\S) (?:PHASE|PH) ([0-9]+)$/iu.exec(phase);
  const numbered = explicit ?? /^(.*\S) ([0-9]+)$/u.exec(phase);
  if (!numbered || !positiveSuffix.test(numbered[2])) return null;
  const base = numbered[1], key = normalized(base);
  // Do not peel a second suffix, treat a numbered road as a phase, or turn an
  // unsupported SECTION/UNIT syntax into an apparently simple numbered family.
  if (!/\p{L}/u.test(base) || UNKNOWN.has(key) || unsupportedMarker.test(base)
    || /(?:^|\s)[0-9]+$/u.test(base) || /\bI[ -][0-9]+\b/iu.test(base)) return null;
  return { base, key, suffix: Number(numbered[2]), section: section ? Number(section[2]) : null,
    basis: explicit ? 'explicit_phase_name' : 'candidate_numbered_name' };
}

function equivalentCountyNameLeaves(members: readonly Candidate[]): boolean {
  if (members.length === 1) return true;
  const first = members[0];
  // A repeated suffix is explained only by the known County-suffix alias, not
  // by equivalent-looking PH/PHASE or SEC/SECTION grammar. Duplicate leaves
  // under the same normalized county spelling are not an alias explanation.
  return !!first.countyKey?.startsWith('known:')
    && members.every(item => item.countyKey === first.countyKey
      && normalized(item.pocket.label) === normalized(first.pocket.label))
    && new Set(members.map(item => normalized(item.pocket.county))).size === members.length;
}

function compatibleFamily(members: readonly Candidate[]): boolean {
  if (members.length < 2 || members.some(item => !item.parsed)) return false;
  const slots = new Map<string, Candidate[]>();
  for (const item of members) {
    // Bare 3 and PH 3 can share a review parent, never an assumed phase ID.
    // Within either grammar, unexplained duplicate slots remain ambiguous.
    const slot = `${item.parsed!.basis}:${item.parsed!.suffix}:${item.parsed!.section ?? ''}`;
    const entries = slots.get(slot) ?? [];
    entries.push(item); slots.set(slot, entries);
  }
  return [...slots.values()].every(equivalentCountyNameLeaves);
}

function familyBasis(members: readonly Candidate[]): ParsedName['basis'] {
  return members.some(item => item.parsed!.basis === 'candidate_numbered_name')
    ? 'candidate_numbered_name' : 'explicit_phase_name';
}

function candidateOrder(a: Candidate, b: Candidate): number {
  return (a.parsed?.suffix ?? 0) - (b.parsed?.suffix ?? 0)
    || (a.parsed?.section ?? 0) - (b.parsed?.section ?? 0)
    || compare(a.parsed?.basis ?? '', b.parsed?.basis ?? '') || compare(a.pocket.id, b.pocket.id);
}

function familyFromCandidates(members: readonly Candidate[], basis: CustomCohortSubdivisionFamily['basis']): CustomCohortSubdivisionFamily {
  const ordered = [...members].sort(basis === 'standalone' ? (a, b) => compare(a.pocket.id, b.pocket.id) : candidateOrder);
  const anchor = [...members].sort((a, b) => compare(a.pocket.id, b.pocket.id))[0];
  const display = [...members].sort((a, b) => compare(a.pocket.label, b.pocket.label) || compare(a.pocket.id, b.pocket.id))[0];
  return Object.freeze({ id: `subdivision-family-v1:${basis}:${anchor.pocket.id}`,
    label: basis === 'standalone' ? display.pocket.label : display.parsed!.base,
    county: [...members].map(item => item.pocket.county).sort(compare)[0], basis,
    pocket_ids: Object.freeze(ordered.map(item => item.pocket.id)),
    member_count: members.reduce((sum, item) => sum + item.pocket.member_count, 0) });
}

/** Transient review-only names over an already checked complete catalog. Local
 * IDs are anchored to an original leaf, not a new digest, source grant or legal
 * subdivision identity. No accounts, labels, saved IDs or selection are changed.
 * Even explicit PHASE names remain recorded-name evidence, not verified plats.
 */
export function buildCustomCohortSubdivisionFamilies(catalog: CheckedPocketCatalog): CustomCohortSubdivisionFamilies {
  ensure(catalog && (catalog.catalog_version === 1 || catalog.catalog_version === 2 || catalog.catalog_version === 3)
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
  ensure(Array.isArray(catalog.pockets) && catalog.pockets.length <= (catalog.catalog_version === 3 ? 2048 : catalog.catalog_version === 2 ? 1024 : 128));
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
    families.push(familyFromCandidates(members, basis));
    for (const item of members) { ensure(!assigned.has(item.pocket.id)); assigned.add(item.pocket.id); }
  }
  for (const members of buckets.values()) {
    // Unexplained repeated slots within either grammar make the candidate
    // family ambiguous. An unqualified base remains
    // its own standalone leaf, never an assumed phase absorbed into the family.
    if (!compatibleFamily(members)) continue;
    add(members, familyBasis(members));
  }
  for (const candidate of candidates) if (!assigned.has(candidate.pocket.id)) add([candidate], 'standalone');
  ensure(assigned.size === catalog.pockets.length);
  families.sort((a, b) => compare(normalized(a.county), normalized(b.county))
    || compare(normalized(a.label), normalized(b.label)) || compare(a.id, b.id));
  return result(families);
}

/** Prepare bounded leaf metadata once for a full map's family projection. The
 * indexes are local to this reader, detached from the input, and never mutated
 * after preparation; there is no account scan or hidden cross-context cache. */
export function createCustomCohortSubdivisionPhaseReader(catalog: CheckedPocketCatalog):
  (family: CustomCohortSubdivisionFamily) => readonly CustomCohortSubdivisionPhase[] {
  ensure(catalog && (catalog.catalog_version === 1 || catalog.catalog_version === 2 || catalog.catalog_version === 3)
    && (catalog.status === 'review_only' || catalog.status === 'incomplete'));
  if (catalog.status === 'incomplete') {
    const empty = Object.freeze([]);
    return () => empty;
  }
  ensure(Array.isArray(catalog.pockets) && catalog.pockets.length <= (catalog.catalog_version === 3 ? 2048 : catalog.catalog_version === 2 ? 1024 : 128));
  const pocketCount = catalog.pockets.length;
  const candidates = new Map<string, Candidate>(), buckets = new Map<string, Candidate[]>();
  for (const pocket of catalog.pockets) {
    const { id, label, county, member_count } = pocket;
    ensure(typeof id === 'string' && id.startsWith('recorded-cad:') && id.length <= 200
      && !candidates.has(id) && typeof label === 'string' && label.length <= 512
      && typeof county === 'string' && county.length <= 512
      && Number.isSafeInteger(member_count) && member_count >= 0 && member_count <= 50_000);
    const candidate = { pocket: { id, label, county, member_count }, countyKey: countyKey(county),
      parsed: member_count ? parsedName(label) : null };
    candidates.set(id, candidate);
    if (candidate.parsed && candidate.countyKey !== null) {
      const key = JSON.stringify([candidate.countyKey, candidate.parsed.key]), members = buckets.get(key) ?? [];
      members.push(candidate); buckets.set(key, members);
    }
  }
  const familyBuckets = new Map([...buckets].filter(([, members]) => compatibleFamily(members)));
  return family => {
    ensure(family && Array.isArray(family.pocket_ids) && family.pocket_ids.length > 0
      && family.pocket_ids.length <= pocketCount);
    const first = candidates.get(family.pocket_ids[0]), familyIds = new Set(family.pocket_ids);
    ensure(first && familyIds.size === family.pocket_ids.length);
    const bucket = first.parsed && first.countyKey !== null
      ? familyBuckets.get(JSON.stringify([first.countyKey, first.parsed.key])) : undefined;
    const grouped = bucket !== undefined, members = bucket ?? [first];
    const expected = familyFromCandidates(members, grouped ? familyBasis(members) : 'standalone');
    ensure(family.id === expected.id && family.label === expected.label && family.county === expected.county
      && family.basis === expected.basis && family.member_count === expected.member_count
      && familyIds.size === expected.pocket_ids.length && expected.pocket_ids.every(id => familyIds.has(id)));
    const phases = new Map<string, Candidate[]>();
    for (const item of members) {
      const key = item.countyKey?.startsWith('known:')
        ? JSON.stringify([item.countyKey, normalized(item.pocket.label)]) : item.pocket.id;
      const entries = phases.get(key) ?? [];
      entries.push(item); phases.set(key, entries);
    }
    return Object.freeze([...phases.values()].sort((a, b) => candidateOrder(a[0], b[0])).map(items => {
      ensure(equivalentCountyNameLeaves(items));
      const ordered = [...items].sort((a, b) => compare(a.pocket.id, b.pocket.id));
      const display = [...items].sort((a, b) => compare(a.pocket.label, b.pocket.label) || compare(a.pocket.id, b.pocket.id))[0];
      return Object.freeze({ id: ordered[0].pocket.id, label: display.pocket.label,
        county: items.map(item => item.pocket.county).sort(compare)[0],
        pocket_ids: Object.freeze(ordered.map(item => item.pocket.id)),
        member_count: items.reduce((sum, item) => sum + item.pocket.member_count, 0) });
    }));
  };
}

/** A metadata-only view of one complete family's phases. Exact recorded names
 * across recognized county aliases share one row, retaining every original ID
 * for explicit union/removal. No source read or selection change is performed.
 * For all-family map projection, prepare one phase reader instead. */
export function buildCustomCohortSubdivisionPhases(catalog: CheckedPocketCatalog,
  family: CustomCohortSubdivisionFamily): readonly CustomCohortSubdivisionPhase[] {
  return createCustomCohortSubdivisionPhaseReader(catalog)(family);
}

/** Click-time lookup only; callers rendering every parcel can index families by
 * their local IDs once. Unknown/unassigned IDs have no derived named family. */
export function customCohortSubdivisionFamilyForPocket(model: CustomCohortSubdivisionFamilies,
  pocketId: string): CustomCohortSubdivisionFamily | null {
  if (!Object.hasOwn(model.family_id_by_pocket_id, pocketId)) return null;
  const id = model.family_id_by_pocket_id[pocketId];
  return model.families.find(family => family.id === id) ?? null;
}
