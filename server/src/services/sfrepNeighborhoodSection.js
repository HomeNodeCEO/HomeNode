// Destination IDs/types checked independently for both legacy forms against
// the installed Appraise-It Pro 3.7.9 MISMO.2.6.GSE dictionary. No vendor source
// code or runtime lookup is included. PRICE fields display thousands of dollars.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const INVALID_XML = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const landFields = { one_unit: 'LandUseOneUnitPercentage', two_to_four_unit: 'LandUse24UnitPercentage',
  multifamily: 'LandUseMultiFamilyPercentage', commercial: 'LandUseCommercialPercentage', other_vacant: 'LandUseOtherPercentage' };
const textFields = { priceLow: 'SingleFamilyHousingPriceLowAmount', priceHigh: 'SingleFamilyHousingPriceHighAmount',
  pricePredominant: 'SingleFamilyHousingPricePredominantAmount', ageLow: 'SingleFamilyHousingAgeLow',
  ageHigh: 'SingleFamilyHousingAgeHigh', agePredominant: 'SingleFamilyHousingAgePredominant' };

function bindingIdentity(binding) {
  const ref = binding?.context_ref;
  return ref && typeof ref.context_id === 'string' && typeof ref.context_sha256 === 'string'
    && Number.isSafeInteger(binding.selection_revision) && typeof binding.selection_sha256 === 'string'
    ? JSON.stringify([ref.context_id, ref.context_revision, ref.context_sha256, binding.selection_revision, binding.selection_sha256]) : null;
}
function workspaceMatches(workspace, binding) {
  const active = workspace?.active, ref = binding?.context_ref;
  return active && ref && !workspace.pending_capture
    && ['context_id', 'context_revision', 'context_sha256'].every(key => active.context_ref?.[key] === ref[key])
    && (active.selection?.revision ?? active.selection_ref?.selection_revision) === binding.selection_revision
    && (!active.selection_ref || active.selection_ref.selection_sha256 === binding.selection_sha256);
}

export function projectSfrepNeighborhoodSection(saved) {
  const fields = [], warnings = [], knownMissing = [];
  if (!record(saved) || !Number.isSafeInteger(saved.assignmentFileId) || saved.assignmentFileId < 1
    || !Number.isSafeInteger(saved.assignmentRevision) || saved.assignmentRevision < 1) return { fields, warnings, knownMissing };
  const assignment = saved.assignmentDetails || {}, market = saved.market?.value;
  const form = market?.neighborhoodForm || {};
  const marketBinding = market?.response?.exploration_binding;
  const identity = bindingIdentity(marketBinding);
  const current = identity !== null && workspaceMatches(saved.workspace?.value, marketBinding);
  const proof = section => ({ kind: 'saved_report', sourceField: 'neighborhood', documentId: null, candidateId: null,
    assignmentFileId: saved.assignmentFileId, sectionKey: section === 'assignment' ? 'report.assignment_details' : 'market_conditions',
    revision: section === 'assignment' ? saved.assignmentRevision : saved.market?.revision, origin: 'appraiser_edit' });
  function put(fieldId, value, type = 'TextField', section = 'market') {
    if (value == null || String(value).trim() === '') return;
    if (section === 'market' && (!Number.isSafeInteger(saved.market?.revision) || saved.market.revision < 1)) return;
    const text = String(value).trim();
    if (text.length > 16000 || INVALID_XML.test(text)) { knownMissing.push({ fieldId, reason: 'Neighborhood text needs correction before export.' }); return; }
    fields.push({ fieldId, value: text, type, sourceField: 'neighborhood', documentId: null, candidateId: null, provenance: proof(section) });
  }
  function choose(value, choices, section = 'market') { if (Object.hasOwn(choices, value)) put(choices[value], 'true', 'CheckBoxField', section); }
  choose(assignment.neighborhood_location_type, { urban: 'LocationUrbanCheckBox', suburban: 'LocationSuburbanCheckBox', rural: 'LocationRuralCheckBox' }, 'assignment');
  choose(form.growth || assignment.neighborhood_growth, { rapid: 'GrowthRapidCheckBox', stable: 'GrowthStableCheckBox', slow: 'GrowthSlowCheckBox' }, form.growth ? 'market' : 'assignment');
  choose(form.demandSupply || assignment.neighborhood_demand_supply, { shortage: 'DemandSupplyShortageCheckBox', in_balance: 'DemandSupplyInBalanceCheckBox', over_supply: 'DemandSupplyOverSupplyCheckBox' }, form.demandSupply ? 'market' : 'assignment');
  put('NeighborhoodDescription', assignment.subject_neighborhood_summary, 'TextField', 'assignment');
  put('NeighborhoodBoundaries', form.boundaries || assignment.neighborhood_boundary_streets || assignment.neighborhood_boundary_label, 'TextField', form.boundaries ? 'market' : 'assignment');
  const keys = Array.isArray(market?.reconciliation?.reliedUponAreaKeys) ? market.reconciliation.reliedUponAreaKeys : [];
  const analyses = (Array.isArray(market?.response?.analyses) ? market.response.analyses : []).filter(analysis => keys.includes(analysis.market?.key));
  if (analyses.length) {
    choose(market.reconciliation.trendConclusion, { increasing: 'PropertyValuesIncreasingCheckBox', stable: 'PropertyValuesStableCheckBox', decreasing: 'PropertyValuesDecliningCheckBox' });
    put('MarketConditions', market.reconciliation.explanation);
    const medians = analyses.map(analysis => number(analysis.recent_periods?.find(period => period.months === 12)?.median_days_on_market))
      .filter(value => value !== null && value >= 0).sort((a, b) => a - b);
    if (medians.length) {
      const mean = medians.reduce((sum, value) => sum + value, 0) / medians.length, middle = Math.floor(medians.length / 2);
      const median = medians.length % 2 ? medians[middle] : (medians[middle - 1] + medians[middle]) / 2;
      const days = (mean + median) / 2;
      put(days < 90 ? 'MarketingTimeUnder3MonthsCheckBox' : days <= 180 ? 'MarketingTime36MonthsCheckBox' : 'MarketingTimeOver6MonthsCheckBox', 'true', 'CheckBoxField');
    } else knownMissing.push({ fieldId: 'MarketingTimeUnder3MonthsCheckBox', reason: 'Rerun studies for trailing-year marketing time, or review the conclusion manually.' });
    if (keys.includes('exploration') && !current) warnings.push('Exploration study selection changed or is unavailable. The saved market reconciliation is exported for review, not represented as a current map calculation.');
  }
  const formCurrent = current && form.explorationIdentity === identity;
  for (const [key, fieldId] of Object.entries(textFields)) {
    const value = number(form[key]);
    if (value !== null && value >= 0) {
      put(fieldId, Math.round(value));
      if (!formCurrent) warnings.push(`${fieldId}: saved neighborhood figures need review against the current exploration selection.`);
    }
  }
  const land = market?.landUse;
  if (land && current && land.explorationIdentity === identity && land.methodology_version === 'selected-parcels-edge-neighbors-v1') {
    const categories = Array.isArray(land.categories) ? land.categories : [];
    for (const [key, fieldId] of Object.entries(landFields)) {
      const value = number(categories.find(category => category.key === key)?.percent);
      if (value !== null && value >= 0 && value <= 100) put(fieldId, value);
    }
    choose(form.builtUp || land.built_up_band, { over_75: 'BuiltUpOver75CheckBox', '25_to_75': 'BuiltUp2575CheckBox', under_25: 'BuiltUpUnder25CheckBox' });
    warnings.push(...(Array.isArray(land.warnings) ? land.warnings.filter(value => typeof value === 'string') : []));
    if (number(land.unknown_percent) > 0) warnings.push('Land-use percentages include an unclassified remainder; review before delivery.');
  } else {
    choose(form.builtUp || assignment.neighborhood_built_up, { over_75: 'BuiltUpOver75CheckBox', '25_to_75': 'BuiltUp2575CheckBox', under_25: 'BuiltUpUnder25CheckBox' }, form.builtUp ? 'market' : 'assignment');
    knownMissing.push({ fieldId: 'LandUseOneUnitPercentage', reason: 'Calculate and save land use for the current Exploration Map Area.' });
  }
  if (!form.growth && !assignment.neighborhood_growth) knownMissing.push({ fieldId: 'GrowthStableCheckBox', reason: 'Select neighborhood growth in HomeNode; sold prices alone do not establish development growth.' });
  if (!form.demandSupply && !assignment.neighborhood_demand_supply) knownMissing.push({ fieldId: 'DemandSupplyInBalanceCheckBox', reason: 'Select demand/supply in HomeNode; a closed-sale sample does not measure active inventory.' });
  return { fields, warnings, knownMissing };
}
