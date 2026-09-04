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
  assert.match(css, /linear-gradient\(118deg, var\(--hn-deep-purple\), #44305e\)/);
  assert.match(css, /\.hn-custom-section-title \{ color: var\(--hn-champagne\) !important; \}/);
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

test("the document center supports compact bulk review and a full-page viewer", () => {
  const documents = read("../../dcad-frontend/src/components/AssignmentDocumentCenter.tsx");

  assert.match(documents, /Approve All \(\$\{suggestedCandidates\.length\}\)/);
  assert.match(documents, /confirmAllAssignmentDocumentCandidates/);
  assert.match(documents, /'Review complete'/);
  assert.match(documents, /h-\[80vh\]/);
  assert.match(documents, /xl:grid-cols-\[16rem_minmax\(0,1fr\)\]/);
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

test("dark headers and actions keep champagne text without overriding session status colors", () => {
  const css = read("../../dcad-frontend/src/index.css");
  const report = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const photos = read("../../dcad-frontend/src/components/AssignmentPhotoCenter.tsx");
  const documents = read("../../dcad-frontend/src/components/AssignmentDocumentCenter.tsx");
  const history = read("../../dcad-frontend/src/components/PreviousAppraisalFiles.tsx");
  const uadEditor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");

  assert.match(css, /\.hn-app-header:not\(aside\) :where\([^)]*strong[^)]*\) \{ color: inherit !important; \}/);
  assert.match(css, /\.hn-action-primary:hover:not\(:disabled\)[\s\S]*color: #fffdf6 !important;/);
  assert.match(css, /\.hn-action-primary :where\([^)]*span[^)]*\) \{ color: inherit !important; \}/);
  assert.match(css, /\.hn-custom-file-status[\s\S]*color: var\(--hn-champagne\) !important;/);
  assert.match(report, /hn-custom-file-status/);
  assert.match(uadEditor, /hn-app-header[\s\S]*editor\.workfile\.file_number/);

  for (const source of [report, photos, documents, history]) {
    assert.doesNotMatch(source, /className="btn btn-primary/);
  }
});

test("Custom Appraisal headers remain still while reduced-motion and print rules protect readability", () => {
  const css = read("../../dcad-frontend/src/index.css");

  assert.doesNotMatch(css, /hn-custom-gradient-flow/);
  assert.match(css, /\.hn-custom-section-header:hover[\s\S]*border-left-color: var\(--hn-gold\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  assert.match(css, /@media print[\s\S]*animation: none !important/);
  assert.match(css, /@media print[\s\S]*\.hn-custom-section-header \.hn-custom-verified\s*\{\s*color: #000 !important;/);
});
