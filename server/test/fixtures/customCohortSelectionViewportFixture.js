import { selectionSummaryTransportFixture } from './customCohortSelectionSummaryTransportFixture.js';
import { presentCustomCohortSelectionViewportMap } from '../../src/services/neighborhoodAssessment/customCohortViewportMap.js';

export async function selectionViewportFixture(options = {}) {
  const f = await selectionSummaryTransportFixture(options);
  const viewport = { west: -97.005, south: 31.99, east: -96.97, north: 32.01 };
  const features = [-97, -96.9, -96.98].map((x, i) => ({ type: 'Feature', id: `gis.dcad_parcels:${i + 1}`,
    properties: { object_id: String(i + 1), account_id: String(10000000000000000n + BigInt(i)), selected: !options.empty && i < 2 },
    geometry: { type: 'Polygon', coordinates: [[[x, 32], [x + .001, 32], [x + .001, 32.001], [x, 32.001], [x, 32]]] } }));
  const viewport_map = presentCustomCohortSelectionViewportMap({ ...f.result,
    parcel_map: { status: 'available', geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
      geojson: { type: 'FeatureCollection', features }, counts: { parcels: 3 } } }, viewport);
  return { ...f, summary: f.result.summary, request: { ...f.request, viewport },
    result: { status: 'viewport', authority: 'not_established', selection_ref: f.request.selection_ref, viewport_map } };
}
