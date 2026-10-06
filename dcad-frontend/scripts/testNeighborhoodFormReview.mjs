import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_NEIGHBORHOOD_FORM, neighborhoodStudyFigures } from '../src/lib/neighborhoodFormReview.ts';
import { validExplorationLandUse } from '../src/lib/explorationLandUse.ts';
import { sfrepNeighborhoodFixture } from '../../server/test/fixtures/sfrepNeighborhoodFixture.js';
import { buildSfrepReportExport } from '../../server/src/services/sfrepReportExport.js';
import { checkSfrepPreview, sfrepProvenanceText } from '../src/features/sfrep/sfrepTransport.ts';

test('form price uses selected-map closed sales in thousands, age uses all selected CAD homes and chosen observation end', () => {
  const response = { analyses: [{ market: { key: 'zip' }, summary: { median_sale_price: 900000 } },
    { market: { key: 'exploration' }, period: { end: '2026-09-30' }, summary: { minimum_sale_price: 200000, maximum_sale_price: 450000, median_sale_price: 300000 } }] };
  const group = { summary: { selected: { stock: { metrics: { year_built: { low: 1951, high: 2021, median: 1966 } } } } } };
  const prior = { ...EMPTY_NEIGHBORHOOD_FORM, growth: 'slow', demandSupply: 'shortage' }, before = structuredClone(response);
  const result = neighborhoodStudyFigures(response, group, 'exact', { explorationIdentity: 'exact', built_up_band: 'over_75' }, prior);
  assert.deepEqual([result.priceLow, result.priceHigh, result.pricePredominant], ['200', '450', '300']);
  assert.deepEqual([result.ageLow, result.ageHigh, result.agePredominant], ['5', '75', '60']);
  assert.equal(result.growth, 'slow'); assert.equal(result.demandSupply, 'shortage'); assert.equal(result.explorationIdentity, 'exact');
  assert.equal(result.builtUp, 'over_75'); assert.deepEqual(response, before);
  response.analyses[1].summary = {}; group.summary.selected.stock.metrics.year_built.high = 2030;
  const absent = neighborhoodStudyFigures(response, group, 'new', null, prior); assert.equal(absent.pricePredominant, ''); assert.equal(absent.ageLow, '');
});

test('land-use response validation preserves missing categories and rejects invalid totals, count drift and duplicate categories', () => {
  const land = sfrepNeighborhoodFixture().market.value.landUse; assert.equal(validExplorationLandUse(land), true);
  for (const mutate of [value => value.categories[1].key = 'one_unit', value => value.categories[1].percent = -1,
    value => value.unknown_percent = 20, value => value.parcel_count++, value => value.warnings = null, value => value.built_up_percent = NaN]) {
    const invalid = structuredClone(land); mutate(invalid); assert.equal(validExplorationLandUse(invalid), false);
  }
  land.categories[0].percent = 50; land.unknown_percent = 10; assert.equal(validExplorationLandUse(land), true);
});

test('actual server neighborhood previews cross the strict transport for both forms and bind market revision without PDF attachment requirements', () => {
  for (const formId of ['FNMA-1004-0911', 'FNMA-2055-0911']) {
    const saved = sfrepNeighborhoodFixture();
    // Exercise the real pure field producer in a frontend-only install. The
    // server suite separately verifies the public preview and digest envelope,
    // which imports backend PDF dependencies unavailable in frontend CI.
    const { reportXml: _xml, pdfAddenda: _pdfs, ...result } = buildSfrepReportExport({
      documents: [], formId, includePdfAddenda: false, savedNeighborhoodReport: saved,
    });
    const preview = JSON.parse(JSON.stringify({ ok: true, ...result, documents: [],
      preview_digest: 'a'.repeat(64), filename: 'HomeNode-SFREP-file-7.rpti',
      savedReport: { assignmentFileId: 7, assignmentRevision: 2, subjectRevision: 0,
        marketRevision: 3, sourceDocumentIds: [] },
    }));
    assert.equal(checkSfrepPreview(preview, [], formId), preview);
    const field = preview.fields.find(item => item.fieldId === 'MarketConditions');
    assert.match(sfrepProvenanceText(field), /Neighborhood \/ Market revision 3/);
    for (const mutate of [value => value.savedReport.marketRevision++, value => delete value.savedReport.marketRevision,
      value => value.fields.find(item => item.fieldId === 'MarketConditions').provenance.sectionKey = 'unrelated',
      value => value.fields.find(item => item.fieldId === 'LandUseOneUnitPercentage').value = '110',
      value => value.fields.find(item => item.fieldId === 'LandUseOneUnitPercentage').fieldId = 'InjectedField']) {
      const invalid = structuredClone(preview); mutate(invalid); assert.throws(() => checkSfrepPreview(invalid, [], formId), /invalid|does not match/);
    }
  }
});
