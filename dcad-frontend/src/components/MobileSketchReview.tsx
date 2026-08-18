import { useEffect, useMemo, useState } from "react";

import {
  makeUrl,
  updateMobileInspectionSketch,
  type AppraisalAssignmentFile,
} from "@/lib/api";

type Sketch = NonNullable<AppraisalAssignmentFile["mobile_inspection_sketch"]>;
type Document = Sketch["document"];
type Area = Document["areas"][number];
type Room = Document["rooms"][number];

type Props = {
  accountId: string;
  assignmentFile: AppraisalAssignmentFile;
  getEditorKey: () => string;
  onSaved: (sketch: Sketch) => void;
};

const AREA_TYPES = [
  "above_grade_finished",
  "above_grade_nonstandard_finished",
  "above_grade_noncontinuous_finished",
  "above_grade_unfinished",
  "below_grade_finished",
  "below_grade_nonstandard_finished",
  "below_grade_unfinished",
  "garage",
  "porch",
  "patio",
  "deck",
  "outbuilding",
  "other",
];

const ROOM_TYPES = [
  "living_room",
  "family_room",
  "dining_room",
  "kitchen",
  "bedroom",
  "bathroom",
  "utility",
  "office",
  "foyer",
  "hall",
  "closet",
  "garage",
  "storage",
  "other",
];

const fieldClass = "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 shadow-sm focus:border-emerald-500 focus:outline-none";

function clone(document: Document): Document {
  return JSON.parse(JSON.stringify(document)) as Document;
}

function title(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function plotFor(area: Area | undefined, rooms: Room[]) {
  if (!area || area.vertices.length < 2) return null;
  const xs = area.vertices.map((point) => point.x);
  const ys = area.vertices.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(460 / Math.max(1, maxX - minX), 280 / Math.max(1, maxY - minY));
  const point = (input: { x: number; y: number }) => ({
    x: 30 + ((input.x - minX) * scale),
    y: 310 - ((input.y - minY) * scale),
  });
  return {
    polygon: area.vertices.map(point).map((item) => item.x + "," + item.y).join(" "),
    rooms: rooms.map((room) => ({ ...room, plot: point(room.anchor) })),
  };
}

export default function MobileSketchReview({
  accountId,
  assignmentFile,
  getEditorKey,
  onSaved,
}: Props) {
  const sketch = assignmentFile.mobile_inspection_sketch;
  const [draft, setDraft] = useState<Document | null>(sketch ? clone(sketch.document) : null);
  const [selectedAreaId, setSelectedAreaId] = useState(sketch?.document.areas[0]?.id || "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!sketch) return;
    setDraft(clone(sketch.document));
    setSelectedAreaId((current) => sketch.document.areas.some((area) => area.id === current)
      ? current
      : sketch.document.areas[0]?.id || "");
    setDirty(false);
  }, [sketch]);

  const selectedArea = draft?.areas.find((area) => area.id === selectedAreaId);
  const selectedRooms = useMemo(
    () => (draft?.rooms || []).filter((room) => room.area_id === selectedAreaId),
    [draft?.rooms, selectedAreaId],
  );
  const plot = useMemo(() => plotFor(selectedArea, selectedRooms), [selectedArea, selectedRooms]);

  if (!sketch || !draft) return null;

  const artifactPath = "/api/accounts/"
    + encodeURIComponent(accountId)
    + "/assignment-files/"
    + assignmentFile.id
    + "/mobile-sketch/";
  const svgUrl = makeUrl(artifactPath + "preview.svg", { revision: sketch.revision });
  const pdfUrl = makeUrl(artifactPath + "report.pdf", { revision: sketch.revision });

  const change = (update: (current: Document) => Document) => {
    setDraft((current) => current ? update(current) : current);
    setDirty(true);
    setMessage("");
  };

  const updateArea = (areaId: string, update: Partial<Area>) => change((current) => ({
    ...current,
    areas: current.areas.map((area) => area.id === areaId ? { ...area, ...update } : area),
  }));

  const updateRoom = (roomId: string, update: Partial<Room>) => change((current) => ({
    ...current,
    rooms: current.rooms.map((room) => room.id === roomId ? { ...room, ...update } : room),
  }));

  const updateVertex = (area: Area, index: number, axis: "x" | "y", value: number) => {
    const vertices = area.vertices.map((vertex) => ({ ...vertex }));
    vertices[index][axis] = value;
    if (index === 0) vertices[vertices.length - 1] = { ...vertices[0] };
    if (index === vertices.length - 1) vertices[0] = { ...vertices[index] };
    updateArea(area.id, { vertices });
  };

  const moveArea = (areaId: string, direction: -1 | 1) => change((current) => {
    const areas = [...current.areas];
    const index = areas.findIndex((area) => area.id === areaId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= areas.length) return current;
    [areas[index], areas[target]] = [areas[target], areas[index]];
    return { ...current, areas: areas.map((area, position) => ({ ...area, position: position + 1 })) };
  });

  const moveRoom = (roomId: string, direction: -1 | 1) => change((current) => {
    const rooms = [...current.rooms];
    const index = rooms.findIndex((room) => room.id === roomId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= rooms.length) return current;
    [rooms[index], rooms[target]] = [rooms[target], rooms[index]];
    return { ...current, rooms: rooms.map((room, position) => ({ ...room, position: position + 1 })) };
  });

  const addCorner = (area: Area) => {
    const vertices = area.vertices.map((point) => ({ ...point }));
    const previous = vertices[Math.max(0, vertices.length - 2)];
    vertices.splice(vertices.length - 1, 0, { x: previous.x + 1, y: previous.y + 1 });
    updateArea(area.id, { vertices });
  };

  const removeCorner = (area: Area, index: number) => {
    if (area.vertices.length <= 4 || index <= 0 || index >= area.vertices.length - 1) return;
    updateArea(area.id, {
      vertices: area.vertices.filter((_, vertexIndex) => vertexIndex !== index),
    });
  };

  const save = async () => {
    const editorKey = getEditorKey();
    if (!editorKey) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await updateMobileInspectionSketch(
        accountId,
        assignmentFile.id,
        {
          sketch: draft,
          expected_revision: sketch.revision,
          reviewer: "HomeNode appraiser",
          client_operation_id: globalThis.crypto.randomUUID(),
        },
        editorKey,
      );
      onSaved(response.sketch);
      setDirty(false);
      setMessage("Sketch revision " + response.sketch.revision + " saved.");
    } catch (error: unknown) {
      const errorText = error instanceof Error
        ? error.message : "Sketch save failed";
      setMessage(errorText === "sketch_revision_conflict"
        ? "A newer sketch exists. Reload before saving."
        : errorText.replaceAll("_", " "));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">Mobile measured sketch review</div>
          <div className="mt-1 text-xs text-slate-600">
            Revision {sketch.revision} - {draft.measurement_standard === "ansi_z765_2021" ? "ANSI Z765-2021" : "Alternate standard"}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold" href={svgUrl} target="_blank" rel="noreferrer">SVG</a>
          <a className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold" href={pdfUrl}>PDF exhibit</a>
          <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50" disabled={!dirty || saving} onClick={() => void save()} type="button">
            {saving ? "Saving..." : "Save next revision"}
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-3">Above grade<div className="mt-1 text-base font-semibold">{sketch.summary.above_grade_finished_sqft.toLocaleString()} sf</div></div>
        <div className="rounded-lg bg-slate-50 p-3">Below grade<div className="mt-1 text-base font-semibold">{sketch.summary.below_grade_finished_sqft.toLocaleString()} sf</div></div>
        <div className="rounded-lg bg-slate-50 p-3">Areas<div className="mt-1 text-base font-semibold">{draft.areas.length}</div></div>
        <div className="rounded-lg bg-slate-50 p-3">Rooms<div className="mt-1 text-base font-semibold">{draft.rooms.length}</div></div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            {draft.areas.map((area, index) => (
              <button className={(selectedAreaId === area.id ? "border-emerald-600 bg-emerald-50" : "border-slate-300 bg-white") + " rounded-md border px-2 py-1 text-xs font-semibold"} key={area.id} onClick={() => setSelectedAreaId(area.id)} type="button">
                {index + 1}. {area.label}
              </button>
            ))}
          </div>
          <svg className="h-auto w-full rounded-md bg-white" viewBox="0 0 520 340" role="img" aria-label="Live sketch geometry">
            {plot ? (
              <>
                <polygon points={plot.polygon} fill="#d1fae5" stroke="#047857" strokeWidth="3" strokeLinejoin="round" />
                {plot.rooms.map((room) => (
                  <g key={room.id}>
                    <circle cx={room.plot.x} cy={room.plot.y} r="3" fill="#0f172a" />
                    <text x={room.plot.x} y={room.plot.y - 8} textAnchor="middle" fontSize="11" fontWeight="700">{room.label}</text>
                  </g>
                ))}
              </>
            ) : null}
          </svg>
          <div className="mt-2 text-[11px] text-slate-500">The saved SVG and PDF are recalculated by the server.</div>
        </div>

        <div className="space-y-3">
          <label className="block text-xs text-slate-600">Measurement method
            <select className={fieldClass} value={draft.measurement_method} onChange={(event) => change((current) => ({ ...current, measurement_method: event.target.value as Document["measurement_method"] }))}>
              <option value="exterior">Exterior</option>
              <option value="interior_perimeter">Interior perimeter</option>
              <option value="plans">Plans</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>
          <label className="block text-xs text-slate-600">Review status
            <select className={fieldClass} value={draft.review_status} onChange={(event) => change((current) => ({ ...current, review_status: event.target.value as Document["review_status"] }))}>
              <option value="draft">Review pending</option>
              <option value="appraiser_confirmed">Appraiser confirmed</option>
            </select>
          </label>
          <label className="block text-xs text-slate-600">Review notes
            <textarea className={fieldClass} rows={4} value={draft.review_notes || ""} onChange={(event) => change((current) => ({ ...current, review_notes: event.target.value || null }))} />
          </label>
        </div>
      </div>

      {selectedArea ? (
        <div className="mt-4 rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold">Selected area</div>
            <div className="flex gap-1">
              <button className="rounded border px-2 py-1 text-xs" onClick={() => moveArea(selectedArea.id, -1)} type="button">Move up</button>
              <button className="rounded border px-2 py-1 text-xs" onClick={() => moveArea(selectedArea.id, 1)} type="button">Move down</button>
            </div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <label className="text-xs">Label<input className={fieldClass} value={selectedArea.label} onChange={(event) => updateArea(selectedArea.id, { label: event.target.value })} /></label>
            <label className="text-xs">Level<input className={fieldClass} value={selectedArea.level_label} onChange={(event) => updateArea(selectedArea.id, { level_label: event.target.value })} /></label>
            <label className="text-xs">Classification
              <select className={fieldClass} value={selectedArea.classification} onChange={(event) => updateArea(selectedArea.id, { classification: event.target.value })}>
                {AREA_TYPES.map((value) => <option key={value} value={value}>{title(value)}</option>)}
              </select>
            </label>
          </div>
          <label className="mt-2 block text-xs">Area notes<textarea className={fieldClass} rows={2} value={selectedArea.notes || ""} onChange={(event) => updateArea(selectedArea.id, { notes: event.target.value || null })} /></label>

          <div className="mt-3 flex items-center justify-between">
            <div className="text-xs font-semibold">Corner coordinates (feet)</div>
            <button className="rounded border px-2 py-1 text-xs" onClick={() => addCorner(selectedArea)} type="button">Add corner</button>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {selectedArea.vertices.map((vertex, index) => (
              <div className="rounded-md border border-slate-200 p-2" key={index}>
                <div className="mb-1 flex justify-between text-[11px] text-slate-500">
                  <span>{index === selectedArea.vertices.length - 1 ? "Closure" : "Corner " + (index + 1)}</span>
                  {index > 0 && index < selectedArea.vertices.length - 1 ? <button className="text-rose-700" onClick={() => removeCorner(selectedArea, index)} type="button">Remove</button> : null}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input className={fieldClass} type="number" step="0.1" value={vertex.x} onChange={(event) => updateVertex(selectedArea, index, "x", Number(event.target.value))} />
                  <input className={fieldClass} type="number" step="0.1" value={vertex.y} onChange={(event) => updateVertex(selectedArea, index, "y", Number(event.target.value))} />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 text-xs font-semibold">Room labels and photo anchors</div>
          <div className="mt-2 space-y-2">
            {selectedRooms.map((room) => (
              <div className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1.2fr_1fr_90px_90px_auto]" key={room.id}>
                <input className={fieldClass} value={room.label} onChange={(event) => updateRoom(room.id, { label: event.target.value })} />
                <select className={fieldClass} value={room.room_type} onChange={(event) => updateRoom(room.id, { room_type: event.target.value })}>
                  {ROOM_TYPES.map((value) => <option key={value} value={value}>{title(value)}</option>)}
                </select>
                <input className={fieldClass} type="number" step="0.1" value={room.anchor.x} onChange={(event) => updateRoom(room.id, { anchor: { ...room.anchor, x: Number(event.target.value) } })} />
                <input className={fieldClass} type="number" step="0.1" value={room.anchor.y} onChange={(event) => updateRoom(room.id, { anchor: { ...room.anchor, y: Number(event.target.value) } })} />
                <div className="flex gap-1">
                  <button className="rounded border px-2 text-xs" onClick={() => moveRoom(room.id, -1)} type="button">Up</button>
                  <button className="rounded border px-2 text-xs" onClick={() => moveRoom(room.id, 1)} type="button">Down</button>
                </div>
              </div>
            ))}
            {!selectedRooms.length ? <div className="text-xs text-slate-500">No rooms are anchored to this area.</div> : null}
          </div>
        </div>
      ) : null}

      {message ? <div className={(message.includes("saved") ? "text-emerald-700" : "text-rose-700") + " mt-3 text-xs font-medium"}>{message}</div> : null}
      <div className="mt-3 text-[11px] leading-5 text-slate-500">
        Every save creates a new sketch revision and audit event. Automatic room-photo captions follow room renames; manual captions remain unchanged.
      </div>
    </div>
  );
}
