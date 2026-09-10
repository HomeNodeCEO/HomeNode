import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import { buildCustomAppraisalReportPdf, customAppraisalReportReadiness } from '../src/services/customAppraisalReportPdf.js';
import { prepareCustomNeighborhoodPdfAppendix } from '../src/services/customNeighborhoodReportPdf.js';
import { reportedObservationReportFixture } from './fixtures/reportedObservationReportFixture.js';
import { customNeighborhoodReportPdfFixture } from './fixtures/customNeighborhoodReportPdfFixture.js';

async function report(f) {
  const calls = [], client = { async query(sql, params) {
    calls.push({ sql, params }); assert.equal(sql, 'SELECT to_regclass($1) AS name');
    assert.deepEqual(params, ['app.inspection_photos']); return { rows: [{ name: null }] };
  } };
  const before = structuredClone(f.snapshot);
  assert.deepEqual(customAppraisalReportReadiness(f.snapshot, f.property).blockers, []);
  const built = await buildCustomAppraisalReportPdf(client, { snapshot: f.snapshot, accountId: f.property.account.account_id,
    assignmentFileId: f.snapshot.assignment_file_id, includeExternalImages: false });
  const extracted = await extractText(new Uint8Array(built.content), { mergePages: false });
  assert.equal(built.page_count, extracted.totalPages);
  extracted.text.forEach((page, index) => assert.ok(page.includes(`Page ${index + 1} of ${built.page_count}`)));
  assert.deepEqual(f.snapshot, before); assert.equal(calls.length, 1, 'No latest/source/account/acceptance read');
  return { ...built, pages: extracted.text.map(text => text.replace(/\s+/g, ' ')) };
}

test('real accepted v2 PDF renders all five parts with account/source-record counts and explicit observation limits', async () => {
  const f = reportedObservationReportFixture();
  for (const key of Object.keys(f.snapshot.assignment.assignment_details).filter(key => key.startsWith('neighborhood_'))) {
    f.snapshot.assignment.assignment_details[key] = 'LEGACY_NEIGHBORHOOD_SENTINEL';
  }
  const result = await report(f), text = result.pages.join(' '), neighborhood = result.pages.slice(9).join(' ');
  assert.match(result.pages[2], /ACCEPTED REPORTED NEIGHBORHOOD OBSERVATIONS/);
  assert.doesNotMatch(text, /LEGACY_NEIGHBORHOOD_SENTINEL/);
  assert.match(neighborhood, /Member count: 2 \(Accounts\); unique account count: 2; account link count: 2/);
  assert.match(neighborhood, /Member count: 1 \(Source records\); unique account count: 2; account link count: 2/);
  assert.doesNotMatch(neighborhood, /unique property count|property link count|Canonical transactions\)/);
  assert.match(neighborhood, /Reported ClosePrice[\s\S]*value: \$282,500\.01 USD/);
  assert.match(neighborhood, /Reported days on market[\s\S]*value: 0 days/);
  assert.match(neighborhood, /Exact retained value: 282500\.01; unit: USD/);
  assert.match(neighborhood, /capture date/); assert.match(neighborhood, /2026-09-10T12:00:00\.123456Z/);
  assert.match(neighborhood, /not verified market facts/); assert.match(neighborhood, /historical housing stock/);
  assert.match(neighborhood, /Median is not predominant/); assert.match(neighborhood, /not full parcel containment/);
  assert.match(neighborhood, /Provider coverage is not established/); assert.match(neighborhood, /no package price allocation is inferred/);
  assert.match(neighborhood, /historical availability: unknown/);
  for (const source of f.assessment.source_snapshots) assert.ok(neighborhood.includes(source.content_sha256));
});

test('PDF retains exact oversized decimal strings, unavailable reasons and every statistic after thirty', async () => {
  const f = reportedObservationReportFixture(raw => {
    const price = raw.statistics[2]; price.value = '9007199254740993.0199999999999';
    for (let i = 0; i < 36; i++) raw.statistics.push({ ...structuredClone(price), id: `ALL_REPORTED_STAT_${i}` });
    raw.statistics.push({ ...structuredClone(price), id: 'current-price', measurement: 'reported_current_price', value: '275000' });
    raw.statistics.push({ ...structuredClone(price), id: 'year', measurement: 'reported_year_built', unit: 'year', value: '1999.5' });
    raw.statistics.push({ ...structuredClone(price), id: 'unknown-unit', measurement: 'reported_site_area', unit: null,
      value: null, status: 'unsupported', estimator: 'unsupported', observed_count: 0, unsupported_count: 1,
      reason: `${'No site unit has been reviewed. '.repeat(35)}EXACT_REASON_END` });
  });
  const result = await report(f), text = result.pages.slice(9).join(' ');
  assert.match(text, /\$9,007,199,254,740,993\.02 USD/);
  assert.match(text, /Exact retained value: 9007199254740993\.0199999999999/);
  assert.match(text, /Reported CurrentPrice \(not ClosePrice\)/); assert.match(text, /1999\.5 year/);
  assert.match(text, /Unavailable - No site unit has been reviewed/); assert.match(text, /EXACT_REASON_END/);
  assert.match(text, /Observed: 0; missing: 0; invalid: 0; conflicting: 0; unsupported: 1; denominator: 1/);
  for (const statistic of f.assessment.statistics) assert.ok(text.includes(`Statistic ${statistic.id} -`), statistic.id);
  assert.ok(result.page_count > 15);
  const pdf = await getDocumentProxy(new Uint8Array(result.content));
  try {
    for (let pageNo = 10; pageNo <= result.page_count; pageNo++) {
      const page = await pdf.getPage(pageNo), content = await page.getTextContent();
      const body = content.items.filter(item => item.transform?.[5] < 704 && item.transform?.[5] > 40);
      assert.ok(body.length > 0);
      for (const item of body) assert.ok(item.transform[5] >= 50, `Appendix overlaps footer on page ${pageNo}`);
    }
  } finally { await pdf.loadingTask.destroy(); }
});

for (const [name, mutate] of [
  ['wrong mapper', x => { x.section.value.mapped_values['custom-neighborhood-report:evidence'].value.mapper_version = 'custom-neighborhood-report-v1'; }],
  ['partial saved group', x => { delete x.section.value.mapped_values['custom-neighborhood-report:populations']; }],
  ['relabelled version', x => { x.section.value.mapped_values['custom-neighborhood-report:evidence'].value.assessment.contract_version = 1; }],
  ['changed account count', x => { x.section.value.mapped_values['custom-neighborhood-report:populations'].value[0].member_count++; }],
  ['number price', x => { x.section.value.mapped_values['custom-neighborhood-report:statistics'].value[2].value = 282500.01; }],
  ['stale section', x => { x.section.revision++; }],
]) test(`v2 PDF refuses ${name} rather than legacy fallback`, () => {
  const f = reportedObservationReportFixture(); mutate(f);
  assert.ok(customAppraisalReportReadiness(f.snapshot, f.property).blockers.some(item => item.code === 'custom_neighborhood_report_unavailable'));
});

test('v1 appendix remains byte-identical in its planned text/position stream', () => {
  const f = customNeighborhoodReportPdfFixture(), doc = { font() { return this; }, fontSize() { return this; }, widthOfString(text) { return text.length * 4; } };
  const pages = prepareCustomNeighborhoodPdfAppendix(doc, { assessment: f.assessment,
    operation_id: f.section.operation_id, accepted_editor_revision: f.section.accepted_editor_revision });
  assert.equal(createHash('sha256').update(JSON.stringify(pages)).digest('hex'), 'dbadecf05191e1cdf5ad9ac23fb555388ac1cc00dd686976fa7f0d0662802aef');
});
