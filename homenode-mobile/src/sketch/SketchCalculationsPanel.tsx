import React, { useMemo, useState } from "react";
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { COLORS } from "../theme";
import type { CalculationArea, CalculationPoint } from "./calculationBreakdown.js";
import { sketchCalculationBreakdown } from "./calculations";
import type { ManualSketchDraft } from "./model";

function squareFeet(value: number | null) {
  return value == null ? "Pending" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SectionDiagram({ area }: { area: CalculationArea }) {
  const [width, setWidth] = useState(280);
  const points = area.sections.flatMap(section => section.vertices);
  if (!points.length) return null;
  const minX = Math.min(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxX = Math.max(...points.map(point => point.x));
  const maxY = Math.max(...points.map(point => point.y));
  const scale = Math.min((width - 36) / Math.max(1, maxX - minX), 160 / Math.max(1, maxY - minY));
  const plot = (point: CalculationPoint) => ({ x: 18 + ((point.x - minX) * scale), y: 18 + ((maxY - point.y) * scale) });
  return (
    <View accessibilityLabel={`${area.label} calculation sections`} onLayout={event => setWidth(Math.max(100, event.nativeEvent.layout.width))} style={styles.diagram}>
      {area.sections.map(section => {
        const vertices = section.vertices.map(plot);
        const center = { x: vertices.reduce((sum, point) => sum + point.x, 0) / vertices.length, y: vertices.reduce((sum, point) => sum + point.y, 0) / vertices.length };
        return <React.Fragment key={section.label}>
          {section.shape === "rectangle" ? <View style={{ position: "absolute", left: vertices[0]!.x, top: vertices[2]!.y, width: vertices[1]!.x - vertices[0]!.x, height: vertices[0]!.y - vertices[2]!.y, backgroundColor: COLORS.violetSoft }} /> : null}
          {vertices.map((from, index) => {
            const to = vertices[(index + 1) % vertices.length]!;
            const length = Math.hypot(to.x - from.x, to.y - from.y);
            const angle = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
            return <View key={index} style={{ backgroundColor: COLORS.violet, height: 1, left: (from.x + to.x) / 2 - length / 2, position: "absolute", top: (from.y + to.y) / 2, transform: [{ rotate: `${angle}deg` }], width: length }} />;
          })}
          <Text style={[styles.sectionMarker, { left: center.x - 13, top: center.y - 8 }]}>{section.label}</Text>
        </React.Fragment>;
      })}
    </View>
  );
}

export function SketchCalculationsPanel({ draft }: { draft: ManualSketchDraft }) {
  const [open, setOpen] = useState(false);
  const breakdown = useMemo(() => sketchCalculationBreakdown(draft), [draft]);
  return <>
    <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={styles.button}>
      <Text style={styles.buttonText}>Calculation breakdown</Text>
    </Pressable>
    <Modal animationType="slide" onRequestClose={() => setOpen(false)} presentationStyle="pageSheet" visible={open}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Sketch calculations</Text>
          <Pressable accessibilityLabel="Close sketch calculations" accessibilityRole="button" onPress={() => setOpen(false)} style={styles.done}><Text style={styles.buttonText}>Done</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.help}>Saved with the sketch through its existing offline queue. The desktop file and PDF exhibit receive the matching calculation breakdown when the sketch synchronizes.</Text>
          {breakdown.areas.map(area => <View key={area.area_id} style={styles.area}>
            <Text style={styles.areaTitle}>{area.label}</Text>
            <Text style={styles.help}>{area.level_label} · {area.classification.replaceAll("_", " ")} · {area.gla_treatment === "deduction" ? "GLA deduction" : area.gla_treatment === "excluded" ? "Separate from GLA" : "Included in GLA"}</Text>
            {area.status === "ready" ? <>
              <SectionDiagram area={area} />
              <View style={styles.tableHeader}><Text style={styles.rowLabel}>Section / calculation (feet)</Text><Text style={styles.resultLabel}>Sq ft</Text></View>
              {area.sections.map(section => <View key={section.label} style={styles.row}>
                <View style={styles.formula}><Text style={styles.sectionTitle}>{section.label} · {section.shape}</Text><Text style={styles.formulaText}>{section.formula}</Text></View>
                <Text style={styles.result}>{squareFeet(section.calculated_area_sqft)}</Text>
              </View>)}
              <View style={styles.total}><Text style={styles.rowLabel}>Calculated area (sum of sections)</Text><Text style={styles.result}>{squareFeet(area.calculated_area_sqft)}</Text></View>
              <Text style={styles.help}>Reported outline: {area.reported_area_sqft?.toLocaleString()} sq ft{area.gla_treatment === "deduction" ? " (deducted from parent GLA)" : ""}.</Text>
              {area.displayed_row_rounding_difference_sqft ? <Text style={styles.help}>Displayed rows differ by {squareFeet(area.displayed_row_rounding_difference_sqft)} sq ft due to rounding. The total uses full precision.</Text> : null}
              {area.angled_walls.length ? <View style={styles.working}><Text style={styles.sectionTitle}>Angled-wall working dimensions</Text>{area.angled_walls.map(wall => <Text key={wall.wall_index} style={styles.help}>Wall {wall.wall_index}: {wall.formula}</Text>)}</View> : null}
            </> : <Text style={styles.help}>{area.reason}</Text>}
          </View>)}
          <View style={styles.area}>
            <Text style={styles.areaTitle}>Area summary</Text>
            {breakdown.summary.levels.map(level => <Text key={level.level_label} style={styles.help}>{level.level_label}: {level.gross_included_sqft.toLocaleString()} gross - {level.deduction_sqft.toLocaleString()} deductions = {level.net_gla_sqft.toLocaleString()} sq ft GLA</Text>)}
            <Text style={styles.sectionTitle}>{breakdown.summary.gross_included_sqft.toLocaleString()} gross - {breakdown.summary.deduction_sqft.toLocaleString()} deductions = {breakdown.summary.net_gla_sqft.toLocaleString()} sq ft reported GLA</Text>
            <Text style={styles.help}>Calculated net included area: {squareFeet(breakdown.summary.net_calculated_sqft)} sq ft.</Text>
            {breakdown.areas.filter(area => area.gla_treatment !== "included").map(area => <Text key={area.area_id} style={styles.help}>{area.label}: {squareFeet(area.calculated_area_sqft)} sq ft · {area.gla_treatment === "deduction" ? "deduction" : "excluded from GLA"}</Text>)}
            {!breakdown.summary.all_breakdowns_ready ? <Text style={styles.help}>Incomplete or unavailable areas are identified above. Review all outlines before relying on the totals.</Text> : null}
          </View>
          <Text style={styles.help}>{breakdown.precision_note}</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  button: { alignItems: "center", borderColor: COLORS.borderStrong, borderRadius: 8, borderWidth: 1, minHeight: 44, justifyContent: "center", padding: 8 },
  buttonText: { color: COLORS.violet, fontSize: 14, fontWeight: "800" },
  screen: { backgroundColor: COLORS.surface, flex: 1 },
  header: { alignItems: "center", borderBottomColor: COLORS.border, borderBottomWidth: 1, flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  title: { color: COLORS.deepPurple, flex: 1, fontSize: 20, fontWeight: "800" },
  done: { justifyContent: "center", minHeight: 44, paddingHorizontal: 8 },
  content: { gap: 14, padding: 16 },
  area: { borderColor: COLORS.border, borderRadius: 10, borderWidth: 1, gap: 8, padding: 12 },
  areaTitle: { color: COLORS.deepPurple, fontSize: 17, fontWeight: "800" },
  help: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  diagram: { height: 196, overflow: "hidden" },
  sectionMarker: { color: COLORS.deepPurple, fontSize: 11, fontWeight: "800", position: "absolute", textAlign: "center", width: 26 },
  tableHeader: { backgroundColor: COLORS.goldSoft, flexDirection: "row", gap: 8, padding: 6 },
  row: { borderBottomColor: COLORS.border, borderBottomWidth: 1, flexDirection: "row", gap: 8, paddingVertical: 7 },
  formula: { flex: 1 },
  sectionTitle: { color: COLORS.deepPurple, fontSize: 12, fontWeight: "800" },
  formulaText: { color: COLORS.textPurple, fontSize: 12, marginTop: 3 },
  rowLabel: { color: COLORS.deepPurple, flex: 1, fontSize: 12, fontWeight: "800" },
  resultLabel: { color: COLORS.deepPurple, fontSize: 12, fontWeight: "800", textAlign: "right", width: 76 },
  result: { color: COLORS.deepPurple, fontSize: 12, fontWeight: "800", textAlign: "right", width: 76 },
  total: { backgroundColor: COLORS.violetSoft, flexDirection: "row", gap: 8, padding: 6 },
  working: { gap: 4, marginTop: 6 },
});
