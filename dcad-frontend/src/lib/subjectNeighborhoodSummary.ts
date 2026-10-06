import { reportNeighborhoodName, reportTitleCase } from './propertyReportText.ts';

export interface SubjectNeighborhoodSummaryInput {
  address?: string | null; subdivision?: string | null; neighborhood?: string | null;
  city?: string | null; county?: string | null;
  yearBuilt?: number | null; housingType?: string | null; effectiveDate?: string | null;
  locationType?: string | null; medianYearBuilt?: number | null;
  medianBedrooms?: number | null; medianBathrooms?: number | null;
  includesTownhomes?: boolean; nearbySchool?: string | null;
  insideMunicipalBoundaries?: boolean | null;
}

const clean = (value?: string | null) => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
const medianCount = (value?: number | null) => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= 30 ? String(value) : '[not available]';

/** Appraiser's fixed template. Missing facts remain explicit draft placeholders,
 * not plausible invented schools, drive times, or municipal-service coverage.
 * Schools describe nearby amenities, never attendance assignments. */
export function buildSubjectNeighborhoodSummary(input: SubjectNeighborhoodSummaryInput): string {
  const subdivision = reportNeighborhoodName(clean(input.subdivision)) || '[subdivision not available]';
  const city = reportTitleCase(clean(input.city)) || '[city not available]';
  const year = /^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate || '') ? Number(input.effectiveDate!.slice(0, 4)) : null;
  const built = input.medianYearBuilt;
  const age = year !== null && typeof built === 'number' && Number.isFinite(built) && built >= 1800 && built <= year
    ? `${Number((year - built).toFixed(1))} years (median year built ${built})` : '[median age/year built not available]';
  const location = ['urban', 'suburban', 'rural'].includes(input.locationType || '')
    ? input.locationType! : '[urban/suburban/rural]';
  const homestead = location === 'rural' ? 'rural' : location.startsWith('[') ? '[urban-suburban/rural]' : 'urban-suburban';
  const municipal = input.insideMunicipalBoundaries === true ? 'within' : input.insideMunicipalBoundaries === false ? 'outside'
    : '[within/outside — verify]';
  const school = clean(input.nearbySchool) || '[nearby school — verify]';
  return `The subject immediate subdivision is known as ${subdivision}. The area consists of single family residential homes${input.includesTownhomes ? ' and townhomes' : ''} mostly built in the past ${age} on residential ${location} lots. `
    + 'The neighborhood has nearby parks, shopping, schools, and recreational amenities. '
    + `The home styles are predominantly two and single story traditional ${medianCount(input.medianBedrooms)} bedrooms and ${medianCount(input.medianBathrooms)} baths homes. `
    + 'The quality of materials seen in the market range from standard builder grade (Q4) to above builder grade (Q3) with improvements and updating. '
    + `The subject is within [verify 5-10 minutes] of recreational amenities and schooling such as ${school}, commercial strip centers, parks, lakes, and other amenities. `
    + `The subject is located ${municipal} the municipal boundaries of the City of ${city} and is served by [verify full municipal services]. `
    + `Specifically, fire protection services are provided by [verify ${city} Fire Station] which is within [verify 5-10 minutes]. `
    + `Police protection services are provided through the [verify ${city} Police Department] which is also [verify less than 5 minutes away]. `
    + 'In addition to these emergency services, the property is served by [verify at least three of the following: municipal water, municipal sewer, electric, and trash collection]. '
    + `The property conforms to standards commonly seen for an "${homestead}" homestead in this market area. `
    + 'The defined market area includes its immediate subdivision and nearby competing areas where buyers would be likely to consider purchasing based on similarity of home pricing, employment availability, proximity to highways, and other factors. '
    + 'Some properties in the neighborhood may be superior or inferior to the subject which is normal for competing market areas.';
}

/** Migration comparison only: replace the old generated narrative only when
 * every character still matches the old generator. Preserve manual edits. */
export function legacySubjectNeighborhoodSummary(input: SubjectNeighborhoodSummaryInput): string {
  const clean = (value?: string | null) => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const address = clean(input.address), subdivision = clean(input.subdivision);
  const neighborhood = clean(input.neighborhood), city = clean(input.city), county = clean(input.county);
  const place = [city, county && `${county.replace(/ County$/i, '')} County`].filter(Boolean).join(', ');
  const subject = address ? `The subject at ${address}` : 'The subject';
  const parts = [subdivision
    ? `${subject} is recorded by CAD in the ${subdivision} subdivision${neighborhood ? `, in the ${neighborhood} area` : ''}${place ? ` of ${place}` : ''}.`
    : `${subject}${place ? ` is located in ${place}` : ' has no verified municipality in the available record'}. The subdivision is not identified in the available CAD record.`];
  const housing = clean(input.housingType).replace(/[_-]+/g, ' ').toLowerCase()
    .replace(/single family/g, 'single-family');
  if (housing) parts.push(`The subject's recorded housing type is ${housing}.`);
  const effectiveYear = /^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate || '')
    ? Number(input.effectiveDate!.slice(0, 4)) : null;
  if (Number.isSafeInteger(input.yearBuilt) && input.yearBuilt! >= 1800 && input.yearBuilt! <= 2200
    && (effectiveYear === null || input.yearBuilt! <= effectiveYear)) {
    parts.push(`The recorded year built for the subject is ${input.yearBuilt}.`);
  }
  if (effectiveYear !== null && effectiveYear < new Date().getFullYear() - 1) {
    parts.push(`This current-CAD description does not establish the neighborhood's characteristics on the retrospective effective date of ${input.effectiveDate}; historical conditions require separate verification.`);
  }
  parts.push('Potential competing properties should be compared for similar housing characteristics, size, age, condition, quality, and amenities. '
    + 'Subdivision names alone do not establish competitive equivalence. Properties outside the recorded subdivision may also compete with the subject, while some properties within it may be superior or inferior.');
  return parts.join(' ');
}
