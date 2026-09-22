/** A source-limited starting narrative, never an assertion about school
 * assignment, nearby amenities, builders, boundaries, or market eligibility. */
export function buildSubjectNeighborhoodSummary(input: {
  address?: string | null; subdivision?: string | null; neighborhood?: string | null;
  city?: string | null; county?: string | null;
  yearBuilt?: number | null; housingType?: string | null;
}): string {
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
  if (Number.isSafeInteger(input.yearBuilt) && input.yearBuilt! >= 1800 && input.yearBuilt! <= 2200) {
    parts.push(`The recorded year built for the subject is ${input.yearBuilt}.`);
  }
  parts.push('Potential competing properties should be compared for similar housing characteristics, size, age, condition, quality, and amenities. '
    + 'Subdivision names alone do not establish competitive equivalence. Properties outside the recorded subdivision may also compete with the subject, while some properties within it may be superior or inferior.');
  return parts.join(' ');
}
