import { sketchCalculationBreakdown } from "./sketchCalculations.js";

const PALETTE = ["#ede9fe", "#fef3c7", "#dcfce7", "#e0e7ff", "#ffe4e6"];
const WIDTH = 540;
const BOTTOM = 730;

function text(value) { return String(value ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim(); }
function sqft(value) { return value == null ? "Pending" : Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function header(doc, metadata, title, continued = false) {
  doc.addPage({ size: "LETTER", layout: "portrait", margin: 0 });
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#6d28d9").text("SKETCH AREA CALCULATIONS", 36, 28, { width: 390 });
  doc.font("Helvetica").fontSize(8).fillColor("#475569").text(`Revision ${metadata.revision}`, 452, 30, { width: 124, align: "right" });
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#2e1065").text(text(title) + (continued ? " (continued)" : ""), 36, 48, { width: WIDTH });
  const y = Math.max(77, doc.y + 5);
  doc.font("Helvetica").fontSize(8).fillColor("#475569").text(text(metadata.fileNumber) + " - " + text(metadata.propertyLabel), 36, y, { width: WIDTH });
  return doc.y + 12;
}

function diagram(doc, area, y) {
  const points = area.sections.flatMap(section => section.vertices);
  const minX = Math.min(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxX = Math.max(...points.map(point => point.x));
  const maxY = Math.max(...points.map(point => point.y));
  const scale = Math.min(500 / Math.max(1, maxX - minX), 170 / Math.max(1, maxY - minY));
  const plot = point => ({ x: 52 + ((point.x - minX) * scale), y: y + 8 + ((maxY - point.y) * scale) });
  area.sections.forEach((section, index) => {
    const vertices = section.vertices.map(plot);
    doc.save().moveTo(vertices[0].x, vertices[0].y);
    for (const point of vertices.slice(1)) doc.lineTo(point.x, point.y);
    doc.closePath().lineWidth(0.7).fillAndStroke(PALETTE[index % PALETTE.length], "#6d28d9").restore();
    const centerX = vertices.reduce((sum, point) => sum + point.x, 0) / vertices.length;
    const centerY = vertices.reduce((sum, point) => sum + point.y, 0) / vertices.length;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#2e1065").text(section.label, centerX - 12, centerY - 4, { width: 24, align: "center", lineBreak: false });
  });
  return y + 192;
}

function tableHeader(doc, y, labels = ["Section", "Calculation (feet)", "Sq ft"]) {
  doc.rect(36, y, WIDTH, 23).fill("#ede9fe");
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#2e1065");
  doc.text(labels[0], 44, y + 8, { width: 107, lineBreak: false });
  doc.text(labels[1], 158, y + 8, { width: 313, lineBreak: false });
  doc.text(labels[2], 478, y + 8, { width: 90, align: "right", lineBreak: false });
  return y + 23;
}

function rowHeight(doc, label, formula) {
  doc.font("Helvetica").fontSize(8);
  return Math.max(24, doc.heightOfString(text(label), { width: 107 }) + 12, doc.heightOfString(text(formula), { width: 313 }) + 12);
}

function row(doc, y, label, formula, value, { total = false } = {}) {
  const height = rowHeight(doc, label, formula);
  doc.rect(36, y, WIDTH, height).fill(total ? "#fef3c7" : "#f8fafc");
  doc.font(total ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor("#2e1065");
  doc.text(text(label), 44, y + 6, { width: 107 });
  doc.text(text(formula), 158, y + 6, { width: 313 });
  doc.text(String(value), 478, y + 6, { width: 90, align: "right" });
  doc.moveTo(36, y + height).lineTo(576, y + height).lineWidth(0.4).strokeColor("#e2e8f0").stroke();
  return y + height;
}

export function appendSketchCalculationPages(doc, document, metadata) {
  const breakdown = sketchCalculationBreakdown(document);
  for (const area of breakdown.areas) {
    let y = header(doc, metadata, area.label);
    const paragraph = (value, { bold = false } = {}) => {
      const content = text(value);
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
      const height = doc.heightOfString(content, { width: WIDTH });
      if (y + height + 8 > BOTTOM) y = header(doc, metadata, area.label, true);
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor("#475569").text(content, 36, y, { width: WIDTH });
      y = doc.y + 8;
    };
    paragraph(`${area.level_label} - ${area.classification.replaceAll("_", " ")} - ${area.gla_treatment === "deduction" ? "GLA deduction" : area.gla_treatment === "excluded" ? "Separate from GLA" : "Included in GLA"}`);
    if (area.status !== "ready") {
      paragraph(area.reason);
      paragraph(`Calculated area: ${sqft(area.calculated_area_sqft)} sq ft. Reported outline: ${area.reported_area_sqft ?? "Pending"} sq ft.`);
      continue;
    }
    y = diagram(doc, area, y);
    y = tableHeader(doc, y);
    for (const section of area.sections) {
      if (y + rowHeight(doc, `${section.label} ${section.shape}`, section.formula) > BOTTOM) {
        y = tableHeader(doc, header(doc, metadata, area.label, true));
      }
      y = row(doc, y, `${section.label} ${section.shape}`, section.formula, sqft(section.calculated_area_sqft));
    }
    if (y + 50 > BOTTOM) y = tableHeader(doc, header(doc, metadata, area.label, true));
    y = row(doc, y, "Calculated area", "Sum of sections (full precision)", sqft(area.calculated_area_sqft), { total: true });
    y += 12;
    paragraph(`Reported outline: ${area.reported_area_sqft.toLocaleString("en-US")} sq ft${area.gla_treatment === "deduction" ? " (deducted from parent GLA)" : ""}.`);
    if (area.displayed_row_rounding_difference_sqft) paragraph(`Displayed row rounding difference: ${sqft(area.displayed_row_rounding_difference_sqft)} sq ft. The total uses full precision.`);
    if (area.angled_walls.length) {
      paragraph("ANGLED-WALL WORKING DIMENSIONS", { bold: true });
      for (const wall of area.angled_walls) paragraph(`Wall ${wall.wall_index}: ${wall.formula}`);
      paragraph("Horizontal offset = measured length x cos(bearing); vertical offset = measured length x sin(bearing). Offsets are derived from the saved vertices.");
    }
    paragraph(breakdown.precision_note);
  }

  let y = header(doc, metadata, "Area summary");
  y = tableHeader(doc, y, ["Area", "Treatment / calculated area", "Reported sq ft"]);
  for (const area of breakdown.areas) {
    const formula = `${area.gla_treatment === "deduction" ? "Deduction" : area.gla_treatment === "excluded" ? "Excluded from GLA" : "Included in GLA"} - ${sqft(area.calculated_area_sqft)} sq ft calculated`;
    if (y + rowHeight(doc, area.label, formula) > BOTTOM) y = tableHeader(doc, header(doc, metadata, "Area summary", true), ["Area", "Treatment / calculated area", "Reported sq ft"]);
    y = row(doc, y, area.label, formula, area.reported_area_sqft == null ? "Pending" : area.reported_area_sqft.toLocaleString("en-US"));
  }
  const summaryRows = [
    ["Gross included", "Sum of included outlines", breakdown.summary.gross_included_sqft],
    ["Deductions", "Subtract garage cutouts only once", breakdown.summary.deduction_sqft],
    ["Net reported GLA", `${breakdown.summary.gross_included_sqft} - ${breakdown.summary.deduction_sqft}`, breakdown.summary.net_gla_sqft],
    ...breakdown.summary.levels.map(level => [level.level_label, `${level.gross_included_sqft} gross - ${level.deduction_sqft} deductions = net GLA`, level.net_gla_sqft]),
  ];
  for (const [label, formula, value] of summaryRows) {
    if (y + rowHeight(doc, label, formula) > BOTTOM) y = tableHeader(doc, header(doc, metadata, "Area summary", true), ["Area", "Treatment", "Reported sq ft"]);
    y = row(doc, y, label, formula, value.toLocaleString("en-US"), { total: label === "Net reported GLA" });
  }
  const note = `Calculated net included area: ${sqft(breakdown.summary.net_calculated_sqft)} sq ft. ${breakdown.summary.all_breakdowns_ready ? "" : "Incomplete or unavailable areas are identified above; review all outlines. "}${breakdown.precision_note}`;
  doc.font("Helvetica").fontSize(8);
  if (y + doc.heightOfString(note, { width: WIDTH }) + 24 > BOTTOM) y = header(doc, metadata, "Area summary", true);
  doc.fillColor("#475569").text(note, 36, y + 16, { width: WIDTH });
  return breakdown;
}
