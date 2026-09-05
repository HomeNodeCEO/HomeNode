// The evidence contract limits compact canonical JSON to 1.5 MB. PostgreSQL's
// jsonb::text adds separator spaces and expands exponent-form numbers; it is a
// different representation, not the evidence hash input. Check its separate
// 2 MB ceiling before opening/writing a transaction. Never hash this estimate.
export const NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES = 2_000_000;
const MAX_NODES = 100_000;
const MAX_DEPTH = 40;

function reject(kind, reason) {
  throw Object.assign(new TypeError(`neighborhood_jsonb_storage_${kind}:${reason}`), {
    code: `neighborhood_jsonb_storage_${kind}`, reason,
  });
}

function numericBytes(value) {
  if (!Number.isFinite(value)) reject("invalid", "nonfinite_number");
  // JSON.stringify normalizes negative zero and supplies the exact decimal
  // token PostgreSQL will parse. Its at-most-25-character exponent form stays
  // small; only count expansion, never allocate a 300-digit replacement.
  const token = JSON.stringify(value);
  const exponent = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(token);
  if (!exponent) return token.length;
  const [, sign, whole, fraction = "", power] = exponent;
  const digits = whole.length + fraction.length;
  const decimalPosition = whole.length + Number(power);
  if (decimalPosition <= 0) return sign.length + 2 - decimalPosition + digits;
  if (decimalPosition >= digits) return sign.length + decimalPosition;
  return sign.length + digits + 1;
}

/**
 * Returns the UTF-8 byte size of PostgreSQL jsonb's textual representation for
 * a plain finite JSON value, or throws a controlled TypeError before DB work.
 * This is a storage compatibility guard, not a replacement for the contract's
 * canonical JSON/hash/scope validation. NUL and unpaired UTF-16 surrogates are
 * rejected in both object keys and values because PostgreSQL jsonb rejects them.
 */
export function assertNeighborhoodJsonbStorage(value) {
  let bytes = 0;
  let nodes = 0;
  const path = new Set();
  const add = count => {
    bytes += count;
    if (bytes > NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES) reject("limit", "bytes");
  };
  const quoted = text => {
    if (text.length > NEIGHBORHOOD_JSONB_STORAGE_MAX_BYTES) reject("limit", "bytes");
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0) reject("invalid", "nul_string");
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) reject("invalid", "unpaired_surrogate");
        add(4);
      } else if (code >= 0xdc00 && code <= 0xdfff) reject("invalid", "unpaired_surrogate");
      else add(3);
    }
  };
  const visit = (item, depth) => {
    if (++nodes > MAX_NODES) reject("limit", "nodes");
    if (depth > MAX_DEPTH) reject("limit", "depth");
    if (item === null) { add(4); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { add(numericBytes(item)); return; }
    if (typeof item === "string") { quoted(item); return; }
    if (!item || typeof item !== "object" ||
        (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) reject("invalid", "not_json");
    if (path.has(item)) reject("invalid", "cycle");
    path.add(item);
    add(2);
    if (Array.isArray(item)) {
      if (item.length > MAX_NODES) reject("limit", "nodes");
      for (let i = 0; i < item.length; i++) {
        if (i) add(2); // PostgreSQL ', ', not compact JSON ','.
        visit(item[i], depth + 1);
      }
    } else {
      const keys = Object.keys(item);
      if (keys.length > MAX_NODES) reject("limit", "nodes");
      for (let i = 0; i < keys.length; i++) {
        if (i) add(2);
        quoted(keys[i]); add(2); // PostgreSQL ': '.
        visit(item[keys[i]], depth + 1);
      }
    }
    path.delete(item);
  };
  visit(value, 0);
  return bytes;
}
