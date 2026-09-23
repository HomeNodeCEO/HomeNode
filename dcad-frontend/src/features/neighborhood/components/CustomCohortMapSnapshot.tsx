import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { CustomCohortSubdivisionFamily } from '../customCohortSubdivisionFamilies';
import { buildCustomCohortSubdivisionPhases } from '../customCohortSubdivisionFamilies';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import type { CustomCohortPreviewInput } from '../customCohortPreviewController';
import type { requestCustomCohortObservationPreview } from '../customCohortPreviewApi';
import CustomCohortPocketInspector from './CustomCohortPocketInspector';

interface Props {
  family: CustomCohortSubdivisionFamily; phaseId: string | null; catalog: CheckedPocketCatalog;
  input: CustomCohortPreviewInput; included: readonly string[]; paused: boolean;
  previewTransport: typeof requestCustomCohortObservationPreview; onClose: () => void;
}

/** Nonmodal, draggable inspection inside the map. It never owns inclusion or
 * supplies substitute statistics; the checked pocket preview remains separate. */
export default function CustomCohortMapSnapshot({ family, phaseId, catalog, input, included, paused,
  previewTransport, onClose }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const phase = buildCustomCohortSubdivisionPhases(catalog, family).find(row => phaseId && row.pocket_ids.includes(phaseId));
  const ids = phase?.pocket_ids ?? family.pocket_ids;
  const includedCount = ids.filter(id => included.includes(id)).length;
  const title = phase?.label ?? family.label;
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = { x: event.clientX, y: event.clientY, ...position };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || !card.current?.parentElement) return;
    const parent = card.current.parentElement;
    const left = drag.current.left + event.clientX - drag.current.x;
    const top = drag.current.top + event.clientY - drag.current.y;
    setPosition({ left: Math.max(0, Math.min(left, parent.clientWidth - card.current.offsetWidth)),
      top: Math.max(0, Math.min(top, parent.clientHeight - card.current.offsetHeight)) });
  };
  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div ref={card} role="dialog" aria-modal="false" aria-label={`${title} area snapshot`}
    className="absolute z-10 overflow-y-auto rounded-xl border border-amber-300 bg-white/95 shadow-xl backdrop-blur-sm print:hidden"
    style={{ left: position.left, top: position.top, width: 'min(21rem, calc(100% - 1rem))', maxHeight: 'calc(100% - 1rem)' }}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <header className="flex cursor-move touch-none items-start justify-between gap-2 border-b border-amber-200 bg-gradient-to-r from-violet-100 to-amber-50 px-3 py-2"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      <div className="min-w-0"><h4 className="truncate text-sm font-semibold text-violet-950">{title}</h4>
        <p className="text-xs text-slate-600">{ids.length} recorded {phase ? 'phase group' : 'groups'} · {includedCount === ids.length ? 'Included' : includedCount ? 'Partly included' : 'Excluded'}</p></div>
      <button type="button" className="hn-action-secondary btn btn-xs normal-case" aria-label="Close area snapshot"
        onPointerDown={event => event.stopPropagation()} onClick={onClose}>Close</button>
    </header>
    <div className="p-3"><CustomCohortPocketInspector input={input} catalog={catalog} pocketId={phaseId ?? family.pocket_ids[0]}
      pocketIds={ids} label={title} previewTransport={previewTransport} paused={paused} compact /></div>
  </div>;
}
