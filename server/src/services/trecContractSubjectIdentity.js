import { isUrarStateCode } from "../util/urarScalarValidation.js";

function firstPageLandIdentityAgrees(lines, header) {
  const start = lines.findIndex(line => /^2\.\s*PROPERTY\s*:/i.test(line));
  if (start < 0) return true;
  const end = lines.findIndex((line, index) => index > start && /^(?:B\.\s*IMPROVEMENTS|3\.\s*SALES PRICE)\s*:/i.test(line));
  const section = lines.slice(start, end > start ? end : start + 15).join(" ");
  // Inspect only the labeled Section 2A property description. A brokerage,
  // notice, or addendum address elsewhere on page one is not a contradiction.
  if (!/\bA\.\s*LAND\s*:/i.test(section) || !/\bAddition,\s*City of\b/i.test(section)) return true;
  if (section.length > 2_500) return false;
  const match = section.match(/\bAddition,\s*City of\s+([A-Za-z][A-Za-z .'-]{0,99}?)\s*,\s*County of\s+[A-Za-z][A-Za-z .'-]{0,99}?\s*,?\s*Texas,\s*known as\s+(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?:\s+1\/2)?\s+[^,]{1,200}?)\s+(\d{5}(?:-\d{4})?)\s*\(address\s*\/\s*zip code\)/i);
  if (!match) return false;
  const [, city, street, postalCode] = match;
  const normalize = value => value.replace(/\s+/g, " ").trim().toUpperCase();
  return normalize(street) === normalize(header.street) && normalize(city) === normalize(header.city)
    && header.state === "TX" && postalCode.slice(0, 5) === header.postalCode.slice(0, 5);
}

/** The subject must be named by the contract, not by the workfile it happens to
 * be uploaded into. Only the complete TREC resale form and its repeated numbered
 * "Contract Concerning" headers qualify here. Addenda and incidental addresses
 * retain their own parsers and cannot acquire Subject identity from this helper. */
export function trecContractSubjectIdentityCandidate(pages) {
  if (!Array.isArray(pages) || pages.length < 2 || pages.length > 250) return null;
  let total = 0;
  const prepared = [];
  for (const text of pages) {
    if (typeof text !== "string" || text.length > 500_000 || (total += text.length) > 4_000_000
      || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(text)) return null;
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
    if (lines.length > 10_000 || lines.some(line => line.length > 4_000)) return null;
    prepared.push(lines);
  }
  const title = /^ONE TO FOUR FAMILY RESIDENTIAL CONTRACT\s*\(RESALE\)$/i;
  if (!prepared[0].slice(0, 40).some(line => title.test(line))
    || !prepared[0].slice(0, 40).some(line => /^PROMULGATED BY THE TEXAS REAL ESTATE COMMISSION\s*\(TREC\)$/i.test(line))
    || prepared.flat().filter(line => title.test(line)).length !== 1) return null;
  const headers = [];
  for (let index = 1; index < prepared.length; index += 1) {
    const named = prepared[index].filter(line => /^Contract Concerning\b/i.test(line));
    if (!named.length) continue; // Appended addenda do not count as form pages.
    if (named.length !== 1 || !prepared[index].slice(0, 12).includes(named[0])) return null;
    const match = named[0].match(/^Contract Concerning\s+(.+?)\s+Page\s+(\d{1,3})\s+of\s+(\d{1,3})(?:\s+\d{2}-\d{2}-\d{4})?$/i);
    if (!match || Number(match[2]) !== index + 1 || Number(match[3]) > pages.length || Number(match[3]) < index + 1) return null;
    const address = match[1].match(/^(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?:\s+1\/2)?\s+[^,]{1,200})\s*,\s*([A-Za-z][A-Za-z .'-]{0,99})\s*,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (!address || !isUrarStateCode(address[3].toUpperCase()) || !/[A-Za-z]/.test(address[1])) return null;
    const normalized = `${address[1].replace(/\s+/g, " ").trim()}, ${address[2].trim()}, ${address[3].toUpperCase()} ${address[4]}`;
    headers.push({ raw: match[1], normalized, page: index + 1, total: Number(match[3]), evidence: named[0],
      street: address[1], city: address[2], state: address[3].toUpperCase(), postalCode: address[4] });
  }
  if (!headers.length || new Set(headers.map(header => header.total)).size !== 1
    || headers.length !== headers[0].total - 1 || new Set(headers.map(header => header.normalized.toUpperCase())).size !== 1) return null;
  const first = headers[0];
  if (!firstPageLandIdentityAgrees(prepared[0], first)) return null;
  return { field_key: "subject_property_address", raw_value: first.raw, normalized_value: first.normalized,
    page_number: first.page, confidence: 0.98, evidence_excerpt: first.evidence,
    extraction_method: "trec_contract_concerning_subject_identity", review_status: "suggested" };
}
