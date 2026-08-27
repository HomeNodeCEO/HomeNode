import { deflateSync } from "node:zlib";

const COLORS = Object.freeze({
  background: [241, 245, 249, 255],
  card: [255, 255, 255, 255],
  border: [203, 213, 225, 255],
  ink: [15, 23, 42, 255],
  muted: [71, 85, 105, 255],
  fill: [209, 250, 229, 255],
  stroke: [4, 120, 87, 255],
  room: [29, 78, 216, 255],
});

const FONT = Object.freeze({
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  "-": ["00000","00000","00000","11111","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  "/": ["00001","00010","00100","01000","10000","00000","00000"],
  ":": ["00000","01100","01100","00000","01100","01100","00000"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11110","00001","00001","01110","00001","00001","11110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","10000","11110","00001","00001","11110"],
  "6": ["01110","10000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00001","01110"],
  A: ["01110","10001","10001","11111","10001","10001","10001"],
  B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01111","10000","10000","10000","10000","10000","01111"],
  D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01111","10000","10000","10111","10001","10001","01111"],
  H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["01110","00100","00100","00100","00100","00100","01110"],
  J: ["00001","00001","00001","00001","10001","10001","01110"],
  K: ["10001","10010","10100","11000","10100","10010","10001"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"],
  N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"],
  P: ["11110","10001","10001","11110","10000","10000","10000"],
  Q: ["01110","10001","10001","10001","10101","10010","01101"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"],
  V: ["10001","10001","10001","10001","10001","01010","00100"],
  W: ["10001","10001","10001","10101","10101","10101","01010"],
  X: ["10001","10001","01010","00100","01010","10001","10001"],
  Y: ["10001","10001","01010","00100","00100","00100","00100"],
  Z: ["11111","00001","00010","00100","01000","10000","11111"],
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function createSurface(width, height, background = COLORS.background) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = background[0];
    pixels[offset + 1] = background[1];
    pixels[offset + 2] = background[2];
    pixels[offset + 3] = background[3];
  }
  return { width, height, pixels };
}

function pixel(surface, xValue, yValue, color) {
  const x = Math.round(xValue);
  const y = Math.round(yValue);
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
  const offset = ((y * surface.width) + x) * 4;
  surface.pixels[offset] = color[0];
  surface.pixels[offset + 1] = color[1];
  surface.pixels[offset + 2] = color[2];
  surface.pixels[offset + 3] = color[3];
}

function rectangle(surface, x, y, width, height, color) {
  for (let row = Math.max(0, Math.round(y)); row < Math.min(surface.height, Math.round(y + height)); row += 1) {
    for (let column = Math.max(0, Math.round(x)); column < Math.min(surface.width, Math.round(x + width)); column += 1) {
      pixel(surface, column, row, color);
    }
  }
}

function line(surface, x0Value, y0Value, x1Value, y1Value, color, thickness = 1) {
  let x0 = Math.round(x0Value);
  let y0 = Math.round(y0Value);
  const x1 = Math.round(x1Value);
  const y1 = Math.round(y1Value);
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    rectangle(surface, x0 - Math.floor(thickness / 2), y0 - Math.floor(thickness / 2), thickness, thickness, color);
    if (x0 === x1 && y0 === y1) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x0 += sx; }
    if (twice <= dx) { error += dx; y0 += sy; }
  }
}

function polygon(surface, points, fill, stroke) {
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const maxY = Math.min(surface.height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));
  for (let y = minY; y <= maxY; y += 1) {
    const intersections = [];
    for (let index = 0; index < points.length; index += 1) {
      const left = points[index];
      const right = points[(index + 1) % points.length];
      if ((left.y <= y && right.y > y) || (right.y <= y && left.y > y)) {
        intersections.push(left.x + ((y - left.y) * (right.x - left.x)) / (right.y - left.y));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      rectangle(surface, Math.ceil(intersections[index]), y, Math.floor(intersections[index + 1]) - Math.ceil(intersections[index]) + 1, 1, fill);
    }
  }
  for (let index = 0; index < points.length; index += 1) {
    const left = points[index];
    const right = points[(index + 1) % points.length];
    line(surface, left.x, left.y, right.x, right.y, stroke, 4);
  }
}

function safeText(value, maximum = 42) {
  return String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9 .:/-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum).toUpperCase();
}

function text(surface, value, x, y, { color = COLORS.ink, scale = 2, maximum = 42 } = {}) {
  let cursor = Math.round(x);
  for (const character of safeText(value, maximum)) {
    const glyph = FONT[character] || FONT[" "];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((bit, columnIndex) => {
        if (bit === "1") rectangle(surface, cursor + (columnIndex * scale), y + (rowIndex * scale), scale, scale, color);
      });
    });
    cursor += 6 * scale;
  }
}

function boundsFor(area) {
  if (area.calculation?.bounds) return area.calculation.bounds;
  const xs = area.vertices.map((vertex) => Number(vertex.x));
  const ys = area.vertices.map((vertex) => Number(vertex.y));
  return { min_x: Math.min(...xs), min_y: Math.min(...ys), max_x: Math.max(...xs), max_y: Math.max(...ys) };
}

function transformFor(area, frame) {
  const bounds = boundsFor(area);
  const width = Math.max(1, Number(bounds.max_x) - Number(bounds.min_x));
  const height = Math.max(1, Number(bounds.max_y) - Number(bounds.min_y));
  const scale = Math.min(frame.width / width, frame.height / height);
  const left = frame.x + ((frame.width - (width * scale)) / 2);
  const top = frame.y + ((frame.height - (height * scale)) / 2);
  return (point) => ({
    x: left + ((Number(point.x) - Number(bounds.min_x)) * scale),
    y: top + ((Number(bounds.max_y) - Number(point.y)) * scale),
  });
}

function renderArea(surface, area, rooms, frame, index, metadata) {
  rectangle(surface, frame.x, frame.y, frame.width, frame.height, COLORS.card);
  line(surface, frame.x, frame.y, frame.x + frame.width, frame.y, COLORS.border, 2);
  line(surface, frame.x, frame.y + frame.height, frame.x + frame.width, frame.y + frame.height, COLORS.border, 2);
  text(surface, `${metadata.fileNumber} - MEASURED SKETCH`, frame.x + 22, frame.y + 18, { scale: 3, maximum: 34 });
  text(surface, metadata.propertyLabel, frame.x + 22, frame.y + 48, { color: COLORS.muted, scale: 2, maximum: 48 });
  text(surface, `AREA ${index + 1}: ${area.label}`, frame.x + frame.width - 250, frame.y + 20, { scale: 2, maximum: 24 });

  const sideWidth = 190;
  const plotFrame = { x: frame.x + 30, y: frame.y + 88, width: frame.width - sideWidth - 70, height: frame.height - 130 };
  const transform = transformFor(area, plotFrame);
  const vertices = area.vertices.slice(0, -1).map(transform);
  polygon(surface, vertices, COLORS.fill, COLORS.stroke);

  const segments = area.calculation?.segments || area.vertices.slice(0, -1).map((from, segmentIndex) => ({
    from,
    to: area.vertices[segmentIndex + 1],
    length_feet: Math.hypot(area.vertices[segmentIndex + 1].x - from.x, area.vertices[segmentIndex + 1].y - from.y),
  }));
  for (const segment of segments) {
    const from = transform(segment.from);
    const to = transform(segment.to);
    text(surface, `${Number(segment.length_feet).toFixed(1)} FT`, ((from.x + to.x) / 2) - 28, ((from.y + to.y) / 2) - 8, { scale: 1, maximum: 10 });
  }
  for (const room of rooms) {
    const anchor = transform(room.anchor);
    line(surface, anchor.x - 5, anchor.y, anchor.x + 5, anchor.y, COLORS.room, 2);
    line(surface, anchor.x, anchor.y - 5, anchor.x, anchor.y + 5, COLORS.room, 2);
    text(surface, room.label, anchor.x + 8, anchor.y - 5, { color: COLORS.room, scale: 1, maximum: 22 });
  }

  const sideX = frame.x + frame.width - sideWidth + 12;
  rectangle(surface, sideX - 10, frame.y + 88, sideWidth - 20, 220, COLORS.background);
  text(surface, area.level_label, sideX, frame.y + 108, { scale: 2, maximum: 20 });
  text(surface, String(area.classification || "AREA").replaceAll("_", " "), sideX, frame.y + 138, { color: COLORS.muted, scale: 1, maximum: 25 });
  text(surface, `${Number(area.calculation?.reported_area_sqft || 0).toLocaleString("en-US")} SQ FT`, sideX, frame.y + 178, { color: COLORS.stroke, scale: 2, maximum: 18 });
  text(surface, `${Number(area.calculation?.perimeter_feet || 0).toFixed(1)} FT PERIMETER`, sideX, frame.y + 214, { color: COLORS.muted, scale: 1, maximum: 22 });
  text(surface, `${rooms.length} ROOM LABELS`, sideX, frame.y + 238, { color: COLORS.muted, scale: 1, maximum: 20 });
  text(surface, metadata.measurementStandard, sideX, frame.y + 272, { color: COLORS.muted, scale: 1, maximum: 24 });
  text(surface, `REVISION ${metadata.revision}`, sideX, frame.y + 294, { color: COLORS.muted, scale: 1, maximum: 18 });
}

function encodePng(surface) {
  const rowBytes = (surface.width * 4) + 1;
  const raw = Buffer.alloc(rowBytes * surface.height);
  for (let row = 0; row < surface.height; row += 1) {
    const output = row * rowBytes;
    raw[output] = 0;
    surface.pixels.copy(raw, output + 1, row * surface.width * 4, (row + 1) * surface.width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(surface.width, 0);
  header.writeUInt32BE(surface.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND"),
  ]);
}

export function renderSketchPng(sketch, options = {}) {
  const document = sketch?.document || sketch;
  if (!document || !Array.isArray(document.areas) || document.areas.length < 1 || !Array.isArray(document.rooms)) {
    throw new Error("invalid_sketch_artifact_document");
  }
  const columns = document.areas.length === 1 ? 1 : 2;
  const tileWidth = columns === 1 ? 1340 : 665;
  const tileHeight = 610;
  const rows = Math.ceil(document.areas.length / columns);
  const surface = createSurface(1400, Math.max(660, 30 + (rows * (tileHeight + 20))));
  const metadata = {
    fileNumber: safeText(options.fileNumber || sketch?.file_number || "UNASSIGNED", 30),
    propertyLabel: safeText(options.propertyLabel || sketch?.property_label || "PROPERTY ADDRESS UNAVAILABLE", 48),
    revision: Number(options.revision ?? sketch?.revision ?? 1),
    measurementStandard: document.measurement_standard === "ansi_z765_2021" ? "ANSI Z765-2021" : "OTHER STANDARD",
  };
  document.areas.forEach((area, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    renderArea(
      surface,
      area,
      document.rooms.filter((room) => room.area_id === area.id),
      { x: 20 + (column * (tileWidth + 20)), y: 20 + (row * (tileHeight + 20)), width: tileWidth, height: tileHeight },
      index,
      metadata,
    );
  });
  return encodePng(surface);
}
