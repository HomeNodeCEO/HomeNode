import type { CheckedPocketRecommendation } from './customCohortPocketRecommendation';
import type { CheckedPreparedSecondaryMap } from './customCohortPreparedSecondaryMap';
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
export function customCohortScoreBands(recommendation: CheckedPocketRecommendation | null,
  preparedMap?: CheckedPreparedSecondaryMap): readonly CustomCohortScoreBand[] {
  if (recommendation?.status !== 'recommendation_for_review' && preparedMap?.version !== 2) return [];
  const bands = Array.from({ length: 10 }, (_, index) => {
    const minimum = 90 - index * 10;
    return { minimum, maximum: minimum + 10, label: minimum === 90 ? '90–100' : `${minimum}–<${minimum + 10}`,
      recorded_group_ids: [] as string[], account_count: 0 };
  });
  const supported = new Map(preparedMap?.groups.filter(group => group.supported_member_count > 0).map(group => [group.id, group]) ?? []);
  const pockets = recommendation?.status === 'recommendation_for_review' ? recommendation.pockets
    : preparedMap!.groups.map(group => ({ ...group, similarity: { lower: supported.has(group.id) ? group.lower : null } }));
  for (const pocket of pockets) {
    const lower = supported.get(pocket.id)?.lower ?? pocket.similarity.lower;
    if (pocket.id === CUSTOM_COHORT_UNASSIGNED_GROUP || pocket.member_count <= 0
      || lower === null || !Number.isFinite(lower) || lower < 0 || lower > 100) continue;
    const index = 9 - Math.min(9, Math.floor(lower / 10));
    bands[index].recorded_group_ids.push(pocket.id);
    bands[index].account_count += pocket.member_count;
  }
  return bands;
}
