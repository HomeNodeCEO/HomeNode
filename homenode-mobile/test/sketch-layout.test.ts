import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import ts from "typescript";

import { normalizeSketchBearing, SKETCH_CLASSIFICATIONS } from "../src/sketch/model";
import { COLORS } from "../src/theme";

type Element = React.ReactElement<Record<string, unknown>>;
type Component = (props: Record<string, unknown>) => React.ReactNode;

// Exercise the actual JSX and event callbacks with native primitives replaced
// by host elements. This is a component contract test, not an iOS simulator.
function componentHarness(file: string) {
  const state = { open: false, keyboardDismissals: 0 };
  const native = {
    Modal: "Modal", Pressable: "Pressable", SafeAreaView: "SafeAreaView", ScrollView: "ScrollView",
    Text: "Text", TextInput: "TextInput", View: "View",
    Keyboard: { dismiss: () => { state.keyboardDismissals++; } },
    StyleSheet: { create: (styles: unknown) => styles },
  };
  const react = { ...React, useState: () => [state.open, (next: boolean) => { state.open = next; }] };
  const source = readFileSync(new URL(`../src/sketch/${file}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, Component> };
  runInNewContext(compiled, {
    exports: module.exports,
    require: (id: string) => {
      if (id === "react") return react;
      if (id === "react-native") return native;
      if (id === "../theme") return { COLORS };
      if (id === "./model") return { normalizeSketchBearing, SKETCH_CLASSIFICATIONS };
      throw new Error(`Unexpected component dependency: ${id}`);
    },
  }, { timeout: 1000 });
  return { state, render: (props: Record<string, unknown>, component = file) => elements(module.exports[component]!(props)) };
}

function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  if (element.type === "Modal" && !element.props.visible) return [element];
  return [element, ...elements(element.props.children as React.ReactNode)];
}

function press(element: Element) {
  assert.equal(typeof element.props.onPress, "function");
  let stopped = false;
  (element.props.onPress as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => { stopped = true; } });
  return stopped;
}

function byLabel(nodes: Element[], label: string) {
  const node = nodes.find(element => element.props.accessibilityLabel === label);
  assert.ok(node, `Missing accessible control: ${label}`);
  return node;
}

function controls(props: Record<string, unknown> = {}) {
  return componentHarness("SketchDrawingControls").render({
    wallLength: "25", bearing: "0", onChangeLength: () => {}, onChangeBearing: () => {},
    onAdjustBearing: () => {}, onAddWall: () => {}, ...props,
  });
}

function directions(props: Record<string, unknown> = {}) {
  return componentHarness("SketchDrawingControls").render({ bearing: 0, onSelectBearing: () => {}, ...props }, "SketchDirectionPad");
}

test("dimension fields and Add wall share one compact horizontal row", () => {
  const nodes = controls();
  const toolbar = byLabel(nodes, "Sketch drawing controls");
  const style = toolbar.props.style as { gap: number };
  assert.ok(style.gap <= 6);
  assert.equal(React.Children.count(toolbar.props.children as React.ReactNode), 2);
  const row = React.Children.toArray(toolbar.props.children as React.ReactNode)[0] as Element;
  assert.equal((row.props.style as { flexDirection: string }).flexDirection, "row");
  assert.equal(React.Children.count(row.props.children as React.ReactNode), 3);
  assert.equal(byLabel(nodes, "New wall length in feet").type, "TextInput");
  assert.equal(byLabel(nodes, "New wall bearing in degrees").type, "TextInput");
  assert.ok(!nodes.some(node => node.props.accessibilityLabel === "Wall direction"));
});

test("each direction preserves its existing bearing and does not add a wall", () => {
  const selections: number[] = [];
  let additions = 0;
  const nodes = directions({ onSelectBearing: (value: number) => selections.push(value), onAddWall: () => { additions++; } });
  for (const [label, bearing] of [
    ["East, 0 degrees", 0], ["Northeast, 45 degrees", 45], ["North, 90 degrees", 90],
    ["Northwest, 135 degrees", 135], ["West, 180 degrees", 180], ["Southwest, 225 degrees", 225],
    ["South, 270 degrees", 270], ["Southeast, 315 degrees", 315],
  ] as const) {
    const arrow = byLabel(nodes, label);
    const style = (arrow.props.style as (state: { pressed: boolean }) => unknown[])({ pressed: false })[0] as { height: number; width: number };
    assert.equal(style.width, 29, "Keep the existing compact in-canvas arrow size");
    assert.equal(style.height, 29);
    assert.equal(press(arrow), true, "Arrow presses must not propagate to room or garage placement");
    assert.equal(selections.at(-1), bearing);
  }
  assert.equal(selections.length, 8);
  assert.equal(additions, 0);
});

test("the selected arrow follows normalized bearings while exact angles remain editable", () => {
  const normalized = directions({ bearing: 450 });
  assert.equal((byLabel(normalized, "North, 90 degrees").props.accessibilityState as { selected: boolean }).selected, true);
  const precise = directions({ bearing: 92.5 });
  const arrows = precise.filter(node => node.props.accessibilityState && node.props.accessibilityRole === "button");
  assert.ok(arrows.every(node => !(node.props.accessibilityState as { selected: boolean }).selected));
  assert.equal(byLabel(controls({ bearing: "92.5" }), "New wall bearing in degrees").props.value, "92.5");
  assert.ok(precise.some(node => node.type === "Text" && React.Children.toArray(node.props.children as React.ReactNode).join("") === "92.5°"));
});

test("length, exact bearing and Add wall still invoke their existing callbacks", () => {
  let length = "";
  let bearing = "";
  let additions = 0;
  const nodes = controls({
    onChangeLength: (value: string) => { length = value; },
    onChangeBearing: (value: string) => { bearing = value; },
    onAddWall: () => { additions++; },
  });
  (byLabel(nodes, "New wall length in feet").props.onChangeText as (value: string) => void)("20.5");
  (byLabel(nodes, "New wall bearing in degrees").props.onChangeText as (value: string) => void)("36.2");
  assert.equal(length, "20.5");
  assert.equal(bearing, "36.2");
  assert.equal(additions, 0);
  const addWall = nodes.find(node => node.type === "Pressable" && elements(node.props.children as React.ReactNode).some(child => child.props.children === "Add wall"))!;
  press(addWall);
  assert.equal(additions, 1);
});

test("fine-angle controls retain both one- and five-degree adjustments", () => {
  const changes: number[] = [];
  const nodes = controls({ onAdjustBearing: (change: number) => changes.push(change) });
  for (const label of [
    "Rotate wall bearing counterclockwise 5 degrees", "Rotate wall bearing counterclockwise 1 degree",
    "Rotate wall bearing clockwise 1 degree", "Rotate wall bearing clockwise 5 degrees",
  ]) press(byLabel(nodes, label));
  assert.deepEqual(changes, [5, 1, -1, -5]);
});

test("classification starts as one closed dropdown, not an inline strip of options", () => {
  const harness = componentHarness("SketchClassificationSelect");
  const nodes = harness.render({ value: "above_grade_finished", onChange: () => {} });
  const selectState = byLabel(nodes, "Area classification: Above-grade finished").props.accessibilityState as { disabled: boolean; expanded: boolean };
  assert.equal(selectState.disabled, false);
  assert.equal(selectState.expanded, false);
  assert.equal(nodes.filter(node => node.props.accessibilityRole === "radio").length, 0);
  assert.equal(nodes.find(node => node.type === "Modal")!.props.visible, false);
});

test("dropdown lists every existing classification and closes after selection", () => {
  const harness = componentHarness("SketchClassificationSelect");
  let selected = "";
  const props = { value: "above_grade_finished", onChange: (value: string) => { selected = value; } };
  press(byLabel(harness.render(props), "Area classification: Above-grade finished"));
  assert.equal(harness.state.keyboardDismissals, 1);
  const opened = harness.render(props);
  const options = opened.filter(node => node.props.accessibilityRole === "radio");
  assert.deepEqual(options.map(node => node.props.accessibilityLabel), SKETCH_CLASSIFICATIONS.map(([, label]) => label));
  assert.equal(options.filter(node => (node.props.accessibilityState as { checked: boolean }).checked).length, 1);
  press(byLabel(opened, "Below-grade finished"));
  assert.equal(selected, "below_grade_finished");
  assert.equal(harness.state.open, false);
});

test("garage cutouts remain fixed deductions and cannot open classification choices", () => {
  const harness = componentHarness("SketchClassificationSelect");
  let changes = 0;
  const props = { value: "garage", disabled: true, onChange: () => { changes++; } };
  const nodes = harness.render(props);
  const select = byLabel(nodes, "Area classification: Garage, garage cutout");
  assert.equal(select.props.disabled, true);
  press(select);
  assert.equal(harness.state.open, false);
  assert.equal(changes, 0);
  assert.equal(harness.state.keyboardDismissals, 0);
  assert.equal(nodes.filter(node => node.props.accessibilityRole === "radio").length, 0);
});

test("Done, backdrop and Android back dismiss classifications without changing the draft", () => {
  for (const dismiss of ["Close area classifications", "Dismiss area classifications", "back"]) {
    const harness = componentHarness("SketchClassificationSelect");
    let changes = 0;
    const props = { value: "porch", onChange: () => { changes++; } };
    press(byLabel(harness.render(props), "Area classification: Porch"));
    const opened = harness.render(props);
    if (dismiss === "back") (opened.find(node => node.type === "Modal")!.props.onRequestClose as () => void)();
    else press(byLabel(opened, dismiss));
    assert.equal(harness.state.open, false);
    assert.equal(changes, 0);
  }
});

test("an unknown cached classification does not crash or silently change the sketch", () => {
  const harness = componentHarness("SketchClassificationSelect");
  let changes = 0;
  const nodes = harness.render({ value: "future_classification", onChange: () => { changes++; } });
  assert.ok(byLabel(nodes, "Area classification: Select classification"));
  assert.equal(changes, 0);
});

test("dropdown sits above the canvas and dimensions immediately below, with arrows still inside", () => {
  const source = readFileSync(new URL("../src/sketch/SketchEditorPanel.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("SketchEditorPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let workspace: ts.JsxElement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "style"
      && attribute.initializer?.getText(ast) === "{styles.sketchWorkspace}")) workspace = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(workspace);
  const children = workspace.children.filter(ts.isJsxSelfClosingElement);
  assert.deepEqual(children.map(node => node.tagName.getText(ast)), ["SketchClassificationSelect", "SketchCanvas", "SketchDrawingControls"]);
  assert.match(children[0]!.getText(ast), /disabled=\{selectedArea\.glaTreatment === "deduction"\}/);
  assert.match(children[0]!.getText(ast), /onChange=\{setAreaClassification\}/);
  assert.match(children[1]!.getText(ast), /onLabelDragActiveChange=\{handleLabelDragActiveChange\}/);
  assert.match(children[1]!.getText(ast), /onMoveDimension=\{moveDimension\}/);
  assert.match(children[1]!.getText(ast), /onMoveAreaLabel=\{moveAreaLabel\}/);
  assert.match(children[1]!.getText(ast), /onConnectTarget=\{connectTarget\}/);
  assert.match(children[1]!.getText(ast), /onSetBearing=\{setNormalizedBearing\}/);
  assert.match(source, /<View style=\{styles\.canvasDirectionPanel\}>\s*<SketchDirectionPad bearing=\{bearing\} onSelectBearing=\{onSetBearing\}/);
  assert.match(source, /canvasDirectionPanel: \{[^\n]*bottom: 8,[^\n]*position: "absolute", right: 8/);
  assert.doesNotMatch(source, /SKETCH_CLASSIFICATIONS\.map/);
  assert.match(source, /sketchWorkspace: \{ gap: 6 \}/);
});

test("inspection scrolling still pauses for label dragging and accepts taps while typing", () => {
  const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(source, /keyboardShouldPersistTaps="handled"\s+scrollEnabled=\{!sketchLabelDragging\}/);
});
