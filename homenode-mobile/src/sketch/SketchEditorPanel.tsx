import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ApiError, type MobileApi } from "../api/client";
import { OfflineStore } from "../offline/store";
import {
  appendMeasuredWall,
  calculateSketchOutline,
  canvasToModel,
  closeSketchOutline,
  connectSketchTarget,
  emptySketchDraft,
  modelToCanvas,
  normalizeSketchBearing,
  pointInArea,
  sketchClosureTargets,
  SKETCH_CLASSIFICATIONS,
  SKETCH_ROOM_TYPES,
  sketchReadyForConfirmation,
  sketchRoomRef,
  type ManualSketchDraft,
  type SketchAreaDraft,
  type SketchClosureTarget,
  type SketchRoomDraft,
  type SketchRoomType,
} from "./model";
import { useSketchSync } from "./sync";

const CANVAS_WIDTH = 320;
const CANVAS_HEIGHT = 260;

const DIRECTION_PAD = Object.freeze([
  [
    { symbol: "↖", label: "Northwest, 135 degrees", bearing: 135 },
    { symbol: "↑", label: "North, 90 degrees", bearing: 90 },
    { symbol: "↗", label: "Northeast, 45 degrees", bearing: 45 },
  ],
  [
    { symbol: "←", label: "West, 180 degrees", bearing: 180 },
    null,
    { symbol: "→", label: "East, 0 degrees", bearing: 0 },
  ],
  [
    { symbol: "↙", label: "Southwest, 225 degrees", bearing: 225 },
    { symbol: "↓", label: "South, 270 degrees", bearing: 270 },
    { symbol: "↘", label: "Southeast, 315 degrees", bearing: 315 },
  ],
]);

export type SelectedSketchRoom = Readonly<{
  id: string;
  roomRef: string;
  label: string;
}>;

function Action({ title, onPress, disabled = false, secondary = false, danger = false }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        secondary && styles.actionSecondary,
        danger && styles.actionDanger,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.actionText, secondary && styles.actionSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]}>
      <Text style={[styles.choiceText, selected && styles.choiceSelectedText]}>{label}</Text>
    </Pressable>
  );
}

function DirectionButton({ symbol, label, selected, onPress }: {
  symbol: string;
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.directionButton,
        selected && styles.directionButtonSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.directionSymbol, selected && styles.directionSymbolSelected]}>{symbol}</Text>
    </Pressable>
  );
}

function updateArea(draft: ManualSketchDraft, areaId: string, update: (area: SketchAreaDraft) => SketchAreaDraft) {
  return {
    ...draft,
    reviewStatus: "draft" as const,
    areas: draft.areas.map((area) => area.id === areaId ? update(area) : area),
  };
}

function SketchCanvas({ area, rooms, closureTargets, selectedRoomId, onSelectRoom, onMoveRoom, onConnectTarget }: {
  area: SketchAreaDraft;
  rooms: SketchRoomDraft[];
  closureTargets: SketchClosureTarget[];
  selectedRoomId: string | null;
  onSelectRoom: (room: SketchRoomDraft) => void;
  onMoveRoom: (roomId: string, point: { x: number; y: number }) => void;
  onConnectTarget: (target: SketchClosureTarget) => void;
}) {
  const displayVertices = [...area.vertices, ...closureTargets.map((target) => target.point)];
  const canvasVertices = area.vertices.map((point) => modelToCanvas(
    point,
    displayVertices,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  ));
  const lines = canvasVertices.slice(0, -1).map((point, index) => {
    const next = canvasVertices[index + 1]!;
    const length = Math.hypot(next.x - point.x, next.y - point.y);
    const angle = Math.atan2(next.y - point.y, next.x - point.x);
    return {
      key: `${index}-${point.x}-${point.y}`,
      style: {
        left: ((point.x + next.x) / 2) - (length / 2),
        top: ((point.y + next.y) / 2) - 1.5,
        width: length,
        transform: [{ rotate: `${angle}rad` }],
      },
      length: Math.hypot(
        area.vertices[index + 1]!.x - area.vertices[index]!.x,
        area.vertices[index + 1]!.y - area.vertices[index]!.y,
      ),
      midpoint: { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 },
    };
  });

  const moveSelected = (event: GestureResponderEvent) => {
    if (!selectedRoomId || area.vertices.length < 2) return;
    const point = canvasToModel(
      { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
      displayVertices,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
    );
    if (pointInArea(point, area.vertices)) onMoveRoom(selectedRoomId, point);
  };

  return (
    <Pressable accessibilityLabel={`Measured sketch for ${area.label}`} onPress={moveSelected} style={styles.canvas}>
      {lines.map((line) => <React.Fragment key={line.key}>
        <View style={[styles.wall, line.style]} />
        <Text style={[styles.dimension, { left: line.midpoint.x - 18, top: line.midpoint.y - 18 }]}>
          {line.length.toFixed(1)}′
        </Text>
      </React.Fragment>)}
      {closureTargets.map((target) => {
        const point = modelToCanvas(target.point, displayVertices, CANVAS_WIDTH, CANVAS_HEIGHT);
        const current = modelToCanvas(
          area.vertices[area.vertices.length - 1]!,
          displayVertices,
          CANVAS_WIDTH,
          CANVAS_HEIGHT,
        );
        const guideLength = Math.hypot(point.x - current.x, point.y - current.y);
        const guideAngle = Math.atan2(point.y - current.y, point.x - current.x);
        return <React.Fragment key={`${target.kind}-${target.point.x}-${target.point.y}`}>
          <View style={[styles.closureGuide, {
            left: ((current.x + point.x) / 2) - (guideLength / 2),
            top: ((current.y + point.y) / 2) - 1,
            width: guideLength,
            transform: [{ rotate: `${guideAngle}rad` }],
          }]} />
          <Pressable
            accessibilityLabel={target.label}
            accessibilityRole="button"
            hitSlop={8}
            onPress={(event) => {
              event.stopPropagation();
              onConnectTarget(target);
            }}
            style={[styles.closureTarget, { left: point.x - 18, top: point.y - 18 }]}
          >
            <View style={[
              styles.closureDot,
              target.kind === "starting_point" ? styles.closureDotStart : styles.closureDotProjected,
            ]} />
          </Pressable>
        </React.Fragment>;
      })}
      {rooms.map((room) => {
        const point = modelToCanvas(room.anchor, displayVertices, CANVAS_WIDTH, CANVAS_HEIGHT);
        const selected = room.id === selectedRoomId;
        return (
          <Pressable
            accessibilityLabel={`${room.label} room marker`}
            key={room.id}
            onPress={(event) => { event.stopPropagation(); onSelectRoom(room); }}
            style={[styles.roomPin, { left: point.x - 30, top: point.y - 14 }, selected && styles.roomPinSelected]}
          >
            <Text numberOfLines={1} style={[styles.roomPinText, selected && styles.roomPinTextSelected]}>{room.label}</Text>
          </Pressable>
        );
      })}
      {!area.vertices.length ? <Text style={styles.canvasEmpty}>Add measured walls to draw this area.</Text> : null}
    </Pressable>
  );
}

function sketchError(reason: unknown) {
  const code = reason instanceof ApiError ? reason.code : reason instanceof Error ? reason.message : "manual_sketch_failed";
  const messages: Record<string, string> = {
    invalid_sketch_wall_length: "Enter a wall length between 0.1 and 10,000 feet.",
    sketch_needs_three_walls: "Add at least three walls before closing the outline.",
    sketch_not_ready_for_confirmation: "Every measured area must close without crossing itself before confirmation.",
    invalid_sketch_room_anchor: "The room marker must be inside its measured area.",
    network_request_failed: "The sketch is saved on this device and will synchronize when service returns.",
  };
  return messages[code] || code.replaceAll("_", " ");
}

export function SketchEditorPanel({
  api,
  store,
  ownerUserId,
  sessionId,
  online,
  selectedRoomId,
  onSelectRoom,
}: {
  api: MobileApi;
  store: OfflineStore;
  ownerUserId: string;
  sessionId: string;
  online: boolean;
  selectedRoomId: string | null;
  onSelectRoom: (room: SelectedSketchRoom | null) => void;
}) {
  const [clientSketchId, setClientSketchId] = useState(() => Crypto.randomUUID());
  const [draft, setDraft] = useState<ManualSketchDraft>(() => emptySketchDraft(Crypto.randomUUID()));
  const [selectedAreaId, setSelectedAreaId] = useState(draft.areas[0]!.id);
  const [wallLength, setWallLength] = useState("");
  const [bearing, setBearing] = useState("0");
  const [roomLabel, setRoomLabel] = useState("");
  const [roomType, setRoomType] = useState<SketchRoomType>("other");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sketchSync = useSketchSync(store, api, ownerUserId, sessionId, online);
  const selectedArea = (draft.areas.find((area) => area.id === selectedAreaId) || draft.areas[0])!;
  const areaRooms = draft.rooms.filter((room) => room.areaId === selectedArea.id);
  const calculation = calculateSketchOutline(selectedArea.vertices);
  const closureTargets = sketchClosureTargets(selectedArea.vertices);

  const setNormalizedBearing = (value: number) => setBearing(String(normalizeSketchBearing(value)));
  const adjustBearing = (change: number) => setNormalizedBearing(Number(bearing) + change);

  const initialize = useCallback(async () => {
    if (dirty) return;
    let local = await store.sketchDraft(ownerUserId, sessionId);
    if (!local && online) {
      try {
        const response = await api.inspectionSketch(sessionId);
        if (response.sketch) {
          await store.cacheServerSketch(ownerUserId, sessionId, response.sketch);
          local = await store.sketchDraft(ownerUserId, sessionId);
        }
      } catch (reason) {
        setError(sketchError(reason));
      }
    }
    if (local) {
      setClientSketchId(local.clientSketchId);
      setDraft(local.draft);
      setSelectedAreaId(local.draft.areas[0]?.id || "");
    }
  }, [api, dirty, online, ownerUserId, sessionId, store]);

  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    if (!dirty && sketchSync.draft) {
      setClientSketchId(sketchSync.draft.clientSketchId);
      setDraft(sketchSync.draft.draft);
      setSelectedAreaId((current) => sketchSync.draft?.draft.areas.some((area) => area.id === current)
        ? current
        : sketchSync.draft?.draft.areas[0]?.id || "");
    }
  }, [dirty, sketchSync.draft]);

  const changeDraft = (change: (current: ManualSketchDraft) => ManualSketchDraft) => {
    setDraft((current) => change(current));
    setDirty(true);
    setError(null);
  };

  const changeArea = (change: (area: SketchAreaDraft) => SketchAreaDraft) => {
    changeDraft((current) => updateArea(current, selectedArea.id, change));
  };

  const addWall = () => {
    try {
      const vertices = appendMeasuredWall(selectedArea.vertices, Number(wallLength), Number(bearing));
      changeArea((area) => ({ ...area, vertices }));
      setWallLength("");
    } catch (reason) {
      setError(sketchError(reason));
    }
  };

  const closeOutline = () => {
    try {
      changeArea((area) => ({ ...area, vertices: closeSketchOutline(area.vertices) }));
    } catch (reason) {
      setError(sketchError(reason));
    }
  };

  const connectTarget = (target: SketchClosureTarget) => {
    try {
      changeArea((area) => ({ ...area, vertices: connectSketchTarget(area.vertices, target) }));
    } catch (reason) {
      setError(sketchError(reason));
    }
  };

  const undoWall = () => {
    if (selectedArea.vertices.length < 2) return;
    changeArea((area) => ({ ...area, vertices: area.vertices.slice(0, -1) }));
  };

  const addArea = () => {
    const id = Crypto.randomUUID();
    const nextPosition = draft.areas.length + 1;
    changeDraft((current) => ({
      ...current,
      areas: [...current.areas, {
        id,
        label: `Area ${nextPosition}`,
        levelLabel: `Level ${nextPosition}`,
        classification: "above_grade_finished",
        notes: "",
        vertices: [],
        position: nextPosition,
      }],
    }));
    setSelectedAreaId(id);
  };

  const removeArea = () => {
    if (draft.areas.length === 1) return;
    const remaining = draft.areas.filter((area) => area.id !== selectedArea.id)
      .map((area, index) => ({ ...area, position: index + 1 }));
    changeDraft((current) => ({
      ...current,
      areas: remaining,
      rooms: current.rooms.filter((room) => room.areaId !== selectedArea.id),
    }));
    setSelectedAreaId(remaining[0]!.id);
    if (draft.rooms.some((room) => room.id === selectedRoomId && room.areaId === selectedArea.id)) onSelectRoom(null);
  };

  const selectRoom = (room: SketchRoomDraft) => {
    onSelectRoom({ id: room.id, roomRef: sketchRoomRef(room.id), label: room.label });
  };

  const addRoom = () => {
    const label = roomLabel.trim();
    if (!label) {
      setError("Enter a room label.");
      return;
    }
    if (!calculation.ready || !calculation.centroid) {
      setError("Close this area before adding room markers.");
      return;
    }
    const anchor = pointInArea(calculation.centroid, selectedArea.vertices)
      ? calculation.centroid
      : selectedArea.vertices[0]!;
    const room: SketchRoomDraft = {
      id: Crypto.randomUUID(),
      areaId: selectedArea.id,
      label,
      roomType,
      anchor,
      position: draft.rooms.length + 1,
    };
    changeDraft((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setRoomLabel("");
    selectRoom(room);
  };

  const moveRoom = (roomId: string, anchor: { x: number; y: number }) => {
    changeDraft((current) => ({
      ...current,
      rooms: current.rooms.map((room) => room.id === roomId ? { ...room, anchor } : room),
    }));
  };

  const renameRoom = (room: SketchRoomDraft, label: string) => {
    changeDraft((current) => ({
      ...current,
      rooms: current.rooms.map((candidate) => candidate.id === room.id ? { ...candidate, label } : candidate),
    }));
    if (selectedRoomId === room.id) {
      onSelectRoom({ id: room.id, roomRef: sketchRoomRef(room.id), label });
    }
  };

  const removeRoom = (roomId: string) => {
    changeDraft((current) => ({
      ...current,
      rooms: current.rooms.filter((room) => room.id !== roomId)
        .map((room, index) => ({ ...room, position: index + 1 })),
    }));
    if (selectedRoomId === roomId) onSelectRoom(null);
  };

  const persist = async (nextDraft = draft) => {
    if (nextDraft.areas.some((area) => area.vertices.length < 2)) {
      setError("Each area needs at least one measured wall before it can be synchronized.");
      return;
    }
    if (nextDraft.measurementStandard === "jurisdiction_required_other" && !nextDraft.alternateStandardName.trim()) {
      setError("Enter the jurisdiction-required measurement standard name.");
      return;
    }
    if (nextDraft.rooms.some((room) => !room.label.trim())) {
      setError("Every room marker needs a label before the sketch can be synchronized.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await store.queueSketchDraft(ownerUserId, sessionId, clientSketchId, nextDraft);
      setDirty(false);
      await sketchSync.refresh();
      if (online) await sketchSync.syncNow();
    } catch (reason) {
      setError(sketchError(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!sketchReadyForConfirmation(draft)) {
      setError(sketchError(new Error("sketch_not_ready_for_confirmation")));
      return;
    }
    const confirmed = { ...draft, reviewStatus: "appraiser_confirmed" as const };
    setDraft(confirmed);
    setDirty(true);
    await persist(confirmed);
  };

  const conflict = sketchSync.draft?.state === "conflict";
  const totalAbove = useMemo(() => draft.areas.reduce((total, area) => (
    area.classification === "above_grade_finished"
      ? total + (calculateSketchOutline(area.vertices).reportedAreaSqft || 0)
      : total
  ), 0), [draft.areas]);

  return (
    <View style={styles.container}>
      <View style={styles.rowBetween}>
        <View>
          <Text style={styles.eyebrow}>ANSI MEASUREMENT WORKSPACE</Text>
          <Text style={styles.title}>Manual sketch</Text>
        </View>
        <Text style={styles.areaTotal}>{totalAbove.toLocaleString()} sf</Text>
      </View>
      <Text style={styles.help}>Enter each measured wall to the nearest tenth of a foot. HomeNode calculates closed areas and preserves above-grade, below-grade, nonstandard, unfinished, and amenity areas separately.</Text>

      <Text style={styles.label}>Measurement standard</Text>
      <View style={styles.choices}>
        <Choice label="ANSI Z765-2021" selected={draft.measurementStandard === "ansi_z765_2021"} onPress={() => changeDraft((current) => ({ ...current, measurementStandard: "ansi_z765_2021", alternateStandardName: "", reviewStatus: "draft" }))} />
        <Choice label="Jurisdiction-required other" selected={draft.measurementStandard === "jurisdiction_required_other"} onPress={() => changeDraft((current) => ({ ...current, measurementStandard: "jurisdiction_required_other", reviewStatus: "draft" }))} />
      </View>
      {draft.measurementStandard === "jurisdiction_required_other" ? <TextInput
        onChangeText={(value) => changeDraft((current) => ({ ...current, alternateStandardName: value, reviewStatus: "draft" }))}
        placeholder="Required standard name"
        style={styles.input}
        value={draft.alternateStandardName}
      /> : null}
      <Text style={styles.label}>Measurement method</Text>
      <View style={styles.choices}>{([
        ["exterior", "Exterior"],
        ["interior_perimeter", "Interior perimeter"],
        ["plans", "Plans"],
        ["mixed", "Mixed"],
      ] as const).map(([value, label]) => (
        <Choice key={value} label={label} selected={draft.measurementMethod === value} onPress={() => changeDraft((current) => ({ ...current, measurementMethod: value, reviewStatus: "draft" }))} />
      ))}</View>

      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Measured areas</Text>
        <Pressable onPress={addArea}><Text style={styles.link}>+ Add area</Text></Pressable>
      </View>
      <View style={styles.choices}>{draft.areas.map((area) => (
        <Choice key={area.id} label={area.label} selected={area.id === selectedArea.id} onPress={() => setSelectedAreaId(area.id)} />
      ))}</View>
      <TextInput onChangeText={(value) => changeArea((area) => ({ ...area, label: value }))} placeholder="Area label" style={styles.input} value={selectedArea.label} />
      <TextInput onChangeText={(value) => changeArea((area) => ({ ...area, levelLabel: value }))} placeholder="Level label" style={styles.input} value={selectedArea.levelLabel} />
      <Text style={styles.label}>Area classification</Text>
      <View style={styles.choices}>{SKETCH_CLASSIFICATIONS.map(([value, label]) => (
        <Choice key={value} label={label} selected={selectedArea.classification === value} onPress={() => changeArea((area) => ({ ...area, classification: value }))} />
      ))}</View>

      <View style={styles.measureRow}>
        <TextInput keyboardType="decimal-pad" onChangeText={setWallLength} placeholder="Length ft" style={[styles.input, styles.measureInput]} value={wallLength} />
        <TextInput keyboardType="decimal-pad" onChangeText={setBearing} placeholder="Bearing°" style={[styles.input, styles.measureInput]} value={bearing} />
      </View>
      <Text style={styles.label}>Wall direction</Text>
      <View style={styles.directionPad}>{DIRECTION_PAD.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.directionRow}>{row.map((direction, columnIndex) => direction ? (
          <DirectionButton
            key={direction.bearing}
            symbol={direction.symbol}
            label={direction.label}
            selected={normalizeSketchBearing(Number(bearing)) === direction.bearing}
            onPress={() => setNormalizedBearing(direction.bearing)}
          />
        ) : (
          <View accessibilityLabel={`Current bearing ${normalizeSketchBearing(Number(bearing))} degrees`} key={`center-${columnIndex}`} style={styles.bearingCenter}>
            <Text style={styles.bearingValue}>{normalizeSketchBearing(Number(bearing))}°</Text>
          </View>
        ))}</View>
      ))}</View>
      <View style={styles.angleAdjustments}>
        <Choice label="↶ 5°" selected={false} onPress={() => adjustBearing(5)} />
        <Choice label="↶ 1°" selected={false} onPress={() => adjustBearing(1)} />
        <Choice label="↷ 1°" selected={false} onPress={() => adjustBearing(-1)} />
        <Choice label="↷ 5°" selected={false} onPress={() => adjustBearing(-5)} />
      </View>
      <Text style={styles.help}>Use an arrow for the nearest direction, then rotate by 1° or 5° for angled walls. You can still enter an exact bearing above.</Text>
      <View style={styles.actionsRow}>
        <Action title="Add wall" onPress={addWall} />
        <Action title="Undo" secondary disabled={selectedArea.vertices.length < 2} onPress={undoWall} />
        <Action title="Close to start" secondary disabled={selectedArea.vertices.length < 3} onPress={closeOutline} />
      </View>
      <SketchCanvas
        area={selectedArea}
        rooms={areaRooms}
        closureTargets={closureTargets}
        selectedRoomId={selectedRoomId}
        onSelectRoom={selectRoom}
        onMoveRoom={moveRoom}
        onConnectTarget={connectTarget}
      />
      {closureTargets[0]?.kind === "projected_corner" ? (
        <Text style={styles.closureHelp}>Tap the orange dot to add the aligned corner. Then tap the green starting dot to close the outline and calculate square footage.</Text>
      ) : closureTargets[0]?.kind === "starting_point" ? (
        <Text style={styles.closureHelp}>Tap the green starting dot to connect the final wall and calculate square footage.</Text>
      ) : null}
      <Text style={[styles.status, calculation.ready ? styles.statusReady : styles.statusPending]}>
        {calculation.ready
          ? `${calculation.reportedAreaSqft?.toLocaleString()} sf · ${calculation.perimeterFeet.toFixed(1)} ft perimeter · closed`
          : calculation.selfIntersecting
            ? "Outline crosses itself — revise the walls"
            : `${calculation.closureGapFeet.toFixed(1)} ft closure gap · area pending`}
      </Text>
      {draft.areas.length > 1 ? <Action title="Remove selected area" danger secondary onPress={removeArea} /> : null}

      <Text style={styles.sectionTitle}>Room markers and photo labels</Text>
      <Text style={styles.help}>Tap a room marker to make it the active photo label. With a room selected, tap inside the sketch to reposition it.</Text>
      <TextInput maxLength={80} onChangeText={setRoomLabel} placeholder="Room label, e.g. Primary bedroom" style={styles.input} value={roomLabel} />
      <View style={styles.choices}>{SKETCH_ROOM_TYPES.map(([value, label]) => (
        <Choice key={value} label={label} selected={roomType === value} onPress={() => setRoomType(value)} />
      ))}</View>
      <Action title="Add room marker" secondary disabled={!calculation.ready} onPress={addRoom} />
      <View style={styles.roomList}>{areaRooms.map((room) => (
        <View key={room.id} style={[styles.roomRow, room.id === selectedRoomId && styles.roomRowSelected]}>
          <Pressable style={styles.roomName} onPress={() => selectRoom(room)}>
            <TextInput
              accessibilityLabel={`Rename ${room.label}`}
              maxLength={80}
              onChangeText={(value) => renameRoom(room, value)}
              onFocus={() => selectRoom(room)}
              style={styles.roomLabelInput}
              value={room.label}
            />
            <Text style={styles.roomMeta}>{room.roomType.replaceAll("_", " ")} · automatic photo label</Text>
          </Pressable>
          <Pressable onPress={() => removeRoom(room.id)}><Text style={styles.removeLink}>Remove</Text></Pressable>
        </View>
      ))}</View>

      <Text style={styles.sectionTitle}>Appraiser review</Text>
      <TextInput
        multiline
        onChangeText={(value) => changeDraft((current) => ({ ...current, reviewNotes: value, reviewStatus: "draft" }))}
        placeholder="Measurement limitations, declarations, ceiling-height or classification notes…"
        style={[styles.input, styles.textArea]}
        textAlignVertical="top"
        value={draft.reviewNotes}
      />
      <Action title={busy ? "Saving…" : "Save sketch offline"} disabled={busy || !dirty} onPress={() => void persist()} />
      <Action title="Confirm appraiser review" secondary disabled={busy || !sketchReadyForConfirmation(draft)} onPress={() => void confirm()} />
      {sketchSync.syncing ? <View style={styles.progress}><ActivityIndicator color="#1d5a43" /><Text style={styles.help}>Synchronizing measured sketch…</Text></View> : null}
      <Text style={styles.syncLine}>{online ? "Online" : "Offline"} · {sketchSync.draft?.state || (dirty ? "unsaved" : "new draft")} · revision {sketchSync.draft?.baseRevision || 0}</Text>
      {conflict ? <View style={styles.conflictCard}>
        <Text style={styles.roomTitle}>Sketch changed in HomeNode</Text>
        <Text style={styles.help}>Your device draft is preserved. Choose the server version or deliberately replace it with this draft.</Text>
        <Action title="Use HomeNode sketch" secondary onPress={() => void store.acceptServerSketch(ownerUserId, sessionId).then(sketchSync.refresh)} />
        <Action title="Replace with device draft" onPress={() => void store.retryLocalSketch(ownerUserId, sessionId).then(sketchSync.syncNow)} />
      </View> : null}
      {error || sketchSync.draft?.errorCode ? <Text style={styles.error}>{error || sketchError(new Error(sketchSync.draft?.errorCode || ""))}</Text> : null}
      <Text style={styles.disclaimer}>Calculated closure does not replace professional judgment. Above/below-grade status, ceiling-height treatment, access, finish classification, declarations, and any jurisdiction-required standard remain subject to the appraiser’s documented review.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 11, marginTop: 24 },
  eyebrow: { color: "#5d786d", fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: "#183f31", fontSize: 25, fontWeight: "800" },
  sectionTitle: { color: "#183f31", fontSize: 18, fontWeight: "800", marginTop: 8 },
  areaTotal: { backgroundColor: "#e8f1ed", borderRadius: 18, color: "#1d5a43", fontWeight: "800", paddingHorizontal: 11, paddingVertical: 7 },
  help: { color: "#617069", fontSize: 13, lineHeight: 19 },
  label: { color: "#33443d", fontSize: 13, fontWeight: "700", marginTop: 3 },
  input: { backgroundColor: "white", borderColor: "#d8dfda", borderRadius: 9, borderWidth: 1, minHeight: 44, paddingHorizontal: 11, paddingVertical: 9 },
  textArea: { minHeight: 90 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { backgroundColor: "#f2f4f2", borderColor: "#d8dfda", borderRadius: 17, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7 },
  choiceSelected: { backgroundColor: "#1d5a43", borderColor: "#1d5a43" },
  choiceText: { color: "#3f4d47", fontSize: 12, fontWeight: "600" },
  choiceSelectedText: { color: "white" },
  rowBetween: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  measureRow: { flexDirection: "row", gap: 8 },
  measureInput: { flex: 1 },
  directionPad: { alignSelf: "center", gap: 6 },
  directionRow: { flexDirection: "row", gap: 6 },
  directionButton: { alignItems: "center", backgroundColor: "white", borderColor: "#a9bbb2", borderRadius: 10, borderWidth: 1, height: 52, justifyContent: "center", width: 58 },
  directionButtonSelected: { backgroundColor: "#1d5a43", borderColor: "#1d5a43" },
  directionSymbol: { color: "#29493c", fontSize: 27, fontWeight: "800" },
  directionSymbolSelected: { color: "white" },
  bearingCenter: { alignItems: "center", backgroundColor: "#e8f1ed", borderColor: "#b8cec2", borderRadius: 10, borderWidth: 1, height: 52, justifyContent: "center", width: 58 },
  bearingValue: { color: "#1d5a43", fontSize: 13, fontWeight: "800" },
  angleAdjustments: { alignSelf: "center", flexDirection: "row", gap: 7 },
  actionsRow: { flexDirection: "row", gap: 7 },
  action: { alignItems: "center", backgroundColor: "#1d5a43", borderRadius: 10, justifyContent: "center", minHeight: 45, paddingHorizontal: 14 },
  actionSecondary: { backgroundColor: "white", borderColor: "#1d5a43", borderWidth: 1 },
  actionDanger: { borderColor: "#9e2c25" },
  actionText: { color: "white", fontSize: 13, fontWeight: "800", textAlign: "center" },
  actionSecondaryText: { color: "#1d5a43" },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.8 },
  canvas: { alignSelf: "center", backgroundColor: "#fbfcfb", borderColor: "#cdd9d2", borderRadius: 12, borderWidth: 1, height: CANVAS_HEIGHT, overflow: "hidden", width: CANVAS_WIDTH },
  canvasEmpty: { color: "#7b8983", left: 30, position: "absolute", right: 30, textAlign: "center", top: 115 },
  wall: { backgroundColor: "#183f31", height: 3, position: "absolute" },
  closureGuide: { backgroundColor: "#d67b2f", height: 2, opacity: 0.55, position: "absolute" },
  closureTarget: { alignItems: "center", height: 36, justifyContent: "center", position: "absolute", width: 36 },
  closureDot: { borderColor: "white", borderRadius: 9, borderWidth: 3, height: 18, width: 18 },
  closureDotProjected: { backgroundColor: "#d67b2f" },
  closureDotStart: { backgroundColor: "#1d8a5b" },
  closureHelp: { backgroundColor: "#fff7e7", borderRadius: 8, color: "#714a14", fontSize: 12, fontWeight: "700", lineHeight: 18, padding: 9 },
  dimension: { backgroundColor: "#fbfcfb", color: "#456457", fontSize: 10, fontWeight: "700", paddingHorizontal: 2, position: "absolute", width: 42 },
  roomPin: { alignItems: "center", backgroundColor: "#e8f1ed", borderColor: "#1d5a43", borderRadius: 13, borderWidth: 1, height: 28, justifyContent: "center", paddingHorizontal: 5, position: "absolute", width: 60 },
  roomPinSelected: { backgroundColor: "#1d5a43" },
  roomPinText: { color: "#1d5a43", fontSize: 9, fontWeight: "800" },
  roomPinTextSelected: { color: "white" },
  status: { borderRadius: 8, fontSize: 12, fontWeight: "700", padding: 9 },
  statusReady: { backgroundColor: "#e8f1ed", color: "#1d5a43" },
  statusPending: { backgroundColor: "#fff7e7", color: "#865d18" },
  roomList: { gap: 7 },
  roomRow: { alignItems: "center", backgroundColor: "white", borderColor: "#dce4df", borderRadius: 9, borderWidth: 1, flexDirection: "row", gap: 8, padding: 10 },
  roomRowSelected: { borderColor: "#1d5a43", borderWidth: 2 },
  roomName: { flex: 1 },
  roomLabelInput: { color: "#183f31", fontSize: 14, fontWeight: "800", minHeight: 28, padding: 0 },
  roomTitle: { color: "#183f31", fontSize: 14, fontWeight: "800" },
  roomMeta: { color: "#6a7771", fontSize: 11, marginTop: 2 },
  removeLink: { color: "#9e2c25", fontSize: 12, fontWeight: "800" },
  link: { color: "#1d5a43", fontSize: 13, fontWeight: "800" },
  progress: { alignItems: "center", flexDirection: "row", gap: 8 },
  syncLine: { color: "#3f5f52", fontSize: 12, fontWeight: "700" },
  conflictCard: { backgroundColor: "#fff7e7", borderColor: "#e5c982", borderRadius: 10, borderWidth: 1, gap: 8, padding: 11 },
  error: { backgroundColor: "#fff0ef", borderRadius: 8, color: "#9e2c25", padding: 10 },
  disclaimer: { backgroundColor: "#f2f6f4", borderRadius: 9, color: "#52635c", fontSize: 11, lineHeight: 17, padding: 10 },
});
