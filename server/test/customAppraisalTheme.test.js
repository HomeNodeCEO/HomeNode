import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.resolve(directory, relative), "utf8");

test("Custom Appraisal sections share the HomeNode purple and gold selected-state language", () => {
  const css = read("../../dcad-frontend/src/index.css");
  const controls = read("../../dcad-frontend/src/components/PropertyReportControls.tsx");

  assert.match(css, /\.hn-custom-section\s*\{/);
  assert.match(css, /\.hn-custom-section-header-active\s*\{/);
  assert.match(css, /linear-gradient\(100deg, var\(--hn-gold-soft\), var\(--hn-violet-soft\) 72%\)/);
  assert.match(css, /\.hn-custom-selection\s*\{/);
  assert.match(controls, /hn-custom-section-active/);
  assert.match(controls, /hn-custom-section-header-active/);
  assert.match(controls, /data-section-expanded=/);
});

test("the Custom Appraisal shell, evidence panels, and prior files use the shared theme", () => {
  const report = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const photos = read("../../dcad-frontend/src/components/AssignmentPhotoCenter.tsx");
  const documents = read("../../dcad-frontend/src/components/AssignmentDocumentCenter.tsx");
  const history = read("../../dcad-frontend/src/components/PreviousAppraisalFiles.tsx");

  assert.match(report, /Custom Appraisal Workspace/);
  assert.match(report, /hn-custom-report/);
  assert.match(report, /hn-custom-report-toolbar/);
  assert.match(report, /hn-custom-approach-link/);
  assert.match(report, /customTheme/);

  for (const evidencePanel of [photos, documents]) {
    assert.match(evidencePanel, /hn-custom-section-active/);
    assert.match(evidencePanel, /hn-custom-section-header-active/);
    assert.match(evidencePanel, /data-section-expanded=/);
  }

  assert.match(history, /hn-custom-history/);
  assert.match(history, /hn-custom-section-header/);
});

test("the Custom Appraisal editor and print output retain legible themed surfaces", () => {
  const editor = read("../../dcad-frontend/src/components/ReportSectionEditor.tsx");
  const css = read("../../dcad-frontend/src/index.css");

  assert.match(editor, /hn-app-header/);
  assert.match(editor, /text-white/);
  assert.match(editor, /text-violet-100/);
  assert.match(editor, /hn-action-primary/);
  assert.match(css, /@media print[\s\S]*\.hn-custom-report/);
  assert.match(css, /@media print[\s\S]*\.hn-custom-section-header-active/);
});
