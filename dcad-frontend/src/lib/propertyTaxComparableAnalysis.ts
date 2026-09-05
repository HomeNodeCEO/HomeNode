import {
  calculateSharedComparableIndication,
  medianComparableIndication,
  type BinaryAdjustmentRule,
  type ManualComparableAdjustment,
  type NumericAdjustmentRule,
  type SharedComparableIndication,
} from './sharedComparableAnalysis.ts';

export type PropertyTaxComparableExclusionCode =
  | 'invalid_sale'
  | 'unverified_sale'
  | 'non_arms_length_sale'
  | 'sale_after_valuation_date'
  | 'sale_outside_lookback'
  | 'different_property_use'
  | 'different_neighborhood'
  | 'different_building_class'
  | 'different_historic_district';

export interface PropertyTaxComparableSubject {
  accountId: string;
  valuationDate: string;
  districtAppraisedValue?: number | null;
  propertyUse: string;
  neighborhoodCode: string;
  buildingClass?: string | null;
  historicDistrictName?: string | null;
  livingAreaSqft?: number | null;
  siteSizeSqft?: number | null;
  bathCount?: number | null;
  bedroomCount?: number | null;
  garageSpaces?: number | null;
  ageYears?: number | null;
  pool?: boolean | null;
  solarPanels?: boolean | null;
}

export interface PropertyTaxComparableCandidate {
  saleId: string;
  address: string;
  saleDate: string;
  salePrice: number;
  concessions?: number | null;
  saleVerified: boolean;
  armsLength: boolean;
  propertyUse: string;
  neighborhoodCode: string;
  buildingClass?: string | null;
  historicDistrictName?: string | null;
  livingAreaSqft?: number | null;
  siteSizeSqft?: number | null;
  bathCount?: number | null;
  bedroomCount?: number | null;
  garageSpaces?: number | null;
  ageYears?: number | null;
  pool?: boolean | null;
  solarPanels?: boolean | null;
  manualAdjustments?: ManualComparableAdjustment[];
  sourceName: string;
  sourceReference?: string | null;
}

export interface PropertyTaxComparablePolicy {
  version: string;
  lookbackMonths: number;
  maximumSelectedComparables: number;
  minimumSelectedComparables: number;
  requireSameNeighborhood: boolean;
  requireSameBuildingClass: boolean;
}

export const DALLAS_RESIDENTIAL_COMPARABLE_POLICY = Object.freeze({
  version: 'dcad-residential-comparables-2026.1',
  lookbackMonths: 24,
  maximumSelectedComparables: 5,
  minimumSelectedComparables: 3,
  requireSameNeighborhood: true,
  requireSameBuildingClass: true,
} satisfies PropertyTaxComparablePolicy);

export interface PropertyTaxComparableDecision {
  saleId: string;
  eligible: boolean;
  similarityScore: number | null;
  exclusionCodes: PropertyTaxComparableExclusionCode[];
}

export interface PropertyTaxSelectedComparable {
  candidate: PropertyTaxComparableCandidate;
  rank: number;
  similarityScore: number;
  indication: SharedComparableIndication;
  valuePosition: 'supports_lower_value' | 'at_or_above_district_value' | 'not_compared';
}

export interface PropertyTaxComparableAnalysisResult {
  version: 1;
  policyVersion: string;
  subjectAccountId: string;
  valuationDate: string;
  candidateDecisions: PropertyTaxComparableDecision[];
  selectedComparables: PropertyTaxSelectedComparable[];
  indicatedMarketValue: number | null;
  diagnostics: string[];
}

function dateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? parsed
    : null;
}

function monthsBefore(value: Date, months: number): Date {
  const result = new Date(value);
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
}

function normalized(value: string | null | undefined): string {
  return (value || '').trim().toLocaleLowerCase('en-US');
}

function canonicalHousingType(value: string | null | undefined): string {
  const text = normalized(value).replace(/[^a-z0-9]+/g, ' ');
  if (/\b(condo|minium)\b/.test(text)) return 'condominium';
  if (/\b(townhome|townhouse|town house)\b/.test(text)) return 'townhouse';
  if (/\b(duplex|triplex|fourplex|quadruplex|multi family|multifamily)\b/.test(text)) return 'multi_family';
  if (/\b(manufactured|mobile home)\b/.test(text)) return 'manufactured';
  if (/\b(detached|single family|singlefamily)\b/.test(text)) return 'detached';
  if (/\battached\b/.test(text)) return 'attached_other';
  return 'unknown';
}

function differenceRatio(subject: number | null | undefined, comparable: number | null | undefined): number | null {
  if (!Number.isFinite(subject) || !Number.isFinite(comparable) || Number(subject) <= 0) return null;
  return Math.abs(Number(subject) - Number(comparable)) / Number(subject);
}

function closenessPoints(ratio: number | null, maximumPoints: number): number {
  if (ratio === null) return maximumPoints * 0.35;
  return Math.max(0, maximumPoints * (1 - Math.min(1, ratio)));
}

/**
 * Score physical and temporal similarity without using price or indicated
 * value. Keeping value out of the ranking is the audit guard against selecting
 * a comparable merely because it produces the desired protest result.
 */
export function propertyTaxComparableSimilarity(
  subject: PropertyTaxComparableSubject,
  candidate: PropertyTaxComparableCandidate,
): number {
  let score = 0;
  score += closenessPoints(differenceRatio(subject.livingAreaSqft, candidate.livingAreaSqft), 30);
  score += closenessPoints(differenceRatio(subject.siteSizeSqft, candidate.siteSizeSqft), 12);
  score += closenessPoints(differenceRatio(subject.ageYears, candidate.ageYears), 12);
  score += closenessPoints(differenceRatio(subject.bathCount, candidate.bathCount), 8);
  score += closenessPoints(differenceRatio(subject.bedroomCount, candidate.bedroomCount), 5);
  score += closenessPoints(differenceRatio(subject.garageSpaces, candidate.garageSpaces), 5);
  if (normalized(subject.buildingClass) && normalized(subject.buildingClass) === normalized(candidate.buildingClass)) score += 12;
  if (normalized(subject.neighborhoodCode)
      && normalized(subject.neighborhoodCode) === normalized(candidate.neighborhoodCode)) score += 10;

  const valuationDate = dateOnly(subject.valuationDate);
  const saleDate = dateOnly(candidate.saleDate);
  if (valuationDate && saleDate) {
    const daysOld = Math.max(0, (valuationDate.getTime() - saleDate.getTime()) / 86_400_000);
    score += Math.max(0, 6 * (1 - Math.min(1, daysOld / 730)));
  }
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

function assessCandidate(
  subject: PropertyTaxComparableSubject,
  candidate: PropertyTaxComparableCandidate,
  policy: PropertyTaxComparablePolicy,
): PropertyTaxComparableDecision {
  const exclusionCodes: PropertyTaxComparableExclusionCode[] = [];
  const valuationDate = dateOnly(subject.valuationDate);
  const saleDate = dateOnly(candidate.saleDate);
  if (!candidate.saleId.trim() || !candidate.address.trim()
      || !Number.isFinite(candidate.salePrice) || candidate.salePrice <= 0 || !saleDate || !valuationDate) {
    exclusionCodes.push('invalid_sale');
  }
  if (!candidate.saleVerified) exclusionCodes.push('unverified_sale');
  if (!candidate.armsLength) exclusionCodes.push('non_arms_length_sale');
  if (valuationDate && saleDate && saleDate > valuationDate) exclusionCodes.push('sale_after_valuation_date');
  if (valuationDate && saleDate && saleDate < monthsBefore(valuationDate, policy.lookbackMonths)) {
    exclusionCodes.push('sale_outside_lookback');
  }
  const subjectHousingType = canonicalHousingType(subject.propertyUse);
  const candidateHousingType = canonicalHousingType(candidate.propertyUse);
  if (
    subjectHousingType === 'unknown'
    || candidateHousingType === 'unknown'
    || subjectHousingType !== candidateHousingType
  ) {
    exclusionCodes.push('different_property_use');
  }
  if (policy.requireSameNeighborhood && normalized(subject.neighborhoodCode)
      && normalized(subject.neighborhoodCode) !== normalized(candidate.neighborhoodCode)) {
    exclusionCodes.push('different_neighborhood');
  }
  if (policy.requireSameBuildingClass && normalized(subject.buildingClass)
      && normalized(subject.buildingClass) !== normalized(candidate.buildingClass)) {
    exclusionCodes.push('different_building_class');
  }
  if (normalized(subject.historicDistrictName)
      && normalized(subject.historicDistrictName) !== normalized(candidate.historicDistrictName)) {
    exclusionCodes.push('different_historic_district');
  }
  return {
    saleId: candidate.saleId,
    eligible: exclusionCodes.length === 0,
    similarityScore: exclusionCodes.length ? null : propertyTaxComparableSimilarity(subject, candidate),
    exclusionCodes: [...new Set(exclusionCodes)],
  };
}

export function analyzePropertyTaxComparables({
  subject,
  candidates,
  numericRules = [],
  binaryRules = [],
  policy = DALLAS_RESIDENTIAL_COMPARABLE_POLICY,
}: {
  subject: PropertyTaxComparableSubject;
  candidates: PropertyTaxComparableCandidate[];
  numericRules?: NumericAdjustmentRule[];
  binaryRules?: BinaryAdjustmentRule[];
  policy?: PropertyTaxComparablePolicy;
}): PropertyTaxComparableAnalysisResult {
  if (!subject.accountId.trim()) throw new Error('property_tax_subject_account_required');
  if (!dateOnly(subject.valuationDate)) throw new Error('property_tax_valuation_date_required');

  const candidateDecisions = candidates.map((candidate) => assessCandidate(subject, candidate, policy));
  const decisionsById = new Map(candidateDecisions.map((decision) => [decision.saleId, decision]));
  const selectedCandidates = candidates
    .filter((candidate) => decisionsById.get(candidate.saleId)?.eligible)
    .map((candidate) => ({
      candidate,
      similarityScore: decisionsById.get(candidate.saleId)?.similarityScore || 0,
    }))
    .sort((left, right) => (
      right.similarityScore - left.similarityScore
      || right.candidate.saleDate.localeCompare(left.candidate.saleDate)
      || left.candidate.saleId.localeCompare(right.candidate.saleId)
    ))
    .slice(0, policy.maximumSelectedComparables);

  const selectedComparables = selectedCandidates.map(({ candidate, similarityScore }, index) => {
    const indication = calculateSharedComparableIndication({
      subject: {
        numeric: {
          living_area_sqft: subject.livingAreaSqft,
          site_size_sqft: subject.siteSizeSqft,
          bath_count: subject.bathCount,
          garage_spaces: subject.garageSpaces,
          age_years: subject.ageYears,
        },
        binary: {
          pool: subject.pool,
          solar_panels: subject.solarPanels,
        },
      },
      comparable: {
        saleId: candidate.saleId,
        salePrice: candidate.salePrice,
        concessions: candidate.concessions,
        numeric: {
          living_area_sqft: candidate.livingAreaSqft,
          site_size_sqft: candidate.siteSizeSqft,
          bath_count: candidate.bathCount,
          garage_spaces: candidate.garageSpaces,
          age_years: candidate.ageYears,
        },
        binary: {
          pool: candidate.pool,
          solar_panels: candidate.solarPanels,
        },
      },
      numericRules,
      binaryRules,
      manualAdjustments: candidate.manualAdjustments,
    });
    const districtValue = Number(subject.districtAppraisedValue);
    const valuePosition = Number.isFinite(districtValue) && districtValue > 0
      ? indication.adjustedSalePrice < districtValue
        ? 'supports_lower_value' as const
        : 'at_or_above_district_value' as const
      : 'not_compared' as const;
    return {
      candidate,
      rank: index + 1,
      similarityScore,
      indication,
      valuePosition,
    };
  });

  const diagnostics: string[] = [];
  if (!subject.neighborhoodCode.trim()) {
    diagnostics.push('The subject neighborhood is unavailable; comparable analysis continued without applying the same-neighborhood exclusion and requires reviewer confirmation.');
  }
  if (selectedComparables.length < policy.minimumSelectedComparables) {
    const boundary = subject.neighborhoodCode.trim() ? 'same-neighborhood ' : '';
    diagnostics.push(`Only ${selectedComparables.length} eligible ${boundary}comparable sale(s) were found; ${policy.minimumSelectedComparables} are required before packet generation.`);
  }
  if (!numericRules.length && !binaryRules.length
      && !selectedComparables.some((comparable) => comparable.candidate.manualAdjustments?.length)) {
    diagnostics.push('No market-supported adjustment rules have been supplied; indications reflect verified prices and concessions only.');
  }

  return {
    version: 1,
    policyVersion: policy.version,
    subjectAccountId: subject.accountId,
    valuationDate: subject.valuationDate,
    candidateDecisions,
    selectedComparables,
    indicatedMarketValue: medianComparableIndication(
      selectedComparables.map((comparable) => comparable.indication),
    ),
    diagnostics,
  };
}
