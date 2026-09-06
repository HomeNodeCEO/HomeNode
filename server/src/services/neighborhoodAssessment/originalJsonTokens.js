// One bounded grammar/number bridge for complete decoding and selective owners.
// Indexes are ephemeral representation, not source locators or authority.
export const ORIGINAL_JSON_TOKEN_LIMITS = Object.freeze({
  input_bytes: 1_500_000, decoded_nodes: 100_000, decoded_depth: 35,
  numeric_token_bytes: 256, numeric_exponent: 1000,
  index_nodes: 100_000, index_edges: 99_999, index_key_bytes: 1_500_000,
});
const LIMITS = ORIGINAL_JSON_TOKEN_LIMITS;
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

export function classifyOriginalJsonTokenFailure(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? FAILURES.get(value) || null : null;
}

// No Buffer allocation or replacement encoding precedes the original byte cap.
export function measureOriginalUnicodeBytes(text) {
  if (arguments.length !== 1 || typeof text !== 'string') stop('invalid_input', 'invalid_argument');
  if (text.length > LIMITS.input_bytes) limit('input_bytes');
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
    if (bytes > LIMITS.input_bytes) limit('input_bytes');
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
export function decodeOriginalNumericText(token, invalidReason) {
  if (arguments.length !== 2 || typeof token !== 'string' ||
      typeof invalidReason !== 'string' || !['invalid_json', 'invalid_numeric_text'].includes(invalidReason)) {
    stop('invalid_input', 'invalid_argument');
  }
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

/** No full-document JSON.parse or converted scalar is stored here. Numeric
 * conversion runs only in full_value, at the original decoder encounter point. */
export function scanOriginalJsonText(text, mode) {
  if (arguments.length !== 2 || typeof text !== 'string' || typeof mode !== 'string' ||
      !['full_value', 'validate_only', 'index'].includes(mode)) stop('invalid_input', 'invalid_argument');
  const usage = { input_utf8_bytes: measureOriginalUnicodeBytes(text), decoded_nodes: 0,
    decoded_depth: 0, numeric_tokens: 0, numeric_token_utf8_bytes: 0 };
  const index = mode === 'index'
    ? { root: 0, nodes: [], index_edges: 0, decoded_key_utf8_bytes: 0 } : null;
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
        const bytes = measureOriginalUnicodeBytes(value);
        return { value, bytes };
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
  function allocate(kind, start) {
    if (!index) return null;
    if (index.nodes.length >= LIMITS.index_nodes) limit('index_nodes');
    const node = { kind, start, end: start,
      members: kind === 'object' ? [] : null, elements: kind === 'array' ? [] : null };
    index.nodes.push(node);
    return node;
  }
  function appendEdge(node, key, child) {
    if (!index) return;
    if (index.index_edges >= LIMITS.index_edges) limit('index_edges');
    index.index_edges++;
    if (node.kind === 'object') node.members.push({ key, value: child });
    else node.elements.push(child);
  }
  function value(depth) {
    if (++usage.decoded_nodes > LIMITS.decoded_nodes) limit('decoded_nodes');
    if (depth > LIMITS.decoded_depth) limit('decoded_depth');
    usage.decoded_depth = Math.max(usage.decoded_depth, depth);
    whitespace();
    const start = at;
    const char = text[at];
    const nodeIndex = index ? index.nodes.length : null;
    let node;
    if (char === '"') {
      node = allocate('string', start); stringToken();
    } else if (char === '{' || char === '[') {
      const object = char === '{';
      const close = object ? '}' : ']';
      const keys = object ? new Set() : null;
      node = allocate(object ? 'object' : 'array', start);
      at++; whitespace();
      if (text[at] === close) at++;
      else while (true) {
        // Every key requires a value node, so bound before decoding/storing it.
        if (usage.decoded_nodes >= LIMITS.decoded_nodes) limit('decoded_nodes');
        let key = null;
        if (object) {
          const decoded = stringToken(); key = decoded.value;
          if (keys.has(key)) unsupported('duplicate_json_key');
          if (index) {
            if (index.decoded_key_utf8_bytes + decoded.bytes > LIMITS.index_key_bytes) limit('index_key_bytes');
            index.decoded_key_utf8_bytes += decoded.bytes;
          }
          keys.add(key); whitespace();
          if (text[at++] !== ':') unsupported('invalid_json');
        }
        const child = value(depth + 1);
        appendEdge(node, key, child); whitespace();
        if (text[at] === close) { at++; break; }
        if (text[at++] !== ',') unsupported('invalid_json');
        whitespace();
      }
    } else {
      let literal = null;
      for (const candidate of ['true', 'false', 'null']) {
        if (text.startsWith(candidate, at)) { literal = candidate; break; }
      }
      if (literal !== null) {
        node = allocate(literal === 'null' ? 'null' : 'boolean', start); at += literal.length;
      } else if (char === '-' || (char >= '0' && char <= '9')) {
        while (at < text.length && /[0-9eE+.\-]/.test(text[at])) at++;
        const token = text.slice(start, at);
        if (mode === 'full_value') decodeOriginalNumericText(token, 'invalid_json');
        else if (!NUMBER.test(token)) unsupported('invalid_json');
        usage.numeric_tokens++; usage.numeric_token_utf8_bytes += token.length;
        node = allocate('number', start);
      } else unsupported('invalid_json');
    }
    if (node) node.end = at;
    return nodeIndex;
  }
  value(0); whitespace();
  if (at !== text.length) unsupported('invalid_json');
  return freeze({ usage, index });
}
