import assert from 'node:assert/strict';

import {
  determineNeighborhoodValuePosition,
  determineHighestBestUse,
  growthFromMarket,
  locationTypeFromLandUse,
  marketingTimeFromMedianDom,
  zoningCompatibility,
} from '../src/lib/neighborhoodAutomation.ts';

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

console.log('Neighborhood automation rules passed.');
