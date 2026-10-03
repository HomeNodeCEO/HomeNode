// Share only scalar predicates. Extraction bounds/whitespace cleanup, reviewed
// value preservation, calendar formatting and XML serialization stay at their
// respective boundaries; those policies are deliberately not interchangeable.
const PLACEHOLDER = /^(?:xsi:nil|null|undefined|unknown|unavailable|n\/?a|not available|not provided|not applicable|not disclosed|undisclosed|unassigned|pending|tbd|tba|to be determined|to be assigned|to be confirmed|to be announced|[-–—_?]+)[.!]?$/i;
const US_STATE_CODES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' '));

/** Exact markers only: names such as "TBD Holdings" remain meaningful text. */
export function isUrarPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value);
}

/** State/district/territory codes already supported by the Subject extractor. */
export function isUrarStateCode(value) {
  return typeof value === 'string' && US_STATE_CODES.has(value.toUpperCase());
}
