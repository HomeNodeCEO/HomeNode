import type { CustomCohortSubdivisionFamily } from '../customCohortSubdivisionFamilies';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import type { CustomCohortPreviewInput } from '../customCohortPreviewController';
import type { requestCustomCohortObservationPreview } from '../customCohortPreviewApi';
import CustomCohortPocketInspector from './CustomCohortPocketInspector';

interface Props {
  family: CustomCohortSubdivisionFamily; catalog: CheckedPocketCatalog;
  input: CustomCohortPreviewInput; included: readonly string[]; paused: boolean;
  previewTransport: typeof requestCustomCohortObservationPreview; onClose: () => void;
}

/** In-flow inspection below the map, so parcel interaction stays unobstructed.
 * It never owns inclusion or
 * supplies substitute statistics; the checked pocket preview remains separate. */
export default function CustomCohortMapSnapshot({ family, catalog, input, included, paused,
  previewTransport, onClose }: Props) {
  const ids = family.pocket_ids;
  const includedCount = ids.filter(id => included.includes(id)).length;
  const title = family.label;
  return <section aria-label={`${title} area snapshot`}
    className="min-w-0 overflow-hidden rounded-xl border border-amber-300 bg-white shadow-md print:hidden"
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header className="flex items-start justify-between gap-3 border-b border-amber-200 bg-gradient-to-r from-violet-100 to-amber-50 px-4 py-3">
      <div className="min-w-0"><h4 className="break-words text-sm font-semibold text-violet-950">{title}</h4>
        <p className="text-xs text-slate-600">{ids.length} recorded groups · {includedCount === ids.length ? 'Included' : includedCount ? 'Partly included' : 'Excluded'}</p></div>
      <button type="button" className="hn-action-secondary btn btn-xs shrink-0 normal-case" aria-label="Close area snapshot"
        onClick={onClose}>Close</button>
    </header>
    <div className="max-h-80 overflow-y-auto overscroll-contain p-4"><CustomCohortPocketInspector input={input} catalog={catalog} pocketId={family.pocket_ids[0]}
      pocketIds={ids} label={title} previewTransport={previewTransport} paused={paused} compact /></div>
  </section>;
}
