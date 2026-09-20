type Props = {
  title: string;
  subtitle: string;
  onRefresh?: () => void | Promise<void>;
  onCreate?: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
  refreshingLabel?: string;
};

export default function SketchWorkspaceEmptyState({
  title,
  subtitle,
  onRefresh,
  onCreate,
  refreshing = false,
  refreshLabel = "Check mobile sync",
  refreshingLabel = "Checking mobile sync…",
}: Props) {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-emerald-300 bg-emerald-50/60 p-4">
      <div className="text-sm font-semibold text-emerald-950">{title}</div>
      <p className="mt-1 max-w-3xl text-xs leading-5 text-emerald-900">{subtitle}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {onCreate ? (
          <button
            className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-violet-800"
            onClick={onCreate}
            type="button"
          >
            Start desktop sketch
          </button>
        ) : null}
        {onRefresh ? (
          <button
            className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-50 disabled:opacity-60"
            disabled={refreshing}
            onClick={() => void onRefresh()}
            type="button"
          >
            {refreshing ? refreshingLabel : refreshLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
