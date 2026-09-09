import { acceptedNeighborhoodOutline } from '../acceptedNeighborhoodOutline';

export default function CustomNeighborhoodAcceptedOutline({ assessment }: { assessment: unknown }) {
  const value = assessment && typeof assessment === 'object' ? assessment as Record<string, unknown> : {};
  const geography = value.geographic_neighborhood && typeof value.geographic_neighborhood === 'object'
    ? value.geographic_neighborhood as Record<string, unknown> : {};
  const outline = acceptedNeighborhoodOutline(geography.geometry);
  return <figure className="hn-subtle-panel rounded-xl border border-violet-200 p-3">
    <figcaption className="text-sm font-semibold text-violet-950">Saved geographic neighborhood outline</figcaption>
    {outline ? <svg role="img" aria-label="Exact saved geographic outline with separate polygons and excluded holes" viewBox="0 0 600 300"
      className="mt-2 max-h-80 w-full rounded-lg bg-violet-50">
      <text x="580" y="20" textAnchor="end" fontSize="12" fill="#4c1d95">N ↑</text>
      {outline.paths.map((path, index) => <path key={index} d={path} fill="#ddd6fe" stroke="#7c3aed"
        strokeWidth="2" fillRule="evenodd" vectorEffect="non-scaling-stroke" />)}
    </svg> : <p className="mt-2 text-sm">Saved outline unavailable. No substitute shape has been generated.</p>}
    <p className="mt-2 text-xs text-slate-600">Saved outline only, not a street basemap. Competitive pocket membership is listed separately below; this diagram does not invent pocket or subdivision boundaries.</p>
  </figure>;
}
