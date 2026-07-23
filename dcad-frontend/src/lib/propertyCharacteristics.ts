type CharacteristicValue = number | string | null | undefined;

export function parseWholeCount(value: CharacteristicValue): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const numberValue =
    typeof value === 'string'
      ? Number(value.replace(/[^0-9.-]/g, ''))
      : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? Math.round(numberValue)
    : undefined;
}

export function formatBathCount(
  fullValue: CharacteristicValue,
  halfValue: CharacteristicValue,
  combinedValue?: CharacteristicValue,
): string {
  const full = parseWholeCount(fullValue);
  const half = parseWholeCount(halfValue);

  if (full !== undefined || half !== undefined) {
    return `${full ?? 0}.${half ?? 0}`;
  }

  if (combinedValue === null || combinedValue === undefined || combinedValue === '') {
    return '';
  }

  const match = String(combinedValue).trim().match(/^(\d+)(?:\.(\d+))?$/);
  return match ? `${Number(match[1])}.${Number(match[2] || 0)}` : '';
}
