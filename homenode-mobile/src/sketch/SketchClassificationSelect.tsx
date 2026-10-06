import React, { useState } from "react";
import { Keyboard, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { COLORS } from "../theme";
import { SKETCH_CLASSIFICATIONS, type SketchClassification } from "./model";

export function SketchClassificationSelect({ value, disabled = false, onChange }: {
  value: SketchClassification;
  disabled?: boolean;
  onChange: (value: SketchClassification) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = SKETCH_CLASSIFICATIONS.find(([classification]) => classification === value)?.[1] || "Select classification";
  return (
    <>
      <Pressable
        accessibilityLabel={`Area classification: ${label}${disabled ? ", garage cutout" : ""}`}
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: open && !disabled }}
        disabled={disabled}
        onPress={() => { if (!disabled) { Keyboard.dismiss(); setOpen(true); } }}
        style={({ pressed }) => [styles.select, disabled && styles.disabled, pressed && styles.pressed]}
      >
        <View style={styles.selectedText}>
          <Text style={styles.label}>Area classification</Text>
          <Text style={styles.value}>{label}</Text>
        </View>
        <Text style={styles.chevron}>{disabled ? "⋯" : "▾"}</Text>
      </Pressable>
      <Modal animationType="fade" onRequestClose={() => setOpen(false)} transparent visible={open && !disabled}>
        <SafeAreaView style={styles.modalScreen}>
          <Pressable accessibilityLabel="Dismiss area classifications" accessibilityRole="button" onPress={() => setOpen(false)} style={styles.backdrop} />
          <View accessibilityViewIsModal style={styles.dialog}>
            <View style={styles.header}>
              <Text style={styles.title}>Area classification</Text>
              <Pressable accessibilityLabel="Close area classifications" accessibilityRole="button" onPress={() => setOpen(false)} style={styles.closeButton}>
                <Text style={styles.closeText}>Done</Text>
              </Pressable>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.options}>
              {SKETCH_CLASSIFICATIONS.map(([classification, optionLabel]) => (
                <Pressable
                  accessibilityLabel={optionLabel}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: classification === value }}
                  key={classification}
                  onPress={() => { onChange(classification); setOpen(false); }}
                  style={({ pressed }) => [styles.option, classification === value && styles.optionSelected, pressed && styles.pressed]}
                >
                  <Text style={[styles.optionText, classification === value && styles.optionSelectedText]}>{optionLabel}</Text>
                  {classification === value ? <Text style={styles.checkmark}>✓</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  select: { alignItems: "center", backgroundColor: COLORS.surface, borderColor: COLORS.borderStrong, borderRadius: 9, borderWidth: 1, flexDirection: "row", minHeight: 54, paddingHorizontal: 11, paddingVertical: 7 },
  selectedText: { flex: 1, gap: 2 },
  label: { color: COLORS.muted, fontSize: 10, fontWeight: "700" },
  value: { color: COLORS.deepPurple, fontSize: 13, fontWeight: "800" },
  chevron: { color: COLORS.violet, fontSize: 22, marginLeft: 8 },
  disabled: { backgroundColor: COLORS.goldSoft },
  pressed: { opacity: 0.8 },
  modalScreen: { alignItems: "center", backgroundColor: "rgba(24,16,40,0.45)", flex: 1, justifyContent: "center", padding: 16 },
  backdrop: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
  dialog: { backgroundColor: COLORS.surface, borderColor: COLORS.gold, borderRadius: 14, borderWidth: 1, maxHeight: "80%", maxWidth: 520, overflow: "hidden", width: "100%" },
  header: { alignItems: "center", borderBottomColor: COLORS.border, borderBottomWidth: 1, flexDirection: "row", gap: 8, justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 8 },
  title: { color: COLORS.deepPurple, flex: 1, fontSize: 17, fontWeight: "800" },
  closeButton: { justifyContent: "center", minHeight: 44, paddingHorizontal: 8 },
  closeText: { color: COLORS.violet, fontSize: 14, fontWeight: "800" },
  options: { padding: 6 },
  option: { alignItems: "center", borderRadius: 8, flexDirection: "row", gap: 8, minHeight: 46, paddingHorizontal: 10, paddingVertical: 10 },
  optionSelected: { backgroundColor: COLORS.violetSoft },
  optionText: { color: COLORS.textPurple, flex: 1, fontSize: 14 },
  optionSelectedText: { color: COLORS.violet, fontWeight: "800" },
  checkmark: { color: COLORS.violet, fontSize: 17, fontWeight: "800" },
});
