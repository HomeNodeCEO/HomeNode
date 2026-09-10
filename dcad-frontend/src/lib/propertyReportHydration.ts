import type { AssignmentDetailsPayload } from './api';
import { displayValue, hasValue } from './propertyReportPresentation.ts';

/** Preserve only previously loaded ZIP/city comparisons during assignment
 * hydration. This is the existing display merge, not new source authority. */
export function retainPropertyReportUnemploymentComparisons(
  serverDraft: AssignmentDetailsPayload,
  current: AssignmentDetailsPayload,
  lookupSucceeded: boolean,
): AssignmentDetailsPayload {
  if (!lookupSucceeded) return serverDraft;
  const zipComparison = hasValue(current.neighborhood_unemployment_pct) ? {
    neighborhood_unemployment_pct: current.neighborhood_unemployment_pct,
    neighborhood_unemployment_zip: current.neighborhood_unemployment_zip,
    neighborhood_unemployment_source: current.neighborhood_unemployment_source,
    neighborhood_unemployment_dataset_year: current.neighborhood_unemployment_dataset_year,
    neighborhood_unemployment_variable: current.neighborhood_unemployment_variable,
  } : {};
  const cityComparison = hasValue(current.neighborhood_city_unemployment_pct) ? {
    neighborhood_city_unemployment_pct: current.neighborhood_city_unemployment_pct,
    neighborhood_city_unemployment_name: current.neighborhood_city_unemployment_name,
    neighborhood_city_unemployment_source: current.neighborhood_city_unemployment_source,
    neighborhood_city_unemployment_dataset_year: current.neighborhood_city_unemployment_dataset_year,
    neighborhood_city_unemployment_variable: current.neighborhood_city_unemployment_variable,
  } : {};
  return { ...serverDraft, ...zipComparison, ...cityComparison };
}

export function propertyReportLocationContext(location?: {
  address?: unknown; city?: unknown; state?: unknown; postal_code?: unknown;
} | null) {
  const street = String(location?.address || '').trim();
  const address = displayValue(location?.address, 'Property address unavailable');
  return {
    streetAddress: address.split(',')[0].trim() || address,
    city: displayValue(location?.city),
    state: displayValue(location?.state, 'TX'),
    postalCode: displayValue(location?.postal_code),
    documentReviewSubjectAddress: street
      ? [street, location?.city, location?.state || 'TX', location?.postal_code]
        .map(value => String(value || '').trim()).filter(Boolean).join(', ')
      : '',
    censusZip: String(location?.postal_code || '').replace(/\D/g, '').slice(0, 5),
  };
}
