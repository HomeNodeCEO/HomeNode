export const CUSTOM_WORKSPACE_DISCOVERY_RADII_METRES = Object.freeze(['4828.032', '8046.72', '16093.44'] as const);
export interface CustomWorkspaceRadiusDiscovery {
  readonly profile_id: 'custom-suburban-radius-v2';
  readonly radius_metres: typeof CUSTOM_WORKSPACE_DISCOVERY_RADII_METRES[number];
}
export interface CustomWorkspaceCityDiscovery {
  readonly profile_id: 'custom-city-polygon-v1';
  readonly city: { readonly geoid: string; readonly vintage: string; readonly asset_sha256: string };
}
export type CustomWorkspaceDiscovery = CustomWorkspaceRadiusDiscovery | CustomWorkspaceCityDiscovery;
function fail(reason = 'discovery'): never {
  throw Object.assign(new TypeError('Invalid custom neighborhood discovery'), { checkpointReason: reason });
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('discovery.non_data_property');
    result[key] = descriptor.value;
  }
  return result;
}
/** Retained identity grammar, not a lookup of today's installed city assets.
 * UI choices use the installed catalog; saved older identities remain readable. */
export function prepareCustomWorkspaceDiscovery(value: unknown): CustomWorkspaceDiscovery {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'profile_id') : undefined;
  const record = closed(value, descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === 'custom-city-polygon-v1'
    ? ['profile_id', 'city'] : ['profile_id', 'radius_metres']);
  if (record.profile_id === 'custom-city-polygon-v1') {
    const city = closed(record.city, ['geoid', 'vintage', 'asset_sha256']);
    if (typeof city.geoid !== 'string' || !/^48\d{5}$/.test(city.geoid)
      || typeof city.vintage !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(city.vintage) || city.vintage.startsWith('0000')
      || typeof city.asset_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(city.asset_sha256)) fail();
    const parsed = new Date(`${city.vintage}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== city.vintage) fail();
    return Object.freeze({ profile_id: record.profile_id,
      city: Object.freeze({ geoid: city.geoid, vintage: city.vintage, asset_sha256: city.asset_sha256 }) });
  }
  if (record.profile_id !== 'custom-suburban-radius-v2'
    || !CUSTOM_WORKSPACE_DISCOVERY_RADII_METRES.some(radius => radius === record.radius_metres)) fail();
  return Object.freeze({ profile_id: record.profile_id, radius_metres: record.radius_metres as CustomWorkspaceRadiusDiscovery['radius_metres'] });
}
export function sameCustomWorkspaceDiscovery(a: CustomWorkspaceDiscovery | undefined, b: CustomWorkspaceDiscovery | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** The city response has no radius. Old radius responses retain their exact shape. */
export function customWorkspaceCaptureDiscoveryMatches(value: unknown, expected?: CustomWorkspaceDiscovery): boolean {
  try {
    if (expected?.profile_id === 'custom-city-polygon-v1') {
      const record = closed(value, ['profile_id', 'city', 'parcel_count', 'account_count']);
      if (!['parcel_count', 'account_count'].every(key => Number.isSafeInteger(record[key]) && Number(record[key]) >= 0)) return false;
      return sameCustomWorkspaceDiscovery(prepareCustomWorkspaceDiscovery({ profile_id: record.profile_id, city: record.city }), expected);
    }
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.hasOwn(value, 'city') || Object.hasOwn(value, 'profile_id')) return false;
    const radius = Object.getOwnPropertyDescriptor(value, 'radius_metres');
    return Boolean(radius?.enumerable && Object.hasOwn(radius, 'value') && radius.value === (expected?.radius_metres ?? '4828.032'));
  } catch { return false; }
}
