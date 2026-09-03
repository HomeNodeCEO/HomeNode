// Example component: src/components/PropertyDetail.tsx
import { useEffect, useState } from 'react';
import { fetchPropertyDetail, type PropertyDetail as PropertyDetailData } from '@/lib/api';

export default function PropertyDetail({ countyId, accountId }: { countyId: number; accountId: string }) {
  const [data, setData] = useState<PropertyDetailData | null>(null);

  useEffect(() => {
    let stop = false;
    fetchPropertyDetail(accountId)
      .then(d => { if (!stop) setData(d); })
      .catch(console.error);
    return () => { stop = true; };
  }, [countyId, accountId]);

  if (!data) return <div className="p-4">Loading…</div>;
  const account = data.account;
  const improvement = data.primary_improvements;

  return (
    <div className="p-4 space-y-2">
      <h1 className="text-xl font-semibold">{account.address || 'Address unavailable'}</h1>
      <div>Year built: {improvement?.year_built ?? '—'}</div>
      <div>Stories: {improvement?.stories ?? '—'}</div>
      <div>Baths: {improvement?.bath_count ?? '—'}</div>
      <div>Bed: {improvement?.bedroom_count ?? '—'}</div>
      <div>Sqft: {improvement?.living_area_sqft ?? '—'}</div>
      <div>Pool: {displayBoolean(improvement?.pool)}</div>
      <div>Basement: {displayBoolean(improvement?.basement)}</div>
      <div>AC: {improvement?.air_conditioning ?? '—'}</div>
      <div>Heat: {improvement?.heating ?? '—'}</div>
      <div>Foundation: {improvement?.foundation ?? '—'}</div>
      <div>Roof: {improvement?.roof_material ?? '—'} · {improvement?.roof_type ?? '—'}</div>
      <div>Exterior: {improvement?.exterior_material ?? '—'}</div>
      <div>Fence: {improvement?.fence_type ?? '—'}</div>
      <div>Units: {improvement?.number_units ?? '—'}</div>
    </div>
  );
}

function displayBoolean(value: boolean | null | undefined): string {
  return value == null ? '—' : value ? 'Yes' : 'No';
}
