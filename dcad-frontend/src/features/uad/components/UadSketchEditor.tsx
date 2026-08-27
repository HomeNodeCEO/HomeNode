import { useCallback, useEffect, useMemo, useState } from "react";

import MobileSketchReview from "@/components/MobileSketchReview";
import type { EditableInspectionSketch } from "@/lib/api";
import { editUadSketch, listUadSketches, type UadSketch } from "../api";

function asEditable(sketch: UadSketch): EditableInspectionSketch | null {
  const document = sketch.geometry as EditableInspectionSketch["document"];
  if (!document || !Array.isArray(document.areas) || !Array.isArray(document.rooms)) return null;
  const summary = (sketch.calculated_areas || {}) as EditableInspectionSketch["summary"];
  return {
    id: sketch.id,
    revision: sketch.revision,
    measurement_standard: document.measurement_standard,
    measurement_method: document.measurement_method,
    review_status: document.review_status,
    confirmed_at: null,
    updated_at: sketch.updated_at,
    summary,
    document,
  };
}

export default function UadSketchEditor({ workfileId, onSaved }: {
  workfileId: string;
  onSaved?: () => void;
}) {
  const [canonical, setCanonical] = useState<UadSketch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sketches = await listUadSketches(workfileId);
      setCanonical(sketches.find((sketch) => sketch.entity_id == null) || sketches[0] || null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The canonical UAD sketch could not be loaded.");
    }
  }, [workfileId]);

  useEffect(() => { void load(); }, [load]);

  const editable = useMemo(() => canonical ? asEditable(canonical) : null, [canonical]);
  if (!canonical || !editable) return error
    ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</div>
    : null;

  return (
    <MobileSketchReview
      sketch={editable}
      title="UAD 3.6 measured sketch editor"
      subtitle="Editing creates a new canonical UAD sketch revision and a newly verified report exhibit. The imported field source remains retained and unchanged."
      saveDraft={async (draft, expectedRevision) => {
        const result = await editUadSketch(workfileId, canonical.id, {
          expected_revision: expectedRevision,
          sketch: draft as unknown as Record<string, unknown>,
          caption: "HomeNode measured sketch",
        });
        setCanonical(result.sketch);
        onSaved?.();
        const next = asEditable(result.sketch);
        if (!next) throw new Error("invalid_uad_sketch_document");
        return next;
      }}
      onSaved={() => undefined}
    />
  );
}
