import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { extractText, getDocumentProxy } from 'unpdf';
import { buildCustomAppraisalReportPdf } from '../src/services/customAppraisalReportPdf.js';
import { prepareCustomNeighborhoodPdfAppendix } from '../src/services/customNeighborhoodReportPdf.js';
import { customNeighborhoodReportPdfFixture } from './fixtures/customNeighborhoodReportPdfFixture.js';
import { reportedObservationReportFixture } from './fixtures/reportedObservationReportFixture.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stream = pages => pages.flat().map(({ y: _y, ...line }) => line);
const measure = () => ({ font() { return this; }, fontSize() { return this; }, widthOfString(text) { return text.length * 4; } });
function projected(fixture) {
  const section = fixture.section.value ?? fixture.section;
  return { assessment: fixture.assessment, operation_id: section.operation_id, accepted_editor_revision: section.accepted_editor_revision };
}
function denseIds(raw) {
  while (raw.selection.pocket_ids.length < 888) {
    raw.selection.pocket_ids.push(`SYNTHETIC-LEAF-${String(raw.selection.pocket_ids.length).padStart(4, '0')}`);
  }
  raw.selection.pocket_ids[887] = `SYNTHETIC-LEAF-${'L'.repeat(170)}-END`;
}
function denseV2(raw) {
  denseIds(raw);
  raw.geographic_neighborhood.cardinal_summaries.north = `${'Complete synthetic north boundary. '.repeat(35)}NORTH_END`;
  raw.populations[0].definition = `${'Complete synthetic population definition. '.repeat(30)}DEFINITION_END`;
  for (let i = 0; i < 36; i++) raw.statistics.push({ ...structuredClone(raw.statistics[2]),
    id: i === 0 ? `SYNTHETIC-STAT-${'X'.repeat(175)}-END` : `SYNTHETIC-STAT-${String(i).padStart(2, '0')}`,
    measurement: 'reported_living_area', unit: null, value: null, status: 'unsupported', estimator: 'unsupported',
    observed_count: 0, unsupported_count: 1,
    reason: i === 0 ? `${'No source-area unit is reviewed. '.repeat(35)}REASON_END` : 'same_payload_area_unit_unavailable',
  });
}

// Complete content/style and old layout hashes captured on 103177d BEFORE the
// keep-with-next edit. Only the new layout hashes may differ from that baseline.
const cases = [
  { name: 'v1 small', fixture: () => customNeighborhoodReportPdfFixture(), pages: 4,
    oldLayout: 'dbadecf05191e1cdf5ad9ac23fb555388ac1cc00dd686976fa7f0d0662802aef',
    layout: 'e43fe3644c47ed3ba2a00141ef3c9880b2953ef3c99fd91ec63bdfb6421dbba4',
    stream: 'cb89714d507a9dfe708e434bfe2316b7d778bd51eb81832657590624cc827c53' },
  { name: 'v1 dense', fixture: () => customNeighborhoodReportPdfFixture({ extraStatistics: 32, longDescriptions: true, mutateRaw: denseIds }), pages: 11,
    oldLayout: '578f6689554d5c8f0af2fe696f7fc677fea39877dc5d255617d33c76bdf3e84d',
    layout: '101ddf90bbc6d4d5b6c5a2762d05d3c0d1456e981ec0bff964e4d92f2e6b0b54',
    stream: '5f75ff0e885454da84a04becb71574616d86159498d96b2a0a0fdc43be40b823' },
  { name: 'v2 small', fixture: () => reportedObservationReportFixture(), pages: 2,
    oldLayout: 'ec2161a958fe9952ad41a80b35885d0ecad40173d9c39f9303e56ec4523f4c3d',
    layout: 'ec2161a958fe9952ad41a80b35885d0ecad40173d9c39f9303e56ec4523f4c3d',
    stream: 'e868058e934678b82d88fa186dcfba4ca27830a62794a3ab4ff2136377c0e63a' },
  { name: 'v2 dense', fixture: () => reportedObservationReportFixture(denseV2), pages: 10,
    oldLayout: '9b56aead088d791a9d2432069bf269a6c8c612a3e70cd0fe81ad5f8c76bd978e',
    layout: 'd0f35778ca6eb3d9e25ee394cea43432d6d3097b37f0e5f4e86bdc5c5e41e7b4',
    stream: '552fa6ab0ed424de59531f83bc4dcc7613c09576d00e50226e4dc33b34f00e57' },
];

function assertHeadingDetails(pages, expectedCount) {
  const rows = pages.flatMap((page, pageIndex) => page.map(line => ({ ...line, pageIndex })));
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].heading || !/^Statistic(?: |$)/.test(rows[i].text)) continue;
    const pageIndex = rows[i].pageIndex;
    let next = i + 1;
    while (rows[next]?.heading) {
      assert.equal(rows[next].pageIndex, pageIndex, 'every wrapped statistic heading line stays together');
      next++;
    }
    assert.ok(rows[next]?.text.startsWith('Estimator:'), 'the first detail remains the estimator/status/value line');
    assert.equal(rows[next].pageIndex, pageIndex, rows[i].text);
    count++;
  }
  assert.equal(count, expectedCount);
}

for (const entry of cases) test(`${entry.name}: exact pre-edit content/style stream, intentional layout and no input mutation`, () => {
  const f = entry.fixture(), before = structuredClone(f), input = projected(f);
  const pages = prepareCustomNeighborhoodPdfAppendix(measure(), input);
  assert.equal(hash(stream(pages)), entry.stream, 'all text, order, fonts, sizes and heading flags are unchanged');
  assert.equal(hash(pages), entry.layout); assert.equal(pages.length, entry.pages);
  if (entry.name === 'v2 small') assert.equal(hash(pages), entry.oldLayout, 'non-orphan fixture layout remains exact');
  else assert.notEqual(hash(pages), entry.oldLayout, 'only the pinned page layout intentionally changed');
  assertHeadingDetails(pages, f.assessment.statistics.length);
  assert.deepEqual(f, before);
  for (const page of pages) {
    assert.ok(page.length, 'no empty appendix pages');
    for (const row of page) assert.ok(row.y >= 88 && row.y + 12 <= 738);
  }
});

// Planner-only edge cases use detached projected fixture data and deterministic
// font metrics to place headings exactly. These do not claim contract admission
// for repeated/absent perimeter edges or deliberately oversized identifiers.
function boundary({ lines = 17, edges = 0, leading = true, id = 'boundary-target', longDetail = false } = {}) {
  const f = customNeighborhoodReportPdfFixture(), input = structuredClone(projected(f));
  const a = input.assessment, population = a.populations.find(value => value.id === 'allocated-a');
  const statistic = a.statistics.find(value => value.population_id === population.id);
  a.populations = [population];
  const target = { ...statistic, id };
  if (longDetail) Object.assign(target, { status: 'unsupported', estimator: 'unsupported', value: null,
    reason: `${'COMPLETE_LONG_DETAIL '.repeat(900)}DETAIL_END` });
  a.statistics = [...(leading ? [{ ...statistic, id: 'first-stat' }] : []), target];
  a.geographic_neighborhood.perimeter = Array.from({ length: edges }, () => a.geographic_neighborhood.perimeter[0]);
  a.geographic_neighborhood.cardinal_summaries.north = 'P'.repeat(lines * 132);
  const pages = prepareCustomNeighborhoodPdfAppendix(measure(), input);
  const rows = pages.flatMap((page, pageIndex) => page.map(row => ({ ...row, pageIndex })));
  let targetRow;
  for (let index = 0; index < rows.length; index++) {
    if (!rows[index].heading || !/^Statistic(?: |$)/.test(rows[index].text)) continue;
    let end = index + 1;
    while (rows[end]?.heading) end++;
    const title = rows.slice(index, end).map(row => row.text).join('').replace(/\s/g, '');
    if (title.startsWith(`Statistic${id}-`)) { targetRow = rows[index]; break; }
  }
  return { pages, input, target: targetRow };
}

test('exact fit retains the statistic at y711 with its first detail ending at the body boundary', () => {
  const { pages, target } = boundary();
  assert.equal(target.pageIndex, 0); assert.equal(target.y, 711);
  const firstDetail = pages[0][pages[0].findIndex(row => row.text === target.text) + 1];
  assert.ok(firstDetail.text.startsWith('Estimator:')); assert.equal(firstDetail.y, 726);
  assert.equal(firstDetail.y + 12, 738); assertHeadingDetails(pages, 2);
});

test('one point beyond the reserved block moves the heading once rather than orphaning it', () => {
  // Pre-edit this first statistic began at y712: 712 + 12 + 3 + 12 = 739.
  const { pages, target } = boundary({ lines: 21, edges: 2, leading: false });
  assert.equal(target.pageIndex, 1); assert.equal(target.y, 88);
  assert.ok(pages[0].length); assert.equal(pages[1][1].y, 103);
  assertHeadingDetails(pages, 1);
});

test('a heading that itself no longer fits starts the next page without an empty intermediate page', () => {
  const { pages, target } = boundary({ lines: 19 });
  assert.equal(target.pageIndex, 1); assert.equal(target.y, 88);
  assert.ok(pages.every(page => page.length)); assertHeadingDetails(pages, 2);
});

for (const [lines, expectedY, expectedPage] of [[16, 699, 0], [17, 88, 1]]) {
  test(`complete two-line heading ${lines === 16 ? 'exactly fits' : 'moves together'} with first detail`, () => {
    const { pages, target } = boundary({ lines, id: `boundary-target-${'X'.repeat(70)}` });
    assert.equal(target.y, expectedY); assert.equal(target.pageIndex, expectedPage);
    const page = pages[expectedPage], index = page.findIndex(row => row.text === target.text);
    assert.equal(page[index + 1].heading, true); assert.equal(page[index + 2].heading, false);
    assert.equal(page[index + 2].y, expectedY + 27); assertHeadingDetails(pages, 2);
  });
}

test('oversized heading retains bounded line-by-line fallback without blank pages or content loss', () => {
  const id = `boundary-target-${'X'.repeat(132 * 55)}-ID_END`;
  const { pages, target } = boundary({ id });
  assert.equal(target.pageIndex, 0); assert.equal(target.y, 711, 'an impossible whole-page reservation is not attempted');
  assert.ok(pages.length >= 3); assert.ok(pages.every(page => page.length));
  const compact = pages.flat().map(row => row.text).join('').replace(/\s/g, '');
  assert.ok(compact.includes(`Statistic${id}-Package-allocatedpropertysaleprice`));
  assert.ok(compact.includes('Estimator:Median;status:ready;value:$120,001USD.'));
  for (const row of pages.flat()) assert.ok(row.y >= 88 && row.y + 12 <= 738);
});

test('oversized detail continues across pages after its first line without truncation or whole-statistic reservation', () => {
  const { pages, target } = boundary({ longDetail: true });
  assert.equal(target.pageIndex, 0); assert.equal(target.y, 711);
  assertHeadingDetails(pages, 2); assert.ok(pages.length > 3);
  const text = pages.flat().map(row => row.text).join(' ');
  assert.equal((text.match(/COMPLETE_LONG_DETAIL/g) ?? []).length, 900);
  assert.ok(text.includes('DETAIL_END')); assert.ok(pages.every(page => page.length));
});

test('non-statistic headings retain the existing line-by-line pagination behavior', () => {
  const f = customNeighborhoodReportPdfFixture(), input = structuredClone(projected(f));
  input.assessment.statistics = []; input.assessment.populations = [];
  input.assessment.geographic_neighborhood.perimeter = [];
  input.assessment.geographic_neighborhood.cardinal_summaries.north = 'P'.repeat(31 * 132);
  const pages = prepareCustomNeighborhoodPdfAppendix(measure(), input);
  assert.deepEqual(pages[0].at(-1), { text: 'Source fixture-source - synthetic-replay', font: 'Helvetica-Bold', size: 9, y: 720, heading: true });
  assert.ok(pages[1][0].text.startsWith('Revision: 1;')); assert.equal(pages[1][0].y, 88);
});

for (const entry of cases.filter(value => value.name.endsWith('dense'))) test(`${entry.name}: genuine accepted PDF retains 888 IDs, every statistic, unknown reasons and photo/header offsets`, async () => {
  const f = entry.fixture(), before = structuredClone(f.snapshot), calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql === 'SELECT to_regclass($1) AS name') {
      assert.deepEqual(params, ['app.inspection_photos']); return { rows: [{ name: 'app.inspection_photos' }] };
    }
    assert.match(sql, /FROM app.report_files report_file[\s\S]*JOIN app.inspection_photos/);
    return { rows: Array.from({ length: 5 }, (_, index) => ({ id: `photo-${index}`, origin_channel: 'mobile', category: 'Interior',
      caption: `SYNTHETIC_PHOTO_END_${index}`, position: index, captured_at: null, object_key: null, content_type: null })) };
  } };
  const built = await buildCustomAppraisalReportPdf(client, { snapshot: f.snapshot, accountId: f.property.account.account_id,
    assignmentFileId: f.snapshot.assignment_file_id, includeExternalImages: false });
  const extracted = await extractText(new Uint8Array(built.content), { mergePages: false });
  assert.equal(extracted.totalPages, built.page_count); assert.deepEqual(f.snapshot, before);
  assert.equal(calls.length, 2, 'only optional synthetic photo metadata, no source or acceptance query');
  const pages = extracted.text.map(text => text.replace(/\s+/g, ' '));
  // Remove running headers/footers before joining lines across page boundaries:
  // a long literal ID can legitimately continue on the next appendix page.
  const compactPages = [], pdf = await getDocumentProxy(new Uint8Array(built.content));
  try {
    for (let number = 10; number <= built.page_count - 2; number++) {
      const page = await pdf.getPage(number), content = await page.getTextContent();
      const body = content.items.filter(item => item.transform?.[5] < 704 && item.transform?.[5] > 40);
      assert.ok(body.length);
      for (const item of body) {
        assert.ok(item.transform[5] >= 50, `footer clearance on page ${number}`);
        assert.ok(item.transform[4] >= 41.5 && item.transform[4] + item.width <= 570.5, `horizontal body bounds on page ${number}`);
      }
      compactPages.push(body.map(item => item.str).join('').replace(/\s/g, ''));
    }
  } finally { await pdf.loadingTask.destroy(); }
  const appendix = compactPages.join('');
  assert.equal(f.assessment.selection.pocket_ids.length, 888); assert.ok(f.assessment.statistics.length > 32);
  for (const id of f.assessment.selection.pocket_ids) assert.ok(appendix.includes(id), id);
  for (const statistic of f.assessment.statistics) {
    const token = `Statistic${statistic.id}-`, hits = compactPages.filter(text => text.includes(token));
    assert.equal(hits.length, 1, `complete heading remains on one page: ${statistic.id}`);
    const tail = hits[0].slice(hits[0].indexOf(token) + token.length);
    assert.ok(tail.includes('Estimator:'));
    const nextStatistic = tail.indexOf('Statistic');
    assert.ok(nextStatistic < 0 || tail.indexOf('Estimator:') < nextStatistic, `first detail stays with ${statistic.id}`);
  }
  pages.forEach((page, index) => assert.ok(page.includes(`Page ${index + 1} of ${built.page_count}`)));
  assert.ok(pages[2].includes(`appendix pages 10-${built.page_count - 2}`));
  assert.match(pages.at(-2), /Subject Photo Appendix.*SYNTHETIC_PHOTO_END_0.*SYNTHETIC_PHOTO_END_3/);
  assert.match(pages.at(-1), /Subject Photo Appendix.*SYNTHETIC_PHOTO_END_4/);
  if (f.assessment.contract_version === 2) {
    assert.ok(appendix.includes('REASON_END')); assert.ok(appendix.includes('DEFINITION_END')); assert.ok(appendix.includes('NORTH_END'));
    assert.match(pages.slice(9).join(' '), /Unavailable - same_payload_area_unit_unavailable/);
    assert.match(pages.slice(9).join(' '), /unsupported: 1; denominator: 1/);
    assert.match(pages.slice(9).join(' '), /CAD accounts are not economic properties/);
  } else for (const marker of ['NORTH_END_MARKER', 'DEFINITION_END_MARKER', 'REASON_END_MARKER']) assert.ok(appendix.includes(marker));
});
