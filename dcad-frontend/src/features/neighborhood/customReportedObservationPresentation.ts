/** Display admission only, not source verification, hash verification or an Apply
 * grant. The authenticated server must reopen the complete accepted group. */
type Data = Record<string, unknown>;
type Period = { start_date: string; end_date: string; date_basis: 'capture_date' | 'closing_date' };
export type ReportedPopulation = {
  id: string; kind: 'account_observations' | 'source_record_observations'; member_unit: 'account' | 'source_record';
  definition: string; member_count: number | null; unique_account_count: number | null; account_link_count: number | null;
  completeness: string; reasons: string[]; observation_period: Period; captured_at: string | null;
  source_refs: string[]; pocket_ids: string[];
};
export type ReportedStatistic = {
  id: string; population_id: string; measurement: string; unit: string | null; estimator: string;
  estimator_parameters: { probability?: number }; value: string | number | null; status: string; reason: string | null;
  observed_count: number; missing_count: number; invalid_count: number; conflicting_count: number; unsupported_count: number;
  denominator_count: number; observation_period: Period; source_refs: string[];
};
export type ReportedAssessment = {
  contract_version: 2; effective_date: string; data_cutoff: string; generated_at: string; observation_period: Period;
  populations: ReportedPopulation[]; statistics: ReportedStatistic[];
  source_snapshots: { id: string; provider: string; revision: string; observed_at: string; content_sha256: string }[];
  selection: { revision: string; pocket_ids: string[] };
  geographic_neighborhood: { status: string; reasons: string[]; cardinal_summaries: Record<string, string | null> };
  diagnostics: { limitations: string[] };
};
export const REPORTED_OBSERVATION_MAPPER = 'custom-reported-observations-report-v2';
const account = 'account_observations', source = 'source_record_observations';
export const reportedObservationMeasurements: Record<string, { label: string; kind: string; units: (string | null)[]; count?: boolean }> = {
  account_count: { label: 'CAD account count', kind: account, units: ['accounts'], count: true },
  source_record_count: { label: 'Source-record count', kind: source, units: ['source_records'], count: true },
  current_cad_living_area: { label: 'Current CAD living area', kind: account, units: ['ft2'] },
  current_cad_parcel_area: { label: 'Current CAD parcel area', kind: account, units: ['ft2'] },
  current_cad_year_built: { label: 'Current CAD year built', kind: account, units: ['year'] },
  current_cad_calendar_age: { label: 'Current CAD calendar age', kind: account, units: ['years'] },
  reported_close_price: { label: 'Reported ClosePrice', kind: source, units: ['USD', null] },
  reported_current_price: { label: 'Reported CurrentPrice (not ClosePrice)', kind: source, units: ['USD', null] },
  reported_living_area: { label: 'Reported living area', kind: source, units: ['sqft', 'sqm', null] },
  reported_site_area: { label: 'Reported site area', kind: source, units: ['sqft', 'sqm', 'acre', null] },
  reported_year_built: { label: 'Reported year built', kind: source, units: ['year'] },
  reported_days_on_market: { label: 'Reported days on market', kind: source, units: ['days'] },
};
const check: (condition: unknown) => asserts condition = condition => { if (!condition) throw new TypeError('reported_observation_display_unavailable'); };
const obj = (value: unknown): Data => { check(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Data; };
const closed = (value: unknown, keys: string): Data => { const data = obj(value), expected = keys ? keys.split(' ') : []; check(Object.keys(data).length === expected.length && expected.every(key => Object.hasOwn(data, key))); return data; };
const str = (value: unknown): string => { check(typeof value === 'string' && value.trim().length > 0); return value; };
const list = (value: unknown, max: number): unknown[] => { check(Array.isArray(value) && value.length <= max); return value; };
const strings = (value: unknown, max = 5000): string[] => { const values = list(value, max).map(str); check(new Set(values).size === values.length); return values; };
const integer = (value: unknown, max = 100000): number => { check(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max); return value as number; };
const hash = (value: unknown) => { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); };
const uuid = (value: unknown) => { check(typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-)[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)); };
const date = (value: unknown): string => { const text = str(value); check(/^\d{4}-\d\d-\d\d$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text); return text; };
const instant = (value: unknown): string => { const text = str(value); check(/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(text)); date(text.slice(0, 10)); return text; };
const instantKey = (value: string) => `${value.slice(0, 19)}.${(value.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0')}Z`;
const period = (value: unknown): Period => { const p = closed(value, 'start_date end_date date_basis'); check(date(p.start_date) <= date(p.end_date) && ['capture_date', 'closing_date'].includes(str(p.date_basis))); return p as Period; };
const samePeriod = (a: Period, b: Period) => a.start_date === b.start_date && a.end_date === b.end_date && a.date_basis === b.date_basis;
const isDecimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value)
  && value.replace('.', '').length <= 31 && (value.split('.')[1]?.length ?? 0) <= 13;

/** Exact bounded decimal-string rounding; never converts recorded money to a
 * floating-point number. The original value remains available as a title. */
export function formatReportedObservationDecimal(value: string, grouping = true): string {
  check(isDecimal(value));
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * 10n ** 13n + BigInt(fraction.padEnd(13, '0'));
  const cents = (scaled + 50_000_000_000n) / 100_000_000_000n;
  const digits = (cents / 100n).toString(), tail = (cents % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${grouping ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : digits}${tail ? `.${tail}` : ''}`;
}
export function reportedObservationValue(statistic: ReportedStatistic): string {
  if (statistic.status !== 'ready' || statistic.value === null) return `Unavailable - ${statistic.reason ?? statistic.status}`;
  const value = typeof statistic.value === 'number' ? statistic.value.toLocaleString('en-US')
    : formatReportedObservationDecimal(statistic.value, statistic.unit !== 'year');
  return `${statistic.unit === 'USD' ? '$' : ''}${value} ${statistic.unit === 'source_records' ? 'source records' : statistic.unit ?? ''}`.trim();
}

/** Closed, bounded display vocabulary. Hashes are checked for shape, never used
 * as truth/authorization. No geometry computation or statistic recomputation. */
export function checkReportedObservationAssessment(value: unknown): ReportedAssessment {
  let nodes = 0, scalarBytes = 0;
  const encoder = new TextEncoder();
  const charge = (text: string) => { check(text.length <= 1500000); scalarBytes += encoder.encode(JSON.stringify(text)).length; check(scalarBytes <= 1500000); };
  const copy = (input: unknown, depth: number): unknown => {
    check(++nodes <= 100000 && depth <= 40);
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') { check(Number.isFinite(input)); return input; }
    if (typeof input === 'string') { charge(input); check(!input.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)); return input; }
    const data = objOrArray(input), keys = Object.keys(data);
    check(Object.getPrototypeOf(data) === (Array.isArray(data) ? Array.prototype : Object.prototype));
    check(Reflect.ownKeys(data).length === keys.length + (Array.isArray(data) ? 1 : 0));
    if (Array.isArray(data)) check(keys.length === data.length);
    const out: Data | unknown[] = Array.isArray(data) ? [] : {};
    for (const key of keys) { if (!Array.isArray(data)) charge(key); const descriptor = Object.getOwnPropertyDescriptor(data, key); check(descriptor && Object.hasOwn(descriptor, 'value')); Object.defineProperty(out, key, { value: copy(descriptor.value, depth + 1), enumerable: true }); }
    return Object.freeze(out);
  };
  const data = closed(copy(value, 0), 'contract_version id revision scope effective_date data_cutoff generated_at observation_period subject_facts methodology source_snapshots discovery selection geographic_neighborhood populations statistics required_statistic_ids required_population_ids development_evidence diagnostics input_signature_sha256 application_group evidence_digest_sha256');
  check(new TextEncoder().encode(JSON.stringify(data)).length <= 1500000 && data.contract_version === 2);
  uuid(data.id); check(integer(data.revision, Number.MAX_SAFE_INTEGER) > 0);
  const scope = closed(data.scope, 'organization_id appraisal_case_id subject_snapshot_id account_id');
  for (const key of ['organization_id', 'appraisal_case_id', 'subject_snapshot_id']) uuid(scope[key]); check(str(scope.account_id).length <= 100);
  const effective = date(data.effective_date), cutoff = date(data.data_cutoff), generated = instant(data.generated_at), study = period(data.observation_period);
  check(cutoff <= effective && study.end_date <= cutoff && study.date_basis === 'closing_date');
  const method = closed(data.methodology, 'version geometry_version configuration'), profile = closed(method.configuration, 'profile_id profile_revision report_basis');
  check(method.version === 'reported-observations-v2' && method.geometry_version === 'appraiser-defined-observation-boundary-v1'
    && profile.profile_id === 'custom-reported-observations-v2' && profile.profile_revision === 1 && profile.report_basis === 'reported_observations_not_verified_market_facts');
  const subject = closed(data.subject_facts, 'basis authority'), discovery = closed(data.discovery, 'complete basis provider_coverage');
  check(subject.basis === 'retained_subject_reference' && subject.authority === 'not_established'
    && [true, false, null].includes(discovery.complete as boolean | null) && discovery.basis === 'complete_retained_roster' && discovery.provider_coverage === 'not_established');
  const sources = new Map<string, Data>();
  for (const row of list(data.source_snapshots, 1000)) {
    const s = closed(row, 'id revision provider content_sha256 visibility scope valid_from valid_to observed_at historical_availability'), id = str(s.id);
    check(!sources.has(id) && ['public', 'organization', 'assignment'].includes(str(s.visibility)) && s.valid_from === null && s.valid_to === null && s.historical_availability === 'unknown');
    str(s.revision); str(s.provider); hash(s.content_sha256); check(instantKey(instant(s.observed_at)) <= instantKey(generated));
    if (s.visibility === 'public') check(s.scope === null); else { const bound = closed(s.scope, 'organization_id appraisal_case_id subject_snapshot_id account_id'); check(Object.keys(scope).every(key => bound[key] === scope[key])); }
    sources.set(id, s);
  }
  const sourceRefs = (value: unknown) => { const refs = strings(value, 1000); check(refs.every(id => sources.has(id))); return refs; };
  const populations = new Map<string, Data>();
  for (const row of list(data.populations, 100)) {
    const p = closed(row, 'id revision kind member_unit definition observation_period captured_at capture_source_ref temporal_basis membership_basis completeness_basis provider_coverage member_count unique_account_count account_link_count member_set_sha256 members_resource_id pocket_ids completeness reasons source_refs');
    const id = str(p.id), stock = p.kind === account;
    check(!populations.has(id) && [account, source].includes(str(p.kind)) && p.member_unit === (stock ? 'account' : 'source_record')
      && p.temporal_basis === (stock ? 'current_cad_capture_reference' : 'reported_closing_dates_observed_at_capture')
      && (stock ? p.membership_basis === 'retained_cad_accounts' : ['reviewed_source_record_matches', 'retained_source_account_associations'].includes(str(p.membership_basis)))
      && p.completeness_basis === 'complete_retained_roster' && p.provider_coverage === 'not_established');
    str(p.revision); str(p.definition); str(p.members_resource_id); strings(p.pocket_ids); const refs = sourceRefs(p.source_refs), reasons = strings(p.reasons);
    check(['complete', 'incomplete', 'unknown'].includes(str(p.completeness)) && (p.completeness === 'complete' ? reasons.length === 0 : reasons.length > 0));
    const n = p.member_count === null ? null : integer(p.member_count), unique = p.unique_account_count === null ? null : integer(p.unique_account_count, 250000), links = p.account_link_count === null ? null : integer(p.account_link_count, 250000);
    if (n !== null && links !== null) check(stock ? links === n : links >= n && links <= Math.min(n * 1000, 250000));
    if (unique !== null && links !== null) check(unique <= links);
    if (n !== null && unique !== null) check(stock ? unique === n : n === 0 ? unique === 0 : unique > 0);
    if (p.member_set_sha256 !== null) hash(p.member_set_sha256);
    if (p.completeness === 'complete') check(n !== null && unique !== null && links !== null && p.member_set_sha256 !== null && p.captured_at !== null && refs.length > 0);
    const observed = period(p.observation_period); check(observed.end_date <= cutoff && observed.date_basis === (stock ? 'capture_date' : 'closing_date'));
    if (!stock) check(observed.start_date >= study.start_date && observed.end_date <= study.end_date);
    if (p.captured_at !== null) { const captured = instant(p.captured_at); check(refs.includes(str(p.capture_source_ref)) && sources.get(str(p.capture_source_ref))?.observed_at === captured);
      check(stock ? captured.slice(0, 10) <= effective && observed.start_date === captured.slice(0, 10) && observed.end_date === observed.start_date : observed.start_date >= study.start_date && observed.end_date <= study.end_date);
    } else check(!stock && p.capture_source_ref === null);
    populations.set(id, p);
  }
  const statistics = new Set<string>();
  for (const row of list(data.statistics, 1000)) {
    const s = closed(row, 'id population_id measurement unit estimator estimator_parameters value status reason observed_count missing_count invalid_count conflicting_count unsupported_count denominator_count denominator_basis observation_period source_refs');
    const id = str(s.id), p = populations.get(str(s.population_id)), name = str(s.measurement);
    check(p && !statistics.has(id) && Object.hasOwn(reportedObservationMeasurements, name)); const definition = reportedObservationMeasurements[name];
    check(p.kind === definition.kind && definition.units.includes(s.unit as string | null) && s.denominator_basis === 'population_members');
    const total = integer(s.denominator_count); check(p.member_count === null || total === p.member_count);
    check(['observed_count', 'missing_count', 'invalid_count', 'conflicting_count', 'unsupported_count'].reduce((sum, key) => sum + integer(s[key]), 0) === total);
    check(samePeriod(period(s.observation_period), period(p.observation_period)));
    const refs = sourceRefs(s.source_refs); check(refs.every(ref => (p.source_refs as string[]).includes(ref)));
    check((definition.count ? ['count', 'unsupported'] : ['exact_median', 'exact_quantile', 'unsupported']).includes(str(s.estimator)));
    if (s.estimator === 'exact_quantile') { const parameters = closed(s.estimator_parameters, 'convention probability'); check(parameters.convention === 'type_7' && [0, 1].includes(parameters.probability as number)); } else closed(s.estimator_parameters, '');
    check(['ready', 'incomplete', 'unsupported'].includes(str(s.status)));
    if (s.status === 'ready') { check(p.completeness === 'complete' && s.reason === null && s.unit !== null && s.estimator !== 'unsupported' && refs.includes(str(p.capture_source_ref)));
      if (definition.count) check(integer(s.value) === total && s.observed_count === total); else check(isDecimal(s.value) && Number(s.observed_count) > 0);
    } else { check(s.value === null); str(s.reason); }
    if (s.estimator === 'unsupported') check(s.status === 'unsupported'); statistics.add(id);
  }
  check(strings(data.required_population_ids).every(id => populations.has(id)) && strings(data.required_statistic_ids).every(id => statistics.has(id)));
  const selection = closed(data.selection, 'revision pocket_ids overrides'); check(/^[1-9]\d*$/.test(str(selection.revision))); strings(selection.pocket_ids);
  for (const row of list(selection.overrides, 5000)) { const override = closed(row, 'pocket_id included'); str(override.pocket_id); check(typeof override.included === 'boolean'); }
  const geo = closed(data.geographic_neighborhood, 'basis manual_source status reasons revision crs geometry perimeter validation cardinal_summaries');
  check(geo.basis === 'appraiser_defined_observation_boundary' && geo.manual_source === 'appraiser_defined_area_manual_v2' && geo.crs === 'EPSG:4326'); str(geo.status); strings(geo.reasons); str(geo.revision);
  const cardinals = closed(geo.cardinal_summaries, 'north east south west'); for (const text of Object.values(cardinals)) check(text === null || typeof text === 'string');
  const validation = closed(geo.validation, 'valid connected covers_recorded_subject_point engine revision');
  for (const key of ['valid', 'connected', 'covers_recorded_subject_point']) check([true, false, null].includes(validation[key] as boolean | null));
  check(['ready', 'incomplete', 'unsupported'].includes(str(geo.status)));
  for (const key of ['engine', 'revision']) if (validation[key] !== null) str(validation[key]);
  const perimeter = list(geo.perimeter, 5000).map(row => { const edge = closed(row, 'edge_id from_node to_node name source_refs'); str(edge.edge_id); str(edge.from_node); str(edge.to_node); check(edge.from_node !== edge.to_node && sourceRefs(edge.source_refs).length > 0); if (edge.name !== null) str(edge.name); return edge; });
  check(new Set(perimeter.map(edge => edge.edge_id)).size === perimeter.length);
  if (geo.geometry !== null) {
    const geometry = closed(geo.geometry, 'type coordinates'); check(geometry.type === 'Polygon');
    const rings = list(geometry.coordinates, 5000); check(rings.length > 0);
    for (const raw of rings) { const ring = list(raw, 5000); check(ring.length >= 4);
      for (const point of ring) { const coordinates = list(point, 2); check(coordinates.length === 2 && coordinates.every(Number.isFinite) && Math.abs(Number(coordinates[0])) <= 180 && Math.abs(Number(coordinates[1])) <= 90); }
      check(JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1)));
    }
  }
  if (geo.status === 'ready') check(geo.geometry !== null && (geo.reasons as string[]).length === 0 && perimeter.length >= 3
    && ['valid', 'connected', 'covers_recorded_subject_point'].every(key => validation[key] === true)
    && validation.engine !== null && validation.revision !== null && Object.values(cardinals).every(text => typeof text === 'string' && text.trim())
    && perimeter.every((edge, i) => edge.to_node === perimeter[(i + 1) % perimeter.length].from_node));
  else check((geo.reasons as string[]).length > 0);
  const diagnostics = closed(data.diagnostics, 'authority limitations'), development = closed(data.development_evidence, 'status reasons');
  check(diagnostics.authority === 'not_established' && strings(diagnostics.limitations).length > 0 && development.status === 'not_established' && strings(development.reasons).length > 0);
  hash(data.input_signature_sha256); hash(data.evidence_digest_sha256);
  const group = closed(data.application_group, 'id revision application_mode policy geometry_revision geometry_sha256 population_refs required_statistic_ids source_refs effective_date data_cutoff status');
  check(group.id === `${data.id}:${data.revision}:neighborhood` && group.revision === data.revision && group.application_mode === 'atomic' && group.policy === 'all_or_nothing'
    && group.geometry_revision === geo.revision && group.effective_date === effective && group.data_cutoff === cutoff);
  if (group.geometry_sha256 !== null) hash(group.geometry_sha256);
  check(JSON.stringify(group.required_statistic_ids) === JSON.stringify(data.required_statistic_ids)); sourceRefs(group.source_refs);
  const refs = list(group.population_refs, 100); check(refs.length === populations.size);
  const seen = new Set<string>();
  for (const ref of refs) { const row = closed(ref, 'id revision member_set_sha256'), id = str(row.id), p = populations.get(id); check(!seen.has(id) && p && p.revision === row.revision && p.member_set_sha256 === row.member_set_sha256); seen.add(id); }
  check(['ready', 'incomplete'].includes(str(group.status)));
  if (group.status === 'ready') check(discovery.complete === true && geo.status === 'ready'
    && (data.required_population_ids as string[]).every(id => populations.get(id)?.completeness === 'complete')
    && (data.required_statistic_ids as string[]).every(id => (data.statistics as Data[]).find(s => s.id === id)?.status === 'ready'));
  return data as unknown as ReportedAssessment;
}
function objOrArray(value: unknown): Data | unknown[] { check(value !== null && typeof value === 'object'); return value as Data | unknown[]; }
