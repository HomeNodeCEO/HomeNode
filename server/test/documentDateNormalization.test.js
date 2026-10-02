import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const serviceUrl = new URL("../src/services/documentIntelligence.js", import.meta.url).href;
const calendarCases = [
  ["September 24, 2026", "2026-09-24"],
  ["24 September 2026", "2026-09-24"],
  ["2026 September 24", "2026-09-24"],
  ["Sep. 24, 26", "2026-09-24"],
  ["2026/09/24", "2026-09-24"],
  ["2026.09.24", "2026-09-24"],
  ["2026-09-24", "2026-09-24"],
  ["09/24/2026", "2026-09-24"],
  ["09/24/26", "2026-09-24"],
  ["2026-09-24T00:30:00", "2026-09-24"],
  ["2026-09-24T23:30:00", "2026-09-24"],
  ["January 1, 2026", "2026-01-01"],
  ["December 31, 2026", "2026-12-31"],
  ["February 29, 2024", "2024-02-29"],
  ["2024-02-29T00:30:00", "2024-02-29"],
];
const instantCases = [
  ["2026-09-24T23:30:00-05:00", "2026-09-25"],
  ["2026-09-24T00:30:00+09:00", "2026-09-23"],
  ["2026-09-24T23:30:00-0500", "2026-09-25"],
  ["2026-09-24T00:30:00+0900", "2026-09-23"],
  ["2026-09-24T00:30:00Z", "2026-09-24"],
  ["2026-01-01T00:30:00+14:00", "2025-12-31"],
  ["2026-12-31T23:30:00-05:00", "2027-01-01"],
  ["2024-02-29T23:30:00-05:00", "2024-03-01"],
];
const textualTimeCases = [
  ["September 24, 2026 00:30:00", "2026-09-24"],
  ["September 24, 2026 11:30:00 PM", "2026-09-24"],
  ["September 24, 2026 00:30:00 GMT+0900", "2026-09-23"],
  ["September 24, 2026 23:30:00 UTC-0500", "2026-09-25"],
  ["24 Sep 2026 00:30:00 +0900", "2026-09-23"],
  ["September 24, 2026 23:30:00 -0500", "2026-09-25"],
  ["September 24, 2026 11:30:00 PM GMT-0500", "2026-09-25"],
  ["September 24, 2026 12:30 AM UTC+0900", "2026-09-23"],
  ["September 24, 2026 23:30:00 GMT-05:00", "2026-09-25"],
  ["2026/09/24 00:30:00 UTC+0900", "2026-09-23"],
  ["September 24, 2026 00:30:00 GMT", "2026-09-24"],
  ["September 24, 2026 00:30:00 UTC", "2026-09-24"],
];
const invalidTextualTimeCases = [
  "September 24, 2026 00:30:00 GMT+2500",
  "September 24, 2026 00:30:00 GMT+0999",
  "September 24, 2026 00:30:00 GMT+09",
  "September 24, 2026 00:30:00 +090",
  "September 24, 2026 00:30:00 EST",
  "September 24, 2026 00:30:00 PDT",
  "September 24, 2026 00:30:00 GMT+0900junk",
  "February 30, 2026 00:30:00 GMT+0900",
].map(source => [source, null]);
const invalidCases = [
  "February 30, 2026", "29 February 2025", "2026/02/30", "2026.02.30",
  "2026-02-30T00:30:00", "2025-02-29T23:30:00-05:00", "02/30/2026",
  "2026-09-24T00:30:00+25:00", "2026-09-24T00:30:00+09:99",
  "2026-09-24T00:30:00+090", "2026-09-24T00:30:00Zjunk", "00:30:00+09:00",
].map(source => [source, null]);

function extractInTimezone(timezone, cases) {
  const program = `
    import { buildDocumentFieldCandidates } from ${JSON.stringify(serviceUrl)};
    const cases = ${JSON.stringify(cases)};
    const results = cases.map(([source]) => {
      const read = (documentType, label, field) => buildDocumentFieldCandidates({
        documentType, pages: [label + ': ' + source],
      }).find(candidate => candidate.field_key === field)?.normalized_value ?? null;
      return { source, contract: read('purchase_contract', 'Contract Date', 'contract_date'),
        listing: read('mls_sheet', 'List Date', 'list_date') };
    });
    process.stdout.write(JSON.stringify({offset: new Date(2026, 8, 24).getTimezoneOffset(), results}));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    env: { ...process.env, TZ: timezone }, encoding: "utf8", timeout: 15_000,
    windowsHide: true, maxBuffer: 500_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

for (const [timezone, offset] of [["UTC", 0], ["Asia/Tokyo", -540], ["America/Chicago", 300]]) {
  test(`timezone-free document dates preserve their printed calendar day in ${timezone}`, () => {
    const actual = extractInTimezone(timezone, calendarCases);
    assert.equal(actual.offset, offset, "child must exercise the requested timezone");
    for (const [index, [source, expected]] of calendarCases.entries()) {
      assert.equal(actual.results[index].contract, expected, `${source}: contract`);
      assert.equal(actual.results[index].listing, expected, `${source}: listing`);
    }
  });

  test(`explicit document-date offsets retain UTC rollover in ${timezone}`, () => {
    const actual = extractInTimezone(timezone, instantCases);
    for (const [index, [source, expected]] of instantCases.entries()) {
      assert.equal(actual.results[index].contract, expected, `${source}: contract`);
      assert.equal(actual.results[index].listing, expected, `${source}: listing`);
    }
  });

  test(`invalid document calendars and offsets stay unresolved in ${timezone}`, () => {
    const actual = extractInTimezone(timezone, invalidCases);
    for (const result of actual.results) {
      assert.equal(result.contract, null, `${result.source}: contract`);
      assert.equal(result.listing, null, `${result.source}: listing`);
    }
  });

  test(`textual document times preserve explicit GMT/UTC and numeric offsets in ${timezone}`, () => {
    const actual = extractInTimezone(timezone, textualTimeCases);
    for (const [index, [source, expected]] of textualTimeCases.entries()) {
      assert.equal(actual.results[index].contract, expected, source);
    }
  });

  test(`unsupported or malformed textual document zones stay unresolved in ${timezone}`, () => {
    const actual = extractInTimezone(timezone, invalidTextualTimeCases);
    for (const result of actual.results) assert.equal(result.contract, null, result.source);
  });
}
