import { types } from 'node:util';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';

/** Experimental screening over supplied evidence, never source or report authority. */
export const POCKET_RANKING_POLICY_VERSION = 'physical-stock-v1-experimental';
export const POCKET_RANKING_LIMITS = Object.freeze({
  pockets: 256, properties: 5000, records: 15000, members: 10000, references: 30000,
  input_bytes: 1000000, output_bytes: 1000000, nodes: 50000, depth: 24,
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const SCOPE = ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'];
const REF = ['source_id', 'source_revision', 'record_id', 'record_revision'];
const FIELDS = ['housing_type', 'year_built', 'gla', 'site_area'];
const WEIGHTS = Object.freeze({ year_built: 4, gla: 4, site_area: 2 });
const SUPPORTED_HOUSING = ['single_family_detached', 'single_family_attached', 'condominium_unit', 'manufactured_home'];
const HOUSING = [...SUPPORTED_HOUSING, 'two_to_four_units', 'nonresidential', 'vacant_land', 'other'];
const COMPLETENESS = ['complete', 'incomplete', 'unknown'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const branded = new WeakMap();
const POLICY = Object.freeze({
  version: POCKET_RANKING_POLICY_VERSION, status: 'experimental', feature_weight_units: WEIGHTS,
  weight_denominator: 10, half_similarity_scales: Object.freeze({ year_built: 10, gla_ratio: 1.25, site_area_ratio: 1.5 }),
  compatible_fraction_numerator: 4, compatible_fraction_denominator: 5,
  minimum_known_weight_units_per_compatible_member: 8, recommendation_threshold: 0.75, decision_margin: 1e-12,
  arithmetic: 'javascript-binary64-exp-log-v1', aggregation: 'equal_unique_property_full_declared_members',
  overlap_policy: 'noncombinable_alternatives', source_authentication: 'not_performed',
});
function invalid(code) {
  const error = new TypeError(`invalid_pocket_ranking_input:${code}`);
  branded.set(error, { kind: 'invalid', code }); throw error;
}
function limited(code) {
  const error = new RangeError('pocket_ranking_incomplete');
  branded.set(error, { kind: 'incomplete', code }); throw error;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function incomplete(reason_code) {
  return freeze({ ranking_version: 1, policy_version: POCKET_RANKING_POLICY_VERSION, status: 'incomplete', reason_code,
    source_authority: 'not_established', report_eligibility: 'not_assessed', sales_support: 'not_assessed',
    builder_support: 'not_assessed', population_application: 'not_performed', input_sha256: null,
    ranking_revision: null, subject_resolution: null, property_resolutions: [], pockets: [], overlap_groups: [] });
}

// Copy only plain descriptor values, before invoking the shared canonicalizer.
// Input Proxies are rejected before reflection; no public getter is evaluated.
function safeCopy(value, limits, byteLimit, label) {
  let nodes = 0, bytes = 0;
  const active = new Set();
  const charge = count => { bytes += count; if (bytes > byteLimit) limited(`${label}_bytes_limit`); };
  const string = text => {
    if (text.length > byteLimit) limited(`${label}_bytes_limit`);
    if (!text.isWellFormed()) invalid('unicode');
    charge(Buffer.byteLength(JSON.stringify(text), 'utf8')); return text;
  };
  function visit(item, depth) {
    if (++nodes > limits.nodes) limited(`${label}_nodes_limit`);
    if (depth > limits.depth) limited(`${label}_depth_limit`);
    if (item === null) { charge(4); return null; }
    if (typeof item === 'string') return string(item);
    if (typeof item === 'boolean') { charge(item ? 4 : 5); return item; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)) invalid('number');
      charge(JSON.stringify(item).length); return item;
    }
    if (typeof item !== 'object' || types.isProxy(item)) invalid('plain_data');
    if (active.has(item)) invalid('cycle');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) invalid('prototype');
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) invalid('symbol');
    if (keys.length > limits.nodes + 1) limited(`${label}_nodes_limit`);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || (!descriptor.enumerable && !(array && key === 'length'))) invalid('descriptor');
    }
    active.add(item); charge(2);
    let result;
    if (array) {
      const length = descriptors.length.value;
      if (length > limits.nodes) limited(`${label}_nodes_limit`);
      if (keys.length !== length + 1 || keys.some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) invalid('array_shape');
      result = [];
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(descriptors, String(index))) invalid('array_hole');
        if (index) charge(1); result.push(visit(descriptors[index].value, depth + 1));
      }
    } else {
      result = {};
      for (const [index, key] of keys.sort(compare).entries()) {
        if (index) charge(1); string(key); charge(1);
        Object.defineProperty(result, key, { value: visit(descriptors[key].value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
    }
    active.delete(item); return result;
  }
  return visit(value, 0);
}
function keys(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid('keys');
}
function id(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid('identifier');
  return value;
}
function choice(value, values) { if (!values.includes(value)) invalid('vocabulary'); }
function array(value) { if (!Array.isArray(value)) invalid('array'); return value; }
function bounded(count, ceiling, name) { if (count > ceiling) limited(`${name}_limit`); }
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('date');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid('date');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid('timestamp');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid('timestamp');
  return value;
}
function scope(value) {
  keys(value, SCOPE); id(value.account_id);
  for (const key of SCOPE.slice(0, 3)) if (typeof value[key] !== 'string' || !UUID.test(value[key])) invalid('scope');
}
function sameScope(a, b) { return SCOPE.every(key => a[key] === b[key]); }
function refKey(value) { keys(value, REF); REF.forEach(key => id(value[key])); return JSON.stringify(REF.map(key => value[key])); }
function refs(values) {
  const seen = new Set(); array(values);
  for (const value of values) { const key = refKey(value); if (seen.has(key)) invalid('duplicate_reference'); seen.add(key); }
  return values.sort((a, b) => compare(refKey(a), refKey(b)));
}
function limitsOf(options) {
  const value = safeCopy(options, { nodes: 64, depth: 3 }, 4096, 'options');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'limits')) invalid('options');
  const overrides = Object.hasOwn(value, 'limits') ? value.limits : {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) invalid('limits');
  const limits = { ...POCKET_RANKING_LIMITS };
  for (const [key, ceiling] of Object.entries(limits)) {
    if (!Object.hasOwn(overrides, key)) continue;
    if (!Number.isSafeInteger(overrides[key]) || overrides[key] <= 0 || overrides[key] > ceiling) invalid('limits');
    limits[key] = overrides[key];
  }
  if (Object.keys(overrides).some(key => !Object.hasOwn(limits, key))) invalid('limits');
  return limits;
}

function validate(input, limits) {
  keys(input, ['ranking_version', 'policy_version', 'scope', 'effective_date', 'knowledge_cutoff', 'units', 'subject_property_id', 'capture', 'properties', 'pockets', 'records']);
  if (input.ranking_version !== 1 || input.policy_version !== POCKET_RANKING_POLICY_VERSION) invalid('version');
  scope(input.scope); day(input.effective_date); timestamp(input.knowledge_cutoff); id(input.subject_property_id);
  keys(input.units, ['year_built', 'gla', 'site_area']);
  if (input.units.year_built !== 'year' || input.units.gla !== 'ft2' || input.units.site_area !== 'ft2') invalid('units');
  keys(input.capture, ['id', 'revision', 'scope', 'effective_date', 'knowledge_cutoff', 'completeness']);
  id(input.capture.id); id(input.capture.revision); scope(input.capture.scope);
  if (!sameScope(input.scope, input.capture.scope) || input.capture.effective_date !== input.effective_date || input.capture.knowledge_cutoff !== input.knowledge_cutoff) invalid('capture_binding');
  choice(input.capture.completeness, COMPLETENESS);
  for (const name of ['properties', 'pockets', 'records']) bounded(array(input[name]).length, limits[name], name);
  const properties = new Map(), pockets = new Map(), records = new Map(), used = new Set();
  let members = 0, references = 0;
  for (const property of input.properties) {
    keys(property, ['id', 'physical_record_refs']); id(property.id);
    if (properties.has(property.id)) invalid('duplicate_property');
    refs(property.physical_record_refs); references += property.physical_record_refs.length;
    properties.set(property.id, property);
  }
  if (!properties.has(input.subject_property_id)) invalid('subject_reference');
  for (const pocket of input.pockets) {
    keys(pocket, ['id', 'revision', 'membership_completeness', 'members']); id(pocket.id); id(pocket.revision);
    if (pockets.has(pocket.id)) invalid('duplicate_pocket');
    choice(pocket.membership_completeness, COMPLETENESS); array(pocket.members);
    const seen = new Set();
    for (const member of pocket.members) {
      keys(member, ['property_id', 'membership_record_refs']); id(member.property_id);
      if (!properties.has(member.property_id)) invalid('property_reference');
      if (seen.has(member.property_id)) invalid('duplicate_member'); seen.add(member.property_id);
      refs(member.membership_record_refs); references += member.membership_record_refs.length; members++;
    }
    pockets.set(pocket.id, pocket);
  }
  bounded(members, limits.members, 'members'); bounded(references, limits.references, 'references');
  for (const record of input.records) {
    const common = ['kind', 'ref', 'scope', 'retrieved_at', 'recorded_at', 'validity', 'property_id'];
    if (record?.kind === 'physical_facts') keys(record, [...common, 'facts']);
    else if (record?.kind === 'pocket_membership') keys(record, [...common, 'pocket_id', 'pocket_revision', 'included']);
    else invalid('record_kind');
    const key = refKey(record.ref); if (records.has(key)) invalid('duplicate_record');
    scope(record.scope); if (!sameScope(input.scope, record.scope)) invalid('record_scope');
    timestamp(record.retrieved_at); timestamp(record.recorded_at);
    if (record.retrieved_at > record.recorded_at) invalid('record_chronology');
    id(record.property_id); if (!properties.has(record.property_id)) invalid('record_property');
    keys(record.validity, ['status', 'from', 'to', 'historical_availability']);
    choice(record.validity.status, ['supported', 'unknown']);
    choice(record.validity.historical_availability, ['known_at_effective_date', 'reconstructed', 'unknown']);
    if (record.validity.status === 'unknown') {
      if (record.validity.from !== null || record.validity.to !== null || record.validity.historical_availability !== 'unknown') invalid('unknown_validity');
    } else {
      day(record.validity.from); if (record.validity.to !== null) day(record.validity.to);
      if (record.validity.to !== null && record.validity.from > record.validity.to) invalid('validity_order');
    }
    if (record.kind === 'physical_facts') {
      keys(record.facts, FIELDS);
      if (record.facts.housing_type !== null) choice(record.facts.housing_type, HOUSING);
      const year = record.facts.year_built;
      if (year !== null && (!Number.isSafeInteger(year) || year < 1600 || year > 9999)) invalid('year_built');
      for (const [field, maximum] of [['gla', 1000000], ['site_area', 1000000000]]) {
        const value = record.facts[field];
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum)) invalid('physical_measurement');
      }
    } else {
      id(record.pocket_id); id(record.pocket_revision); if (![true, false, null].includes(record.included)) invalid('membership_value');
    }
    records.set(key, record);
  }
  const resolve = (reference, kind, propertyId, pocket = null) => {
    const key = refKey(reference), record = records.get(key); if (!record) invalid('record_reference');
    if (record.kind !== kind || record.property_id !== propertyId || (pocket &&
        (record.pocket_id !== pocket.id || record.pocket_revision !== pocket.revision))) invalid('record_target');
    used.add(key); return record;
  };
  for (const property of properties.values()) for (const reference of property.physical_record_refs) resolve(reference, 'physical_facts', property.id);
  const memberProperties = new Set([input.subject_property_id]);
  for (const pocket of pockets.values()) for (const member of pocket.members) {
    memberProperties.add(member.property_id);
    for (const reference of member.membership_record_refs) resolve(reference, 'pocket_membership', member.property_id, pocket);
  }
  if (used.size !== records.size) invalid('unreferenced_record');
  if (memberProperties.size !== properties.size) invalid('unreferenced_property');
  input.properties.sort((a, b) => compare(a.id, b.id)); input.pockets.sort((a, b) => compare(a.id, b.id));
  input.records.sort((a, b) => compare(refKey(a.ref), refKey(b.ref)));
  for (const pocket of input.pockets) pocket.members.sort((a, b) => compare(a.property_id, b.property_id));
  return records;
}

function applicable(record, input) {
  return record.retrieved_at <= input.knowledge_cutoff && record.recorded_at <= input.knowledge_cutoff &&
    record.validity.status === 'supported' && record.validity.historical_availability !== 'unknown' &&
    record.validity.from <= input.effective_date && (record.validity.to === null || record.validity.to >= input.effective_date);
}
function resolveProperty(property, records, input) {
  const all = property.physical_record_refs.map(reference => records.get(refKey(reference)));
  const available = all.filter(record => applicable(record, input));
  const facts = {};
  for (const field of FIELDS) {
    const present = available.filter(record => record.facts[field] !== null);
    const future = field === 'year_built' ? present.filter(record => record.facts[field] > Number(input.effective_date.slice(0, 4))) : [];
    const usable = present.filter(record => field !== 'year_built' || record.facts[field] <= Number(input.effective_date.slice(0, 4)));
    const values = [...new Set(usable.map(record => record.facts[field]))];
    const conflicted = values.length > 1;
    const status = conflicted ? 'conflicted' : values.length ? 'supported' : future.length || (all.length && !available.length) ? 'unsupported' : 'missing';
    const reasons = [];
    if (conflicted) reasons.push('conflicting_physical_fact');
    if (future.length) reasons.push('year_built_after_effective_date');
    if (!available.length && all.length) reasons.push('no_applicable_physical_record');
    if (status === 'missing') reasons.push('physical_fact_missing');
    facts[field] = { status, value: status === 'supported' ? values[0] : null,
      record_refs: (usable.length ? usable : future.length ? future : available).map(record => record.ref), reason_codes: reasons.sort(compare) };
  }
  return { property_id: property.id, facts, ignored_record_refs: all.filter(record => !applicable(record, input)).map(record => record.ref) };
}
function unit(value) {
  if (!Number.isFinite(value) || value < -1e-12 || value > 1 + 1e-12) limited('numeric_result_invalid');
  return Math.max(0, Math.min(1, value));
}
function propertyScore(subject, property, supportedSubject) {
  const empty = { housing_compatibility: 'unknown', feature_scores: { year_built: null, gla: null, site_area: null },
    known_weight_units: 0, observed_score: null, lower_bound: 0, upper_bound: 1, reason_codes: [] };
  if (!supportedSubject) return { ...empty, reason_codes: ['subject_evidence_incomplete'] };
  if (property.facts.housing_type.status !== 'supported') return { ...empty, reason_codes: ['housing_compatibility_unknown'] };
  if (property.facts.housing_type.value !== subject.facts.housing_type.value) {
    return { ...empty, housing_compatibility: 'incompatible', upper_bound: 0, reason_codes: ['housing_incompatible'] };
  }
  const scores = {}, reasons = []; let known = 0, weighted = 0;
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const a = subject.facts[field], b = property.facts[field];
    if (a.status !== 'supported' || b.status !== 'supported') { scores[field] = null; reasons.push(`${field}_similarity_unknown`); continue; }
    const distance = field === 'year_built' ? Math.abs(a.value - b.value) / 10
      : Math.abs(Math.log(a.value) - Math.log(b.value)) / Math.log(field === 'gla' ? 1.25 : 1.5);
    const score = unit(Math.exp(-Math.LN2 * distance ** 2));
    scores[field] = score; known += weight; weighted += weight * score;
  }
  return { housing_compatibility: 'compatible', feature_scores: scores, known_weight_units: known,
    observed_score: known ? unit(weighted / known) : null, lower_bound: unit(weighted / 10),
    upper_bound: unit((weighted + 10 - known) / 10), reason_codes: reasons.sort(compare) };
}
function compute(input, records, limits) {
  const reasons = new Set(), add = code => { reasons.add(code); if (reasons.size > 32) limited('diagnostics_limit'); };
  const propertyResolutions = input.properties.map(property => resolveProperty(property, records, input));
  const resolved = new Map(propertyResolutions.map(row => [row.property_id, row]));
  const subject = resolved.get(input.subject_property_id);
  const subjectSupported = SUPPORTED_HOUSING.includes(subject.facts.housing_type.value) &&
    ['housing_type', 'year_built', 'gla'].every(field => subject.facts[field].status === 'supported');
  if (!subjectSupported) add('subject_evidence_incomplete');
  if (input.capture.completeness !== 'complete') add('candidate_capture_incomplete');
  let status = reasons.size ? 'incomplete' : 'complete';
  const scores = new Map(propertyResolutions.map(row => [row.property_id, propertyScore(subject, row, subjectSupported)]));
  const overlap = new Map();
  const pockets = input.pockets.map(pocket => {
    const pocketReasons = new Set();
    const members = pocket.members.map(member => {
      const membershipRecords = member.membership_record_refs.map(reference => records.get(refKey(reference))).filter(record => applicable(record, input));
      const hasTrue = membershipRecords.some(record => record.included === true), hasFalse = membershipRecords.some(record => record.included === false);
      const membershipStatus = hasFalse ? 'conflicted' : hasTrue ? 'supported' : 'unknown';
      const base = scores.get(member.property_id);
      const item = { property_id: member.property_id, membership_status: membershipStatus,
        membership_record_refs: member.membership_record_refs, ...base, feature_scores: { ...base.feature_scores }, reason_codes: [...base.reason_codes] };
      if (membershipStatus !== 'supported') {
        Object.assign(item, { housing_compatibility: 'unknown', feature_scores: { year_built: null, gla: null, site_area: null },
          known_weight_units: 0, observed_score: null, lower_bound: 0, upper_bound: 1,
          reason_codes: [membershipStatus === 'conflicted' ? 'membership_conflicted' : 'membership_unknown'] });
        pocketReasons.add('membership_unresolved');
      }
      const ids = overlap.get(member.property_id) || []; ids.push(pocket.id); overlap.set(member.property_id, ids);
      return item;
    });
    if (!members.length) pocketReasons.add('empty_pocket');
    if (pocket.membership_completeness !== 'complete') pocketReasons.add('membership_capture_incomplete');
    const completeMembership = !pocketReasons.size;
    if (!completeMembership) { status = 'incomplete'; for (const reason of pocketReasons) add(reason); }
    const n = members.length, compatible = members.filter(member => member.housing_compatibility === 'compatible');
    const incompatible = members.filter(member => member.housing_compatibility === 'incompatible').length;
    const unknown = n - compatible.length - incompatible;
    const knownUnits = compatible.reduce((sum, member) => sum + member.known_weight_units, 0);
    const observed = compatible.filter(member => member.observed_score !== null);
    const lower = n ? unit(members.reduce((sum, member) => sum + member.lower_bound, 0) / n) : 0;
    const upper = n ? unit(members.reduce((sum, member) => sum + member.upper_bound, 0) / n) : 1;
    let disposition = 'review_required';
    if (input.capture.completeness === 'complete' && subjectSupported && completeMembership && n) {
      if (5 * (compatible.length + unknown) < 4 * n) { disposition = 'not_recommended'; pocketReasons.add('compatibility_below_minimum'); }
      else if (5 * compatible.length >= 4 * n && knownUnits >= 8 * compatible.length && lower > 0.75 + 1e-12) disposition = 'recommended';
      else if (upper < 0.75 - 1e-12) { disposition = 'not_recommended'; pocketReasons.add('similarity_below_minimum'); }
      else pocketReasons.add('similarity_or_support_requires_review');
    } else {
      if (!subjectSupported) pocketReasons.add('subject_evidence_incomplete');
      if (input.capture.completeness !== 'complete') pocketReasons.add('candidate_capture_incomplete');
    }
    return { id: pocket.id, revision: pocket.revision, rank: 0, membership_status: completeMembership ? 'complete' : 'incomplete',
      member_count: n, compatible_count: compatible.length, incompatible_count: incompatible, unknown_count: unknown,
      compatible_fraction: n ? compatible.length / n : null, incompatible_fraction: n ? incompatible / n : null, unknown_fraction: n ? unknown / n : null,
      compatible_observed_score: observed.length ? unit(observed.reduce((sum, member) => sum + member.observed_score, 0) / observed.length) : null,
      compatible_physical_support: compatible.length ? knownUnits / (10 * compatible.length) : null,
      lower_bound: lower, upper_bound: upper, disposition, members, reason_codes: [...pocketReasons].sort(compare) };
  });
  const fields = ['lower_bound', 'compatible_fraction', 'compatible_physical_support', 'compatible_observed_score'];
  pockets.sort((a, b) => {
    for (const field of fields) { const difference = (b[field] ?? -1) - (a[field] ?? -1); if (difference) return difference; }
    return compare(a.id, b.id);
  });
  pockets.forEach((pocket, index) => { pocket.rank = index + 1; });
  const body = { ranking_version: 1, policy_version: POCKET_RANKING_POLICY_VERSION, scope: input.scope,
    effective_date: input.effective_date, knowledge_cutoff: input.knowledge_cutoff, status, performed_policy: POLICY, limits,
    capture_ref: { id: input.capture.id, revision: input.capture.revision }, subject_property_id: input.subject_property_id,
    input_sha256: assessmentEvidenceDigest({ input, limits }), source_authority: 'not_established', report_eligibility: 'not_assessed',
    sales_support: 'not_assessed', builder_support: 'not_assessed', population_application: 'not_performed',
    subject_resolution: { property_id: input.subject_property_id, status: subjectSupported ? 'supported' : 'incomplete' },
    property_resolutions: propertyResolutions, pockets,
    overlap_groups: [...overlap].filter(([, ids]) => ids.length > 1).sort(([a], [b]) => compare(a, b))
      .map(([property_id, pocket_ids]) => ({ property_id, pocket_ids })),
    reasons: [...reasons].sort(compare).map(code => ({ code, property_id: null, pocket_id: null })) };
  return body;
}

/** Pure, bounded, deterministic within the declared JS binary64 arithmetic policy. */
export function rankNeighborhoodPockets(raw, options = {}) {
  try {
    const limits = limitsOf(options);
    const input = safeCopy(raw, limits, limits.input_bytes, 'input');
    const records = validate(input, limits);
    // Include normalized limits and all unavailable record bytes in the identity.
    safeCopy({ input, limits }, limits, limits.input_bytes, 'input');
    const body = compute(input, records, limits);
    safeCopy(body, limits, limits.output_bytes, 'output');
    const result = { ...body, ranking_revision: assessmentEvidenceDigest(body) };
    const copied = safeCopy(result, limits, limits.output_bytes, 'output');
    canonicalAssessmentJson(copied);
    return freeze(copied);
  } catch (error) {
    const detail = branded.get(error);
    if (detail?.kind === 'incomplete') return incomplete(detail.code);
    if (detail?.kind === 'invalid') invalid(detail.code);
    invalid('validation_failed');
  }
}
