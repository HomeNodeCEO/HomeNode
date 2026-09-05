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
  assert.match(css, /background: var\(--hn-section-fill\)/);
  assert.match(css, /\.hn-custom-section-title \{ color: var\(--hn-deep-purple\) !important; \}/);
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

test("loaded subject photos stay inside fixed frames without changing full-size viewing", () => {
  const report = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const photos = read("../../dcad-frontend/src/components/AssignmentPhotoCenter.tsx");
  const css = read("../../dcad-frontend/src/index.css");
  assert.match(report, /<figure className="hn-subject-photo-hero relative h-64 bg-slate-100 sm:h-72"/);
  assert.match(report, /className="hn-subject-photo-image h-full w-full select-none object-cover"/);
  assert.match(photos, /className="hn-assignment-photo-preview h-36 w-full object-cover"/);
  assert.match(css, /\.hn-subject-photo-hero \{ overflow: hidden; \}/);
  assert.match(css, /\.hn-subject-photo-image\s*\{[^}]*height: 100%;[^}]*object-fit: cover;/);
  assert.match(css, /\.hn-assignment-photo-preview\s*\{[^}]*height: 9rem;[^}]*object-fit: cover;/);
  // Keep responsive media and full-size evidence viewing unchanged elsewhere.
  assert.match(css, /img, video, canvas, iframe \{ max-width: 100%; height: auto; \}/);
  assert.match(report, /className="max-h-full max-w-full select-none object-contain"/);
  assert.match(report, /onClick=\{\(\) => setPhotoModalOpen\(true\)\}/);
});

test("saved document choices, refresh, and document types use explicit readable themed states", () => {
  const documents = read("../../dcad-frontend/src/components/AssignmentDocumentCenter.tsx");
  const css = read("../../dcad-frontend/src/index.css");

  assert.match(documents, /className="hn-document-type select/);
  assert.match(documents, /hn-action-secondary btn btn-xs[^\n]+loadDocuments\(\)[^\n]+disabled=\{loading\}>Refresh/);
  assert.match(documents, /onClick=\{\(\) => void loadDocument\(document.id\)\} aria-pressed=\{selectedDocument\?\.id === document.id\}/);
  assert.match(css, /\.hn-document-choice\s*\{\s*display: block;\s*text-align: left;/);
  assert.match(css, /\.hn-document-choice:hover\s*\{[^}]*color: var\(--hn-deep-purple\)/);
  assert.match(css, /\.hn-document-choice\[aria-pressed="true"\]\s*\{[^}]*color: var\(--hn-champagne\)/);
  assert.match(css, /\.hn-document-type option \{ background: var\(--hn-surface\); color: var\(--hn-deep-purple\); \}/);
  assert.match(css, /\.hn-document-choice:focus-visible,[\s\S]*outline-offset: 3px/);
  // Processing status retains its own semantic badge colors, independent of selection.
  assert.match(documents, /statusStyle\(document.processing_status\)/);
});

test("reviewer borders rotate in gold and purple without white or silver stops", () => {
  const css = read("../../dcad-frontend/src/index.css");
  const documents = read("../../dcad-frontend/src/components/AssignmentDocumentCenter.tsx");
  for (const name of ["frame", "input-ring"]) {
    const rule = css.match(new RegExp(`^\\.hn-evidence-reviewer-${name}::before\\s*\\{([^}]+)\\}`, "m"))?.[1];
    assert.ok(rule, `Missing reviewer ${name} border`);
    assert.match(rule, /conic-gradient/);
    assert.match(rule, /var\(--hn-gold\)/);
    assert.match(rule, /var\(--hn-deep-purple\)/);
    assert.match(rule, /animation: hn-evidence-reviewer-orbit 4.8s linear infinite/);
    assert.match(rule, /pointer-events: none/);
    assert.doesNotMatch(rule, /#fff(?:fff|9df)?\b|#94a3b8|#f8fafc/i);
  }
  assert.match(css, /\.hn-document-reviewer \.hn-evidence-reviewer-input\s*\{[^}]*color: var\(--hn-champagne\) !important/);
  assert.doesNotMatch(css, /\.hn-evidence-reviewer-frame\s*\{[^}]*background: linear-gradient\(120deg, var\(--hn-deep-purple\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.hn-evidence-reviewer-input-ring::before\s*\{\s*animation: none;\s*\}/);
  assert.match(documents, /!window.matchMedia\('\(prefers-reduced-motion: reduce\)'\).matches/);
  assert.match(documents, /htmlFor=\{reviewerInputId\}/);
  assert.match(documents, /id=\{reviewerInputId\}/);
  assert.match(documents, /aria-pressed=\{reviewerAnimationEnabled\}/);
  assert.match(css, /\.hn-document-reviewer\[data-reviewer-animation="on"\][^{]*\{\s*animation: hn-evidence-reviewer-orbit/);
  assert.match(css, /\.hn-document-reviewer\[data-reviewer-animation="off"\][^{]*\{\s*animation: none/);
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

test("dark mastheads retain champagne while gold actions use dark ink without overriding session colors", () => {
  const css = read("../../dcad-frontend/src/index.css");
  const report = read("../../dcad-frontend/src/pages/PropertyReport.tsx");
  const photos = read("../../dcad-frontend/src/components/AssignmentPhotoCenter.tsx");
  const documents = read("../../dcad-frontend/src/components/AssignmentDocumentCenter.tsx");
  const history = read("../../dcad-frontend/src/components/PreviousAppraisalFiles.tsx");
  const uadEditor = read("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx");

  assert.match(css, /\.hn-app-header:not\(aside\) :where\([^)]*strong[^)]*\) \{ color: inherit !important; \}/);
  assert.match(css, /\.hn-action-primary:hover:not\(:disabled\)[\s\S]*color: var\(--hn-midnight\) !important;/);
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
