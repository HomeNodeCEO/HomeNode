import { buildSubjectNeighborhoodSummary } from './subjectNeighborhoodSummary.ts';
import { reportTitleCase } from './propertyReportText.ts';
import type { SubjectNeighborhoodSummaryInput } from './subjectNeighborhoodSummary';
import type { CustomCohortPreviewGroup } from '../features/neighborhood/customCohortPreviewController';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const median = (value: unknown) => {
  const m = object(value);
  return typeof m.count === 'number' && m.count > 0 && typeof m.median === 'number' && Number.isFinite(m.median) ? m.median : null;
};
export const NEIGHBORHOOD_TEMPLATE_REVIEW_ITEMS = Object.freeze([
  'nearby_school_and_amenities', 'municipal_boundary_and_services', 'fire_and_police_providers',
  'travel_times', 'housing_styles_and_quality', 'historical_CAD_applicability',
]);

/** The parent supplies only a current coherent selection. No row downloads,
 * median-of-medians, separate polygon, new cache, or inferred school assignment. */
export function neighborhoodSummaryTemplate(input: SubjectNeighborhoodSummaryInput, group: CustomCohortPreviewGroup | null): string {
  const summary = object(group?.summary), selected = object(summary.selected), stock = object(object(selected.stock).metrics);
  const narrative = object(summary.narrative_observations), period = object(narrative.observation_period);
  const expected = object(summary.observation_period);
  const matching = narrative.basis === 'in_period_single_account_closed_sales'
    && typeof expected.start_date === 'string' && period.start_date === expected.start_date && period.end_date === expected.end_date;
  const metrics = matching ? object(narrative.metrics) : {};
  return buildSubjectNeighborhoodSummary({ ...input, medianYearBuilt: median(stock.year_built),
    medianBedrooms: median(metrics.bedrooms_total), medianBathrooms: median(metrics.bathrooms_total_integer) });
}

/** Preserve every manual edit. A baseline retained in this file distinguishes
 * auto-generated text from appraiser-authored prose across reloads/autosaves. */
export function refreshNeighborhoodSummaryTemplate(current: string, baseline: string | undefined,
  input: SubjectNeighborhoodSummaryInput, group: CustomCohortPreviewGroup | null): string | null {
  if (!baseline || current !== baseline) return null;
  let next: string;
  if (group) next = neighborhoodSummaryTemplate(input, group);
  else {
    // Loading/pending choices do not erase previously captured medians. Only
    // the appraiser's classification can change before the next coherent result.
    const location = ['urban', 'suburban', 'rural'].includes(input.locationType || '') ? input.locationType! : '[urban/suburban/rural]';
    const homestead = location === 'rural' ? 'rural' : location.startsWith('[') ? '[urban-suburban/rural]' : 'urban-suburban';
    next = current.replace(/on residential (?:urban|suburban|rural|\[urban\/suburban\/rural\]) lots\./, `on residential ${location} lots.`)
      .replace(/for an "(?:urban-suburban|rural|\[urban-suburban\/rural\])" homestead/, `for an "${homestead}" homestead`);
    if (input.nearbySchool?.trim()) next = next.replace('[nearby school — verify]', reportTitleCase(input.nearbySchool.trim()));
  }
  return next === current ? null : next;
}
