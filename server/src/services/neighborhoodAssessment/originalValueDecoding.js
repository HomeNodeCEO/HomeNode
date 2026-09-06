import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';

export const ORIGINAL_VALUE_DECODER_VERSION = 1;
export const ORIGINAL_VALUE_DECODER_LIMITS = Object.freeze({
  input_bytes: 1_500_000, decoded_nodes: 100_000, decoded_depth: 35,
  numeric_token_bytes: 256, numeric_exponent: 1000,
  output_bytes: 1_500_000, output_nodes: 100_000, output_depth: 40,
  output_jsonb_bytes: 2_000_000,
});
const LIMITS = ORIGINAL_VALUE_DECODER_LIMITS;
const KINDS = ['jsonb', 'numeric', 'date', 'timestamptz', 'utc6'];
const STATES = ['sql_null', 'json_null', 'present'];
const FAILURES = new WeakMap();
const NUMBER = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/;
function stop(status, reason) {
  const token = Object.freeze({});
  FAILURES.set(token, Object.freeze({ status, reason }));
  throw token;
}
const unsupported = reason => stop('unsupported', reason);
const limit = reason => stop('limit_exceeded', reason);
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// No Buffer allocation or replacement encoding precedes the original byte cap.
function unicodeBytes(text, maximum) {
  if (text.length > maximum) limit('input_bytes');
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) unsupported('invalid_unicode');
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) unsupported('invalid_unicode');
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) unsupported('invalid_unicode');
    else bytes += 3;
    if (bytes > maximum) limit('input_bytes');
  }
  return bytes;
}

// A decimal is compared as sign/significant digits/power, never expanded.
function decimal(token, invalidReason) {
  if (token.length > LIMITS.numeric_token_bytes) limit('numeric_token_limit');
  const match = NUMBER.exec(token);
  if (!match) unsupported(invalidReason);
  const [, sign, whole, fraction = '', exponentSign = '', exponentDigits = '0'] = match;
  const exponentMagnitude = exponentDigits.replace(/^0+/, '') || '0';
  if (exponentMagnitude.length > 4 ||
      (exponentMagnitude.length === 4 && exponentMagnitude > '1000')) limit('numeric_exponent_limit');
  const declared = Number(exponentMagnitude) * (exponentSign === '-' ? -1 : 1);
  const combined = (whole + fraction).replace(/^0+/, '');
  if (!combined) return { sign, digits: '0', power: 0 };
  const digits = combined.replace(/0+$/, '');
  const power = declared - fraction.length + combined.length - digits.length;
  if (Math.abs(power) > LIMITS.numeric_exponent) limit('numeric_exponent_limit');
  return { sign, digits, power };
}
function numeric(token, invalidReason) {
  const original = decimal(token, invalidReason);
  if (original.digits === '0' && original.sign === '-') unsupported('negative_zero');
  const value = Number(token);
  if (!Number.isFinite(value)) unsupported('nonfinite_numeric');
  if (value === 0 && original.digits !== '0') unsupported('numeric_underflow');
  const rendered = decimal(JSON.stringify(value), invalidReason);
  if (original.sign !== rendered.sign || original.digits !== rendered.digits || original.power !== rendered.power) {
    unsupported('inexact_numeric');
  }
  return value;
}

// This lexer retains no object values. Only bounded string tokens are parsed
// before every original numeric leaf and the full grammar have been admitted.
function scanJson(text, usage) {
  let at = 0;
  const whitespace = () => {
    while (text[at] === ' ' || text[at] === '\n' || text[at] === '\r' || text[at] === '\t') at++;
  };
  function stringToken() {
    if (text[at] !== '"') unsupported('invalid_json');
    const start = at++;
    while (at < text.length) {
      const code = text.charCodeAt(at++);
      if (code === 34) {
        const value = JSON.parse(text.slice(start, at));
        unicodeBytes(value, LIMITS.input_bytes);
        return value;
      }
      if (code < 32) unsupported('invalid_json');
      if (code === 92) {
        const escape = text[at++];
        if (escape === 'u') {
          for (let i = 0; i < 4; i++) {
            const digit = text[at++];
            if (digit === undefined || !/[0-9a-fA-F]/.test(digit)) unsupported('invalid_json');
          }
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) unsupported('invalid_json');
      }
    }
    unsupported('invalid_json');
  }
  function value(depth) {
    if (++usage.decoded_nodes > LIMITS.decoded_nodes) limit('decoded_nodes');
    if (depth > LIMITS.decoded_depth) limit('decoded_depth');
    usage.decoded_depth = Math.max(usage.decoded_depth, depth);
    whitespace();
    const char = text[at];
    if (char === '"') { stringToken(); return; }
    if (char === '{' || char === '[') {
      const object = char === '{';
      const close = object ? '}' : ']';
      const keys = object ? new Set() : null;
      at++; whitespace();
      if (text[at] === close) { at++; return; }
      while (true) {
        // Every key will require a value node. Refuse before allocating it.
        if (usage.decoded_nodes >= LIMITS.decoded_nodes) limit('decoded_nodes');
        if (object) {
          const key = stringToken();
          if (keys.has(key)) unsupported('duplicate_json_key');
          keys.add(key); whitespace();
          if (text[at++] !== ':') unsupported('invalid_json');
        }
        value(depth + 1); whitespace();
        if (text[at] === close) { at++; return; }
        if (text[at++] !== ',') unsupported('invalid_json');
        whitespace();
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) { at += literal.length; return; }
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const start = at;
      while (at < text.length && /[0-9eE+.\-]/.test(text[at])) at++;
      const token = text.slice(start, at);
      numeric(token, 'invalid_json');
      usage.numeric_tokens++;
      usage.numeric_token_utf8_bytes += token.length;
      return;
    }
    unsupported('invalid_json');
  }
  value(0); whitespace();
  if (at !== text.length) unsupported('invalid_json');
}

function date(text, reason) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) || text.startsWith('0000')) unsupported(reason);
  try { return assessmentDate(text); } catch { unsupported(reason); }
}
function timestamp(text, strict) {
  const expression = strict
    ? /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{6})Z$/
    : /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(?:Z|\+00|\+00:00)$/;
  const match = expression.exec(text);
  if (!match || match[2] > '23' || match[3] > '59' || match[4] > '59') unsupported('invalid_timestamp_text');
  date(match[1], 'invalid_timestamp_text');
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${(match[5] || '').padEnd(6, '0')}Z`;
}

function admitOutput(result) {
  // All values are newly parsed/admitted primitives, with no user getters or
  // injected helpers. Classify only the real helpers' fixed capacity failures.
  try { canonicalAssessmentJson(result); }
  catch (error) {
    if (error instanceof TypeError && ['invalid_neighborhood_assessment:json_limit',
      'invalid_neighborhood_assessment:json_bytes'].includes(error.message)) limit('output_limit');
    throw error;
  }
  try { assertNeighborhoodJsonbStorage(result); }
  catch (error) {
    if (error instanceof TypeError && ['neighborhood_jsonb_storage_limit:bytes',
      'neighborhood_jsonb_storage_limit:nodes', 'neighborhood_jsonb_storage_limit:depth'].includes(error.message)) limit('output_limit');
    throw error;
  }
  return freeze(result);
}

/** Complete-snapshot/scalar representation only. The caller retains original
 * text on every outcome; no source, domain, timestamp-origin or access authority
 * is established. This synchronous helper supplies no deadline/cancellation. */
export function decodeNeighborhoodOriginalValue(kind, storageState, originalText) {
  const safeKind = typeof kind === 'string' && KINDS.includes(kind) ? kind : null;
  const safeState = typeof storageState === 'string' && STATES.includes(storageState) ? storageState : null;
  const base = { decoder_version: 1, interpretation: 'representation_only',
    status: 'decoded', reason: null, kind: safeKind, storage_state: safeState, value: null, usage: null };
  try {
    if (!safeKind || !safeState || arguments.length !== 3) stop('invalid_input', 'invalid_argument');
    const usage = { input_utf8_bytes: 0, decoded_nodes: 0, decoded_depth: 0,
      numeric_tokens: 0, numeric_token_utf8_bytes: 0 };
    if (storageState === 'sql_null') {
      if (originalText !== null) stop('invalid_input', 'storage_state_mismatch');
      return admitOutput({ ...base, usage });
    }
    if (typeof originalText !== 'string' ||
        (storageState === 'json_null' && (kind !== 'jsonb' || originalText !== 'null'))) {
      stop('invalid_input', 'storage_state_mismatch');
    }
    usage.input_utf8_bytes = unicodeBytes(originalText, LIMITS.input_bytes);
    let value;
    if (kind === 'jsonb') {
      scanJson(originalText, usage);
      value = JSON.parse(originalText);
      if (storageState === 'present' && value === null) stop('invalid_input', 'storage_state_mismatch');
    } else {
      usage.decoded_nodes = 1;
      if (kind === 'numeric') {
        if (['NaN', 'Infinity', '-Infinity'].includes(originalText)) unsupported('nonfinite_numeric');
        value = numeric(originalText, 'invalid_numeric_text');
        usage.numeric_tokens = 1; usage.numeric_token_utf8_bytes = originalText.length;
      } else if (kind === 'date') value = date(originalText, 'invalid_date_text');
      else value = timestamp(originalText, kind === 'utc6');
    }
    return admitOutput({ ...base, value, usage });
  } catch (error) {
    const known = error !== null && (typeof error === 'object' || typeof error === 'function') ? FAILURES.get(error) : null;
    return freeze({ ...base, status: known?.status || 'failed', reason: known?.reason || 'decoder_failed' });
  }
}
