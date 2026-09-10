import { useEffect, useId, useRef, useState } from 'react';
import catalog from '@/data/neighborhoodCityBoundaries.json';
import { createCityReferenceLoader, hideCityReference, showCityReference,
  type CityReferenceMap } from '@/lib/neighborhoodCityReference';

const loadCity = createCityReferenceLoader((url, options) =>
  fetch(`${import.meta.env.BASE_URL}${String(url)}`, options));

export default function NeighborhoodCityReferenceControl({
  map, onViewChange,
}: {
  map: CityReferenceMap | null;
  onViewChange: (active: boolean) => void;
}) {
  const [chosen, setChosen] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const currentMap = useRef(map); currentMap.current = map;
  const viewChange = useRef(onViewChange); viewChange.current = onViewChange;
  const selectId = useId();
  const selected = catalog.cities.find(city => city.geoid === chosen);

  useEffect(() => {
    request.current += 1;
    setChosen(''); setShown(null); setLoading(false); setError(null);
    viewChange.current(false);
    return () => {
      request.current += 1;
      viewChange.current(false);
      // A parent map can already be disposed when a child effect cleans up.
      if (map) { try { hideCityReference(map); } catch { /* Map disposal owns its layers. */ } }
    };
  }, [map]);

  const show = async () => {
    if (!map || !selected) return;
    const generation = ++request.current;
    setLoading(true); setError(null);
    try {
      const city = await loadCity(selected);
      if (generation !== request.current || currentMap.current !== map) return;
      showCityReference(map, city);
      viewChange.current(true); setShown(selected.name);
    } catch (failure) {
      if (generation === request.current) setError(failure instanceof Error ? failure.message : 'City reference unavailable.');
    } finally { if (generation === request.current) setLoading(false); }
  };

  const hide = () => {
    request.current += 1;
    if (map) hideCityReference(map);
    setShown(null); setLoading(false); setError(null);
    viewChange.current(false);
  };

  return (
    <section aria-label="City boundary reference" className="mt-3 rounded-lg border border-amber-300 bg-gradient-to-r from-violet-50 to-amber-50 p-3 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-xs font-semibold text-violet-950">City limits</label>
        <select id={selectId} value={selected?.geoid ?? ''} disabled={loading}
          onChange={event => setChosen(event.target.value)} className="rounded-md border border-amber-300 bg-white px-2 py-1.5 text-xs text-violet-950">
          <option value="">Select a reference city</option>
          {catalog.cities.map(city => <option key={city.geoid} value={city.geoid}>{city.name}</option>)}
        </select>
        <button type="button" onClick={() => void show()} disabled={!map || !selected || loading}
          className="rounded-md border border-amber-400 bg-violet-700 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-violet-800 disabled:opacity-50">
          {loading ? 'Loading saved outline…' : 'Show city limits'}
        </button>
        {shown || loading ? <button type="button" onClick={hide}
          className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-violet-950 hover:bg-amber-100">
          Return to analysis area
        </button> : null}
      </div>
      <p className="mt-2 text-xs text-slate-700">
        {shown ? `Showing ${shown}. ` : ''}Map reference only: choosing a city does not establish the subject's jurisdiction. Showing it does not add properties, change your drawn boundary, or recalculate statistics.
        {' '}City outlines do not expand parcel/sales coverage.
      </p>
      <p className="mt-1 text-[11px] text-slate-600">
        <a href={catalog.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">Census city limits, {catalog.vintage}</a>
        {' '}· Five pilot cities · Saved snapshot; later annexations require verification.
      </p>
      {error ? <p role="alert" className="mt-2 text-xs text-red-800">{error} Your analysis selection has not changed.</p> : null}
    </section>
  );
}
