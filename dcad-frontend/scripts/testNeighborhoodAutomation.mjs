import assert from 'node:assert/strict';

import {
  determineNeighborhoodValuePosition,
  determineHighestBestUse,
  growthFromMarket,
  locationTypeFromLandUse,
  marketingTimeFromMedianDom,
  zoningCompatibility,
} from '../src/lib/neighborhoodAutomation.ts';
import {
  calculateNeighborhoodRepresentativeness,
  DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
  hasSavedNeighborhoodLandUseProfile,
} from '../src/lib/neighborhoodCharacteristics.ts';

assert.equal(locationTypeFromLandUse({ oneUnit: 10, twoToFourUnit: 0, multifamily: 0, commercial: 45, otherVacant: 45 }), 'urban');
assert.equal(locationTypeFromLandUse({ oneUnit: 60, twoToFourUnit: 0, multifamily: 0, commercial: 10, otherVacant: 30 }), 'suburban');
assert.equal(locationTypeFromLandUse({ oneUnit: 10, twoToFourUnit: 0, multifamily: 0, commercial: 10, otherVacant: 80 }), 'rural');

assert.equal(marketingTimeFromMedianDom(89), 'under_3_months');
assert.equal(marketingTimeFromMedianDom(90), '3_to_6_months');
assert.equal(marketingTimeFromMedianDom(181), 'over_6_months');
assert.equal(growthFromMarket(11, 5, 'suburban'), 'rapid');
assert.equal(growthFromMarket(4, 30, 'suburban'), 'stable');
assert.equal(growthFromMarket(4, 201, 'urban'), 'slow');
assert.equal(growthFromMarket(-11, 30, 'rural'), 'slow');
assert.equal(growthFromMarket(4, 201, 'rural'), 'stable');

assert.equal(zoningCompatibility('Planned Development District', 'Single Detached'), true);
assert.equal(zoningCompatibility('Single-Family District 7K SF', 'Single Detached'), true);
assert.equal(zoningCompatibility('Commercial Retail District', 'Single Detached'), false);
assert.equal(zoningCompatibility('Duplex Residential District', 'Duplex'), true);

const compatible = determineHighestBestUse({
  zoning: 'Single-Family District 7K SF',
  currentUse: 'Single Detached',
  subjectSmallerThanAllComparisons: false,
  comparisonParcelCount: 50,
});
assert.equal(compatible.conclusion, 'current_use');
assert.deepEqual(compatible.flags, []);

const flagged = determineHighestBestUse({
  zoning: 'Commercial Retail District',
  currentUse: 'Single Detached',
  subjectSmallerThanAllComparisons: true,
  comparisonParcelCount: 12,
});
assert.equal(flagged.conclusion, 'investigation_required');
assert.equal(flagged.flags.length, 2);

const abovePredominant = determineNeighborhoodValuePosition({
  concludedValue: 360_000,
  predominantValue: 300_000,
  neighborhoodLowValue: 225_000,
  neighborhoodHighValue: 425_000,
  subjectGla: 2_200,
  predominantGla: 1_800,
  subjectSiteSize: 10_000,
  predominantSiteSize: 7_500,
  subjectAge: 15,
  predominantAge: 35,
  conditionRating: 'C2',
  qualityRating: 'Q3',
  conformsToNeighborhood: true,
});
assert.equal(abovePredominant.ready, true);
assert.equal(abovePredominant.relationship, 'above_predominant');
assert.equal(abovePredominant.differencePercent, 20);
assert.equal(abovePredominant.recommendedReview, '');
assert.match(abovePredominant.narrative, /larger 2,200-square-foot GLA/);
assert.match(abovePredominant.narrative, /conforms to the area/);

const underImprovement = determineNeighborhoodValuePosition({
  concludedValue: 190_000,
  predominantValue: 300_000,
  neighborhoodLowValue: 225_000,
  neighborhoodHighValue: 425_000,
  subjectGla: 1_200,
  predominantGla: 1_800,
  subjectAge: 60,
  predominantAge: 35,
  conditionRating: 'C5',
  conformsToNeighborhood: false,
  nonconformityType: 'under_improvement',
});
assert.equal(underImprovement.recommendedReview, 'under_improvement');
assert.match(underImprovement.narrative, /does not conform/);
assert.match(underImprovement.narrative, /redevelopment, or demolition/);

const pendingValue = determineNeighborhoodValuePosition({
  concludedValue: null,
  predominantValue: 300_000,
});
assert.equal(pendingValue.ready, false);
assert.equal(pendingValue.relationship, 'pending');

const representativeSales = calculateNeighborhoodRepresentativeness({
  neighborhood_house_price_predominant: 310_000,
  neighborhood_all_house_price_predominant: 300_000,
  neighborhood_ppsf_predominant: 205,
  neighborhood_all_ppsf_predominant: 200,
  neighborhood_age_predominant: 28,
  neighborhood_all_age_predominant: 30,
  neighborhood_gla_predominant: 1_850,
  neighborhood_all_gla_predominant: 1_800,
});
assert.equal(representativeSales.label, 'Highly representative');
assert.equal(representativeSales.factors.length, 4);
assert.equal(representativeSales.score, 96.2);
assert.match(representativeSales.narrative, /sales-only predominant characteristics/);

const insufficientProfile = calculateNeighborhoodRepresentativeness({
  neighborhood_age_predominant: 30,
  neighborhood_all_age_predominant: 32,
});
assert.equal(insufficientProfile.score, null);
assert.equal(insufficientProfile.label, 'Insufficient data');
assert.match(DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE, /intentionally broad/);

const savedBoundary = {
  type: 'Polygon',
  coordinates: [[[-96.7, 32.9], [-96.6, 32.9], [-96.6, 32.8], [-96.7, 32.9]]],
};
const completeSavedProfile = {
  neighborhood_boundary_geometry: savedBoundary,
  neighborhood_boundary_saved_at: '2026-08-15T12:00:00.000Z',
  neighborhood_land_use_analyzed_at: '2026-08-15T12:01:00.000Z',
  neighborhood_land_use_boundary_signature: 'saved-boundary-hash',
  neighborhood_land_use_parcel_count: 3994,
  neighborhood_land_use_one_unit_pct: 70,
  neighborhood_land_use_two_to_four_unit_pct: 5,
  neighborhood_land_use_multifamily_pct: 5,
  neighborhood_land_use_commercial_pct: 10,
  neighborhood_land_use_other_vacant_pct: 10,
  neighborhood_all_property_count: 3120,
};
assert.equal(hasSavedNeighborhoodLandUseProfile(completeSavedProfile), true);
assert.equal(hasSavedNeighborhoodLandUseProfile({
  ...completeSavedProfile,
  neighborhood_all_property_count: '',
}), false);
assert.equal(hasSavedNeighborhoodLandUseProfile({
  ...completeSavedProfile,
  neighborhood_boundary_saved_at: '2026-08-15T12:02:00.000Z',
}), false);

console.log('Neighborhood automation rules passed.');

