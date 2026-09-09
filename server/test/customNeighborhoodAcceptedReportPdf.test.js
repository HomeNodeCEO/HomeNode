import assert from "node:assert/strict";
import test from "node:test";
import { extractText, getDocumentProxy } from "unpdf";
import { buildCustomAppraisalReportPdf, customAppraisalReportReadiness, renderCustomAppraisalReportPdf,
  ensureSignedCustomAppraisalReportArtifact } from "../src/services/customAppraisalReportPdf.js";
import { drawCustomNeighborhoodOutline } from "../src/services/customNeighborhoodReportPdf.js";
import { customNeighborhoodReportPdfFixture } from "./fixtures/customNeighborhoodReportPdfFixture.js";

const fixture = customNeighborhoodReportPdfFixture;
const blocked = ({ snapshot, property }) => customAppraisalReportReadiness(snapshot, property).blockers.some(item => item.code === "custom_neighborhood_report_unavailable");
async function reportFor(value, { photos = 0, accountId, assignmentFileId } = {}) {
  const queries = [];
  const client = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql === "SELECT to_regclass($1) AS name") {
      assert.deepEqual(params, ["app.inspection_photos"]);
      return { rows: [{ name: photos ? "app.inspection_photos" : null }] };
    }
    assert.match(sql, /FROM app.report_files report_file[\s\S]*JOIN app.inspection_photos/);
    return { rows: Array.from({ length: photos }, (_, index) => ({ id: `photo-${index}`, origin_channel: "mobile", category: "Interior",
      caption: `PHOTO_END_${index}`, position: index, captured_at: null, object_key: null, content_type: null })) };
  } };
  const report = await buildCustomAppraisalReportPdf(client, { snapshot: value.snapshot, accountId: accountId ?? value.property.account.account_id,
    assignmentFileId: assignmentFileId ?? value.snapshot.assignment_file_id, includeExternalImages: false });
  const parsed = await extractText(new Uint8Array(report.content), { mergePages: false });
  assert.equal(report.page_count, parsed.totalPages);
  parsed.text.forEach((page, index) => assert.ok(page.includes(`Page ${index + 1} of ${report.page_count}`), `Missing correct header on page ${index + 1}`));
  return { ...report, pages: parsed.text.map(text => text.replace(/\s+/g, " ")), queries };
}

test("reserved accepted catalog replaces every legacy neighborhood display without mutating snapshot", async () => {
  const value = fixture(), details = value.snapshot.assignment.assignment_details;
  for (const field of Object.keys(details).filter(key => key.startsWith("neighborhood_"))) details[field] = "LEGACY_NEIGHBORHOOD_SENTINEL";
  const before = structuredClone(value.snapshot);
  assert.equal(blocked(value), false);
  assert.deepEqual(customAppraisalReportReadiness(value.snapshot, value.property).blockers, []);
  const report = await reportFor(value), text = report.pages.join(" ");
  assert.deepEqual(value.snapshot, before);
  assert.doesNotMatch(text, /LEGACY_NEIGHBORHOOD_SENTINEL/);
  assert.match(report.pages[2], /ACCEPTED NEIGHBORHOOD GROUP/);
  assert.match(report.pages[2], /North Road/);
  assert.match(text, /Selected competitive pocket IDs[\s\S]*pocket-a[\s\S]*pocket-b/);
  assert.match(text, /Member count: 3 \(Canonical transactions\); unique property count: 2/);
  assert.match(text, /Member count: 33 \(Listings\); unique property count: 31/);
  assert.match(text, /Recorded sale price[\s\S]*Estimator: Median; status: ready; value: \$330,000 USD/);
  assert.match(text, /CAD assessed market value \(not a sale price\); tax year: 2024[\s\S]*\$410,001 USD/);
  assert.match(text, /CAD assessed value per square foot \(not a sale price\); tax year: 2024[\s\S]*\$205.00 USD\/ft2/);
  assert.match(text, /Predominant modal interval \[lower, upper\); status: ready; value: \[\$300,000, \$350,000\) USD; supplied value \$335,001 USD/);
  assert.match(text, /Age at sale[\s\S]*18 years/);
  assert.match(text, /Age at effective date[\s\S]*20 years/);
  assert.match(text, /Package-allocated property sale price \(not a recorded transaction price\)[\s\S]*\$120,001 USD/);
  assert.match(text, /Observed: 2; missing: 0; denominator: 2; denominator basis: unique properties/);
  assert.match(text, /Observed: 0; missing: 4; denominator: 4; denominator basis: population members/);
  assert.match(text, /status: ready; value: 0 percent/);
  assert.match(text, /status: ready; value: 0 properties/);
  assert.match(text, /Unavailable - denominator_unavailable/);
  assert.match(text, /Unavailable - no_supported_modal_estimator/);
  assert.match(text, /COD is dispersion, not reliability/);
  assert.match(text, /Source fixture-source - synthetic-replay/);
  assert.ok(text.includes(value.assessment.source_snapshots[0].content_sha256));
  assert.equal(report.queries.length, 1, "No latest assessment, source, acceptance or report-link lookup");
});

test("all statistics beyond thirty and full long descriptions paginate before photos with exact page counts", async () => {
  const value = fixture({ extraStatistics: 45, longDescriptions: true });
  const report = await reportFor(value, { photos: 5 }), text = report.pages.join(" ");
  for (const population of value.assessment.populations) assert.ok(text.includes(`Population ${population.id} -`));
  for (const statistic of value.assessment.statistics) assert.ok(text.includes(`Statistic ${statistic.id} -`), statistic.id);
  for (const marker of ["NORTH_END_MARKER", "DEFINITION_END_MARKER", "REASON_END_MARKER"]) assert.ok(text.includes(marker), marker);
  assert.ok(report.page_count > 12);
  assert.match(report.pages.at(-1), /Subject Photo Appendix[\s\S]*PHOTO_END_4/);
  assert.match(report.pages.at(-2), /Subject Photo Appendix[\s\S]*PHOTO_END_0[\s\S]*PHOTO_END_3/);
  assert.match(report.pages.at(-3), /Neighborhood Evidence Appendix/);
  const appendixEnd = report.page_count - 2;
  assert.ok(report.pages[2].includes(`appendix pages 10-${appendixEnd}`));
  // Actual positioned text proves precomputed appendix lines stay clear of footer.
  const pdf = await getDocumentProxy(new Uint8Array(report.content));
  try {
    for (let pageNo = 10; pageNo <= appendixEnd; pageNo++) {
      const page = await pdf.getPage(pageNo), textContent = await page.getTextContent();
      const body = textContent.items.filter(item => item.transform?.[5] < 704 && item.transform?.[5] > 40);
      assert.ok(body.length > 0);
      for (const item of body) assert.ok(item.transform[5] >= 50, `Appendix text overlaps footer on page ${pageNo}`);
    }
  } finally { await pdf.loadingTask.destroy(); }
});

test("PDF formats money, per-square-foot values, percentages and counts without changing exact accepted facts", async () => {
  const value = fixture({ mutateRaw(raw) {
    raw.statistics.find(stat => stat.id === "median-sale-price").value = 1234567.891;
    raw.statistics.find(stat => stat.id === "cad-per-sf").value = 1234.56789;
    raw.statistics.find(stat => stat.id === "sale-cod").value = 12.34567;
    const listings = raw.populations.find(population => population.id === "listings-a");
    Object.assign(listings, { member_count: 3456, unique_property_count: 1234, property_link_count: 3456 });
    Object.assign(raw.statistics.find(stat => stat.id === "listing-count"), { value: 3456, observed_count: 3456, denominator_count: 3456 });
  } });
  const before = structuredClone(value.snapshot), report = await reportFor(value), text = report.pages.join(" ");
  assert.match(text, /value: \$1,234,567.89 USD/);
  assert.match(text, /value: \$1,234.57 USD\/ft2/);
  assert.match(text, /value: 12.35 percent/);
  assert.match(text, /value: 3,456 listings/);
  assert.match(text, /Member count: 3,456 \(Listings\); unique property count: 1,234; property link count: 3,456/);
  assert.match(text, /Observed: 3,456; missing: 0; denominator: 3,456/);
  assert.deepEqual(value.snapshot, before);
  assert.equal(value.assessment.statistics.find(stat => stat.id === "cad-per-sf").value, 1234.56789);
});

test("outline draws each supplied hole/disconnected ring as a separate closed path with even-odd fill", () => {
  const rings = [
    [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
    [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]],
    [[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]],
  ];
  const calls = [], doc = {};
  for (const method of ["roundedRect", "fillAndStroke", "save", "lineWidth", "fillOpacity", "strokeOpacity", "moveTo", "lineTo", "closePath", "restore"]) doc[method] = (...args) => { calls.push([method, ...args]); return doc; };
  drawCustomNeighborhoodOutline(doc, { type: "Polygon", coordinates: rings }, { x: 42, y: 184, width: 300, height: 202 });
  assert.equal(calls.filter(([name]) => name === "moveTo").length, 3);
  assert.equal(calls.filter(([name]) => name === "closePath").length, 3);
  assert.equal(calls.filter(([name]) => name === "lineTo").length, 12);
  assert.deepEqual(calls.filter(([name]) => name === "fillAndStroke").at(-1), ["fillAndStroke", "#7c3aed", "#5b21b6", "even-odd"]);
  const paths = calls.filter(([name]) => ["moveTo", "lineTo", "closePath"].includes(name));
  for (let index = 0; index < 3; index++) assert.equal(paths[index * 6][0], "moveTo");
});

for (const [name, mutate] of [
  ["explicit null", value => { value.snapshot.sections.neighborhood_assessment = null; }],
  ["explicit missing value", value => { value.snapshot.sections.neighborhood_assessment.value = undefined; }],
  ["empty value", value => { value.snapshot.sections.neighborhood_assessment.value = {}; }],
  ["missing section revision", value => { delete value.snapshot.sections.neighborhood_assessment.revision; }],
  ["mismatched section revision", value => { value.snapshot.sections.neighborhood_assessment.revision++; }],
  ["coerced section revision", value => { value.snapshot.sections.neighborhood_assessment.revision = String(value.section.accepted_editor_revision); }],
  ["bare section without saved revision", value => { value.snapshot.sections.neighborhood_assessment = value.section; }],
  ["unknown catalog", value => { value.section.mapped_values["custom-neighborhood-report:evidence"].value.mapper_version = "unknown"; }],
  ["partial group", value => { delete value.section.mapped_values["custom-neighborhood-report:selection"]; }],
  ["tampered statistic", value => { value.section.mapped_values["custom-neighborhood-report:statistics"].value[0].value = 999999; }],
  ["tampered boundary", value => { value.section.mapped_values["custom-neighborhood-report:geography"].value.cardinal_summaries.north = "TAMPERED"; }],
  ["malformed operation", value => { value.section.operation_id = null; }],
  ["different assignment", value => { value.snapshot.assignment_file_id++; }],
  ["different account", value => { value.property.account.account_id = "another-account"; }],
  ["different organization", value => { value.snapshot.signature.organization_id = "ffffffff-0000-4000-8000-000000000001"; }],
  ["explicit missing organization", value => { value.snapshot.assignment.organization_id = null; }],
  ["different report", value => { value.snapshot.evidence.report_files[0].id = "ffffffff-0000-4000-8000-000000000001"; }],
  ["wrong report assignment", value => { value.snapshot.evidence.report_files[0].custom_assignment_file_id++; }],
  ["wrong report workflow", value => { value.snapshot.evidence.report_files[0].workflow_type = "uad_3_6"; }],
  ["explicit missing report capture", value => { value.snapshot.evidence.report_files = []; }],
  ["ambiguous reports", value => { value.snapshot.evidence.report_files.push(structuredClone(value.snapshot.evidence.report_files[0])); }],
]) test(`${name} blocks readiness and aborts PDF, never returning legacy neighborhood data`, async () => {
  const value = fixture(); mutate(value);
  assert.equal(blocked(value), true);
  await assert.rejects(renderCustomAppraisalReportPdf(value), { code: "custom_neighborhood_report_unavailable" });
});

test("draft requires independently captured report binding while trusted signed snapshot supports absent-only UUID fallback", async () => {
  const value = fixture(); delete value.snapshot.evidence.report_files;
  assert.equal(blocked(value), false);
  assert.ok((await reportFor(value)).page_count > 9);
  value.snapshot.status = "draft";
  assert.equal(blocked(value), true);
  await assert.rejects(reportFor(value), { code: "custom_neighborhood_report_unavailable" });
});

test("draft accepts an exact captured report binding and request identity cannot override stored target", async () => {
  const value = fixture(); value.snapshot.status = "draft";
  assert.equal(blocked(value), false);
  assert.ok((await reportFor(value)).page_count > 9);
  await assert.rejects(reportFor(value, { assignmentFileId: 999 }), { code: "custom_neighborhood_report_unavailable" });
  await assert.rejects(reportFor(value, { accountId: "another-account" }), { code: "custom_neighborhood_report_unavailable" });
  await assert.rejects(buildCustomAppraisalReportPdf({ query() { assert.fail("Mismatched accepted target must not load optional media"); } }, {
    snapshot: value.snapshot, accountId: "another-account", assignmentFileId: value.snapshot.assignment_file_id,
  }), { code: "custom_neighborhood_report_unavailable" });
});

test("signed stored PDF remains byte-identical and bypasses projection even with missing/malformed source snapshot", async () => {
  const original = { canonical_file_name: "original.pdf", content: Buffer.from("immutable original"), report_version: 2, page_count: 9 };
  let calls = 0;
  const pool = { async query(sql) {
    calls++;
    if (/CREATE TABLE IF NOT EXISTS app\.custom_appraisal_report_artifacts/.test(sql)) return { rows: [] };
    assert.match(sql, /^SELECT canonical_file_name, report_version, workfile_checksum_sha256/);
    return { rows: [original] };
  } };
  const result = await ensureSignedCustomAppraisalReportArtifact(pool, { accountId: "ignored", assignmentFileId: 125, snapshot: null });
  assert.equal(result, original); assert.equal(calls, 2);
});
