import assert from "node:assert/strict";
import test from "node:test";
import { trecContractSubjectIdentityCandidate } from "../src/services/trecContractSubjectIdentity.js";
import { buildDocumentFieldCandidates } from "../src/services/documentIntelligence.js";
import { sfrepDocumentPropertyRole } from "../src/services/sfrepSubjectContext.js";

const title = "PROMULGATED BY THE TEXAS REAL ESTATE COMMISSION (TREC)\n05-04-2026\nONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)";
const address = "100 Example Drive , Exampleton, Tx 75000";
const header = (page, total = 3, place = address) => `Contract Concerning ${place} Page ${page} of ${total} 05-04-2026\n(Address of Property)`;
const pages = () => [title, header(2), `${header(3)}\nContract Date: 08/20/2026`];

test("complete TREC headers yield one exact page-cited reviewable Subject identity", () => {
  const source = pages(), before = [...source];
  const candidate = trecContractSubjectIdentityCandidate(source);
  assert.equal(candidate.field_key, "subject_property_address");
  assert.equal(candidate.normalized_value, "100 Example Drive, Exampleton, TX 75000");
  assert.equal(candidate.raw_value, address); assert.equal(candidate.page_number, 2);
  assert.equal(candidate.review_status, "suggested"); assert.match(candidate.evidence_excerpt, /^Contract Concerning/);
  assert.deepEqual(source, before);
  const doc = { id: 1, processing_status: "reviewed", subject_context: { address: "100 Example Dr", city: "Exampleton", state: "TX", postalCode: "75000" }, candidates: [{ ...candidate, id: 11, document_id: 1, review_status: "confirmed", confirmed_value: candidate.normalized_value }] };
  assert.equal(sfrepDocumentPropertyRole(doc), "subject");
  assert.equal(sfrepDocumentPropertyRole({ ...doc, candidates: [{ ...doc.candidates[0], review_status: "suggested" }] }), "unknown");
  assert.equal(sfrepDocumentPropertyRole({ ...doc, subject_context: { ...doc.subject_context, address: "200 Other Dr" } }), "comparable");
});

test("conflicting, missing, malformed or unnumbered contract headers cannot prove Subject identity", () => {
  for (const source of [
    [title, header(2), header(3, 3, "200 Different Dr, Exampleton, TX 75000")],
    [title, header(2), header(3, 3, "100 Example Drive, Dallas, TX 75000")],
    [title, header(2), "No readable third-page identity"],
    [title, header(2), `${header(3)}\n${header(3)}`],
    [title, header(2), header(3, 4)],
    [title, header(3), header(2)],
    [title, header(2), "Contract Concerning 100 Example Drive, Exampleton, TX 75000"],
    [title, header(2), header(3, 3, "100 Example Drive, Exampleton, ZZ 75000")],
    [title, header(2), header(3, 3, "100 Example Drive, Exampleton, TX UNKNOWN")],
  ]) assert.equal(trecContractSubjectIdentityCandidate(source), null);
});

test("standalone addenda, incidental addresses, later copies and mixed contracts do not claim Subject", () => {
  for (const source of [
    ["THIRD PARTY FINANCING ADDENDUM", header(2, 2)],
    ["NON-REALTY ITEMS ADDENDUM", header(2, 2)],
    ["A letter quoting the ONE TO FOUR FAMILY RESIDENTIAL CONTRACT (RESALE)", header(2, 2)],
    ["A cover page", title, header(3)],
    [title, header(2), `${header(3)}\n${title}`],
  ]) assert.equal(trecContractSubjectIdentityCandidate(source), null);
  const attached = [...pages(), "THIRD PARTY FINANCING ADDENDUM\nProperty Address: 100 Example Drive, Exampleton, TX 75000"];
  assert.ok(trecContractSubjectIdentityCandidate(attached));
});

test("contract identity is additive and unreadable identity does not disable established contract fields", () => {
  const source = pages();
  const candidates = buildDocumentFieldCandidates({ documentType: "purchase_contract", pages: source });
  assert.equal(candidates.find(item => item.field_key === "subject_property_address")?.normalized_value, "100 Example Drive, Exampleton, TX 75000");
  assert.equal(candidates.find(item => item.field_key === "contract_date")?.normalized_value, "2026-08-20");
  const damaged = buildDocumentFieldCandidates({ documentType: "purchase_contract", pages: [...source, "\uFFFD"] });
  assert.equal(damaged.find(item => item.field_key === "subject_property_address"), undefined);
  assert.equal(damaged.find(item => item.field_key === "contract_date")?.normalized_value, "2026-08-20");
});

test("recognizable first-page Section 2 property identity must agree with every later header", () => {
  const land = (street = "100 Example Drive", city = "Exampleton", zip = "75000") => [
    title, "2. PROPERTY: The land, improvements and accessories are collectively referred to as the Property.",
    "A. LAND: Lot 1 Block A Example Addition", `Addition, City of ${city} , County of Dallas`,
    `Texas, known as ${street} ${zip}`, "(address/zip code), or as described on attached exhibit.",
    "B. IMPROVEMENTS: The house and fixtures.", "3. SALES PRICE: $300,000",
  ].join("\n");
  const complete = [land(), header(2), header(3)];
  assert.ok(trecContractSubjectIdentityCandidate(complete));
  for (const pageOne of [land("200 Different Drive"), land("100 Example Drive", "Dallas"),
    land("100 Example Drive", "Exampleton", "75201"), land().replace("known as 100 Example Drive 75000", "known as UNKNOWN")]) {
    assert.equal(trecContractSubjectIdentityCandidate([pageOne, header(2), header(3)]), null);
  }
  assert.ok(trecContractSubjectIdentityCandidate([`${land()}\nBroker Address: 200 Different Drive, Dallas, TX 75201`, header(2), header(3)]));
});
