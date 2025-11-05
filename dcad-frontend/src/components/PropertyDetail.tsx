// Example component: src/components/PropertyDetail.tsx
import { useEffect, useState } from 'react';
import { fetchPropertyDetail } from '@/lib/api';

export default function PropertyDetail({ countyId, accountId }: { countyId: number; accountId: string }) {
  const [data, setData] = useState<any | null>(null);

  useEffect(() => {
    let stop = false;
    fetchPropertyDetail(countyId, accountId)
      .then(d => { if (!stop) setData(d); })
      .catch(console.error);
    return () => { stop = true; };
  }, [countyId, accountId]);

  if (!data) return <div className="p-4">Loading…</div>;

  return (
    <div className="p-4 space-y-2">
      <h1 className="text-xl font-semibold">{data.situs_address}</h1>
      <div>Year built: {data.year_built ?? '—'}</div>
      <div>Stories: {data.stories_display ?? '—'}</div>
      <div>Baths: {data.bath_count_display ?? '—'}</div>
      <div>Bed: {data.bedroom_count ?? '—'}</div>
      <div>Sqft: {data.living_area_sqft ?? '—'}</div>
      <div>Pool: {data.pool_display ?? '—'}</div>
      <div>Basement: {data.basement_display ?? '—'}</div>
      <div>AC: {data.air_conditioning_display ?? '—'}</div>
      <div>Heat: {data.heating_display ?? '—'}</div>
      <div>Foundation: {data.foundation_display ?? '—'}</div>
      <div>Roof: {data.roof_material_display ?? '—'} · {data.roof_type_display ?? '—'}</div>
      <div>Exterior: {data.exterior_material_display ?? '—'}</div>
      <div>Fence: {data.fence_type_display ?? '—'}</div>
      <div>Units: {data.number_units ?? '—'}</div>
    </div>
  );
}
