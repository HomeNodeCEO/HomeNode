// Compact, capture-bound map opening metadata. This is a display aid, never a
// replacement for the retained parcel geometry or a legal subdivision line.
const MAX_MANIFEST_BYTES = 4_000_000;
const UNASSIGNED = 'discovery:unassigned';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function fail() { throw Object.assign(new TypeError('invalid_custom_cohort_map_manifest'), { reason: 'invalid_input' }); }

function anchorOf(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let chosen = null, first = null;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (!first && ring.length) first = ring[0];
    for (const point of ring) {
      if (!chosen || point[0] < chosen[0] || (point[0] === chosen[0] && point[1] < chosen[1])) chosen = point;
    }
  }
  if (!chosen || !first) fail();
  return { label: [chosen[0], chosen[1]], subject: [first[0], first[1]] };
}

export function buildCustomCohortMapManifest(catalog, map) {
  if (!catalog || !map || !['available', 'unavailable'].includes(map.status)
    || !catalog.binding?.context_ref || !catalog.subject_membership?.account_id
    || !Array.isArray(catalog.pockets) || !Array.isArray(catalog.unassigned?.account_ids)) fail();
  const ref = catalog.binding.context_ref, subject = catalog.subject_membership.account_id;
  if (map.status === 'unavailable') return { status: 'unavailable', context_ref: ref,
    geometry_semantics: map.geometry_semantics, reason: map.reason };
  if (map.geojson?.type !== 'FeatureCollection' || !Array.isArray(map.geojson.features)) fail();
  const groupByAccount = new Map(), names = new Map();
  for (const pocket of catalog.pockets) {
    if (names.has(pocket.id) || !Array.isArray(pocket.account_ids)) fail();
    names.set(pocket.id, { label: pocket.label, county: pocket.county });
    for (const account of pocket.account_ids) {
      if (groupByAccount.has(account)) fail();
      groupByAccount.set(account, pocket.id);
    }
  }
  for (const account of catalog.unassigned.account_ids) {
    if (groupByAccount.has(account)) fail();
    groupByAccount.set(account, UNASSIGNED);
  }
  if (map.counts?.parcels !== map.geojson.features.length) fail();
  if (map.counts.accounts !== groupByAccount.size) return { status: 'unavailable', context_ref: ref,
    geometry_semantics: map.geometry_semantics, reason: 'catalog_geometry_mismatch' };
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const candidates = new Map(), represented = new Set(), subjectParcels = [];
  for (const feature of map.geojson.features) {
    const account = feature.properties?.account_id, group = groupByAccount.get(account);
    if (!group) return { status: 'unavailable', context_ref: ref,
      geometry_semantics: map.geometry_semantics, reason: 'catalog_geometry_mismatch' };
    if (feature.id !== `gis.dcad_parcels:${feature.properties.object_id}`) fail();
    represented.add(account);
    const geometry = feature.geometry, polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates;
    if (!Array.isArray(polygons)) fail();
    for (const polygon of polygons) for (const ring of polygon) for (const [x, y] of ring) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) fail();
      west = Math.min(west, x); south = Math.min(south, y);
      east = Math.max(east, x); north = Math.max(north, y);
    }
    const points = anchorOf(geometry);
    if (account === subject) subjectParcels.push({ parcel_id: feature.id, account_id: account,
      coordinates: points.subject, anchor_basis: 'retained_exterior_ring_vertex' });
    if (group === UNASSIGNED) continue;
    const previous = candidates.get(group);
    if (!previous || compare(account, previous.account) < 0
      || (account === previous.account && compare(feature.id, previous.parcel) < 0)) {
      candidates.set(group, { account, parcel: feature.id, point: points.label });
    }
  }
  if (represented.size !== groupByAccount.size) return { status: 'unavailable', context_ref: ref,
    geometry_semantics: map.geometry_semantics, reason: 'catalog_geometry_mismatch' };
  if (!Number.isFinite(west)) fail();
  const labels = [], unlabelled = [];
  for (const id of [...names.keys()].sort(compare)) {
    const candidate = candidates.get(id), name = names.get(id);
    if (!candidate) { unlabelled.push(id); continue; }
    labels.push({ type: 'Feature', id: `custom-cohort-label:${id}`,
      geometry: { type: 'Point', coordinates: candidate.point },
      properties: { pocket_id: id, label: name.label, county: name.county,
        account_id: candidate.account, parcel_id: candidate.parcel,
        anchor_basis: 'retained_exterior_ring_vertex' } });
  }
  const output = { status: 'available', context_ref: ref, geometry_semantics: map.geometry_semantics,
    bounds: [[west, south], [east, north]], labels: { type: 'FeatureCollection', features: labels },
    unlabelled_group_ids: unlabelled, subject_parcels: subjectParcels,
    counts: { captured_parcels: map.counts.parcels, captured_accounts: map.counts.accounts } };
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_MANIFEST_BYTES) fail();
  return output;
}
