import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Modal,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { ApiError, type MobileApi } from "../api/client";
import { OfflineStore } from "../offline/store";
import { COLORS } from "../theme";
import {
  appendMeasuredWall,
  calculateSketchGla,
  calculateSketchOutline,
  canvasToModel,
  closeSketchOutline,
  connectSketchTarget,
  emptySketchDraft,
  garageCutoutFitsParent,
  modelToCanvas,
  nearestPointOnSketchWall,
  nextSketchRoomLabel,
  normalizeSketchBearing,
  pointInArea,
  resizeSketchWall,
  sketchClosureTargets,
  sketchBounds,
  SKETCH_ROOM_TYPES,
  sketchReadyForConfirmation,
  sketchRoomRef,
  type ManualSketchDraft,
  type SketchAreaDraft,
  type SketchClosureTarget,
  type SketchRoomDraft,
  type SketchRoomType,
  type SketchPoint,
} from "./model";
import { SketchClassificationSelect } from "./SketchClassificationSelect";
import { SketchDirectionPad, SketchDrawingControls } from "./SketchDrawingControls";
import { useSketchSync } from "./sync";

export type SelectedSketchRoom = Readonly<{
  id: string;
  roomRef: string;
  label: string;
}>;

type SelectedSketchWall = Readonly<{
  areaId: string;
  segmentIndex: number;
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

function updateArea(draft: ManualSketchDraft, areaId: string, update: (area: SketchAreaDraft) => SketchAreaDraft) {
  return {
    ...draft,
    reviewStatus: "draft" as const,
    areas: draft.areas.map((area) => area.id === areaId ? update(area) : area),
  };
}

const CANVAS_PADDING = 70;
const MIN_CANVAS_HEIGHT = 330;
const DEFAULT_DIMENSION_SIZE = Object.freeze({ width: 34, height: 17 });
const DEFAULT_ROOM_LABEL_SIZE = Object.freeze({ width: 50, height: 18 });
const DEFAULT_AREA_LABEL_SIZE = Object.freeze({ width: 78, height: 30 });

function clampLabelCenter(
  position: SketchPoint,
  size: { width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
) {
  return {
    x: Math.max(size.width / 2, Math.min(canvasWidth - (size.width / 2), position.x)),
    y: Math.max(size.height / 2, Math.min(canvasHeight - (size.height / 2), position.y)),
  };
}

function lineStyle(from: SketchPoint, to: SketchPoint, thickness = 1) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  return {
    left: ((from.x + to.x) / 2) - (length / 2),
    top: ((from.y + to.y) / 2) - (thickness / 2),
    width: length,
    transform: [{ rotate: `${angle}rad` }],
  };
}

function DraggableDimension({ midpoint, position, label, deduction, canvasWidth, canvasHeight, onDragActiveChange, onMove }: {
  midpoint: SketchPoint;
  position: SketchPoint;
  label: string;
  deduction: boolean;
  canvasWidth: number;
  canvasHeight: number;
  onDragActiveChange: (active: boolean) => void;
  onMove: (position: SketchPoint) => void;
}) {
  const [translation, setTranslation] = useState({ x: 0, y: 0 });
  const [labelSize, setLabelSize] = useState<{ width: number; height: number }>(DEFAULT_DIMENSION_SIZE);
  const dragState = useRef({ position, labelSize, canvasWidth, canvasHeight, onDragActiveChange, onMove });
  dragState.current = { position, labelSize, canvasWidth, canvasHeight, onDragActiveChange, onMove };
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
    onMoveShouldSetPanResponderCapture: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
    onPanResponderGrant: () => dragState.current.onDragActiveChange(true),
    onPanResponderMove: (_, gesture) => setTranslation({ x: gesture.dx, y: gesture.dy }),
    onPanResponderRelease: (_, gesture) => {
      const active = dragState.current;
      active.onMove(clampLabelCenter(
        { x: active.position.x + gesture.dx, y: active.position.y + gesture.dy },
        active.labelSize,
        active.canvasWidth,
        active.canvasHeight,
      ));
      setTranslation({ x: 0, y: 0 });
      active.onDragActiveChange(false);
    },
    onPanResponderTerminate: () => {
      setTranslation({ x: 0, y: 0 });
      dragState.current.onDragActiveChange(false);
    },
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }), []);
  const current = { x: position.x + translation.x, y: position.y + translation.y };
  return <>
    <View style={[styles.dimensionLeader, lineStyle(midpoint, current)]} />
    <View
      accessibilityHint="Drag to move this dimension label away from nearby labels"
      accessibilityLabel={`${label} wall dimension`}
      hitSlop={8}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setLabelSize((currentSize) => currentSize.width === width && currentSize.height === height
          ? currentSize
          : { width, height });
      }}
      {...panResponder.panHandlers}
      style={[
        styles.dimension,
        deduction && styles.deductionDimension,
        { left: current.x - (labelSize.width / 2), top: current.y - (labelSize.height / 2) },
      ]}
    >
      <Text style={[styles.dimensionText, deduction && styles.deductionDimensionText]}>{label}</Text>
    </View>
  </>;
}

function DraggableAreaLabel({ anchor, position, title, subtitle, deduction, selected, canvasWidth, canvasHeight, onDragActiveChange, onMove }: {
  anchor: SketchPoint;
  position: SketchPoint;
  title: string;
  subtitle: string;
  deduction: boolean;
  selected: boolean;
  canvasWidth: number;
  canvasHeight: number;
  onDragActiveChange: (active: boolean) => void;
  onMove: (position: SketchPoint) => void;
}) {
  const [translation, setTranslation] = useState({ x: 0, y: 0 });
  const [labelSize, setLabelSize] = useState<{ width: number; height: number }>(DEFAULT_AREA_LABEL_SIZE);
  const dragState = useRef({ position, labelSize, canvasWidth, canvasHeight, onDragActiveChange, onMove });
  dragState.current = { position, labelSize, canvasWidth, canvasHeight, onDragActiveChange, onMove };
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
    onMoveShouldSetPanResponderCapture: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
    onPanResponderGrant: () => dragState.current.onDragActiveChange(true),
    onPanResponderMove: (_, gesture) => setTranslation({ x: gesture.dx, y: gesture.dy }),
    onPanResponderRelease: (_, gesture) => {
      const active = dragState.current;
      active.onMove(clampLabelCenter(
        { x: active.position.x + gesture.dx, y: active.position.y + gesture.dy },
        active.labelSize,
        active.canvasWidth,
        active.canvasHeight,
      ));
      setTranslation({ x: 0, y: 0 });
      active.onDragActiveChange(false);
    },
    onPanResponderTerminate: () => {
      setTranslation({ x: 0, y: 0 });
      dragState.current.onDragActiveChange(false);
    },
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }), []);
  const current = { x: position.x + translation.x, y: position.y + translation.y };
  return <>
    <View style={[styles.areaLabelLeader, lineStyle(anchor, current)]} />
    <View
      accessibilityHint="Drag to reposition this area label"
      accessibilityLabel={`${title}, ${subtitle}`}
      hitSlop={8}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setLabelSize((currentSize) => currentSize.width === width && currentSize.height === height
          ? currentSize
          : { width, height });
      }}
      {...panResponder.panHandlers}
      style={[
        styles.areaLabel,
        deduction && styles.deductionAreaLabel,
        selected && styles.areaLabelSelected,
        { left: current.x - (labelSize.width / 2), top: current.y - (labelSize.height / 2) },
      ]}
    >
      <Text numberOfLines={1} style={[styles.areaLabelTitle, deduction && styles.deductionAreaLabelText]}>{title}</Text>
      <Text numberOfLines={1} style={[styles.areaLabelValue, deduction && styles.deductionAreaLabelText]}>{subtitle}</Text>
    </View>
  </>;
}

function DraggableRoomLabel({ position, label, selected, canvasWidth, canvasHeight, onDragActiveChange, onSelect, onMove }: {
  position: SketchPoint;
  label: string;
  selected: boolean;
  canvasWidth: number;
  canvasHeight: number;
  onDragActiveChange: (active: boolean) => void;
  onSelect: () => void;
  onMove: (position: SketchPoint) => void;
}) {
  const [translation, setTranslation] = useState({ x: 0, y: 0 });
  const [labelSize, setLabelSize] = useState<{ width: number; height: number }>(DEFAULT_ROOM_LABEL_SIZE);
  const dragState = useRef({ position, labelSize, canvasWidth, canvasHeight, onDragActiveChange, onSelect, onMove });
  dragState.current = { position, labelSize, canvasWidth, canvasHeight, onDragActiveChange, onSelect, onMove };
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
    onMoveShouldSetPanResponderCapture: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2,
    onPanResponderGrant: () => dragState.current.onDragActiveChange(true),
    onPanResponderMove: (_, gesture) => setTranslation({ x: gesture.dx, y: gesture.dy }),
    onPanResponderRelease: (_, gesture) => {
      const active = dragState.current;
      active.onSelect();
      if (Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2) {
        active.onMove(clampLabelCenter(
          { x: active.position.x + gesture.dx, y: active.position.y + gesture.dy },
          active.labelSize,
          active.canvasWidth,
          active.canvasHeight,
        ));
      }
      setTranslation({ x: 0, y: 0 });
      active.onDragActiveChange(false);
    },
    onPanResponderTerminate: () => {
      setTranslation({ x: 0, y: 0 });
      dragState.current.onDragActiveChange(false);
    },
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }), []);
  const current = { x: position.x + translation.x, y: position.y + translation.y };
  return (
    <View
      accessibilityHint="Drag to reposition this room label inside its measured area"
      accessibilityLabel={`${label} room marker`}
      accessibilityRole="button"
      hitSlop={8}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setLabelSize((currentSize) => currentSize.width === width && currentSize.height === height
          ? currentSize
          : { width, height });
      }}
      {...panResponder.panHandlers}
      style={[
        styles.roomPin,
        { left: current.x - (labelSize.width / 2), top: current.y - (labelSize.height / 2) },
        selected && styles.roomPinSelected,
      ]}
    >
      <Text numberOfLines={1} style={[styles.roomPinText, selected && styles.roomPinTextSelected]}>{label}</Text>
    </View>
  );
}

function SketchCanvas({ areas, selectedAreaId, rooms, closureTargets, bearing, placingGarage, placingRoom, selectedRoomId, selectedWall, onLabelDragActiveChange, onSelectRoom, onMoveRoom, onPlaceRoom, onMoveAreaLabel, onMoveDimension, onSelectWall, onConnectTarget, onSetBearing, onStartGarage }: {
  areas: SketchAreaDraft[];
  selectedAreaId: string;
  rooms: SketchRoomDraft[];
  closureTargets: SketchClosureTarget[];
  bearing: number;
  placingGarage: boolean;
  placingRoom: boolean;
  selectedRoomId: string | null;
  selectedWall: SelectedSketchWall | null;
  onLabelDragActiveChange: (active: boolean) => void;
  onSelectRoom: (room: SketchRoomDraft) => void;
  onMoveRoom: (roomId: string, point: { x: number; y: number }) => void;
  onPlaceRoom: (point: { x: number; y: number }) => void;
  onMoveAreaLabel: (areaId: string, offset: SketchPoint) => void;
  onMoveDimension: (areaId: string, segmentIndex: number, offset: SketchPoint) => void;
  onSelectWall: (areaId: string, segmentIndex: number, length: number) => void;
  onConnectTarget: (target: SketchClosureTarget) => void;
  onSetBearing: (bearing: number) => void;
  onStartGarage: (point: { x: number; y: number }) => void;
}) {
  const selectedArea = (areas.find((area) => area.id === selectedAreaId) || areas[0])!;
  const { width: windowWidth } = useWindowDimensions();
  const displayVertices = [
    ...areas.flatMap((area) => area.vertices),
    ...closureTargets.map((target) => target.point),
  ];
  const bounds = sketchBounds(displayVertices);
  const canvasWidth = Math.max(300, Math.min(600, windowWidth - 28));
  const canvasHeight = Math.max(MIN_CANVAS_HEIGHT, Math.min(
    620,
    108 + ((canvasWidth - (CANVAS_PADDING * 2)) * (bounds.height / bounds.width)),
  ));
  const lines = areas.flatMap((area) => {
    const canvasVertices = area.vertices.map((point) => modelToCanvas(
      point,
      displayVertices,
      canvasWidth,
      canvasHeight,
      CANVAS_PADDING,
    ));
    const calculation = calculateSketchOutline(area.vertices);
    const areaCenter = calculation.centroid
      ? modelToCanvas(calculation.centroid, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING)
      : canvasVertices.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
    if (!calculation.centroid && canvasVertices.length) {
      areaCenter.x /= canvasVertices.length;
      areaCenter.y /= canvasVertices.length;
    }
    return canvasVertices.slice(0, -1).map((point, index) => {
      const next = canvasVertices[index + 1]!;
      const length = Math.hypot(next.x - point.x, next.y - point.y);
      const midpoint = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
      const firstNormal = { x: -(next.y - point.y) / length, y: (next.x - point.x) / length };
      const secondNormal = { x: -firstNormal.x, y: -firstNormal.y };
      const away = { x: midpoint.x - areaCenter.x, y: midpoint.y - areaCenter.y };
      const outward = ((away.x * firstNormal.x) + (away.y * firstNormal.y))
        >= ((away.x * secondNormal.x) + (away.y * secondNormal.y)) ? firstNormal : secondNormal;
      const autoDistance = length < 58 ? 40 + ((index % 2) * 12) : 29;
      const saved = area.dimensionLabels.find((label) => label.segmentIndex === index);
      const modelMidpoint = {
        x: (area.vertices[index]!.x + area.vertices[index + 1]!.x) / 2,
        y: (area.vertices[index]!.y + area.vertices[index + 1]!.y) / 2,
      };
      const dimensionPosition = saved
        ? modelToCanvas({
          x: modelMidpoint.x + saved.offset.x,
          y: modelMidpoint.y + saved.offset.y,
        }, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING)
        : { x: midpoint.x + (outward.x * autoDistance), y: midpoint.y + (outward.y * autoDistance) };
      return {
        area,
        index,
        key: `${area.id}-${index}-${point.x}-${point.y}`,
        style: lineStyle(point, next, 3),
        touchStyle: lineStyle(point, next, 22),
        length: Math.hypot(
          area.vertices[index + 1]!.x - area.vertices[index]!.x,
          area.vertices[index + 1]!.y - area.vertices[index]!.y,
        ),
        midpoint,
        modelMidpoint,
        dimensionPosition,
      };
    });
  });

  const handleCanvasPress = (event: GestureResponderEvent) => {
    const point = canvasToModel(
      { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
      displayVertices,
      canvasWidth,
      canvasHeight,
      CANVAS_PADDING,
    );
    if (placingGarage) {
      onStartGarage(point);
      return;
    }
    if (placingRoom) {
      onPlaceRoom(point);
      return;
    }
    if (!selectedRoomId) return;
    const room = rooms.find((candidate) => candidate.id === selectedRoomId);
    const roomArea = room && areas.find((candidate) => candidate.id === room.areaId);
    if (roomArea && pointInArea(point, roomArea.vertices)) onMoveRoom(selectedRoomId, point);
  };

  return (
    <Pressable
      accessibilityLabel={placingGarage
        ? "Tap a solid exterior wall to anchor the garage cutout"
        : placingRoom
          ? "Tap inside the selected measured area to place the room label"
          : "Combined measured property sketch"}
      onPress={handleCanvasPress}
      style={[
        styles.canvas,
        { height: canvasHeight, width: canvasWidth },
        placingGarage && styles.canvasPlacing,
        placingRoom && styles.canvasPlacingRoom,
      ]}
    >
      {lines.map((line) => <React.Fragment key={line.key}>
        <Pressable
          accessibilityLabel={`${line.area.label} wall ${line.index + 1}, ${line.length.toFixed(1)} feet`}
          accessibilityRole="button"
          accessibilityState={{ selected: selectedWall?.areaId === line.area.id && selectedWall.segmentIndex === line.index }}
          disabled={placingGarage || placingRoom}
          hitSlop={4}
          onPress={(event) => {
            event.stopPropagation();
            onSelectWall(line.area.id, line.index, line.length);
          }}
          pointerEvents={placingGarage || placingRoom ? "none" : "auto"}
          style={[styles.wallTouch, line.touchStyle]}
        />
        <View style={[
          styles.wall,
          line.area.glaTreatment === "deduction" && styles.deductionWall,
          line.area.id !== selectedAreaId && styles.wallMuted,
          selectedWall?.areaId === line.area.id && selectedWall.segmentIndex === line.index && styles.wallSelected,
          line.style,
        ]} />
        <DraggableDimension
          midpoint={line.midpoint}
          position={line.dimensionPosition}
          label={`${line.length.toFixed(1)}′`}
          deduction={line.area.glaTreatment === "deduction"}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          onDragActiveChange={onLabelDragActiveChange}
          onMove={(position) => {
            const anchor = canvasToModel(position, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
            onMoveDimension(line.area.id, line.index, {
              x: anchor.x - line.modelMidpoint.x,
              y: anchor.y - line.modelMidpoint.y,
            });
          }}
        />
      </React.Fragment>)}
      {areas.map((area) => {
        const calculation = calculateSketchOutline(area.vertices);
        if (!calculation.ready || !calculation.centroid) return null;
        const anchor = modelToCanvas(calculation.centroid, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
        const offset = area.labelOffset || { x: 0, y: 0 };
        const position = modelToCanvas({
          x: calculation.centroid.x + offset.x,
          y: calculation.centroid.y + offset.y,
        }, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
        return <DraggableAreaLabel
          anchor={anchor}
          canvasHeight={canvasHeight}
          canvasWidth={canvasWidth}
          deduction={area.glaTreatment === "deduction"}
          key={`label-${area.id}`}
          onDragActiveChange={onLabelDragActiveChange}
          onMove={(canvasPoint) => {
            const modelPoint = canvasToModel(canvasPoint, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
            onMoveAreaLabel(area.id, {
              x: modelPoint.x - calculation.centroid!.x,
              y: modelPoint.y - calculation.centroid!.y,
            });
          }}
          position={position}
          selected={area.id === selectedAreaId}
          subtitle={`${area.glaTreatment === "deduction" ? "−" : ""}${calculation.reportedAreaSqft?.toLocaleString()} sf`}
          title={area.label}
        />;
      })}
      {placingGarage ? areas.filter((area) => area.glaTreatment === "included").flatMap((area) => (
        area.vertices.slice(0, -1).map((vertex, index) => {
          const point = modelToCanvas(vertex, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
          return <View key={`anchor-${area.id}-${index}`} style={[styles.wallAnchor, { left: point.x - 5, top: point.y - 5 }]} />;
        })
      )) : null}
      {closureTargets.map((target) => {
        const point = modelToCanvas(target.point, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
        const current = modelToCanvas(
          selectedArea.vertices[selectedArea.vertices.length - 1]!,
          displayVertices,
          canvasWidth,
          canvasHeight,
          CANVAS_PADDING,
        );
        const guideLength = Math.hypot(point.x - current.x, point.y - current.y);
        const guideAngle = Math.atan2(point.y - current.y, point.x - current.x);
        const modelLength = Math.hypot(
          target.point.x - selectedArea.vertices[selectedArea.vertices.length - 1]!.x,
          target.point.y - selectedArea.vertices[selectedArea.vertices.length - 1]!.y,
        );
        return <React.Fragment key={`${target.kind}-${target.point.x}-${target.point.y}`}>
          <View style={[
            styles.closureGuide,
            target.kind === "starting_point" ? styles.closureGuideStart : styles.closureGuideProjected,
            {
              left: ((current.x + point.x) / 2) - (guideLength / 2),
              top: ((current.y + point.y) / 2) - 1,
              width: guideLength,
              transform: [{ rotate: `${guideAngle}rad` }],
            },
          ]} />
          <Text style={[
            styles.closureDimension,
            target.kind === "starting_point" ? styles.closureDimensionStart : styles.closureDimensionProjected,
            { left: ((current.x + point.x) / 2) - 20, top: ((current.y + point.y) / 2) - 20 },
          ]}>
            {modelLength.toFixed(1)}′
          </Text>
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
        const point = modelToCanvas(room.anchor, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
        const selected = room.id === selectedRoomId;
        const roomArea = areas.find((area) => area.id === room.areaId);
        return (
          <DraggableRoomLabel
            canvasHeight={canvasHeight}
            canvasWidth={canvasWidth}
            key={room.id}
            label={room.label}
            onDragActiveChange={onLabelDragActiveChange}
            onMove={(canvasPoint) => {
              const modelPoint = canvasToModel(canvasPoint, displayVertices, canvasWidth, canvasHeight, CANVAS_PADDING);
              if (roomArea && pointInArea(modelPoint, roomArea.vertices)) onMoveRoom(room.id, modelPoint);
            }}
            onSelect={() => onSelectRoom(room)}
            position={point}
            selected={selected}
          />
        );
      })}
      {!displayVertices.length ? <Text style={styles.canvasEmpty}>Add measured walls to draw the first exterior area.</Text> : null}
      {placingGarage ? <Text style={styles.placementBanner}>Tap a corner or anywhere along a solid exterior wall</Text> : null}
      {placingRoom ? <Text style={styles.roomPlacementBanner}>Tap inside the sketch to place this room</Text> : null}
      <View style={styles.canvasDirectionPanel}>
        <SketchDirectionPad bearing={bearing} onSelectBearing={onSetBearing} />
      </View>
    </Pressable>
  );
}

function sketchError(reason: unknown) {
  const code = reason instanceof ApiError ? reason.code : reason instanceof Error ? reason.message : "manual_sketch_failed";
  const messages: Record<string, string> = {
    invalid_sketch_wall_length: "Enter a wall length between 0.1 and 10,000 feet.",
    invalid_sketch_wall_segment: "Select a valid measured wall and try again.",
    invalid_sketch_wall_resize: "That length would collapse or cross another wall. Enter a different length.",
    sketch_needs_three_walls: "Add at least three walls before closing the outline.",
    sketch_not_ready_for_confirmation: "Every measured area must close without crossing itself before confirmation.",
    invalid_sketch_room_anchor: "The room marker must be inside its measured area.",
    invalid_garage_cutout_bounds: "Keep the closed garage cutout inside or on the walls of its main exterior area.",
    invalid_sketch_deduction_bounds: "The garage cutout must remain inside its main exterior area.",
    custom_appraisal_workfile_signed: "This appraisal is signed. The sketch remains saved on this device until a new revision is opened.",
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
  onLabelDragActiveChange,
  onSelectRoom,
}: {
  api: MobileApi;
  store: OfflineStore;
  ownerUserId: string;
  sessionId: string;
  online: boolean;
  selectedRoomId: string | null;
  onLabelDragActiveChange?: (active: boolean) => void;
  onSelectRoom: (room: SelectedSketchRoom | null) => void;
}) {
  const [clientSketchId, setClientSketchId] = useState(() => Crypto.randomUUID());
  const [draft, setDraft] = useState<ManualSketchDraft>(() => emptySketchDraft(Crypto.randomUUID()));
  const [selectedAreaId, setSelectedAreaId] = useState(draft.areas[0]!.id);
  const [wallLength, setWallLength] = useState("");
  const [bearing, setBearing] = useState("0");
  const [roomLabel, setRoomLabel] = useState("");
  const [roomType, setRoomType] = useState<SketchRoomType>("other");
  const [selectedWall, setSelectedWall] = useState<SelectedSketchWall | null>(null);
  const [selectedWallLength, setSelectedWallLength] = useState("");
  const [placingGarage, setPlacingGarage] = useState(false);
  const [placingRoom, setPlacingRoom] = useState(false);
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sketchSync = useSketchSync(store, api, ownerUserId, sessionId, online);
  const selectedArea = (draft.areas.find((area) => area.id === selectedAreaId) || draft.areas[0])!;
  const areaRooms = draft.rooms.filter((room) => room.areaId === selectedArea.id);
  const calculation = calculateSketchOutline(selectedArea.vertices);
  const closureTargets = sketchClosureTargets(selectedArea.vertices);
  const selectedWallArea = selectedWall
    ? draft.areas.find((area) => area.id === selectedWall.areaId) || null
    : null;
  const selectedWallCurrentLength = selectedWallArea && selectedWall
    && selectedWall.segmentIndex >= 0
    && selectedWall.segmentIndex < selectedWallArea.vertices.length - 1
    ? Math.hypot(
      selectedWallArea.vertices[selectedWall.segmentIndex + 1]!.x - selectedWallArea.vertices[selectedWall.segmentIndex]!.x,
      selectedWallArea.vertices[selectedWall.segmentIndex + 1]!.y - selectedWallArea.vertices[selectedWall.segmentIndex]!.y,
    )
    : null;

  useEffect(() => () => onLabelDragActiveChange?.(false), [onLabelDragActiveChange]);
  const handleLabelDragActiveChange = useCallback(
    (active: boolean) => onLabelDragActiveChange?.(active),
    [onLabelDragActiveChange],
  );

  const setNormalizedBearing = (value: number) => setBearing(String(normalizeSketchBearing(value)));
  const adjustBearing = (change: number) => setNormalizedBearing(Number(bearing) + change);

  const initialize = useCallback(async () => {
    if (dirty) return;
    let local = await store.withDatabaseActivity(() => store.sketchDraft(ownerUserId, sessionId));
    if (!local && online) {
      try {
        const response = await api.inspectionSketch(sessionId);
        const serverSketch = response.sketch;
        if (serverSketch) {
          await store.withDatabaseActivity(() => store.cacheServerSketch(ownerUserId, sessionId, serverSketch));
          local = await store.withDatabaseActivity(() => store.sketchDraft(ownerUserId, sessionId));
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

  const changeAreaVertices = (vertices: SketchAreaDraft["vertices"]) => {
    const dimensionLabels = selectedArea.dimensionLabels.filter((label) => label.segmentIndex < Math.max(0, vertices.length - 1));
    const nextArea = { ...selectedArea, vertices, dimensionLabels };
    const nextAreas = draft.areas.map((area) => area.id === selectedArea.id ? nextArea : area);
    const nextCalculation = calculateSketchOutline(vertices);
    if (nextCalculation.ready && draft.rooms.some((room) => (
      room.areaId === nextArea.id && !pointInArea(room.anchor, vertices)
    ))) throw new Error("invalid_sketch_room_anchor");
    if (nextAreas.some((area) => (
      area.glaTreatment === "deduction"
      && calculateSketchOutline(area.vertices).ready
      && !garageCutoutFitsParent(area, nextAreas)
    ))) throw new Error("invalid_garage_cutout_bounds");
    changeArea((area) => ({ ...area, vertices, dimensionLabels }));
  };

  const moveDimension = (areaId: string, segmentIndex: number, offset: SketchPoint) => {
    changeDraft((current) => updateArea(current, areaId, (area) => ({
      ...area,
      dimensionLabels: [
        ...area.dimensionLabels.filter((label) => label.segmentIndex !== segmentIndex),
        { segmentIndex, offset },
      ].sort((left, right) => left.segmentIndex - right.segmentIndex),
    })));
  };

  const moveAreaLabel = (areaId: string, labelOffset: SketchPoint) => {
    changeDraft((current) => updateArea(current, areaId, (area) => ({
      ...area,
      labelOffset,
    })));
  };

  const selectWall = (areaId: string, segmentIndex: number, length: number) => {
    setSelectedAreaId(areaId);
    setSelectedWall({ areaId, segmentIndex });
    setSelectedWallLength(String(Number(length.toFixed(1))));
    setPlacingGarage(false);
    setPlacingRoom(false);
  };

  const clearSelectedWall = () => {
    setSelectedWall(null);
    setSelectedWallLength("");
  };

  const updateSelectedWallLength = () => {
    if (!selectedWall || !selectedWallArea || selectedWallArea.id !== selectedArea.id) return;
    try {
      changeAreaVertices(resizeSketchWall(
        selectedWallArea.vertices,
        selectedWall.segmentIndex,
        Number(selectedWallLength),
      ));
      setSelectedWallLength(String(Number(Number(selectedWallLength).toFixed(1))));
    } catch (reason) {
      setError(sketchError(reason));
    }
  };

  const addWall = () => {
    try {
      const vertices = appendMeasuredWall(selectedArea.vertices, Number(wallLength), Number(bearing));
      changeAreaVertices(vertices);
      setWallLength("");
    } catch (reason) {
      setError(sketchError(reason));
    }
  };

  const closeOutline = () => {
    try {
      changeAreaVertices(closeSketchOutline(selectedArea.vertices));
    } catch (reason) {
      setError(sketchError(reason));
    }
  };

  const connectTarget = (target: SketchClosureTarget) => {
    try {
      changeAreaVertices(connectSketchTarget(selectedArea.vertices, target));
    } catch (reason) {
      setError(sketchError(reason));
    }
  };

  const undoWall = () => {
    if (selectedArea.vertices.length < 2) return;
    changeArea((area) => ({ ...area, vertices: area.vertices.slice(0, -1) }));
    clearSelectedWall();
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
        glaTreatment: "included",
        parentAreaId: null,
        notes: "",
        vertices: [],
        dimensionLabels: [],
        labelOffset: { x: 0, y: 0 },
        position: nextPosition,
      }],
    }));
    setSelectedAreaId(id);
    setPlacingGarage(false);
    setPlacingRoom(false);
    clearSelectedWall();
  };

  const beginGarageCutout = () => {
    if (!draft.areas.some((area) => area.glaTreatment === "included" && calculateSketchOutline(area.vertices).ready)) {
      setError("Close the main exterior area before adding a garage cutout.");
      return;
    }
    setPlacingGarage(true);
    setPlacingRoom(false);
    setError(null);
    clearSelectedWall();
    onSelectRoom(null);
  };

  const startGarageCutout = (point: { x: number; y: number }) => {
    const snap = nearestPointOnSketchWall(point, draft.areas);
    if (!snap) {
      setError("Tap a solid wall or corner of a closed exterior area.");
      return;
    }
    const parent = draft.areas.find((area) => area.id === snap.areaId)!;
    const id = Crypto.randomUUID();
    changeDraft((current) => ({
      ...current,
      areas: [...current.areas, {
        id,
        label: "Garage",
        levelLabel: parent.levelLabel,
        classification: "garage",
        glaTreatment: "deduction",
        parentAreaId: parent.id,
        notes: "",
        vertices: [snap.point],
        dimensionLabels: [],
        labelOffset: { x: 0, y: 0 },
        position: current.areas.length + 1,
      }],
    }));
    setSelectedAreaId(id);
    setPlacingGarage(false);
    setPlacingRoom(false);
    clearSelectedWall();
    setError(null);
  };

  const setAreaClassification = (classification: SketchAreaDraft["classification"]) => {
    if (
      classification !== "above_grade_finished"
      && draft.areas.some((area) => area.parentAreaId === selectedArea.id)
    ) {
      setError("Remove this area's garage cutout before changing it from above-grade finished GLA.");
      return;
    }
    changeArea((area) => ({
      ...area,
      classification,
      glaTreatment: classification === "above_grade_finished" ? "included" : "excluded",
    }));
  };

  const removeArea = () => {
    const exteriorCount = draft.areas.filter((area) => area.glaTreatment !== "deduction").length;
    if (selectedArea.glaTreatment !== "deduction" && exteriorCount === 1) {
      setError("Keep at least one exterior area in the sketch.");
      return;
    }
    const removedIds = new Set([
      selectedArea.id,
      ...draft.areas.filter((area) => area.parentAreaId === selectedArea.id).map((area) => area.id),
    ]);
    const remaining = draft.areas.filter((area) => !removedIds.has(area.id))
      .map((area, index) => ({ ...area, position: index + 1 }));
    changeDraft((current) => ({
      ...current,
      areas: remaining,
      rooms: current.rooms.filter((room) => !removedIds.has(room.areaId)),
    }));
    setSelectedAreaId(remaining[0]!.id);
    setPlacingGarage(false);
    setPlacingRoom(false);
    clearSelectedWall();
    if (draft.rooms.some((room) => room.id === selectedRoomId && room.areaId === selectedArea.id)) onSelectRoom(null);
  };

  const selectRoom = (room: SketchRoomDraft) => {
    onSelectRoom({ id: room.id, roomRef: sketchRoomRef(room.id), label: room.label });
  };

  const beginRoomPlacement = (nextRoomType: SketchRoomType) => {
    setRoomType(nextRoomType);
    if (!calculation.ready) {
      setError("Close this area before adding room labels.");
      setPlacingRoom(false);
      return false;
    }
    setPlacingRoom(true);
    setPlacingGarage(false);
    clearSelectedWall();
    onSelectRoom(null);
    setError(null);
    return true;
  };

  const placeRoom = (anchor: { x: number; y: number }) => {
    if (!placingRoom) return;
    if (!pointInArea(anchor, selectedArea.vertices)) {
      setError(`Tap inside ${selectedArea.label} to place this room.`);
      return;
    }
    const room: SketchRoomDraft = {
      id: Crypto.randomUUID(),
      areaId: selectedArea.id,
      label: nextSketchRoomLabel(draft.rooms, roomType, roomLabel),
      roomType,
      anchor,
      position: draft.rooms.length + 1,
    };
    changeDraft((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setRoomLabel("");
    setPlacingRoom(false);
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
      await store.withDatabaseActivity(() => store.queueSketchDraft(ownerUserId, sessionId, clientSketchId, nextDraft));
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
  const gla = useMemo(() => calculateSketchGla(draft.areas), [draft.areas]);
  const selectedRoom = draft.rooms.find((room) => room.id === selectedRoomId) || null;

  return (
    <View style={styles.container}>
      <View style={styles.rowBetween}>
        <View>
          <Text style={styles.eyebrow}>ANSI MEASUREMENT WORKSPACE</Text>
          <Text style={styles.title}>Manual sketch</Text>
        </View>
        <Text style={styles.areaTotal}>{gla.netGlaSqft.toLocaleString()} sf GLA</Text>
      </View>
      {gla.deductionAreaSqft ? <Text style={styles.glaBreakdown}>
        {gla.grossAreaSqft.toLocaleString()} sf gross − {gla.deductionAreaSqft.toLocaleString()} sf garage = {gla.netGlaSqft.toLocaleString()} sf GLA
      </Text> : null}

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
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Sketch layers</Text>
        <Pressable onPress={addArea}><Text style={styles.link}>+ Exterior area</Text></Pressable>
      </View>
      <Action title={placingGarage ? "Tap the solid wall below…" : "+ Garage cutout"} secondary disabled={placingGarage} onPress={beginGarageCutout} />
      <View style={styles.choices}>{draft.areas.map((area) => (
        <Choice
          key={area.id}
          label={`${area.glaTreatment === "deduction" ? "⋯ " : ""}${area.label}`}
          selected={area.id === selectedArea.id}
          onPress={() => { setSelectedAreaId(area.id); setPlacingGarage(false); setPlacingRoom(false); clearSelectedWall(); }}
        />
      ))}</View>
      <TextInput onChangeText={(value) => changeArea((area) => ({ ...area, label: value }))} placeholder="Area label" style={styles.input} value={selectedArea.label} />
      <TextInput onChangeText={(value) => changeArea((area) => ({ ...area, levelLabel: value }))} placeholder="Level label" style={styles.input} value={selectedArea.levelLabel} />
      {selectedArea.glaTreatment === "deduction" ? <Text style={styles.deductionNotice}>Dotted garage cutout · its closed area is deducted from the main GLA.</Text> : null}
      <View style={styles.sketchWorkspace}>
        <SketchClassificationSelect
          key={selectedArea.id}
          value={selectedArea.classification}
          disabled={selectedArea.glaTreatment === "deduction"}
          onChange={setAreaClassification}
        />
        <SketchCanvas
          areas={draft.areas}
          selectedAreaId={selectedArea.id}
          rooms={draft.rooms}
          closureTargets={closureTargets}
          bearing={Number(bearing)}
          placingGarage={placingGarage}
          placingRoom={placingRoom}
          selectedRoomId={selectedRoomId}
          selectedWall={selectedWall}
          onLabelDragActiveChange={handleLabelDragActiveChange}
          onSelectRoom={selectRoom}
          onMoveRoom={moveRoom}
          onPlaceRoom={placeRoom}
          onMoveAreaLabel={moveAreaLabel}
          onMoveDimension={moveDimension}
          onSelectWall={selectWall}
          onConnectTarget={connectTarget}
          onSetBearing={setNormalizedBearing}
          onStartGarage={startGarageCutout}
        />
        <SketchDrawingControls
          wallLength={wallLength}
          bearing={bearing}
          onChangeLength={setWallLength}
          onChangeBearing={setBearing}
          onAdjustBearing={adjustBearing}
          onAddWall={addWall}
        />
      </View>
      <View style={styles.actionsRow}>
        <Action title="Undo" secondary disabled={selectedArea.vertices.length < 2} onPress={undoWall} />
        <Action title="Close to start" secondary disabled={selectedArea.vertices.length < 3} onPress={closeOutline} />
        <Action title={`Select Labels${areaRooms.length ? ` (${areaRooms.length})` : ""}`} secondary onPress={() => setRoomModalOpen(true)} />
      </View>
      {selectedRoom ? <Text numberOfLines={1} style={styles.selectedRoomSummary}>Photo label: {selectedRoom.label}</Text> : null}
      <Text style={styles.canvasHelp}>{placingRoom
        ? "Tap inside the selected closed area to place the room label."
        : "Drag measurements, room labels, or the area label throughout the workspace. Tap a wall to edit its measured length."}</Text>
      {selectedWall && selectedWallArea && selectedWallCurrentLength != null ? (
        <View style={styles.wallEditor}>
          <View style={styles.rowBetween}>
            <View>
              <Text style={styles.wallEditorTitle}>{selectedWallArea.label} · wall {selectedWall.segmentIndex + 1}</Text>
              <Text style={styles.wallEditorMeta}>Current length {selectedWallCurrentLength.toFixed(1)} ft</Text>
            </View>
            <Pressable onPress={clearSelectedWall}><Text style={styles.link}>Done</Text></Pressable>
          </View>
          <View style={styles.measureRow}>
            <TextInput
              accessibilityLabel="Selected wall length in feet"
              keyboardType="decimal-pad"
              onChangeText={setSelectedWallLength}
              placeholder="New length ft"
              style={[styles.input, styles.measureInput]}
              value={selectedWallLength}
            />
            <Action title="Update wall" onPress={updateSelectedWallLength} />
          </View>
          <Text style={styles.wallEditorMeta}>Connected corners remain aligned and the closed area recalculates automatically.</Text>
        </View>
      ) : null}
      {closureTargets.some((target) => target.kind === "projected_corner") ? (
        <Text style={styles.closureHelp}>Orange adds the calculated logical corner; green closes directly to the starting point. After choosing orange, tap green to add the final wall and calculate square footage.</Text>
      ) : closureTargets.some((target) => target.kind === "starting_point") ? (
        <Text style={styles.closureHelp}>Tap the green starting dot to connect the final wall and calculate square footage.</Text>
      ) : null}
      <Text style={[styles.status, calculation.ready ? styles.statusReady : styles.statusPending]}>
        {calculation.ready
          ? `${selectedArea.glaTreatment === "deduction" ? "Deducts " : ""}${calculation.reportedAreaSqft?.toLocaleString()} sf · ${calculation.perimeterFeet.toFixed(1)} ft perimeter · closed`
          : calculation.selfIntersecting
            ? "Outline crosses itself — revise the walls"
            : `${calculation.closureGapFeet.toFixed(1)} ft closure gap · area pending`}
      </Text>
      {draft.areas.length > 1 ? <Action title={`Remove selected ${selectedArea.glaTreatment === "deduction" ? "cutout" : "area"}`} danger secondary onPress={removeArea} /> : null}

      <Modal
        animationType="slide"
        onRequestClose={() => setRoomModalOpen(false)}
        presentationStyle="pageSheet"
        visible={roomModalOpen}
      >
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.eyebrow}>SKETCH LABELS</Text>
              <Text style={styles.modalTitle}>{selectedArea.label}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => setRoomModalOpen(false)}><Text style={styles.modalDone}>Done</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionTitle}>Choose a room</Text>
            <Text style={styles.help}>Tap a room type, then tap its location in the sketch.</Text>
            <TextInput maxLength={80} onChangeText={setRoomLabel} placeholder="Optional custom name, e.g. Primary bedroom" style={styles.input} value={roomLabel} />
            <View style={styles.choices}>{SKETCH_ROOM_TYPES.map(([value, label]) => (
              <Choice
                key={value}
                label={label}
                selected={roomType === value}
                onPress={() => {
                  if (beginRoomPlacement(value)) setRoomModalOpen(false);
                }}
              />
            ))}</View>
            <Text style={styles.sectionTitle}>Placed labels</Text>
            {!areaRooms.length ? <Text style={styles.help}>No room labels have been placed in this area yet.</Text> : null}
            <View style={styles.roomList}>{areaRooms.map((room) => (
              <View key={room.id} style={[styles.roomRow, room.id === selectedRoomId && styles.roomRowSelected]}>
                <View style={styles.roomName}>
                  <TextInput
                    accessibilityLabel={`Rename ${room.label}`}
                    maxLength={80}
                    onChangeText={(value) => renameRoom(room, value)}
                    onFocus={() => selectRoom(room)}
                    style={styles.roomLabelInput}
                    value={room.label}
                  />
                  <Text style={styles.roomMeta}>{room.roomType.replaceAll("_", " ")} · automatic photo label</Text>
                </View>
                <View style={styles.roomRowActions}>
                  <Pressable onPress={() => { selectRoom(room); setRoomModalOpen(false); }}><Text style={styles.link}>Select</Text></Pressable>
                  <Pressable onPress={() => removeRoom(room.id)}><Text style={styles.removeLink}>Remove</Text></Pressable>
                </View>
              </View>
            ))}</View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Text style={styles.sectionTitle}>Sketch review notes</Text>
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
      {sketchSync.syncing ? <View style={styles.progress}><ActivityIndicator color={COLORS.violet} /><Text style={styles.help}>Synchronizing measured sketch…</Text></View> : null}
      <Text style={styles.syncLine}>{online ? "Online" : "Offline"} · {sketchSync.draft?.state || (dirty ? "unsaved" : "new draft")} · revision {sketchSync.draft?.baseRevision || 0}</Text>
      {conflict ? <View style={styles.conflictCard}>
        <Text style={styles.roomTitle}>Sketch changed in HomeNode</Text>
        <Text style={styles.help}>Your device draft is preserved. Choose the server version or deliberately replace it with this draft.</Text>
        <Action title="Use HomeNode sketch" secondary onPress={() => void store.withDatabaseActivity(() => store.acceptServerSketch(ownerUserId, sessionId)).then(sketchSync.refresh)} />
        <Action title="Replace with device draft" onPress={() => void store.withDatabaseActivity(() => store.retryLocalSketch(ownerUserId, sessionId)).then(sketchSync.syncNow)} />
      </View> : null}
      {error || sketchSync.draft?.errorCode ? <Text style={styles.error}>{error || sketchError(new Error(sketchSync.draft?.errorCode || ""))}</Text> : null}
      <Text style={styles.disclaimer}>Calculated closure does not replace professional judgment. Above/below-grade status, ceiling-height treatment, access, finish classification, declarations, and any jurisdiction-required standard remain subject to the appraiser’s documented review.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 11, marginTop: 24 },
  eyebrow: { color: COLORS.goldInk, fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: COLORS.deepPurple, fontSize: 25, fontWeight: "800" },
  sectionTitle: { color: COLORS.deepPurple, fontSize: 18, fontWeight: "800", marginTop: 8 },
  areaTotal: { backgroundColor: COLORS.violetSoft, borderColor: COLORS.gold, borderRadius: 18, borderWidth: 1, color: COLORS.violet, fontWeight: "800", paddingHorizontal: 11, paddingVertical: 7 },
  glaBreakdown: { backgroundColor: COLORS.goldSoft, borderRadius: 8, color: COLORS.goldInk, fontSize: 12, fontWeight: "700", padding: 8, textAlign: "center" },
  help: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  label: { color: COLORS.textPurple, fontSize: 13, fontWeight: "700", marginTop: 3 },
  input: { backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong, borderRadius: 9, borderWidth: 1, minHeight: 44, paddingHorizontal: 11, paddingVertical: 9 },
  textArea: { minHeight: 90 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong, borderRadius: 17, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7 },
  choiceSelected: { backgroundColor: COLORS.violet, borderColor: COLORS.violet },
  choiceText: { color: COLORS.textPurple, fontSize: 12, fontWeight: "600" },
  choiceSelectedText: { color: COLORS.white },
  rowBetween: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  measureRow: { flexDirection: "row", gap: 8 },
  measureInput: { flex: 1 },
  sketchWorkspace: { gap: 6 },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  action: { alignItems: "center", backgroundColor: COLORS.violet, borderRadius: 10, justifyContent: "center", minHeight: 45, paddingHorizontal: 14 },
  actionSecondary: { backgroundColor: COLORS.surface, borderColor: COLORS.gold, borderWidth: 1 },
  actionDanger: { borderColor: COLORS.danger },
  actionText: { color: COLORS.white, fontSize: 13, fontWeight: "800", textAlign: "center" },
  actionSecondaryText: { color: COLORS.deepPurple },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.8 },
  canvas: { alignSelf: "center", backgroundColor: COLORS.surfaceMuted, borderColor: COLORS.border, borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  canvasPlacing: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold, borderWidth: 2 },
  canvasPlacingRoom: { backgroundColor: COLORS.violetSoft, borderColor: COLORS.violet, borderWidth: 2 },
  canvasDirectionPanel: { backgroundColor: "rgba(255,255,255,0.92)", borderColor: COLORS.borderStrong, borderRadius: 9, borderWidth: 1, bottom: 8, padding: 5, position: "absolute", right: 8 },
  canvasHelp: { color: COLORS.muted, fontSize: 11, lineHeight: 16, textAlign: "center" },
  canvasEmpty: { color: COLORS.mutedSoft, left: 30, position: "absolute", right: 30, textAlign: "center", top: 115 },
  wallTouch: { backgroundColor: "transparent", height: 22, position: "absolute" },
  wall: { backgroundColor: COLORS.deepPurple, height: 3, position: "absolute" },
  wallSelected: { backgroundColor: COLORS.goldHover, height: 5 },
  wallMuted: { opacity: 0.58 },
  deductionWall: { backgroundColor: "transparent", borderColor: COLORS.goldHover, borderStyle: "dashed", borderTopWidth: 3, height: 0 },
  wallAnchor: { backgroundColor: COLORS.gold, borderColor: COLORS.white, borderRadius: 5, borderWidth: 2, height: 10, position: "absolute", width: 10 },
  placementBanner: { alignSelf: "center", backgroundColor: COLORS.goldSoft, borderRadius: 7, color: COLORS.goldInk, fontSize: 11, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 5, position: "absolute", top: 8 },
  roomPlacementBanner: { alignSelf: "center", backgroundColor: COLORS.violet, borderRadius: 7, color: COLORS.white, fontSize: 11, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 5, position: "absolute", top: 8 },
  areaLabelLeader: { backgroundColor: COLORS.violet, height: 1, opacity: 0.55, position: "absolute" },
  areaLabel: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.92)", borderColor: COLORS.violet, borderRadius: 4, borderWidth: 0.75, justifyContent: "center", maxWidth: 120, paddingHorizontal: 4, paddingVertical: 2, position: "absolute" },
  areaLabelSelected: { borderColor: COLORS.gold, borderWidth: 1.5 },
  areaLabelTitle: { color: COLORS.deepPurple, fontSize: 10, fontWeight: "800", textAlign: "center" },
  areaLabelValue: { color: COLORS.textPurple, fontSize: 9, fontWeight: "700", textAlign: "center" },
  deductionAreaLabel: { backgroundColor: "rgba(250,245,232,0.94)", borderColor: COLORS.gold },
  deductionAreaLabelText: { color: COLORS.goldInk },
  closureGuide: { height: 2, opacity: 0.55, position: "absolute" },
  closureGuideProjected: { backgroundColor: COLORS.gold },
  closureGuideStart: { backgroundColor: COLORS.violet },
  closureDimension: { borderRadius: 4, fontSize: 10, fontWeight: "800", paddingHorizontal: 3, position: "absolute", textAlign: "center", width: 40 },
  closureDimensionProjected: { backgroundColor: COLORS.goldSoft, color: COLORS.goldInk },
  closureDimensionStart: { backgroundColor: COLORS.violetSoft, color: COLORS.violet },
  closureTarget: { alignItems: "center", height: 36, justifyContent: "center", position: "absolute", width: 36 },
  closureDot: { borderColor: "white", borderRadius: 9, borderWidth: 3, height: 18, width: 18 },
  closureDotProjected: { backgroundColor: COLORS.gold },
  closureDotStart: { backgroundColor: COLORS.violet },
  closureHelp: { backgroundColor: COLORS.goldSoft, borderRadius: 8, color: COLORS.goldInk, fontSize: 12, fontWeight: "700", lineHeight: 18, padding: 9 },
  dimensionLeader: { backgroundColor: COLORS.mutedSoft, height: 1, opacity: 0.75, position: "absolute" },
  dimension: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.88)", borderColor: COLORS.borderStrong, borderRadius: 3, borderWidth: 0.75, justifyContent: "center", paddingHorizontal: 2, paddingVertical: 1, position: "absolute" },
  dimensionText: { color: COLORS.textPurple, fontSize: 10, fontWeight: "800" },
  deductionDimension: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold },
  deductionDimensionText: { color: COLORS.goldInk },
  deductionNotice: { backgroundColor: COLORS.goldSoft, borderRadius: 8, color: COLORS.goldInk, fontSize: 12, fontWeight: "700", lineHeight: 18, padding: 9 },
  roomPin: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.88)", borderColor: COLORS.violet, borderRadius: 3, borderWidth: 0.75, justifyContent: "center", maxWidth: 120, paddingHorizontal: 2, paddingVertical: 1, position: "absolute" },
  roomPinSelected: { backgroundColor: COLORS.violet },
  roomPinText: { color: COLORS.violet, fontSize: 9, fontWeight: "800" },
  roomPinTextSelected: { color: COLORS.white },
  selectedRoomSummary: { color: COLORS.muted, fontSize: 11 },
  status: { borderRadius: 8, fontSize: 12, fontWeight: "700", padding: 9 },
  statusReady: { backgroundColor: COLORS.successSoft, color: COLORS.success },
  statusPending: { backgroundColor: COLORS.warningSoft, color: COLORS.warning },
  roomList: { gap: 7 },
  roomRow: { alignItems: "center", backgroundColor: COLORS.surface, borderColor: COLORS.border, borderRadius: 9, borderWidth: 1, flexDirection: "row", gap: 8, padding: 10 },
  roomRowSelected: { borderColor: COLORS.gold, borderWidth: 2 },
  roomName: { flex: 1 },
  roomLabelInput: { color: COLORS.deepPurple, fontSize: 14, fontWeight: "800", minHeight: 28, padding: 0 },
  roomTitle: { color: COLORS.deepPurple, fontSize: 14, fontWeight: "800" },
  roomMeta: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  roomRowActions: { alignItems: "flex-end", gap: 8 },
  modalSafe: { backgroundColor: COLORS.appBackground, flex: 1 },
  modalHeader: { alignItems: "center", borderBottomColor: COLORS.border, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 14 },
  modalTitle: { color: COLORS.deepPurple, fontSize: 22, fontWeight: "800" },
  modalDone: { color: COLORS.violet, fontSize: 16, fontWeight: "800" },
  modalContent: { gap: 11, padding: 18, paddingBottom: 40 },
  wallEditor: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold, borderRadius: 10, borderWidth: 1, gap: 8, padding: 11 },
  wallEditorTitle: { color: COLORS.deepPurple, fontSize: 14, fontWeight: "800" },
  wallEditorMeta: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  removeLink: { color: COLORS.danger, fontSize: 12, fontWeight: "800" },
  link: { color: COLORS.violet, fontSize: 13, fontWeight: "800" },
  progress: { alignItems: "center", flexDirection: "row", gap: 8 },
  syncLine: { color: COLORS.success, fontSize: 12, fontWeight: "700" },
  conflictCard: { backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold, borderRadius: 10, borderWidth: 1, gap: 8, padding: 11 },
  error: { backgroundColor: COLORS.dangerSoft, borderRadius: 8, color: COLORS.danger, padding: 10 },
  disclaimer: { backgroundColor: COLORS.violetSoft, borderRadius: 9, color: COLORS.muted, fontSize: 11, lineHeight: 17, padding: 10 },
});
