import type { CheckedPocketRecommendation } from './customCohortPocketRecommendation';
import { CUSTOM_COHORT_UNASSIGNED_GROUP } from './customCohortPocketCatalog';

export interface CustomCohortScoreBand {
  readonly minimum: number;
  readonly maximum: number;
  readonly label: string;
  readonly recorded_group_ids: readonly string[];
  readonly account_count: number;
}

/** Selection bands are a view of the checked, current-recorded lower bound.
 * They do not recalculate similarity, infer a parcel-level score, or change
 * the saved recommendation/report. Unknown and unassigned groups stay out. */
export function customCohortScoreBands(recommendation: CheckedPocketRecommendation | null): readonly CustomCohortScoreBand[] {
  if (recommendation?.status !== 'recommendation_for_review') return [];
  const bands = Array.from({ length: 10 }, (_, index) => {
    const minimum = 90 - index * 10;
    return { minimum, maximum: minimum + 10, label: minimum === 90 ? '90–100' : `${minimum}–<${minimum + 10}`,
      recorded_group_ids: [] as string[], account_count: 0 };
  });
  for (const pocket of recommendation.pockets) {
    const lower = pocket.similarity.lower;
    if (pocket.id === CUSTOM_COHORT_UNASSIGNED_GROUP || pocket.member_count <= 0
      || lower === null || !Number.isFinite(lower) || lower < 0 || lower > 100) continue;
    const index = 9 - Math.min(9, Math.floor(lower / 10));
    bands[index].recorded_group_ids.push(pocket.id);
    bands[index].account_count += pocket.member_count;
  }
  return bands;
}
