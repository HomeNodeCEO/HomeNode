import { useEffect, useState } from 'react';

export function UadRatingSelect({
  ariaLabel,
  value,
  ratings,
  onChange,
  disabled = false,
}: {
  ariaLabel: string;
  value: string;
  ratings: readonly string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="w-full min-w-[4.75rem] rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
    >
      <option value="">Select</option>
      {ratings.map((rating) => (
        <option key={rating} value={rating}>
          {rating}
        </option>
      ))}
    </select>
  );
}

export function MlsPhoto({
  src,
  alt,
  photoCount = 0,
  onOpen,
  compact = false,
}: {
  src?: string | null;
  alt: string;
  photoCount?: number;
  onOpen?: () => void;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const size = compact ? 'h-16 w-24' : 'h-28 w-full min-w-0';
  if (!src || failed) {
    return (
      <div
        className={`${size} flex items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-2 text-center text-[11px] font-medium text-slate-500`}
        aria-label={`${alt}: MLS photo unavailable`}
      >
        MLS photo unavailable
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className={`${size} group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-left shadow-sm disabled:cursor-default`}
      aria-label={`View ${photoCount || 1} MLS photo${photoCount === 1 ? '' : 's'} for ${alt}`}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-200 group-enabled:hover:scale-[1.03]"
        onError={() => setFailed(true)}
      />
      {onOpen && (
        <span className="absolute bottom-1.5 right-1.5 rounded-full bg-slate-950/80 px-2 py-0.5 text-[10px] font-semibold text-white">
          View {photoCount || 1}
        </span>
      )}
    </button>
  );
}
