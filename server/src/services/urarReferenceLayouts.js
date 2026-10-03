import { isUrarPlaceholder, isUrarStateCode } from "../util/urarScalarValidation.js";

/** Bounded, read-only adapters for verified DCAD and CoreLogic Property Details
 * text layouts. These are suggestions, never confirmation or subject identity. */
const LIMITS = { pages: 250, pageChars: 500_000, totalChars: 4_000_000, lines: 50_000, lineChars: 4_000 };
const compact = value => value.replace(/\s+/g, " ").trim();
const accountPattern = /^Residential Account\s*#\s*(\d{5,30})$/i;
const urlPattern = /^https:\/\/(?:www\.)?dallascad\.org\/AcctDetailRes\.aspx\?ID=(\d{5,30})(?:\s+\d+\/\d+)?$/i;
const cadTitle = /^(?:\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}\s+[AP]M\s+)?DCAD:\s*Residential Acct Detail$/i;
const locationTitle = /^Property Location\s*\(Current\s+\d{4}\)$/i;
const ownerTitle = /^Owner\s*\(Current\s+\d{4}\)$/i;
const legalTitle = /^Legal Desc\s*\(Current\s+\d{4}\)$/i;
const cadBoundary = /^(?:(?:Property Location|Owner|Multi-Owner|Legal Desc|Main Improvement|Additional Improvements)\s*\([^)]*\)|(?:Value|Appraisal Record|ARB Hearing|Land|Exemptions|Estimated Taxes|History)(?:\s*\([^)]*\))?|https:\/\/|(?:\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}\s+[AP]M\s+)?DCAD:)/i;
const taxHeader = /^Tax Year\s+Total Tax\s+Change\s*\(\$\)\s+Change\s*\(%\)$/i;
const realistFooter = /^Property Details(?:\s*\|\s*|\s+)Courtesy of\b.+\bGenerated on:\s*\S+/i;
const disclaimer = /The data within this report is compiled by CoreLogic from public and private sources\./i;

function boundedPages(pages, unresolved) {
  if (!Array.isArray(pages) || pages.length > LIMITS.pages) {
    unresolved.push({ reason: "reference_layout_page_limit_or_invalid_input" }); return null;
  }
  let total = 0, count = 0;
  const result = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (typeof page !== "string" || page.length > LIMITS.pageChars
      || (total += page.length) > LIMITS.totalChars || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(page)) {
      unresolved.push({ page_number: index + 1, reason: "reference_layout_text_limit_or_unreadable" }); return null;
    }
    const lines = page.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
    if ((count += lines.length) > LIMITS.lines || lines.some(line => line.length > LIMITS.lineChars)) {
      unresolved.push({ page_number: index + 1, reason: "reference_layout_line_limit_exceeded" }); return null;
    }
    result.push({ page_number: index + 1, lines });
  }
  return result;
}

function signatures(pages) {
  const all = pages.flatMap(page => page.lines);
  const cad = all.some(line => cadTitle.test(line)) && all.some(line => urlPattern.test(line))
    && all.some(line => accountPattern.test(line)) && all.some(line => locationTitle.test(line));
  const realist = pages.some(page => {
    const headings = new Set(page.lines.map(compact));
    return ["OWNER INFORMATION", "LOCATION INFORMATION", "TAX INFORMATION", "ASSESSMENT & TAX"].every(title => headings.has(title))
      && page.lines.some(line => realistFooter.test(line)) && disclaimer.test(page.lines.join(" "));
  });
  return { cad, realist };
}

/** Distinguish ordinary unrecognized layouts from unsafe/incomplete input so
 * callers cannot fall back to a permissive parser after a structural failure. */
export function inspectUrarReferenceLayout(pages) {
  const unresolved = [];
  const prepared = boundedPages(pages, unresolved);
  if (!prepared) return { sourceKind: null, unresolved };
  const found = signatures(prepared);
  if (found.cad && found.realist) unresolved.push({ reason: "reference_layout_mixed_sources" });
  return { sourceKind: found.cad === found.realist ? null : found.cad ? "cad" : "realist", unresolved };
}

/** Identify a complete layout signature, not an incidental brand or heading. */
export function identifyUrarReferenceLayout(pages) {
  return inspectUrarReferenceLayout(pages).sourceKind;
}

function matches(pages, pattern) {
  return pages.flatMap(page => page.lines.flatMap((line, index) => {
    const match = line.match(pattern);
    return match ? [{ ...page, index, line, match }] : [];
  }));
}

function section(pages, pattern, unresolved, fieldKey) {
  const starts = matches(pages, pattern);
  if (starts.length !== 1) {
    unresolved.push({ field_key: fieldKey, reason: starts.length ? "reference_section_ambiguous" : "reference_section_missing" }); return null;
  }
  const start = starts[0], lines = [];
  for (let index = start.index + 1; index < start.lines.length; index += 1) {
    if (cadBoundary.test(start.lines[index])) break;
    if (lines.length >= 80) {
      unresolved.push({ field_key: fieldKey, page_number: start.page_number, reason: "reference_section_limit_exceeded" }); return null;
    }
    lines.push(start.lines[index]);
  }
  return { page_number: start.page_number, title: start.line, lines };
}

function isStreet(value) {
  const match = value.match(/^\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?:\s+1\/2)?\s+(.+)$/);
  return value.length <= 300 && match && /[A-Za-z]/.test(match[1]) && !isUrarPlaceholder(match[1]);
}

function addCandidate(result, sourceKind, fieldKey, raw, normalized, pageNumber, evidence, method, confidence = 0.9) {
  if (!raw || !normalized || raw.length > 2_000 || normalized.length > 2_000 || evidence.length > 2_000
    || isUrarPlaceholder(normalized)) {
    result.unresolved.push({ field_key: fieldKey, page_number: pageNumber, reason: "reference_value_missing_or_unsafe" }); return;
  }
  result.candidates.push({ field_key: fieldKey, raw_value: raw, normalized_value: normalized, page_number: pageNumber,
    evidence_excerpt: evidence, extraction_method: `urar_subject_${sourceKind}_${method}`, source_kind: sourceKind,
    review_status: "suggested", confidence });
}

function extractCensusTract(result, sourceKind, lines, pageNumber, heading) {
  const labeled = lines.filter(line => /\bCensus Tract\b/i.test(line));
  if (!labeled.length) return;
  const values = labeled.map(line => ({ line, match: line.match(/\bCensus Tract(?: Number)?\s*:?\s+(\d{1,4}(?:\.\d{1,2})?)(?=$|\s+[A-Za-z])/i) }));
  if (values.some(item => !item.match) || new Set(values.map(item => item.match?.[1])).size !== 1) {
    result.unresolved.push({ field_key: "census_tract", page_number: pageNumber, reason: "reference_census_tract_missing_or_ambiguous" }); return;
  }
  const first = values[0];
  addCandidate(result, sourceKind, "census_tract", first.match[1], first.match[1], pageNumber,
    `${heading}\n${first.line}`, "property_location_census_tract");
}

function extractCad(pages, result) {
  const accounts = matches(pages, accountPattern), urls = matches(pages, urlPattern);
  const ids = new Set([...accounts, ...urls].map(item => item.match[1]));
  if (accounts.length !== 1 || matches(pages, /^Residential Account\b/i).length !== 1
    || matches(pages, /^https:\/\/(?:www\.)?dallascad\.org\/AcctDetailRes\.aspx\b/i).length !== urls.length
    || ids.size !== 1 || matches(pages, locationTitle).length !== 1) {
    result.unresolved.push({ reason: "cad_multiple_or_mismatched_records" }); return;
  }
  const account = accounts[0];
  addCandidate(result, "cad", "assessor_parcel_number", account.match[1], account.match[1], account.page_number,
    account.line, "dcad_account_layout");
  const location = section(pages, locationTitle, result.unresolved, "subject_property_address");
  if (location) {
    extractCensusTract(result, "cad", location.lines, location.page_number, location.title);
    const addresses = location.lines.map(line => ({ line, match: line.match(/^Address:\s*(.+)$/i) })).filter(item => item.match);
    if (addresses.length === 1 && isStreet(addresses[0].match[1])) {
      const item = addresses[0];
      addCandidate(result, "cad", "subject_property_address", item.match[1], compact(item.match[1]), location.page_number,
        `${location.title}\n${item.line}`, "dcad_property_location");
    } else result.unresolved.push({ field_key: "subject_property_address", page_number: location.page_number, reason: "cad_property_address_missing_or_ambiguous" });
    const counties = location.lines.map(line => ({ line, match: line.match(/^County:\s*([A-Za-z][A-Za-z .'-]{1,99})$/i) })).filter(item => item.match);
    if (counties.length === 1) {
      const item = counties[0];
      addCandidate(result, "cad", "county", item.match[1], compact(item.match[1]), location.page_number,
        `${location.title}\n${item.line}`, "dcad_property_county");
    } else result.unresolved.push({ field_key: "county", page_number: location.page_number, reason: "cad_county_not_explicit_or_ambiguous" });
  }
  const owner = section(pages, ownerTitle, result.unresolved, "owner_name");
  if (owner) {
    const mailingStart = owner.lines.findIndex(line => /^\d+[A-Za-z]?(?:[-/]\d+)?\s+\S|^P\.?\s*O\.?\s*BOX\b|^(?:C\/O|CARE OF|ATTN[:.]?)\s|^(?:(?:Owner\s+)?Mailing|Tax Billing)\s+(?:Address|City|State|Zip)(?:\s*[:=].*)?$|^Address(?:\s*[:=].*)?$/i.test(line));
    const names = mailingStart > 0 ? owner.lines.slice(0, mailingStart) : [];
    if (names.length >= 1 && names.length <= 4 && names.every(name => !isUrarPlaceholder(name)
      && /^[\p{L}][\p{L}\p{M} .,'&()/-]{1,199}$/u.test(name))) {
      addCandidate(result, "cad", "owner_name", names.join("\n"), names.join("\n"), owner.page_number,
        [owner.title, ...names].join("\n"), "dcad_current_owner");
    } else result.unresolved.push({ field_key: "owner_name", page_number: owner.page_number, reason: "cad_owner_block_missing_or_ambiguous" });
  }
  const legal = section(pages, legalTitle, result.unresolved, "legal_description");
  if (legal) {
    const rows = legal.lines.slice(0, 5).map(line => line.match(/^([1-5]):\s*(.*)$/));
    if (rows.length !== 5 || rows.some((row, index) => !row || Number(row[1]) !== index + 1)
      || legal.lines.slice(5).some(line => /^\d+:/.test(line))) {
      result.unresolved.push({ field_key: "legal_description", page_number: legal.page_number, reason: "cad_numbered_legal_incomplete_or_ambiguous" }); return;
    }
    const raw = rows.map(row => row[2]).filter(Boolean).join("\n");
    const evidence = [legal.title, ...legal.lines.slice(0, 5)].join("\n");
    addCandidate(result, "cad", "legal_description", raw, raw, legal.page_number, evidence, "dcad_numbered_legal");
    const name = rows[0][2], lotBlock = rows[1][2];
    if (/\b(?:BLK|BLOCK)\s+[A-Za-z0-9-]+\b/i.test(lotBlock) && /\b(?:LT|LOT)\s+[A-Za-z0-9-]+\b/i.test(lotBlock)
      && /^[A-Za-z][A-Za-z0-9 .,'&()/-]{2,199}$/.test(name) && !isUrarPlaceholder(name)
      && !/\b(?:ABSTRACT|TRACT|SURVEY|ACRES?|BEING|BEGINNING|THENCE|METES|BOUNDS|OWNER|ADDRESS|ACCOUNT|PARCEL)\b/i.test(name)) {
      addCandidate(result, "cad", "neighborhood_name", name, name, legal.page_number, evidence, "dcad_legal_subdivision_lot_block", 0.8);
    } else result.unresolved.push({ field_key: "neighborhood_name", page_number: legal.page_number, reason: "cad_legal_subdivision_not_explicit" });
  }
}

function fullPropertyHeader(line) {
  const match = line.match(/^(.+),\s*([A-Za-z][A-Za-z .'-]*),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?),\s*([A-Za-z][A-Za-z .'-]*?)\s+County(?:\s+(?:Active|Pending|Sold|Off Market|Inactive|Expired|Withdrawn|Cancelled)\s+Listing)?$/i);
  return match && isStreet(match[1]) && isUrarStateCode(match[3]) ? match : null;
}

function taxAmount(value) {
  const match = value.match(/^\$(\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.(\d{1,2}))?$/);
  return match ? `${match[1].replaceAll(",", "")}.${(match[2] || "").padEnd(2, "0")}` : null;
}

function extractRealistTaxes(pages, result, propertyPageNumber) {
  const tables = matches(pages, taxHeader);
  if (tables.length !== 1) {
    result.unresolved.push({ field_key: "tax_amount", reason: tables.length ? "realist_tax_tables_ambiguous" : "realist_total_tax_table_missing" }); return;
  }
  const table = tables[0];
  if (table.page_number !== propertyPageNumber) {
    result.unresolved.push({ field_key: "tax_amount", page_number: table.page_number, reason: "realist_tax_table_not_on_verified_property_page" }); return;
  }
  const assessment = table.lines.slice(0, table.index).findLastIndex(line => compact(line) === "ASSESSMENT & TAX");
  if (assessment < 0 || table.index - assessment > 60) {
    result.unresolved.push({ field_key: "tax_amount", page_number: table.page_number, reason: "realist_tax_table_outside_assessment_section" }); return;
  }
  const rows = [];
  let ended = false;
  for (let index = table.index + 1; index < table.lines.length && rows.length <= 30; index += 1) {
    const line = table.lines[index];
    if (/^Jurisdiction\s+Tax Amount\s+Tax Type\s+Tax Rate$|^CHARACTERISTICS$|^Property Details\b/i.test(line)) { ended = true; break; }
    const row = line.match(/^([12]\d{3})(?:\s+(.*))?$/);
    if (!row) {
      result.unresolved.push({ field_key: "tax_amount", page_number: table.page_number, reason: "realist_tax_table_row_ambiguous" }); return;
    }
    const columns = (row[2] || "").split(/\s+/).filter(Boolean);
    const validChanges = columns.length === 1 || (columns.length === 3
      && /^-?\$[\d,]+(?:\.\d{1,2})?$/.test(columns[1]) && /^-?\d+(?:\.\d+)?%$/.test(columns[2]));
    rows.push({ year: row[1], amount: validChanges ? taxAmount(columns[0] || "") : null, line, rawAmount: columns[0] });
  }
  if (!ended || !rows.length || rows.length > 30 || new Set(rows.map(row => row.year)).size !== rows.length) {
    result.unresolved.push({ field_key: "tax_amount", page_number: table.page_number, reason: "realist_tax_table_incomplete_or_duplicate_year" }); return;
  }
  const latest = rows.reduce((selected, row) => Number(row.year) > Number(selected.year) ? row : selected);
  if (!latest.amount) {
    result.unresolved.push({ field_key: "tax_amount", page_number: table.page_number, reason: "realist_latest_tax_year_incomplete" }); return;
  }
  if (rows.some(row => !row.amount)) result.unresolved.push({ field_key: "tax_amount", page_number: table.page_number, reason: "realist_prior_tax_year_incomplete" });
  const evidence = `ASSESSMENT & TAX\n${table.line}\n${latest.line}`;
  for (const [field, raw, normalized] of [["tax_year", latest.year, latest.year], ["tax_amount", latest.rawAmount, latest.amount]]) {
    addCandidate(result, "realist", field, raw, normalized, table.page_number, evidence, "property_details_total_tax_row");
  }
}

function extractRealist(pages, result) {
  const headers = pages.flatMap(page => page.lines.flatMap((line, index) => {
    const match = fullPropertyHeader(line);
    return match ? [{ ...page, line, index, match }] : [];
  }));
  const apns = matches(pages, /^APN:\s*([A-Za-z0-9.-]{2,80})(?:\s+CLIP:\s*[A-Za-z0-9-]+)?$/i);
  // Count recognizable record starts as well as successfully parsed values;
  // a second malformed/standalone APN must not borrow the first record's ID.
  const apnLabels = matches(pages, /^APN(?:\s*:|\s*$)/i);
  const recordHeaders = matches(pages, /^\d+[^\n]*,\s*[A-Z]{2}\s+[^,]+,\s*[^\n]+\s+County\b/i);
  if (headers.length !== 1 || apns.length !== 1 || apnLabels.length !== 1 || recordHeaders.length !== 1
    || matches(pages, /^OWNER INFORMATION$/).length !== 1 || matches(pages, /^LOCATION INFORMATION$/).length !== 1
    || headers[0].page_number !== apns[0].page_number
    || apns[0].index <= headers[0].index || apns[0].index - headers[0].index > 3
    || !signatures([headers[0]]).realist) {
    result.unresolved.push({ reason: "realist_property_identity_missing_or_multiple_records" }); return;
  }
  const header = headers[0], apn = apns[0], [, street, city, state, zip, county] = header.match;
  const address = `${street}, ${city}, ${state.toUpperCase()} ${zip}`;
  for (const [field, value] of [["subject_property_address", address], ["subject_street_address", street], ["subject_city", city],
    ["subject_state", state.toUpperCase()], ["subject_zip", zip], ["county", county]]) {
    addCandidate(result, "realist", field, value, value, header.page_number, header.line, "property_details_subject_header");
  }
  addCandidate(result, "realist", "assessor_parcel_number", apn.match[1], apn.match[1], apn.page_number, apn.line, "property_details_apn");
  const locationStart = header.lines.findIndex(line => line === "LOCATION INFORMATION");
  const locationEnd = header.lines.findIndex((line, index) => index > locationStart && line === "TAX INFORMATION");
  if (locationStart >= 0 && locationEnd > locationStart && locationEnd - locationStart <= 80) {
    extractCensusTract(result, "realist", header.lines.slice(locationStart + 1, locationEnd), header.page_number, "LOCATION INFORMATION");
  }
  extractRealistTaxes(pages, result, header.page_number);
}

/** Return page-cited suggestions and bounded diagnostics. Even an explicitly
 * supplied sourceKind must match the document's full source-layout signature. */
export function extractUrarReferenceLayout({ sourceKind, pages } = {}) {
  const result = { candidates: [], unresolved: [] };
  const prepared = boundedPages(pages, result.unresolved);
  if (!prepared) return result;
  const found = signatures(prepared);
  if (found.cad && found.realist) { result.unresolved.push({ reason: "reference_layout_mixed_sources" }); return result; }
  if (!["cad", "realist"].includes(sourceKind) || !found[sourceKind]) {
    result.unresolved.push({ reason: "reference_layout_source_not_verified" }); return result;
  }
  if (sourceKind === "cad") extractCad(prepared, result);
  else extractRealist(prepared, result);
  return result;
}
