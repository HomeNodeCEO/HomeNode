import PDFDocument from "pdfkit";

const PAGE = Object.freeze({ width: 792, height: 612 });
const STYLES = Object.freeze({
  above_grade_finished: { fill: "#d1fae5", stroke: "#047857" },
  above_grade_nonstandard_finished: { fill: "#fef3c7", stroke: "#b45309" },
  above_grade_noncontinuous_finished: { fill: "#fef3c7", stroke: "#b45309" },
  above_grade_unfinished: { fill: "#e5e7eb", stroke: "#475569" },
  below_grade_finished: { fill: "#dbeafe", stroke: "#1d4ed8" },
  below_grade_nonstandard_finished: { fill: "#e0e7ff", stroke: "#4338ca" },
  below_grade_unfinished: { fill: "#e5e7eb", stroke: "#475569" },
  garage: { fill: "#f1f5f9", stroke: "#475569" },
  porch: { fill: "#ffedd5", stroke: "#c2410c" },
  patio: { fill: "#ffedd5", stroke: "#c2410c" },
  deck: { fill: "#ffedd5", stroke: "#c2410c" },
  outbuilding: { fill: "#ede9fe", stroke: "#6d28d9" },
  other: { fill: "#f8fafc", stroke: "#334155" },
});

function sketchDocument(sketch) {
  const document = sketch?.document || sketch;
  if (!document || !Array.isArray(document.areas) || !Array.isArray(document.rooms)) {
    throw new Error("invalid_sketch_artifact_document");
  }
  return document;
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function ascii(value) {
  return String(value || "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return ascii(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function styleFor(classification) {
  return STYLES[classification] || STYLES.other;
}

function areaBounds(area) {
  if (area.calculation?.bounds) return area.calculation.bounds;
  const xs = area.vertices.map((vertex) => Number(vertex.x));
  const ys = area.vertices.map((vertex) => Number(vertex.y));
  return {
    min_x: Math.min(...xs),
    min_y: Math.min(...ys),
    max_x: Math.max(...xs),
    max_y: Math.max(...ys),
  };
}

function plotTransform(area, frame) {
  const bounds = areaBounds(area);
  const widthFeet = Math.max(1, Number(bounds.max_x) - Number(bounds.min_x));
  const heightFeet = Math.max(1, Number(bounds.max_y) - Number(bounds.min_y));
  const scale = Math.min(frame.width / widthFeet, frame.height / heightFeet);
  const left = frame.x + ((frame.width - (widthFeet * scale)) / 2);
  const top = frame.y + ((frame.height - (heightFeet * scale)) / 2);
  return {
    point(vertex) {
      return {
        x: left + ((Number(vertex.x) - Number(bounds.min_x)) * scale),
        y: top + ((Number(bounds.max_y) - Number(vertex.y)) * scale),
      };
    },
  };
}

function areaSegments(area) {
  if (Array.isArray(area.calculation?.segments)) return area.calculation.segments;
  return area.vertices.slice(0, -1).map((from, index) => {
    const to = area.vertices[index + 1];
    return {
      from,
      to,
      length_feet: Math.round(Math.hypot(to.x - from.x, to.y - from.y) * 10) / 10,
    };
  });
}

function metadataFor(sketch, options) {
  return {
    fileNumber: ascii(options.fileNumber || sketch?.file_number || "Unassigned"),
    propertyLabel: ascii(options.propertyLabel || sketch?.property_label || "Property address unavailable"),
    revision: Number(options.revision ?? sketch?.revision ?? 1),
    updatedAt: options.updatedAt || sketch?.updated_at || null,
  };
}

function svgArea(area, rooms, index, metadata) {
  const pageY = index * 700;
  const transform = plotTransform(area, { x: 45, y: pageY + 105, width: 750, height: 500 });
  const polygon = area.vertices
    .map((vertex) => transform.point(vertex))
    .map((point) => point.x.toFixed(2) + "," + point.y.toFixed(2))
    .join(" ");
  const style = styleFor(area.classification);
  const dimensions = areaSegments(area).map((segment) => {
    const from = transform.point(segment.from);
    const to = transform.point(segment.to);
    const x = (from.x + to.x) / 2;
    const y = (from.y + to.y) / 2;
    return [
      "<g>",
      '<rect x="' + (x - 20).toFixed(2) + '" y="' + (y - 9).toFixed(2) + '" width="40" height="18" rx="4" fill="#ffffff" fill-opacity="0.9"/>',
      '<text x="' + x.toFixed(2) + '" y="' + (y + 4).toFixed(2) + '" text-anchor="middle" class="dimension">' + xml(Number(segment.length_feet).toFixed(1)) + " ft</text>",
      "</g>",
    ].join("");
  }).join("");
  const roomLabels = rooms.map((room) => {
    const anchor = transform.point(room.anchor);
    return [
      "<g>",
      '<circle cx="' + anchor.x.toFixed(2) + '" cy="' + anchor.y.toFixed(2) + '" r="3" fill="#0f172a"/>',
      '<text x="' + anchor.x.toFixed(2) + '" y="' + (anchor.y - 8).toFixed(2) + '" text-anchor="middle" class="room">' + xml(room.label) + "</text>",
      "</g>",
    ].join("");
  }).join("");
  const squareFeet = area.calculation?.reported_area_sqft;
  return [
    '<g data-area-id="' + xml(area.id) + '">',
    '<rect x="20" y="' + (pageY + 20) + '" width="1060" height="660" rx="12" fill="#ffffff" stroke="#cbd5e1"/>',
    '<text x="45" y="' + (pageY + 54) + '" class="title">' + xml(metadata.fileNumber) + " - Measured Sketch</text>",
    '<text x="45" y="' + (pageY + 78) + '" class="subtitle">' + xml(metadata.propertyLabel) + "</text>",
    '<text x="825" y="' + (pageY + 54) + '" class="meta">Revision ' + metadata.revision + "</text>",
    '<text x="825" y="' + (pageY + 76) + '" class="meta">Page ' + (index + 1) + "</text>",
    '<rect x="830" y="' + (pageY + 112) + '" width="225" height="220" rx="8" fill="#f8fafc" stroke="#e2e8f0"/>',
    '<text x="848" y="' + (pageY + 142) + '" class="area-title">' + xml(area.label) + "</text>",
    '<text x="848" y="' + (pageY + 167) + '" class="sidebar">' + xml(area.level_label) + "</text>",
    '<text x="848" y="' + (pageY + 192) + '" class="sidebar">' + xml(titleCase(area.classification)) + "</text>",
    '<text x="848" y="' + (pageY + 232) + '" class="area-value">' + (squareFeet == null ? "Pending" : xml(Number(squareFeet).toLocaleString("en-US")) + " sf") + "</text>",
    '<text x="848" y="' + (pageY + 261) + '" class="sidebar">' + xml(Number(area.calculation?.perimeter_feet || 0).toFixed(1)) + " ft perimeter</text>",
    '<text x="848" y="' + (pageY + 286) + '" class="sidebar">' + rooms.length + " room label" + (rooms.length === 1 ? "" : "s") + "</text>",
    '<polygon points="' + polygon + '" fill="' + style.fill + '" stroke="' + style.stroke + '" stroke-width="3" stroke-linejoin="round"/>',
    dimensions,
    roomLabels,
    '<text x="45" y="' + (pageY + 646) + '" class="footer">Dimensions shown to 0.1 ft. Area classification and ANSI declaration require appraiser review.</text>',
    "</g>",
  ].join("\n");
}

export function renderSketchSvg(sketch, options = {}) {
  const document = sketchDocument(sketch);
  const metadata = metadataFor(sketch, options);
  const height = Math.max(700, document.areas.length * 700);
  const pages = document.areas.map((area, index) => svgArea(
    area,
    document.rooms.filter((room) => room.area_id === area.id),
    index,
    metadata,
  )).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 ' + height + '" role="img" aria-label="Measured property sketch">',
    "<style>",
    "text { font-family: Arial, Helvetica, sans-serif; fill: #0f172a; }",
    ".title { font-size: 24px; font-weight: 700; }",
    ".subtitle, .meta, .sidebar { font-size: 13px; fill: #475569; }",
    ".area-title { font-size: 19px; font-weight: 700; }",
    ".area-value { font-size: 25px; font-weight: 700; fill: #047857; }",
    ".dimension { font-size: 11px; font-weight: 700; }",
    ".room { font-size: 12px; font-weight: 700; paint-order: stroke; stroke: #ffffff; stroke-width: 3px; }",
    ".footer { font-size: 11px; fill: #64748b; }",
    "</style>",
    '<rect width="1100" height="' + height + '" fill="#f1f5f9"/>',
    pages,
    "</svg>",
  ].join("\n");
}

function drawPdfArea(doc, area, rooms, index, count, metadata, document) {
  const transform = plotTransform(area, { x: 38, y: 100, width: 535, height: 430 });
  const points = area.vertices.map((vertex) => transform.point(vertex));
  const style = styleFor(area.classification);

  doc.font("Helvetica-Bold").fontSize(17).fillColor("#0f172a")
    .text(metadata.fileNumber + " - Measured Sketch", 36, 28, { width: 520 });
  doc.font("Helvetica").fontSize(9).fillColor("#475569")
    .text(metadata.propertyLabel, 36, 52, { width: 520 });
  doc.fontSize(8).text("Revision " + metadata.revision, 620, 30, { width: 135, align: "right" });
  doc.text("Page " + (index + 1) + " of " + count, 620, 44, { width: 135, align: "right" });
  doc.moveTo(36, 72).lineTo(PAGE.width - 36, 72).strokeColor("#cbd5e1").lineWidth(1).stroke();

  doc.save().moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) doc.lineTo(point.x, point.y);
  doc.fillAndStroke(style.fill, style.stroke).restore();

  for (const segment of areaSegments(area)) {
    const from = transform.point(segment.from);
    const to = transform.point(segment.to);
    const x = (from.x + to.x) / 2;
    const y = (from.y + to.y) / 2;
    doc.roundedRect(x - 17, y - 6, 34, 12, 3).fill("#ffffff");
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#0f172a")
      .text(Number(segment.length_feet).toFixed(1) + " ft", x - 18, y - 2.6, { width: 36, align: "center", lineBreak: false });
  }

  for (const room of rooms) {
    const anchor = transform.point(room.anchor);
    doc.circle(anchor.x, anchor.y, 2).fill("#0f172a");
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#0f172a")
      .text(ascii(room.label), anchor.x - 45, anchor.y - 13, { width: 90, align: "center", lineBreak: false });
  }

  doc.roundedRect(590, 102, 166, 250, 7).fillAndStroke("#f8fafc", "#e2e8f0");
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
    .text(ascii(area.label), 606, 121, { width: 134 });
  doc.font("Helvetica").fontSize(8.5).fillColor("#475569")
    .text(ascii(area.level_label), 606, 145, { width: 134 })
    .text(titleCase(area.classification), 606, 160, { width: 134 });
  const squareFeet = area.calculation?.reported_area_sqft;
  doc.font("Helvetica-Bold").fontSize(21).fillColor("#047857")
    .text(squareFeet == null ? "Pending" : Number(squareFeet).toLocaleString("en-US") + " sf", 606, 198, { width: 134 });
  doc.font("Helvetica").fontSize(8.5).fillColor("#475569")
    .text(Number(area.calculation?.perimeter_feet || 0).toFixed(1) + " ft perimeter", 606, 231, { width: 134 })
    .text(rooms.length + " room label" + (rooms.length === 1 ? "" : "s"), 606, 247, { width: 134 })
    .text(titleCase(document.measurement_method), 606, 278, { width: 134 })
    .text(document.measurement_standard === "ansi_z765_2021" ? "ANSI Z765-2021" : ascii(document.alternate_standard_name || "Alternate standard"), 606, 294, { width: 134 });

  doc.font("Helvetica").fontSize(7.5).fillColor("#64748b")
    .text("Dimensions shown to 0.1 ft. Geometric closure does not replace the appraiser's area classification and ANSI declaration review.", 36, PAGE.height - 52, { width: PAGE.width - 72, align: "center" });
}

export async function renderSketchPdf(sketch, options = {}) {
  const document = sketchDocument(sketch);
  const metadata = metadataFor(sketch, options);
  const parsedTimestamp = metadata.updatedAt ? new Date(metadata.updatedAt) : new Date("2000-01-01T00:00:00.000Z");
  const timestamp = Number.isNaN(parsedTimestamp.getTime()) ? new Date("2000-01-01T00:00:00.000Z") : parsedTimestamp;
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: true,
    info: {
      Title: metadata.fileNumber + " Measured Sketch",
      Author: "HomeNode",
      Subject: "Manual measured sketch exhibit",
      CreationDate: timestamp,
      ModDate: timestamp,
    },
  });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  document.areas.forEach((area, index) => {
    doc.addPage({ size: "LETTER", layout: "landscape", margin: 0 });
    drawPdfArea(
      doc,
      area,
      document.rooms.filter((room) => room.area_id === area.id),
      index,
      document.areas.length,
      metadata,
      document,
    );
  });
  doc.end();
  return complete;
}

export const SKETCH_CLASSIFICATION_STYLES = STYLES;
