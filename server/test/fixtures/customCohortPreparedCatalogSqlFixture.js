import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortPreparedCatalogRegistry as registry } from '../../src/services/neighborhoodAssessment/customCohortPreparedCatalogRegistry.js';
import { customCohortPreparedCatalogRegistryFixture as fixture } from './customCohortPreparedCatalogRegistryFixture.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => { const text = Buffer.from(JSON.stringify(value)); return { bytes: text.length, digest: hash(text), packed: gzipSync(text) }; };

/** In-memory SQL protocol only, with ACTUAL original mapper/index/compiler and
 * registry. This does not simulate a database authorization grant or migration.
 * The separately guarded native owner fixture proves those boundaries. */
export function customCohortPreparedCatalogSqlFixture(f = fixture(), hooks = {}) {
  const c = encode(f.payload), p = encode(f.preview), originals = new Map(), calls = [];
  const source = { source_catalog_format_version: 2, catalog_sha256: c.digest, catalog_utf8_bytes: c.bytes,
    compressed_catalog_sha256: hash(c.packed), compressed_catalog: c.packed,
    preview_sha256: p.digest, preview_utf8_bytes: p.bytes, compressed_preview_sha256: hash(p.packed), compressed_preview: p.packed };
  let root = null, memberRoot = null;
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values }); await hooks.before?.(sql, values, source);
    let result;
    if (sql.includes('registry:transaction')) result = { rowCount: 1, rows: [{ transaction_id: hooks.transaction?.() ?? '77' }] };
    else if (/registry:(pins|originals)/.test(sql)) result = hooks.missingSource ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ ...source }] };
    else if (sql.includes('prepared-catalog-membership:read')) result = memberRoot ? { rowCount:1,rows:[{ ...memberRoot }] } : { rowCount:0,rows:[] };
    else if (sql.includes('prepared-catalog-membership:insert')) {
      if (!memberRoot) {
        memberRoot = { display_manifest_sha256:values[4],display_manifest_utf8_bytes:values[5],
          witness_sha256:values[6],witness_utf8_bytes:values[7] };
        result = { rowCount:1,rows:[{ witness_sha256:memberRoot.witness_sha256 }] };
      } else result = { rowCount:0,rows:[] };
    }
    else if (sql.includes('registry:read')) result = root ? { rowCount: 1, rows: [{ ...root,
      current_catalog_format_version: source.source_catalog_format_version,
      ...Object.fromEntries(['catalog_sha256', 'catalog_utf8_bytes', 'compressed_catalog_sha256', 'preview_sha256',
        'preview_utf8_bytes', 'compressed_preview_sha256'].map(k => [`current_${k}`, source[k]])) }] } : { rowCount: 0, rows: [] };
    else if (sql.includes('registry:insert')) {
      if (!root) {
        const fields = ['source_catalog_format_version', 'catalog_sha256', 'catalog_utf8_bytes', 'compressed_catalog_sha256',
          'preview_sha256', 'preview_utf8_bytes', 'compressed_preview_sha256', 'manifest_sha256', 'manifest_utf8_bytes',
          'original_catalog_sha256', 'original_catalog_utf8_bytes', 'source_read_model_sha256', 'roster_account_ids_sha256'];
        root = Object.fromEntries(fields.map((k, i) => [k, values[i + 3]]));
        result = { rowCount: 1, rows: [{ manifest_sha256: root.manifest_sha256 }] };
      } else result = { rowCount: 0, rows: [] };
    } else if (sql.includes('neighborhood-cohort-blob:insert')) {
      const [org, digest, length, text] = values; const id = `${org}:${digest}`, existed = originals.has(id);
      if (!existed) originals.set(id, text);
      result = { rowCount: existed ? 0 : 1, rows: existed ? [] : [{ content_sha256: digest, canonical_utf8_bytes: String(length), canonical_utf8: text }] };
    } else if (sql.includes('neighborhood-cohort-blob:read')) {
      const text = originals.get(`${values[0]}:${values[1]}`);
      result = { rowCount: text === undefined ? 0 : 1, rows: text === undefined ? [] : [{ content_sha256: values[1],
        canonical_utf8_bytes: String(Buffer.byteLength(text)), canonical_utf8: text }] };
    } else throw new Error('unexpected_sql');
    await hooks.after?.(sql, result, source); return result;
  } };
  const make = (options = {}, scope = f.scope) => registry(client, json(scope), json(f.context), options);
  return { f, client, calls, source, originals, make, root: () => root, memberRoot: () => memberRoot,
    dropRoot: () => { root = null; },dropMemberRoot: () => { memberRoot = null; } };
}
