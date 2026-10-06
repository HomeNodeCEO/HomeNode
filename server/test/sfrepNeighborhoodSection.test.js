import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSfrepNeighborhoodSection } from '../src/services/sfrepNeighborhoodSection.js';
import { buildSfrepReportExport, SFREP_PRIMARY_FORM_ID, SFREP_2055_FORM_ID } from '../src/services/sfrepReportExport.js';
import { previewSfrepDocuments } from '../src/services/sfrepDocumentTransfer.js';
import { sfrepNeighborhoodFixture } from './fixtures/sfrepNeighborhoodFixture.js';
const values = result => Object.fromEntries(result.fields.map(field => [field.fieldId, field.value]));

test('both legacy forms map the same saved Neighborhood section, including zero percentages, without attached PDFs', () => {
  const saved = sfrepNeighborhoodFixture(), before = structuredClone(saved);
  for (const formId of [SFREP_PRIMARY_FORM_ID, SFREP_2055_FORM_ID]) {
    const result = buildSfrepReportExport({ documents: [], formId, includePdfAddenda: false, savedNeighborhoodReport: saved });
    const mapped = values(result);
    assert.equal(mapped.LocationSuburbanCheckBox, 'true'); assert.equal(mapped.PropertyValuesStableCheckBox, 'true');
    assert.equal(mapped.GrowthStableCheckBox, 'true'); assert.equal(mapped.DemandSupplyInBalanceCheckBox, 'true');
    assert.equal(mapped.BuiltUpOver75CheckBox, 'true'); assert.equal(mapped.MarketingTimeUnder3MonthsCheckBox, 'true');
    assert.equal(mapped.SingleFamilyHousingPricePredominantAmount, '300'); assert.equal(mapped.SingleFamilyHousingAgePredominant, '60');
    assert.equal(mapped.LandUseOneUnitPercentage, '60'); assert.equal(mapped.LandUse24UnitPercentage, '0');
    assert.equal(mapped.LandUseCommercialPercentage, '20'); assert.equal(mapped.LandUseOtherPercentage, '20');
    assert.match(mapped.MarketConditions, /ZIP & Exploration/); assert.match(result.reportXml, /ZIP &amp; Exploration/);
    assert.match(result.reportXml, new RegExp(`<Form Id="${formId}">`)); assert.deepEqual(result.pdfAddenda, []);
    for (const field of result.fields.filter(item => item.sourceField === 'neighborhood')) {
      assert.equal(field.provenance.assignmentFileId, 7); assert.equal(field.provenance.origin, 'appraiser_edit');
      assert.equal(field.provenance.revision, field.provenance.sectionKey === 'market_conditions' ? 3 : 2);
    }
  }
  assert.deepEqual(saved, before);
});

test('marketing category follows selected studies and exact trailing-year medians, not all analyses', () => {
  const saved = sfrepNeighborhoodFixture(); saved.market.value.reconciliation.reliedUponAreaKeys = ['radius_2'];
  assert.equal(values(projectSfrepNeighborhoodSection(saved)).MarketingTimeOver6MonthsCheckBox, 'true');
  delete saved.market.value.response.analyses[2].recent_periods;
  const missing = projectSfrepNeighborhoodSection(saved);
  assert.equal(values(missing).MarketingTimeUnder3MonthsCheckBox, undefined);
  assert.ok(missing.knownMissing.some(item => /trailing-year/.test(item.reason)));
});

test('stale land use is not exported as current; the saved reconciliation and entered figures remain flagged for review', () => {
  for (const mutate of [saved => saved.workspace.value.active.selection.revision++, saved => { saved.workspace.value.pending_capture = {}; },
    saved => { saved.market.value.landUse.explorationIdentity = 'foreign'; }]) {
    const saved = sfrepNeighborhoodFixture(); mutate(saved); const result = projectSfrepNeighborhoodSection(saved);
    assert.equal(values(result).LandUseOneUnitPercentage, undefined); assert.match(values(result).MarketConditions, /Exploration/);
    assert.ok(result.knownMissing.some(item => item.fieldId === 'LandUseOneUnitPercentage'));
  }
  const saved = sfrepNeighborhoodFixture(); saved.market.value.landUse.unknown_percent = 10;
  assert.ok(projectSfrepNeighborhoodSection(saved).warnings.some(item => /unclassified/.test(item)));
});

test('missing growth/supply and absent market data are not replaced by invented default conclusions', () => {
  const saved = sfrepNeighborhoodFixture(); delete saved.market;
  const result = projectSfrepNeighborhoodSection(saved);
  assert.equal(values(result).LocationSuburbanCheckBox, 'true'); assert.equal(values(result).GrowthStableCheckBox, undefined);
  assert.equal(values(result).DemandSupplyInBalanceCheckBox, undefined); assert.equal(values(result).PropertyValuesStableCheckBox, undefined);
  assert.equal(values(projectSfrepNeighborhoodSection({ ...saved, assignmentFileId: -1 })).LocationSuburbanCheckBox, undefined);
});

test('neighborhood section revision and changed weighting are included in the preview digest, not just attached documents', () => {
  const saved = sfrepNeighborhoodFixture(), documents = []; documents.saved_report = saved;
  const input = { accountId: saved.accountId, assignmentFileId: 7, documentIds: [], includeDocuments: false, formId: SFREP_PRIMARY_FORM_ID };
  const first = previewSfrepDocuments(documents, input); assert.equal(first.savedReport.marketRevision, 3);
  saved.market.revision++; saved.market.value.reconciliation.reliedUponAreaKeys = ['radius_2'];
  const changed = previewSfrepDocuments(documents, input); assert.notEqual(first.preview_digest, changed.preview_digest);
  assert.equal(changed.savedReport.marketRevision, 4); assert.equal(values(changed).MarketingTimeOver6MonthsCheckBox, 'true');
});
