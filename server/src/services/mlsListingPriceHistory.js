/** Bounded, read-only adapter for the Matrix "Listing History from MLS" PDF.
 * Keep each listing separate. Equal current/original prices are not proof of
 * zero reductions, and status rows' sale prices/DOM do not become listing data.
 * Suggestions still require normal document identity and appraiser review. */
const HEADING = /^Listing History from MLS$/im;
const TABLE = /^Field Name\s+Effective Dt\s+Change Dt\s+Chg Time\s+Previous Value\s+New Value\s+DOM$/i;
const RECORD = /^MLS\s*#\s*:\s*(\S+)\s+(.+?)\s+Prop Type:\s*([A-Z0-9 -]+)$/i;
const ROW = /^([A-Za-z][A-Za-z0-9 _/-]{0,50}?)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+((?:0?[1-9]|1[0-2]):[0-5]\d\s+[AP]M)\s+(.+)$/i;
const LIMITS = { pages: 250, pageChars: 500_000, totalChars: 4_000_000, lineChars: 4_000, lines: 50_000, rows: 500, serialized: 3_900 };
const compact = value => value.replace(/\s+/g, " ").trim();

export function isMlsListingHistory(text) {
  return typeof text === "string" && HEADING.test(text)
    && /\bField\s+Name\s+Effective\s+Dt\s+Change\s+Dt\b/i.test(text)
    && /\bPrevious\s+Value\s+New\s+Value\s+DOM\b/i.test(text);
}

function calendarDate(value) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  let [, month, day, year] = match.map(Number);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;
}
function money(value) {
  const match = value.match(/^\$?(\d{1,10}|\d{1,3}(?:,\d{3}){1,3})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const amount = Number(`${match[1].replaceAll(",", "")}.${(match[2] || "").padEnd(2, "0")}`);
  return amount > 0 && amount <= 9_999_999_999 ? amount.toFixed(2) : null;
}
function timestamp(date, time) {
  const [, hour, minute, half] = time.match(/^(\d{1,2}):(\d{2})\s+([AP])M$/i);
  return `${date}T${String(Number(hour) % 12 + (half.toUpperCase() === "P" ? 12 : 0)).padStart(2, "0")}:${minute}`;
}
function readPages(pages) {
  if (!Array.isArray(pages) || pages.length > LIMITS.pages) return null;
  let total = 0, lineCount = 0;
  const entries = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (typeof page !== "string" || page.length > LIMITS.pageChars || (total += page.length) > LIMITS.totalChars
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(page)) return null;
    for (const line of page.replace(/\r\n?/g, "\n").split("\n")) {
      if (++lineCount > LIMITS.lines || line.length > LIMITS.lineChars) return null;
      if (line.trim()) entries.push({ line: compact(line), page_number: index + 1 });
    }
  }
  return entries;
}

function pageCoverage(entries, pageCount) {
  const footers = new Map();
  for (const entry of entries) {
    const match = entry.line.match(/(?:^|\s)(\d+)\/(\d+)$/);
    if (!match || (!/^https:\/\/[^/]*mlsmatrix\.com\/Matrix\//i.test(entry.line) && !/^\d+\/\d+$/.test(entry.line))) continue;
    const signature = `${Number(match[1])}/${Number(match[2])}`;
    const previous = footers.get(entry.page_number);
    if (previous && previous !== signature) return false;
    footers.set(entry.page_number, signature);
  }
  return footers.size === pageCount && [...footers].every(([page, signature]) => signature === `${page}/${pageCount}`);
}

function parseRow(entry) {
  const match = entry.line.match(ROW);
  if (!match) return null;
  const [, field, rawDate, rawChangeDate, time, rawValues] = match;
  const date = calendarDate(rawDate), changeDate = calendarDate(rawChangeDate);
  if (!date || !changeDate) return null;
  const common = { date, change_date: changeDate, recorded_at: timestamp(changeDate, time), page_number: entry.page_number, evidence: entry.line };
  const fieldKey = field.toLowerCase().replace(/[ _/-]/g, "");
  if (fieldKey === "mlsstatus") {
    const values = rawValues.match(/^(INC|CSN|ACT|AOC|PND|SLD|EXP|CAN|WDN|TOM|CON|P|A|S)\s+(INC|CSN|ACT|AOC|PND|SLD|EXP|CAN|WDN|TOM|CON|P|A|S)(?:\s+\(\$[\d,]+(?:\.\d{1,2})?\))?(?:\s+\d{1,4})?$/i);
    return values ? { ...common, type: "status", previous: values[1].toUpperCase(), next: values[2].toUpperCase() } : null;
  }
  if (["listprice", "listingprice", "originalprice", "originallistprice"].includes(fieldKey)) {
    const values = rawValues.match(/^(\$?[\d,]+(?:\.\d{1,2})?)\s+(\$?[\d,]+(?:\.\d{1,2})?)(?:\s+\d{1,4})?$/);
    const previous = values && money(values[1]), next = values && money(values[2]);
    return previous && next ? { ...common, type: fieldKey.includes("original") ? "original_price" : "price", previous, next } : null;
  }
  // Unknown fields are an explicit adapter limitation, never silently skipped
  // while declaring a history complete.
  return null;
}

export function extractMlsListingPriceHistory(pages = []) {
  const result = { candidates: [], unresolved: [] };
  const fail = (reason, page) => {
    result.candidates.length = 0;
    result.unresolved.push({ field_key: "listing_price_history", reason, ...(page ? { page_number: page } : {}) });
    return result;
  };
  const entries = readPages(pages);
  if (!entries) return fail("listing_history_input_incomplete");
  const text = entries.map(entry => entry.line).join("\n");
  if (!HEADING.test(text)) return result;
  if (!isMlsListingHistory(text)) return fail("listing_history_layout_not_verified");
  const groups = new Map();
  let current = null, table = false, totalRows = 0;
  for (const entry of entries) {
    if (HEADING.test(entry.line)) { table = false; continue; }
    const record = entry.line.match(RECORD);
    if (record) {
      const [, rawId, address] = record;
      if (!/^[A-Z0-9][A-Z0-9-]{2,44}$/i.test(rawId) || /^(?:unknown|unavailable|pending|tbd|null)$/i.test(rawId)
        || !/^\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?\s+[A-Za-z0-9]/.test(address)) return fail("listing_history_identity_ambiguous", entry.page_number);
      const id = rawId.toUpperCase();
      current = groups.get(id);
      if (current && current.address.toUpperCase() !== address.toUpperCase()) return fail("listing_history_identity_ambiguous", entry.page_number);
      if (!current) { current = { id, address, entry, rows: [], keys: new Set() }; groups.set(id, current); }
      table = false; continue;
    }
    if (/^MLS\s*#/i.test(entry.line)) return fail("listing_history_identity_ambiguous", entry.page_number);
    if (TABLE.test(entry.line)) {
      if (!current) return fail("listing_history_missing_listing_identity", entry.page_number);
      table = true; continue;
    }
    if (/^(?:\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}\s+[AP]M\s+)?Matrix$/i.test(entry.line)
      || /^https:\/\/[^/]*mlsmatrix\.com\/Matrix\//i.test(entry.line) || /^\d+\/\d+$/.test(entry.line)) continue;
    if (!table && /^(?:Closed|Active|Active Option Contract|Pending|Expired|Cancelled|Canceled|Withdrawn|Coming Soon)$/i.test(entry.line)) continue;
    if (!table) return fail("listing_history_unassigned_row", entry.page_number);
    const row = parseRow(entry);
    if (!row) return fail("listing_history_row_unparseable", entry.page_number);
    const key = JSON.stringify([row.type, row.date, row.recorded_at, row.previous, row.next]);
    if (current.keys.has(key)) continue;
    current.keys.add(key); current.rows.push(row);
    if (++totalRows > LIMITS.rows) return fail("listing_history_row_limit_exceeded");
  }
  if (!groups.size) return fail("listing_history_missing_listing_identity");
  const numberedPagesComplete = pageCoverage(entries, pages.length);
  for (const group of groups.values()) {
    const rows = group.rows.sort((a, b) => a.date.localeCompare(b.date) || a.recorded_at.localeCompare(b.recorded_at));
    const origins = rows.filter(row => row.type === "status" && row.previous === "INC" && ["CSN", "ACT", "A"].includes(row.next));
    if (origins.length > 1 || !rows.length) return fail("listing_history_origin_ambiguous", group.entry.page_number);
    const prices = rows.filter(row => row.type === "price");
    for (let index = 1; index < prices.length; index += 1) {
      if (prices[index].previous !== prices[index - 1].next
        || (prices[index].date === prices[index - 1].date && prices[index].recorded_at === prices[index - 1].recorded_at)) {
        return fail("listing_history_price_chain_incomplete", prices[index].page_number);
      }
    }
    const reductions = prices.filter(row => Number(row.next) < Number(row.previous));
    const complete = numberedPagesComplete && origins.length === 1 && rows[0] === origins[0];
    const projectPrice = row => ({ date: row.date, change_date: row.change_date, previous_price: row.previous, new_price: row.next, page_number: row.page_number });
    const summary = {
      schema_version: 1, listing_id: group.id, property_address: group.address,
      list_date: origins[0]?.date || null, coverage: complete ? "complete" : "partial",
      coverage_basis: complete ? "matrix_numbered_pages_and_initial_listing_event" : "unverified_start_or_page_coverage",
      reductions: reductions.map(projectPrice), reduction_count: reductions.length,
      first_reduction_date: reductions[0]?.date || null, last_reduction_date: reductions.at(-1)?.date || null,
      final_list_price: prices.at(-1)?.next || null, price_changes: prices.map(projectPrice),
    };
    const normalized = JSON.stringify(summary);
    if (normalized.length > LIMITS.serialized) return fail("listing_history_summary_limit_exceeded");
    const evidence = ["Listing History from MLS", group.entry.line, ...rows.map(row => row.evidence)].join("\n").slice(0, 2_000);
    result.candidates.push({ field_key: "listing_price_history", raw_value: evidence, normalized_value: normalized,
      page_number: group.entry.page_number, evidence_excerpt: evidence, review_status: "suggested", confidence: 0.9,
      source_kind: "mls_sheet", extraction_method: "urar_subject_mls_sheet_listing_price_history" });
    if (!complete) result.unresolved.push({ field_key: "listing_price_history", reason: "listing_history_coverage_incomplete", listing_id: group.id });
  }
  return result;
}
