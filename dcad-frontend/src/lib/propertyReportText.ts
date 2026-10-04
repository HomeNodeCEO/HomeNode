const NAME_ACRONYMS = new Set(['LLC', 'PLLC', 'LLP', 'LP', 'PC', 'INC', 'USA', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX']);
const ADDRESS_ACRONYMS = new Set(['US', 'PO', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const STATE_CODES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' '));

/** Report formatting only: never alter CAD identifiers, legal text, or evidence.
 * Preserve already mixed-case names instead of guessing spelling (McDonald).
 */
export function reportTitleCase(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\p{L}[\p{L}\p{M}]*/gu, word => {
    const upper = word.toUpperCase();
    if (NAME_ACRONYMS.has(upper)) return upper;
    if (word !== upper && word !== word.toLowerCase()) return word;
    const lower = word.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

export function reportZip5(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  return /^\d{5}(?:-?\d{4})?$/.test(text) ? text.slice(0, 5) : text;
}

export function reportAddress(value: unknown): string {
  return reportTitleCase(value)
    .replace(/\b(?:n|s|e|w|ne|nw|se|sw|us|po)\b/gi, word => ADDRESS_ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word)
    // A postal state belongs immediately before its ZIP, not in arbitrary
    // street words such as "In The Woods". No address components are inferred.
    .replace(/\b([A-Za-z]{2}|Texas)(\s+)(\d{5})(?:-?\d{4})?(?=\s*$)/, (suffix, state: string, gap: string, zip: string) => state === 'Texas' ? `Texas${gap}${zip}` : STATE_CODES.has(state.toUpperCase()) ? `${state.toUpperCase()}${gap}${zip}` : suffix);
}

export function reportNeighborhoodName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return reportTitleCase(value.replace(/\s+\d+\s*$/, ''));
}
