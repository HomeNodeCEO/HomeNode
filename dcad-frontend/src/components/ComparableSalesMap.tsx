import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '@/lib/api';
import type { MarketConditionsSubject, SaleRow } from '@/lib/api';

const MAPLIBRE_SCRIPT = 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js';
const MAPLIBRE_STYLE = 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css';
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';

type Props = {
  subjectAccountId: string;
  assignmentFileId?: number | null;
  subjectAddress?: string | null;
  sales: Array<SaleRow | null>;
  onOpenSale?: (sale: SaleRow) => void;
};

type MappedComparable = {
  sale: SaleRow;
  slot: number;
  latitude: number;
  longitude: number;
  distanceMiles: number | null;
};

type MarkerCoordinate = [number, number];

type MapLibreLngLat = { lng: number; lat: number };
type MapLibreGeoJsonSource = { setData: (data: unknown) => void };
type MapLibreMarker = {
  setLngLat: (coordinate: MarkerCoordinate) => MapLibreMarker;
  addTo: (map: MapLibreMap) => MapLibreMarker;
  getLngLat: () => MapLibreLngLat;
  on: (event: string, handler: () => void) => MapLibreMarker;
};
type MapLibreBounds = {
  extend: (coordinate: MarkerCoordinate) => MapLibreBounds;
};
type MapLibreMap = {
  addControl: (control: unknown, position: string) => void;
  addLayer: (layer: unknown) => void;
  addSource: (id: string, source: unknown) => void;
  fitBounds: (bounds: MapLibreBounds, options: unknown) => void;
  getSource: (id: string) => MapLibreGeoJsonSource | undefined;
  on: (event: string, handler: () => void) => void;
  once: (event: string, handler: () => void) => void;
  remove: () => void;
  resize: () => void;
};
type MapLibreRuntime = {
  Map: new (options: unknown) => MapLibreMap;
  Marker: new (options: unknown) => MapLibreMarker;
  LngLatBounds: new () => MapLibreBounds;
  NavigationControl: new (options: unknown) => unknown;
};

function currentMapLibre(): MapLibreRuntime | undefined {
  return (window as unknown as { maplibregl?: MapLibreRuntime }).maplibregl;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineMiles(
  subjectLatitude: number,
  subjectLongitude: number,
  comparableLatitude: number,
  comparableLongitude: number,
): number {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(comparableLatitude - subjectLatitude);
  const longitudeDelta = radians(comparableLongitude - subjectLongitude);
  const startLatitude = radians(subjectLatitude);
  const endLatitude = radians(comparableLatitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function displayAddress(sale: SaleRow): string {
  return [sale.address, sale.city, sale.state, sale.zip].filter(Boolean).join(', ') ||
    sale.primary_account_id ||
    'Address unavailable';
}

function addStyle(): void {
  if (document.querySelector('link[data-homenode-map-style="maplibre"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = MAPLIBRE_STYLE;
  link.dataset.homenodeMapStyle = 'maplibre';
  document.head.appendChild(link);
}

function loadMapLibre(): Promise<MapLibreRuntime> {
  addStyle();
  const existingGlobal = currentMapLibre();
  if (existingGlobal) return Promise.resolve(existingGlobal);
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-homenode-map-script="maplibre"]',
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => currentMapLibre()
        ? resolve(currentMapLibre()!)
        : reject(new Error('map_library_missing_global')), { once: true });
      existing.addEventListener('error', () => reject(new Error('map_library_load_failed')), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MAPLIBRE_SCRIPT;
    script.async = true;
    script.dataset.homenodeMapScript = 'maplibre';
    script.addEventListener('load', () => currentMapLibre()
      ? resolve(currentMapLibre()!)
      : reject(new Error('map_library_missing_global')), { once: true });
    script.addEventListener('error', () => reject(new Error('map_library_load_failed')), { once: true });
    document.head.appendChild(script);
  });
}

function markerIdentity(comparable: MappedComparable): string {
  return String(
    comparable.sale.source_record_id ||
    comparable.sale.listing_id ||
    comparable.sale.sale_id ||
    `${comparable.sale.primary_account_id || 'unmatched'}:${comparable.slot}`,
  );
}

function defaultLabelCoordinate(comparable: MappedComparable): MarkerCoordinate {
  // Fan the movable cards around their true parcel pins. The leader line keeps
  // the exact location unambiguous while avoiding a stack of overlapping cards.
  const angle = ((comparable.slot * 137.5) - 90) * Math.PI / 180;
  const offsetFeet = 245;
  const latitudeFeet = 364_000;
  const longitudeFeet = Math.max(
    220_000,
    latitudeFeet * Math.cos(comparable.latitude * Math.PI / 180),
  );
  return [
    comparable.longitude + (Math.cos(angle) * offsetFeet) / longitudeFeet,
    comparable.latitude + (Math.sin(angle) * offsetFeet) / latitudeFeet,
  ];
}

function makeHousePin(
  label: string,
  address: string,
  color: string,
): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'grid';
  wrapper.style.justifyItems = 'center';
  wrapper.style.width = '34px';
  wrapper.style.height = '42px';
  wrapper.title = address;
  wrapper.className = 'homenode-house-pin';

  const pin = document.createElement('div');
  pin.style.display = 'grid';
  pin.style.placeItems = 'center';
  pin.style.width = '30px';
  pin.style.height = '30px';
  pin.style.borderRadius = '50% 50% 50% 0';
  pin.style.transform = 'rotate(-45deg)';
  pin.style.background = color;
  pin.style.border = '3px solid white';
  pin.style.boxShadow = '0 2px 8px rgba(15, 23, 42, .38)';

  const house = document.createElement('span');
  house.textContent = label;
  house.style.display = 'grid';
  house.style.placeItems = 'center';
  house.style.width = '22px';
  house.style.height = '22px';
  house.style.transform = 'rotate(45deg)';
  house.style.color = 'white';
  house.style.fontSize = label.length > 2 ? '8px' : '11px';
  house.style.fontWeight = '800';
  house.style.lineHeight = '1';

  pin.appendChild(house);
  wrapper.appendChild(pin);
  return wrapper;
}

function makeComparableMarker(
  comparable: MappedComparable,
  onOpenSale?: (sale: SaleRow) => void,
): { element: HTMLDivElement; button: HTMLButtonElement } {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'grid';
  wrapper.style.justifyItems = 'center';
  wrapper.style.width = '142px';
  wrapper.style.cursor = 'grab';
  wrapper.style.touchAction = 'none';
  wrapper.className = 'homenode-comparable-label';

  const marker = document.createElement('button');
  marker.type = 'button';
  marker.title = displayAddress(comparable.sale);
  marker.setAttribute('aria-label', `Comparable ${comparable.slot + 1}: ${displayAddress(comparable.sale)}`);
  marker.style.display = 'flex';
  marker.style.alignItems = 'center';
  marker.style.gap = '6px';
  marker.style.width = '142px';
  marker.style.padding = '4px';
  marker.style.border = '2px solid #2563eb';
  marker.style.borderRadius = '9px';
  marker.style.background = 'white';
  marker.style.boxShadow = '0 3px 10px rgba(15, 23, 42, .28)';
  marker.style.textAlign = 'left';
  marker.style.cursor = 'grab';
  marker.style.touchAction = 'none';
  marker.className = 'homenode-comparable-card';

  const image = document.createElement('div');
  image.style.width = '42px';
  image.style.height = '34px';
  image.style.flex = '0 0 auto';
  image.style.overflow = 'hidden';
  image.style.borderRadius = '6px';
  image.style.background = '#e2e8f0';
  if (comparable.sale.primary_photo_url) {
    const thumbnail = document.createElement('img');
    thumbnail.src = comparable.sale.primary_photo_url;
    thumbnail.alt = '';
    thumbnail.style.width = '100%';
    thumbnail.style.height = '100%';
    thumbnail.style.objectFit = 'cover';
    image.appendChild(thumbnail);
  } else {
    image.textContent = 'No photo';
    image.style.display = 'grid';
    image.style.placeItems = 'center';
    image.style.fontSize = '8px';
    image.style.color = '#475569';
  }

  const copy = document.createElement('span');
  copy.style.display = 'grid';
  copy.style.minWidth = '0';

  const title = document.createElement('strong');
  title.textContent = `Comparable #${comparable.slot + 1}`;
  title.style.fontSize = '10px';
  title.style.color = '#1e3a8a';
  title.style.whiteSpace = 'nowrap';

  const distance = document.createElement('span');
  distance.textContent = comparable.distanceMiles === null
    ? 'Distance unavailable'
    : `${comparable.distanceMiles.toFixed(2)} mi`;
  distance.style.fontSize = '9px';
  distance.style.color = '#475569';
  distance.style.whiteSpace = 'nowrap';

  copy.append(title, distance);
  marker.append(image, copy);

  const pointer = document.createElement('span');
  pointer.setAttribute('aria-hidden', 'true');
  pointer.style.display = 'block';
  pointer.style.width = '0';
  pointer.style.height = '0';
  pointer.style.marginTop = '-1px';
  pointer.style.borderLeft = '9px solid transparent';
  pointer.style.borderRight = '9px solid transparent';
  pointer.style.borderTop = '10px solid #2563eb';
  wrapper.append(marker, pointer);
  marker.addEventListener('click', (event) => {
    event.stopPropagation();
    if (marker.dataset.dragged === 'true') return;
    if (comparable.sale.primary_photo_url) onOpenSale?.(comparable.sale);
  });
  return { element: wrapper, button: marker };
}

export default function ComparableSalesMap({
  subjectAccountId,
  assignmentFileId,
  subjectAddress,
  sales,
  onOpenSale,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const openSaleRef = useRef(onOpenSale);
  const labelPositionsRef = useRef<Record<string, MarkerCoordinate>>({});
  const [subject, setSubject] = useState<MarketConditionsSubject | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [markerLayoutRevision, setMarkerLayoutRevision] = useState(0);

  useEffect(() => {
    openSaleRef.current = onOpenSale;
  }, [onOpenSale]);

  useEffect(() => {
    let cancelled = false;
    setSubject(null);
    setMapError(null);
    if (!subjectAccountId || !assignmentFileId) return () => { cancelled = true; };
    setContextLoading(true);
    void api.getMarketConditionsContext(subjectAccountId, assignmentFileId)
      .then((response) => {
        if (!cancelled) setSubject(response.subject);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMapError(error instanceof Error ? error.message : 'Subject map location could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => { cancelled = true; };
  }, [assignmentFileId, subjectAccountId]);

  const mappedComparables = useMemo<MappedComparable[]>(() => {
    const subjectLatitude = numberValue(subject?.latitude);
    const subjectLongitude = numberValue(subject?.longitude);
    return sales.flatMap((sale, slot) => {
      if (!sale) return [];
      const latitude = numberValue(sale.latitude);
      const longitude = numberValue(sale.longitude);
      if (latitude === null || longitude === null) return [];
      const suppliedDistance = numberValue(sale.distanceMiles);
      const distanceMiles = suppliedDistance ?? (
        subjectLatitude !== null && subjectLongitude !== null
          ? haversineMiles(subjectLatitude, subjectLongitude, latitude, longitude)
          : null
      );
      return [{ sale, slot, latitude, longitude, distanceMiles }];
    });
  }, [sales, subject?.latitude, subject?.longitude]);

  const selectedCount = sales.filter(Boolean).length;
  const missingLocationCount = Math.max(0, selectedCount - mappedComparables.length);
  const markerFingerprint = mappedComparables
    .map((item) => `${item.slot}:${item.latitude}:${item.longitude}:${item.sale.primary_photo_url || ''}`)
    .join('|');

  useEffect(() => {
    const subjectLatitude = numberValue(subject?.latitude);
    const subjectLongitude = numberValue(subject?.longitude);
    if (!containerRef.current || subjectLatitude === null || subjectLongitude === null) {
      return () => undefined;
    }
    let cancelled = false;
    let map: MapLibreMap | null = null;
    setMapError(null);
    void loadMapLibre()
      .then((maplibre) => {
        if (cancelled || !containerRef.current || !maplibre) return;
        map = new maplibre.Map({
          container: containerRef.current,
          style: MAP_STYLE_URL,
          center: [subjectLongitude, subjectLatitude],
          zoom: 13,
          attributionControl: true,
        });
        const activeMap = map;
        activeMap.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        activeMap.on('load', () => {
          if (cancelled) return;
          const bounds = new maplibre.LngLatBounds();
          bounds.extend([subjectLongitude, subjectLatitude]);
          new maplibre.Marker({
            element: makeHousePin(
              'S',
              subject?.address || subjectAddress || subjectAccountId,
              '#dc2626',
            ),
            anchor: 'bottom',
          })
            .setLngLat([subjectLongitude, subjectLatitude])
            .addTo(activeMap);

          const leaderFeatures = mappedComparables.map((comparable) => {
            const labelCoordinate = labelPositionsRef.current[markerIdentity(comparable)] ||
              defaultLabelCoordinate(comparable);
            return {
              type: 'Feature' as const,
              properties: { id: markerIdentity(comparable) },
              geometry: {
                type: 'LineString' as const,
                coordinates: [
                  [comparable.longitude, comparable.latitude],
                  labelCoordinate,
                ],
              },
            };
          });
          const leaderData = {
            type: 'FeatureCollection' as const,
            features: leaderFeatures,
          };
          const leaderEndpointFeatures = mappedComparables.map((comparable) => {
            const labelCoordinate = labelPositionsRef.current[markerIdentity(comparable)] ||
              defaultLabelCoordinate(comparable);
            return {
              type: 'Feature' as const,
              properties: { id: markerIdentity(comparable) },
              geometry: {
                type: 'Point' as const,
                coordinates: labelCoordinate,
              },
            };
          });
          const leaderEndpointData = {
            type: 'FeatureCollection' as const,
            features: leaderEndpointFeatures,
          };
          activeMap.addSource('comparable-label-leaders', {
            type: 'geojson',
            data: leaderData,
          });
          activeMap.addSource('comparable-label-leader-ends', {
            type: 'geojson',
            data: leaderEndpointData,
          });
          activeMap.addLayer({
            id: 'comparable-label-leaders',
            type: 'line',
            source: 'comparable-label-leaders',
            paint: {
              'line-color': '#1d4ed8',
              'line-width': 2,
              'line-opacity': 0.9,
              'line-dasharray': [2, 1.5],
            },
          });
          activeMap.addLayer({
            id: 'comparable-label-leader-ends',
            type: 'circle',
            source: 'comparable-label-leader-ends',
            paint: {
              'circle-color': '#1d4ed8',
              'circle-radius': 3,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1,
            },
          });

          const updateLeader = (
            comparable: MappedComparable,
            coordinate: MarkerCoordinate,
          ) => {
            const feature = leaderFeatures.find(
              (item) => item.properties.id === markerIdentity(comparable),
            );
            if (!feature) return;
            feature.geometry.coordinates[1] = coordinate;
            const endpointFeature = leaderEndpointFeatures.find(
              (item) => item.properties.id === markerIdentity(comparable),
            );
            if (endpointFeature) endpointFeature.geometry.coordinates = coordinate;
            activeMap.getSource('comparable-label-leaders')?.setData(leaderData);
            activeMap.getSource('comparable-label-leader-ends')?.setData(leaderEndpointData);
          };

          mappedComparables.forEach((comparable) => {
            bounds.extend([comparable.longitude, comparable.latitude]);
            const labelMarkerElement = makeComparableMarker(
              comparable,
              (sale) => openSaleRef.current?.(sale),
            );
            const identity = markerIdentity(comparable);
            const initialCoordinate = labelPositionsRef.current[identity] ||
              defaultLabelCoordinate(comparable);
            const labelMarker = new maplibre.Marker({
              element: labelMarkerElement.element,
              anchor: 'bottom',
              draggable: true,
            })
              .setLngLat(initialCoordinate)
              .addTo(activeMap);
            labelMarker.on('dragstart', () => {
              labelMarkerElement.button.dataset.dragged = 'true';
              labelMarkerElement.element.style.cursor = 'grabbing';
              labelMarkerElement.button.style.cursor = 'grabbing';
            });
            labelMarker.on('drag', () => {
              const coordinate = labelMarker.getLngLat();
              updateLeader(comparable, [coordinate.lng, coordinate.lat]);
            });
            labelMarker.on('dragend', () => {
              const coordinate = labelMarker.getLngLat();
              labelPositionsRef.current[identity] = [coordinate.lng, coordinate.lat];
              updateLeader(comparable, [coordinate.lng, coordinate.lat]);
              labelMarkerElement.element.style.cursor = 'grab';
              labelMarkerElement.button.style.cursor = 'grab';
              window.setTimeout(() => {
                labelMarkerElement.button.dataset.dragged = 'false';
              }, 0);
            });
          });

          if (mappedComparables.length) {
            activeMap.fitBounds(bounds, { padding: 110, maxZoom: 14, duration: 0 });
          }
        });

        const resizeForPrint = () => map?.resize();
        window.addEventListener('beforeprint', resizeForPrint);
        window.addEventListener('afterprint', resizeForPrint);
        map.once('remove', () => {
          window.removeEventListener('beforeprint', resizeForPrint);
          window.removeEventListener('afterprint', resizeForPrint);
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setMapError(error instanceof Error ? error.message : 'Comparable map could not be loaded.');
      });
    return () => {
      cancelled = true;
      if (map) map.remove();
    };
  }, [mappedComparables, markerFingerprint, markerLayoutRevision, subject?.address, subject?.latitude, subject?.longitude, subjectAccountId, subjectAddress]);

  const farthestDistance = mappedComparables.reduce<number | null>(
    (largest, item) => item.distanceMiles === null
      ? largest
      : largest === null
        ? item.distanceMiles
        : Math.max(largest, item.distanceMiles),
    null,
  );

  return (
    <div className="mt-3">
      <style>{`
        .homenode-comparable-label,
        .homenode-comparable-card,
        .homenode-house-pin {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        @media print {
          .comparable-map-print {
            height: 5.2in !important;
            break-inside: avoid;
            overflow: hidden !important;
          }
          .comparable-map-print .maplibregl-ctrl-group,
          .comparable-map-print .maplibregl-ctrl-attrib-button {
            display: none !important;
          }
          .homenode-comparable-card {
            box-shadow: none !important;
            border-width: 2px !important;
          }
        }
      `}</style>
      <div className="comparable-map-print relative h-[380px] overflow-hidden rounded-xl border border-slate-300 bg-slate-100">
        <div ref={containerRef} className="h-full w-full" aria-label="Selected comparable sales map" />
        {(contextLoading || (!subject && !mapError)) && (
          <div className="absolute inset-0 grid place-items-center bg-slate-100/90 text-sm font-medium text-slate-600">
            Loading subject and comparable locations…
          </div>
        )}
        {mapError && (
          <div className="absolute inset-x-4 top-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 shadow-sm">
            {mapError} The selected-property cards remain available below.
          </div>
        )}
        {!contextLoading && subject && selectedCount === 0 && (
          <div className="pointer-events-none absolute inset-x-4 bottom-4 rounded-lg bg-white/95 px-3 py-2 text-center text-sm text-slate-600 shadow-sm">
            Select a comparable sale to place it on the map.
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rotate-45 rounded-sm bg-red-600" /> Subject property</span>
        <span className="inline-flex items-center gap-2"><span className="w-5 border-t-2 border-dashed border-blue-700" /> Line begins at exact comparable location</span>
        {mappedComparables.length > 0 && (
          <button
            type="button"
            onClick={() => {
              labelPositionsRef.current = {};
              setMarkerLayoutRevision((current) => current + 1);
            }}
            className="rounded border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50 print:hidden"
          >
            Reset label positions
          </button>
        )}
        <span>{mappedComparables.length} of {selectedCount} selected comparable{selectedCount === 1 ? '' : 's'} mapped</span>
        {farthestDistance !== null && <span>Farthest selected sale: {farthestDistance.toFixed(2)} mi</span>}
        {missingLocationCount > 0 && <span className="font-semibold text-amber-800">{missingLocationCount} location{missingLocationCount === 1 ? '' : 's'} unavailable</span>}
      </div>
      {mappedComparables.length > 0 && (
        <p className="mt-1 text-xs text-slate-500 print:hidden">
          Drag any Comparable label to prevent overlap or reveal the house beneath it. The dotted leader begins at the exact property location and remains attached to the label for printing.
        </p>
      )}

      {selectedCount > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {sales.map((sale, slot) => {
            if (!sale) return null;
            const mapped = mappedComparables.find((item) => item.slot === slot);
            return (
              <article key={`mapped-comparable-${slot}`} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
                {sale.primary_photo_url ? (
                  <button type="button" onClick={() => onOpenSale?.(sale)} className="h-14 w-20 flex-none overflow-hidden rounded-md bg-slate-200">
                    <img src={sale.primary_photo_url} alt={`${displayAddress(sale)} thumbnail`} className="h-full w-full object-cover" />
                  </button>
                ) : (
                  <div className="grid h-14 w-20 flex-none place-items-center rounded-md bg-slate-200 px-2 text-center text-[10px] text-slate-500">No MLS photo</div>
                )}
                <div className="min-w-0 text-xs">
                  <div className="font-semibold text-blue-900">Comparable #{slot + 1}</div>
                  <div className="truncate font-medium text-slate-800" title={displayAddress(sale)}>{displayAddress(sale)}</div>
                  <div className="mt-0.5 text-slate-500">{mapped?.distanceMiles == null ? 'Distance unavailable' : `${mapped.distanceMiles.toFixed(2)} miles from subject`}</div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
