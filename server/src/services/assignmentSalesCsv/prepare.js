import { createHash } from 'node:crypto';
import { parseAssignmentSalesCsv } from './parse.js';
import { ASSIGNMENT_SALES_OBSERVATION_HEADERS, normalizeAssignmentSalesObservations } from './observations.js';

export const ASSIGNMENT_SALES_CSV_PROFILE = 'private_sales_csv_preparation_v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalHeaders = new Map(ASSIGNMENT_SALES_OBSERVATION_HEADERS.map(name => [name.toLowerCase(), name]));
const identityHeaders = ['ListingKey', 'ListingId', 'ParcelNumber', 'ParcelNumber2',
  'Address', 'UnparsedAddress', 'PropertyAddress', 'StreetAddress'];

function requireSalesColumns(columns) {
  const names = new Set(columns.map(name => canonicalHeaders.get(name.toLowerCase())));
  if (!names.has('CloseDate') || !(names.has('CurrentPrice') || names.has('ClosePrice'))
    || !identityHeaders.some(name => names.has(name))) {
    throw Object.assign(new Error('assignment_sales_csv_unsupported_columns'),
      { code: 'assignment_sales_csv_unsupported_columns' });
  }
}

// Groups are scoped to this one uploaded file. Neither an MLS identifier nor an
// identical row is authority to merge global sales or resolve a parcel account.
function groupRows(rows, identities) {
  const parents = rows.map((_, index) => index);
  const root = index => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const seen = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.record_sha256) continue;
    const tokens = ['content:' + row.record_sha256, ...identities[index]];
    for (const token of tokens) {
      if (seen.has(token)) {
        const first = root(seen.get(token));
        const next = root(index);
        parents[Math.max(first, next)] = Math.min(first, next);
      } else seen.set(token, index);
    }
  }
  const components = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    if (!rows[index].record_sha256) continue;
    const key = root(index);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(index);
  }
  const groups = [];
  for (const indices of components.values()) {
    if (indices.length < 2) continue;
    const first = rows[indices[0]];
    const conflict = indices.some(index => rows[index].record_sha256 !== first.record_sha256);
    const groupId = `rows:${first.source_row_number}`;
    groups.push({ group_id: groupId, kind: conflict ? 'identity_conflict' : 'duplicate_content',
      source_row_numbers: indices.map(index => rows[index].source_row_number) });
    for (const index of indices) {
      const row = rows[index];
      row.group_id = groupId;
      if (conflict) {
        row.preparation_disposition = 'identity_conflict';
        row.issues = [...new Set([...row.issues, 'conflicting_listing_identity'])];
      } else if (index !== indices[0]) {
        row.preparation_disposition = 'duplicate';
        row.duplicate_of_source_row_number = first.source_row_number;
      }
    }
  }
  return groups;
}

/**
 * Prepare observations, not committed receipts. This pure boundary does not
 * connect to a database, match accounts, claim eligibility, or mutate reports.
 * The eventual assignment-authorized importer must retain the original bytes
 * and produce separate post-commit receipts before displaying "saved".
 */
export function prepareAssignmentSalesCsv(bytes) {
  const parsed = parseAssignmentSalesCsv(bytes);
  requireSalesColumns(parsed.columns);
  const mappedColumns = parsed.columns.map(name => canonicalHeaders.get(name.toLowerCase()) ?? null);
  const identities = [];
  const rows = parsed.rows.map(source => {
    const row = {
      source_row_number: source.source_row_number,
      source_line_number: source.source_line_number,
      byte_start: source.byte_start,
      byte_end: source.byte_end,
      raw_cells: source.cells,
      record_sha256: null,
      preparation_disposition: 'prepared',
      issues: [],
      values: null,
      group_id: null,
      duplicate_of_source_row_number: null,
      persisted: false,
      matching_status: 'not_evaluated',
      analysis_status: 'not_evaluated',
    };
    identities.push([]);
    if (source.cells.every(cell => cell.trim() === '')) {
      row.preparation_disposition = 'empty';
      row.issues = ['empty_record'];
      return row;
    }
    if (source.cells.length !== mappedColumns.length) {
      row.preparation_disposition = 'rejected';
      row.issues = ['column_count_mismatch'];
      return row;
    }
    const raw = Object.fromEntries(mappedColumns.flatMap((name, index) =>
      name === null ? [] : [[name, source.cells[index]]]));
    const observation = normalizeAssignmentSalesObservations(raw);
    row.values = observation.values;
    row.issues = [...observation.issues];
    if (!identityHeaders.some(name => raw[name]?.trim())) row.issues.push('missing_property_identity');
    row.issues = [...new Set(row.issues)];
    if (row.issues.length) row.preparation_disposition = 'needs_review';
    row.record_sha256 = hash(JSON.stringify(source.cells));
    identities[identities.length - 1] = ['ListingKey', 'ListingId'].flatMap(name => {
      const value = raw[name]?.trim().toUpperCase();
      return value ? [`${name}:${hash(value)}`] : [];
    });
    return row;
  });
  const groups = groupRows(rows, identities);
  const summary = { prepared: 0, needs_review: 0, duplicate: 0, identity_conflict: 0, rejected: 0, empty: 0 };
  for (const row of rows) summary[row.preparation_disposition] += 1;
  return {
    preparation_version: 1,
    profile_id: ASSIGNMENT_SALES_CSV_PROFILE,
    preparation_status: 'prepared',
    intended_scope: 'assignment_private',
    persisted: false,
    source_sha256: parsed.source_sha256,
    source_byte_length: parsed.source_byte_length,
    raw_headers: parsed.headers,
    columns: parsed.columns,
    row_count: rows.length,
    summary,
    groups,
    rows,
    source_interpretation_status: 'not_reviewed',
    matching_status: 'not_evaluated',
    analysis_status: 'not_evaluated',
  };
}
