type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return '';
}

function firstArrayItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function joinedLines(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const source = Array.isArray(value)
    ? value
    : valueAt(value, ['lines']);
  if (!Array.isArray(source)) return '';
  return source
    .map(textValue)
    .filter(Boolean)
    .join('\n');
}

export function ownerNameFromDetail(detail: unknown): string {
  const firstOwner = firstArrayItem(valueAt(detail, ['owner', 'multi_owner']));
  const firstHistory = firstArrayItem(valueAt(detail, ['history', 'owner_history']));
  return firstText(
    valueAt(detail, ['owner', 'owner_name']),
    valueAt(detail, ['owner_name']),
    valueAt(detail, ['owner', 'name']),
    valueAt(firstOwner, ['owner_name']),
    valueAt(firstOwner, ['name']),
    valueAt(firstHistory, ['owner']),
  );
}

export function countyFromAccount(accountResponse: unknown): string {
  return firstText(valueAt(accountResponse, ['account', 'county']));
}

export function subjectAddressFromAccount(accountResponse: unknown): string {
  return firstText(valueAt(accountResponse, ['account', 'address']));
}

export function subjectAddressFromDetail(detail: unknown): string {
  return firstText(
    valueAt(detail, ['detail', 'property_location', 'address']),
    valueAt(detail, ['property_location', 'address']),
  );
}

export function mapscoFromDetail(detail: unknown): string {
  return firstText(
    valueAt(detail, ['detail', 'property_location', 'mapsco']),
    valueAt(detail, ['property_location', 'mapsco']),
  );
}

export function mailingAddressFromDetail(detail: unknown): string {
  return firstText(
    valueAt(detail, ['detail', 'owner', 'mailing_address']),
    valueAt(detail, ['owner', 'mailing_address']),
  );
}

export function legalDescriptionFromDetail(detail: unknown): string {
  return joinedLines(valueAt(detail, ['detail', 'legal_description']))
    || joinedLines(valueAt(detail, ['legal_description']));
}

export function legalDescriptionFromAccount(accountResponse: unknown): string {
  const current = valueAt(accountResponse, ['legal_current']);
  return joinedLines(valueAt(current, ['legal_lines']))
    || firstText(valueAt(current, ['legal_text']));
}

export function signupErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message.trim()
    : firstText(valueAt(error, ['message']));
  return message ? message.slice(0, 160) : 'Submit failed';
}
