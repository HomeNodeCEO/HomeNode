type Props = {
  title: string;
  subtitle: string;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
};

export default function SketchWorkspaceEmptyState({
  title,
  subtitle,
  onRefresh,
  refreshing = false,
}: Props) {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-emerald-300 bg-emerald-50/60 p-4">
      <div className="text-sm font-semibold text-emerald-950">{title}</div>
      <p className="mt-1 max-w-3xl text-xs leading-5 text-emerald-900">{subtitle}</p>
      {onRefresh ? (
        <button
          className="mt-3 rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-50 disabled:opacity-60"
          disabled={refreshing}
          onClick={() => void onRefresh()}
          type="button"
        >
          {refreshing ? "Checking mobile sync…" : "Check mobile sync"}
        </button>
      ) : null}
    </div>
  );
}
