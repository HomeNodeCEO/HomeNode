export interface CheckedPreparedSecondaryMap {
  readonly version: 1;
  readonly basis: 'prepared_current_cad_snapshot_diagnostic_only';
  readonly source_observed_at: string;
  readonly retained_capture_at: string;
  readonly groups: readonly { readonly id: string; readonly member_count: number;
    readonly supported_member_count: number; readonly lower: number | null; readonly upper: number | null }[];
}

const ensure: (ok: unknown) => asserts ok = ok => { if (!ok) throw new TypeError('Invalid prepared neighborhood map score'); };
const keys = (value: unknown, expected: readonly string[]): Record<string, unknown> => {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)));
  return value as Record<string, unknown>;
};
const date = (value: unknown): string => {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value); return value;
};
const score = (value: unknown): number => { ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100); return value; };
const count = (value: unknown): number => { ensure(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 50_000); return Number(value); };

/** A bounded display-only supplement. Never promote these current CAD facts to
 * report evidence, historical stock, a recommended selection or a reliability
 * statistic. Exact group IDs and denominators must match the checked catalog.
 */
export function checkCustomCohortPreparedSecondaryMap(value: unknown,
  groups: readonly { readonly id: string; readonly member_count: number }[]): CheckedPreparedSecondaryMap {
  const raw = keys(value, ['version', 'basis', 'authority', 'generation_id', 'source_observed_at', 'retained_capture_at', 'groups']);
  ensure(raw.version === 1 && raw.basis === 'prepared_current_cad_snapshot_diagnostic_only'
    && raw.authority === 'not_established' && typeof raw.generation_id === 'string'
    && /^[a-f0-9-]{36}$/i.test(raw.generation_id));
  const observed = date(raw.source_observed_at), captured = date(raw.retained_capture_at);
  ensure(observed <= captured && Array.isArray(raw.groups) && raw.groups.length === groups.length && raw.groups.length <= 2049);
  const expected = new Map(groups.map(group => [group.id, group.member_count])), seen = new Set<string>();
  const checked = raw.groups.map(value => {
    const row = keys(value, ['id', 'member_count', 'supported_member_count', 'lower', 'upper']);
    ensure(typeof row.id === 'string' && expected.has(row.id) && !seen.has(row.id)); seen.add(row.id);
    const member_count = count(row.member_count), supported_member_count = count(row.supported_member_count);
    ensure(member_count === expected.get(row.id) && supported_member_count <= member_count);
    const lower = member_count ? score(row.lower) : null, upper = member_count ? score(row.upper) : null;
    ensure(member_count ? lower! <= upper! : row.lower === null && row.upper === null);
    return Object.freeze({ id: row.id as string, member_count, supported_member_count, lower, upper });
  });
  return Object.freeze({ version: 1, basis: 'prepared_current_cad_snapshot_diagnostic_only',
    source_observed_at: observed, retained_capture_at: captured, groups: Object.freeze(checked) });
}
