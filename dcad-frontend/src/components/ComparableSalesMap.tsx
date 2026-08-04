import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '@/lib/api';
import type { MarketConditionsSubject, SaleRow } from '@/lib/api';

const MAPLIBRE_SCRIPT = 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js';
const MAPLIBRE_STYLE = 'https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css';
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';

type Props = {
  subjectAccountId: string;
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

function loadMapLibre(): Promise<any> {
  addStyle();
  const existingGlobal = (window as any).maplibregl;
  if (existingGlobal) return Promise.resolve(existingGlobal);
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-homenode-map-script="maplibre"]',
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve((window as any).maplibregl), { once: true });
      existing.addEventListener('error', () => reject(new Error('map_library_load_failed')), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MAPLIBRE_SCRIPT;
    script.async = true;
    script.dataset.homenodeMapScript = 'maplibre';
    script.addEventListener('load', () => resolve((window as any).maplibregl), { once: true });
    script.addEventListener('error', () => reject(new Error('map_library_load_failed')), { once: true });
    document.head.appendChild(script);
  });
}

function makeSubjectMarker(address: string): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'grid';
  wrapper.style.justifyItems = 'center';
  wrapper.style.gap = '3px';
  wrapper.title = address;

  const dot = document.createElement('div');
  dot.style.width = '18px';
  dot.style.height = '18px';
  dot.style.borderRadius = '999px';
  dot.style.background = '#dc2626';
  dot.style.border = '3px solid white';
  dot.style.boxShadow = '0 2px 8px rgba(15, 23, 42, .35)';

  const label = document.createElement('div');
  label.textContent = 'Subject';
  label.style.padding = '2px 7px';
  label.style.borderRadius = '999px';
  label.style.background = '#7f1d1d';
  label.style.color = 'white';
  label.style.fontSize = '11px';
  label.style.fontWeight = '700';
  label.style.whiteSpace = 'nowrap';

  wrapper.append(dot, label);
  return wrapper;
}

function makeComparableMarker(
  comparable: MappedComparable,
  onOpenSale?: (sale: SaleRow) => void,
): HTMLButtonElement {
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
  marker.style.cursor = comparable.sale.primary_photo_url ? 'pointer' : 'default';

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
  marker.addEventListener('click', (event) => {
    event.stopPropagation();
    if (comparable.sale.primary_photo_url) onOpenSale?.(comparable.sale);
  });
  return marker;
}

export default function ComparableSalesMap({
  subjectAccountId,
  subjectAddress,
  sales,
  onOpenSale,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const openSaleRef = useRef(onOpenSale);
  const [subject, setSubject] = useState<MarketConditionsSubject | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    openSaleRef.current = onOpenSale;
  }, [onOpenSale]);

  useEffect(() => {
    let cancelled = false;
    setSubject(null);
    setMapError(null);
    if (!subjectAccountId) return () => { cancelled = true; };
    setContextLoading(true);
    void api.getMarketConditionsContext(subjectAccountId)
      .then((response) => {
        if (!cancelled) setSubject(response.subject);
      })
      .catch((error: any) => {
        if (!cancelled) setMapError(error?.message || 'Subject map location could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => { cancelled = true; };
  }, [subjectAccountId]);

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
    let map: any = null;
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
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
          if (cancelled || !map) return;
          const bounds = new maplibre.LngLatBounds();
          bounds.extend([subjectLongitude, subjectLatitude]);
          new maplibre.Marker({
            element: makeSubjectMarker(subject?.address || subjectAddress || subjectAccountId),
            anchor: 'bottom',
          })
            .setLngLat([subjectLongitude, subjectLatitude])
            .addTo(map);

          mappedComparables.forEach((comparable) => {
            bounds.extend([comparable.longitude, comparable.latitude]);
            new maplibre.Marker({
              element: makeComparableMarker(comparable, (sale) => openSaleRef.current?.(sale)),
              anchor: 'bottom',
            })
              .setLngLat([comparable.longitude, comparable.latitude])
              .addTo(map);
          });

          if (mappedComparables.length) {
            map.fitBounds(bounds, { padding: 75, maxZoom: 14, duration: 0 });
          }
        });
      })
      .catch((error: any) => {
        if (!cancelled) setMapError(error?.message || 'Comparable map could not be loaded.');
      });
    return () => {
      cancelled = true;
      if (map) map.remove();
    };
  }, [markerFingerprint, subject?.address, subject?.latitude, subject?.longitude, subjectAccountId, subjectAddress]);

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
      <div className="relative h-[380px] overflow-hidden rounded-xl border border-slate-300 bg-slate-100">
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
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-red-600" /> Subject property</span>
        <span className="inline-flex items-center gap-2"><span className="h-3 w-3 rounded bg-blue-600" /> Selected comparable</span>
        <span>{mappedComparables.length} of {selectedCount} selected comparable{selectedCount === 1 ? '' : 's'} mapped</span>
        {farthestDistance !== null && <span>Farthest selected sale: {farthestDistance.toFixed(2)} mi</span>}
        {missingLocationCount > 0 && <span className="font-semibold text-amber-800">{missingLocationCount} location{missingLocationCount === 1 ? '' : 's'} unavailable</span>}
      </div>

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
