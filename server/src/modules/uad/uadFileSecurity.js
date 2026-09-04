import { createHash } from "node:crypto";
import { getDocumentProxy } from "unpdf";

export const MAX_UAD_VERIFIED_ASSET_BYTES = 50 * 1024 * 1024;
export const MAX_UAD_JSON_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_UAD_IMAGE_DIMENSION = 20_000;
export const MAX_UAD_IMAGE_PIXELS = 100_000_000;
export const MAX_UAD_PDF_PAGES = 200;
export const MAX_UAD_PDF_ANNOTATIONS = 10_000;
const ACTIVE_PDF_ANNOTATION_SUBTYPES = new Set([
  "FileAttachment",
  "RichMedia",
  "Screen",
  "Movie",
  "Sound",
  "3D",
]);

function invalid(reason = "payload") {
  throw new Error(`invalid_uad_asset_${reason}`);
}

function hasPrefix(body, bytes) {
  return body.length >= bytes.length && bytes.every((byte, index) => body[index] === byte);
}

function pngDimensions(body) {
  if (!hasPrefix(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || body.length < 24
    || body.subarray(12, 16).toString("ascii") !== "IHDR") invalid("content_type_mismatch");
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

function jpegDimensions(body) {
  if (!hasPrefix(body, [0xff, 0xd8, 0xff])) invalid("content_type_mismatch");
  let offset = 2;
  while (offset + 3 < body.length) {
    if (body[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = body[offset + 1];
    while (marker === 0xff && offset + 2 < body.length) marker = body[++offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > body.length) break;
    const length = body.readUInt16BE(offset);
    if (length < 2 || offset + length > body.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) break;
      return { height: body.readUInt16BE(offset + 3), width: body.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  invalid("image_dimensions");
}

function validateDimensions(dimensions) {
  if (!dimensions) return null;
  const width = Number(dimensions.width);
  const height = Number(dimensions.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > MAX_UAD_IMAGE_DIMENSION || height > MAX_UAD_IMAGE_DIMENSION
    || width * height > MAX_UAD_IMAGE_PIXELS) invalid("image_dimensions");
  return Object.freeze({ width, height, pixels: width * height });
}

function validateIsoBaseMedia(body, expectedType) {
  if (body.length < 16 || body.subarray(4, 8).toString("ascii") !== "ftyp") invalid("content_type_mismatch");
  const brand = body.subarray(8, 12).toString("ascii").toLowerCase();
  const brands = {
    "image/avif": new Set(["avif", "avis"]),
    "image/heic": new Set(["heic", "heix", "hevc", "hevx", "mif1"]),
    "image/heif": new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]),
  };
  if (!brands[expectedType]?.has(brand)) invalid("content_type_mismatch");
}

function validatePdf(body) {
  if (!body.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) invalid("content_type_mismatch");
  const source = body.toString("latin1").replace(
    /\/[^\s<>{}\[\]()%/]+/g,
    (name) => name.replace(/#([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
  );
  if (/\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia|Encrypt|XFA)\b/i.test(source)) {
    invalid("pdf_active_content");
  }
}

function hasEntries(value) {
  if (!value) return false;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function annotationHasActiveContent(annotation) {
  if (!annotation || typeof annotation !== "object") return false;
  if (annotation.unsafeUrl || annotation.action || annotation.attachment || annotation.richMedia) return true;
  if (hasEntries(annotation.actions)) return true;
  return ACTIVE_PDF_ANNOTATION_SUBTYPES.has(String(annotation.subtype || ""));
}

export async function inspectUadPdfSafety(bodyValue) {
  const body = Buffer.isBuffer(bodyValue) ? bodyValue : Buffer.from(bodyValue || "");
  if (!body.length || body.length > MAX_UAD_VERIFIED_ASSET_BYTES) invalid("byte_size");
  validatePdf(body);

  let pdf = null;
  try {
    pdf = await getDocumentProxy(new Uint8Array(body), {
      disableAutoFetch: true,
      disableFontFace: true,
      disableStream: true,
      isEvalSupported: false,
      stopAtErrors: true,
      useSystemFonts: false,
    });
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_UAD_PDF_PAGES) {
      invalid("pdf_page_count");
    }

    const xfa = pdf.isPureXfa ? await pdf.getXfa() : null;
    const [hasJavaScript, javaScriptActions, openAction, attachments] = await Promise.all([
      pdf.hasJSActions(),
      pdf.getJSActions(),
      pdf.getOpenAction(),
      pdf.getAttachments(),
    ]);
    if (hasJavaScript || hasEntries(javaScriptActions) || openAction || hasEntries(attachments) || xfa) {
      invalid("pdf_active_content");
    }

    let annotationCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const [annotations, pageJavaScript] = await Promise.all([
          page.getAnnotations({ intent: "display" }),
          page.getJSActions(),
        ]);
        if (hasEntries(pageJavaScript)) invalid("pdf_active_content");
        annotationCount += Array.isArray(annotations) ? annotations.length : 0;
        if (annotationCount > MAX_UAD_PDF_ANNOTATIONS) invalid("pdf_annotation_count");
        if (annotations?.some(annotationHasActiveContent)) invalid("pdf_active_content");
      } finally {
        page.cleanup?.();
      }
    }
  } catch (error) {
    if (String(error?.message || "").startsWith("invalid_uad_asset_")) throw error;
    invalid("pdf_structure");
  } finally {
    await pdf?.destroy?.().catch(() => undefined);
  }
}

function validateJson(body) {
  if (body.length > MAX_UAD_JSON_ASSET_BYTES) invalid("json_bytes");
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    invalid("json");
  }
  const queue = [{ value: parsed, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const { value, depth } = queue.pop();
    nodes += 1;
    if (nodes > 100_000 || depth > 64) invalid("json_complexity");
    if (value && typeof value === "object") {
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

export function inspectUadAssetPayload(bodyValue, contentTypeValue) {
  const body = Buffer.isBuffer(bodyValue) ? bodyValue : Buffer.from(bodyValue || "");
  const contentType = String(contentTypeValue || "").split(";", 1)[0].trim().toLowerCase();
  if (!body.length || body.length > MAX_UAD_VERIFIED_ASSET_BYTES) invalid("byte_size");
  let dimensions = null;
  switch (contentType) {
    case "image/png":
      dimensions = pngDimensions(body);
      break;
    case "image/jpeg":
      dimensions = jpegDimensions(body);
      break;
    case "image/gif":
      if (!["GIF87a", "GIF89a"].includes(body.subarray(0, 6).toString("ascii")) || body.length < 10) {
        invalid("content_type_mismatch");
      }
      dimensions = { width: body.readUInt16LE(6), height: body.readUInt16LE(8) };
      break;
    case "image/bmp":
      if (body.subarray(0, 2).toString("ascii") !== "BM" || body.length < 26) invalid("content_type_mismatch");
      dimensions = { width: Math.abs(body.readInt32LE(18)), height: Math.abs(body.readInt32LE(22)) };
      break;
    case "image/tiff":
      if (!hasPrefix(body, [0x49, 0x49, 0x2a, 0x00]) && !hasPrefix(body, [0x4d, 0x4d, 0x00, 0x2a])) {
        invalid("content_type_mismatch");
      }
      break;
    case "image/webp":
      if (body.length < 16 || body.subarray(0, 4).toString("ascii") !== "RIFF"
        || body.subarray(8, 12).toString("ascii") !== "WEBP") invalid("content_type_mismatch");
      break;
    case "image/avif":
    case "image/heic":
    case "image/heif":
      validateIsoBaseMedia(body, contentType);
      break;
    case "application/pdf":
      validatePdf(body);
      break;
    case "application/json":
      validateJson(body);
      break;
    default:
      invalid("content_type");
  }
  return Object.freeze({
    content_type: contentType,
    byte_size: body.length,
    checksum_sha256: createHash("sha256").update(body).digest("hex"),
    dimensions: validateDimensions(dimensions),
  });
}
