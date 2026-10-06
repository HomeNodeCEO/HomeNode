import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { COLORS } from "../theme";
import { normalizeSketchBearing } from "./model";

const DIRECTION_PAD = [
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
] as const;

export function SketchDrawingControls({
  wallLength, bearing, onChangeLength, onChangeBearing, onAdjustBearing, onAddWall,
}: {
  wallLength: string;
  bearing: string;
  onChangeLength: (value: string) => void;
  onChangeBearing: (value: string) => void;
  onAdjustBearing: (change: number) => void;
  onAddWall: () => void;
}) {
  return (
    <View style={styles.controls} accessibilityLabel="Sketch drawing controls">
      <View style={styles.measureRow}>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Length (ft)</Text>
          <TextInput
            accessibilityLabel="New wall length in feet"
            keyboardType="decimal-pad"
            onChangeText={onChangeLength}
            onSubmitEditing={onAddWall}
            placeholder="Length"
            style={styles.input}
            value={wallLength}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Bearing (°)</Text>
          <TextInput
            accessibilityLabel="New wall bearing in degrees"
            keyboardType="decimal-pad"
            onChangeText={onChangeBearing}
            placeholder="Bearing"
            style={styles.input}
            value={bearing}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onAddWall}
          style={({ pressed }) => [styles.addWall, pressed && styles.pressed]}
        >
          <Text style={styles.addWallText}>Add wall</Text>
        </Pressable>
      </View>
      <View style={styles.angleAdjustments}>
        {[5, 1, -1, -5].map((change) => (
          <Pressable
            accessibilityLabel={`Rotate wall bearing ${change > 0 ? "counterclockwise" : "clockwise"} ${Math.abs(change)} degree${Math.abs(change) === 1 ? "" : "s"}`}
            accessibilityRole="button"
            key={change}
            onPress={() => onAdjustBearing(change)}
            style={({ pressed }) => [styles.angleButton, pressed && styles.pressed]}
          >
            <Text style={styles.angleText}>{change > 0 ? "↶" : "↷"} {Math.abs(change)}°</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function SketchDirectionPad({ bearing, onSelectBearing }: {
  bearing: number;
  onSelectBearing: (value: number) => void;
}) {
  const currentBearing = normalizeSketchBearing(bearing);
  return (
    <View style={styles.directionPad} accessibilityLabel="Wall direction">
      <Text style={styles.directionTitle}>Wall direction</Text>
      {DIRECTION_PAD.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.directionRow}>
          {row.map((direction, columnIndex) => direction ? (
            <Pressable
              accessibilityLabel={direction.label}
              accessibilityRole="button"
              accessibilityState={{ selected: currentBearing === direction.bearing }}
              key={direction.bearing}
              onPress={(event) => { event.stopPropagation(); onSelectBearing(direction.bearing); }}
              style={({ pressed }) => [
                styles.directionButton,
                currentBearing === direction.bearing && styles.directionSelected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.directionSymbol, currentBearing === direction.bearing && styles.directionSymbolSelected]}>{direction.symbol}</Text>
            </Pressable>
          ) : (
            <View key={`center-${columnIndex}`} style={styles.bearingCenter}>
              <Text style={styles.bearingValue}>{currentBearing}°</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  controls: { gap: 6 },
  measureRow: { alignItems: "flex-end", flexDirection: "row", gap: 6 },
  field: { flex: 1, gap: 3, minWidth: 0 },
  fieldLabel: { color: COLORS.textPurple, fontSize: 11, fontWeight: "700" },
  input: { backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong, borderRadius: 8, borderWidth: 1, color: COLORS.deepPurple, fontSize: 16, minHeight: 44, paddingHorizontal: 8, paddingVertical: 8 },
  addWall: { alignItems: "center", backgroundColor: COLORS.violet, borderRadius: 8, justifyContent: "center", minHeight: 44, paddingHorizontal: 10, width: 90 },
  addWallText: { color: COLORS.white, fontSize: 14, fontWeight: "800" },
  angleAdjustments: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  angleButton: { alignItems: "center", backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong, borderRadius: 6, borderWidth: 1, flexGrow: 1, minHeight: 28, paddingHorizontal: 5, paddingVertical: 5 },
  angleText: { color: COLORS.textPurple, fontSize: 11, fontWeight: "700" },
  directionPad: { gap: 2 },
  directionTitle: { color: COLORS.deepPurple, fontSize: 8, fontWeight: "800", marginBottom: 1, textAlign: "center" },
  directionRow: { flexDirection: "row", gap: 2 },
  directionButton: { alignItems: "center", backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong, borderRadius: 6, borderWidth: 1, height: 29, justifyContent: "center", width: 29 },
  directionSelected: { backgroundColor: COLORS.violet, borderColor: COLORS.violet },
  directionSymbol: { color: COLORS.deepPurple, fontSize: 17, fontWeight: "800" },
  directionSymbolSelected: { color: COLORS.white },
  bearingCenter: { alignItems: "center", backgroundColor: COLORS.goldSoft, borderColor: COLORS.gold, borderRadius: 6, borderWidth: 1, height: 29, justifyContent: "center", width: 29 },
  bearingValue: { color: COLORS.goldInk, fontSize: 8, fontWeight: "800" },
  pressed: { opacity: 0.8 },
});
