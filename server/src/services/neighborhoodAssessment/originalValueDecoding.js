import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';
import { scanOriginalJsonText, decodeOriginalNumericText, measureOriginalUnicodeBytes,
  classifyOriginalJsonTokenFailure } from './originalJsonTokens.js';

export const ORIGINAL_VALUE_DECODER_VERSION = 1;
export const ORIGINAL_VALUE_DECODER_LIMITS = Object.freeze({
  input_bytes: 1_500_000, decoded_nodes: 100_000, decoded_depth: 35,
  numeric_token_bytes: 256, numeric_exponent: 1000,
  output_bytes: 1_500_000, output_nodes: 100_000, output_depth: 40,
  output_jsonb_bytes: 2_000_000,
});
const KINDS = ['jsonb', 'numeric', 'date', 'timestamptz', 'utc6'];
const STATES = ['sql_null', 'json_null', 'present'];
const FAILURES = new WeakMap();
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
    let value;
    if (kind === 'jsonb') {
      Object.assign(usage, scanOriginalJsonText(originalText, 'full_value').usage);
      value = JSON.parse(originalText);
      if (storageState === 'present' && value === null) stop('invalid_input', 'storage_state_mismatch');
    } else {
      usage.input_utf8_bytes = measureOriginalUnicodeBytes(originalText);
      usage.decoded_nodes = 1;
      if (kind === 'numeric') {
        if (['NaN', 'Infinity', '-Infinity'].includes(originalText)) unsupported('nonfinite_numeric');
        value = decodeOriginalNumericText(originalText, 'invalid_numeric_text');
        usage.numeric_tokens = 1; usage.numeric_token_utf8_bytes = originalText.length;
      } else if (kind === 'date') value = date(originalText, 'invalid_date_text');
      else value = timestamp(originalText, kind === 'utc6');
    }
    return admitOutput({ ...base, value, usage });
  } catch (error) {
    const own = error !== null && (typeof error === 'object' || typeof error === 'function') ? FAILURES.get(error) : null;
    const known = own || classifyOriginalJsonTokenFailure(error);
    return freeze({ ...base, status: known?.status || 'failed', reason: known?.reason || 'decoder_failed' });
  }
}
