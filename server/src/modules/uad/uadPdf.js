import { createHash } from "node:crypto";

import PDFDocument from "pdfkit";

import { buildUadNativePdfFileName, UAD_SYSTEM_PACKAGE_PROFILE } from "./systemPackage.js";

const PAGE = Object.freeze({ width: 612, height: 1008, margin: 42 });
const CONTENT_WIDTH = PAGE.width - (PAGE.margin * 2);
const CONTENT_TOP = 78;
const CONTENT_BOTTOM = PAGE.height - 62;
const REPORT_ENGINE = "HomeNode UAD 3.6 Native Report Engine";
const REPORT_ENGINE_VERSION = "1.0.0";
const SUPPORTED_EMBEDDED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

function cleanText(value, fallback = "Not reported") {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  return String(value)
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return cleanText(value)
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  const parsed = numberValue(value);
  return parsed === null ? cleanText(value) : new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(parsed);
}

function dateText(value) {
  if (!value) return "Not reported";
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return cleanText(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function present(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return present(value.amount) && present(value.unit);
  return true;
}

function formatValue(field, value) {
  if (!present(value)) return "Not reported";
  if (field?.dataType === "boolean") return value ? "Yes" : "No";
  if (field?.dataType === "currency") return money(value);
  if (field?.dataType === "date") return dateText(value);
  if (field?.dataType === "percentage") return `${Number(value).toFixed(2).replace(/\.00$/, "")}%`;
  if (field?.dataType === "measurement") {
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(Number(value.amount))} ${titleCase(value.unit)}`;
  }
  if (Array.isArray(value)) return value.map(titleCase).join(" | ");
  if (field?.dataType === "enum") return titleCase(value);
  return cleanText(value);
}

function fieldKey(contextKey, uid) {
  return `${contextKey}:${uid}`;
}

function entityLabel(entity) {
  if (!entity) return "Subject / Assignment";
  const identifier = cleanText(entity.entity_identifier, "");
  const type = titleCase(entity.entity_type);
  return identifier ? `${type} - ${identifier}` : `${type} #${Number(entity.ordinal || 1)}`;
}

function buildFieldIndex(editor) {
  const index = new Map();
  for (const section of editor.sections || []) {
    for (const group of section.groups || []) {
      for (const field of group.fields || []) {
        index.set(field.key || fieldKey(field.contextKey, field.uid), { field, group, section });
      }
    }
  }
  return index;
}

function sortedEntities(editor) {
  return [...(editor.entities || [])].sort((left, right) => (
    Number(left.ordinal || 0) - Number(right.ordinal || 0)
    || String(left.entity_type).localeCompare(String(right.entity_type))
    || String(left.id).localeCompare(String(right.id))
  ));
}

function assetLabel(asset) {
  return cleanText(asset.caption || titleCase(asset.caption_type || asset.asset_kind || "Report exhibit"));
}

export function createUadPdfViewModel(editor, { assets = [], signers = [] } = {}) {
  if (!editor?.workfile?.id || !editor?.workfile?.specification_release_key) {
    throw new Error("invalid_uad_pdf_editor");
  }
  const fieldIndex = buildFieldIndex(editor);
  const entities = sortedEntities(editor);
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const buckets = new Map();
  const valueByKey = new Map();

  for (const value of editor.values || []) {
    const key = fieldKey(value.context_key, value.uid);
    const definition = fieldIndex.get(key);
    if (!definition || !present(value.value)) continue;
    const sectionKey = definition.section.key;
    const groupKey = `${definition.group.name}:${value.entity_id || "root"}`;
    let sectionBucket = buckets.get(sectionKey);
    if (!sectionBucket) {
      sectionBucket = new Map();
      buckets.set(sectionKey, sectionBucket);
    }
    let groupBucket = sectionBucket.get(groupKey);
    if (!groupBucket) {
      groupBucket = {
        name: definition.group.name,
        entity: value.entity_id ? entitiesById.get(value.entity_id) || null : null,
        rows: [],
      };
      sectionBucket.set(groupKey, groupBucket);
    }
    groupBucket.rows.push({
      label: definition.field.label,
      reportFieldId: definition.field.reportFieldId,
      value: formatValue(definition.field, value.value),
      confirmed: Boolean(value.is_appraiser_confirmed) || Boolean(definition.field.calculated),
    });
    valueByKey.set(`${value.entity_id || "root"}:${key}`, value.value);
  }

  const reportAssets = (assets || [])
    .filter((asset) => asset.status === "verified" && Number.isInteger(Number(asset.section_number)))
    .sort((left, right) => (
      Number(left.section_number) - Number(right.section_number)
      || String(left.caption_type || "").localeCompare(String(right.caption_type || ""))
      || String(left.id).localeCompare(String(right.id))
    ));
  const sections = (editor.sections || [])
    .filter((section) => section.applicable !== false)
    .map((section) => ({
      key: section.key,
      number: Number(section.officialSectionNumber),
      title: section.title,
      groups: [...(buckets.get(section.key)?.values() || [])],
      assets: reportAssets.filter((asset) => Number(asset.section_number) === Number(section.officialSectionNumber)),
    }))
    .filter((section) => section.groups.length || section.assets.length);

  const value = (key, entityId = null) => valueByKey.get(`${entityId || "root"}:${key}`);
  const address = cleanText(value("subject_address:0100.0007"), "Property address unavailable");
  return {
    workfile: editor.workfile,
    fileName: buildUadNativePdfFileName(editor.workfile),
    address,
    opinionOfValue: formatValue({ dataType: "currency" }, value("reconciliation:1300.0017")),
    effectiveDate: formatValue({ dataType: "date" }, value("reconciliation:1300.0012")),
    quality: formatValue({ dataType: "enum" }, value("subject:1600.0007")),
    condition: formatValue({ dataType: "enum" }, value("subject:1600.0006")),
    assignmentReason: formatValue({ dataType: "enum" }, value("assignment:1000.0034")),
    valuationMethod: formatValue({ dataType: "enum" }, value("assignment:1000.0158")),
    contractPrice: formatValue({ dataType: "currency" }, value("sales_contract:0600.0008")),
    sections,
    reportAssets,
    signers: [...signers].sort((left, right) => (
      (left.signer_role === "appraiser" ? 0 : 1) - (right.signer_role === "appraiser" ? 0 : 1)
    )),
  };
}

function addPage(doc) {
  doc.addPage({ size: [PAGE.width, PAGE.height], margin: 0 });
  return CONTENT_TOP;
}

function ensureSpace(doc, y, needed, onNewPage = null) {
  if (y + needed <= CONTENT_BOTTOM) return y;
  const nextY = addPage(doc);
  return onNewPage ? onNewPage(nextY) : nextY;
}

function sectionBar(doc, number, title, y) {
  y = ensureSpace(doc, y, 35);
  const label = `${number}. ${cleanText(title)}`;
  doc.font("Helvetica-Bold").fontSize(10);
  const width = Math.min(CONTENT_WIDTH, Math.max(205, doc.widthOfString(label) + 28));
  doc.save();
  doc.roundedRect(PAGE.margin, y, width, 24, 10).fill("#252122");
  doc.rect(PAGE.margin, y + 12, CONTENT_WIDTH, 12).fill("#252122");
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff")
    .text(label, PAGE.margin + 10, y + 7, { width: width - 20, height: 12, ellipsis: true });
  doc.restore();
  return y + 34;
}

function subsectionBar(doc, title, entity, y, onNewPage = null) {
  y = ensureSpace(doc, y, 58, onNewPage);
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, 20).fill("#e8e8e8");
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#252122")
    .text(cleanText(title), PAGE.margin + 6, y + 5, { width: CONTENT_WIDTH * 0.62, height: 12, ellipsis: true });
  if (entity) {
    doc.font("Helvetica").fontSize(7.5).fillColor("#4b5563")
      .text(entityLabel(entity), PAGE.margin + (CONTENT_WIDTH * 0.62), y + 6, {
        width: CONTENT_WIDTH * 0.36,
        height: 10,
        align: "right",
        ellipsis: true,
      });
  }
  return y + 26;
}

function fieldRow(doc, row, y, onNewPage = null) {
  const labelWidth = 205;
  const valueWidth = CONTENT_WIDTH - labelWidth;
  doc.font("Helvetica-Bold").fontSize(7.5);
  const labelHeight = doc.heightOfString(cleanText(row.label), { width: labelWidth - 12, lineGap: 1 });
  doc.font("Helvetica").fontSize(8);
  const valueHeight = doc.heightOfString(cleanText(row.value), { width: valueWidth - 18, lineGap: 1.4 });
  const height = Math.max(22, Math.min(90, Math.max(labelHeight, valueHeight) + 10));
  y = ensureSpace(doc, y, height, onNewPage);
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, height).fillAndStroke("#ffffff", "#b7b7b7");
  doc.moveTo(PAGE.margin + labelWidth, y).lineTo(PAGE.margin + labelWidth, y + height)
    .lineWidth(0.4).strokeColor("#b7b7b7").stroke();
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#252122")
    .text(cleanText(row.label), PAGE.margin + 6, y + 5, {
      width: labelWidth - 12,
      height: height - 9,
      ellipsis: true,
      lineGap: 1,
    });
  doc.font("Helvetica").fontSize(8).fillColor("#252122")
    .text(cleanText(row.value), PAGE.margin + labelWidth + 7, y + 5, {
      width: valueWidth - 17,
      height: height - 9,
      ellipsis: true,
      lineGap: 1.4,
    });
  if (!row.confirmed) {
    doc.font("Helvetica-Bold").fontSize(5.5).fillColor("#8a5b00")
      .text("SOURCE VALUE", PAGE.width - PAGE.margin - 64, y + height - 9, { width: 58, align: "right" });
  }
  return y + height;
}

function imageCard(doc, asset, y, onNewPage = null) {
  const height = 245;
  y = ensureSpace(doc, y, height + 10, onNewPage);
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, height).lineWidth(0.6).strokeColor("#888888").stroke();
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#252122")
    .text(assetLabel(asset), PAGE.margin + 7, y + 7, { width: CONTENT_WIDTH - 14, height: 13, ellipsis: true });
  const frame = { x: PAGE.margin + 8, y: y + 26, width: CONTENT_WIDTH - 16, height: height - 34 };
  doc.rect(frame.x, frame.y, frame.width, frame.height).fill("#eeeeee");
  if (asset.body && SUPPORTED_EMBEDDED_IMAGE_TYPES.has(String(asset.content_type).toLowerCase())) {
    try {
      doc.image(asset.body, frame.x, frame.y, { fit: [frame.width, frame.height], align: "center", valign: "center" });
      return y + height + 10;
    } catch {
      // The report calls out an unreadable verified object instead of silently dropping it.
    }
  }
  doc.font("Helvetica").fontSize(8).fillColor("#6b7280")
    .text("Verified report image could not be rendered from its stored display format.", frame.x + 20, frame.y + (frame.height / 2) - 5, {
      width: frame.width - 40,
      align: "center",
    });
  return y + height + 10;
}

function summaryPage(doc, view) {
  let y = addPage(doc);
  doc.font("Helvetica").fontSize(25).fillColor("#252122")
    .text("Uniform Residential Appraisal Report", PAGE.margin, y + 10, { width: CONTENT_WIDTH });
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#252122")
    .text(view.address.toUpperCase(), PAGE.margin, y + 47, { width: CONTENT_WIDTH, height: 26, ellipsis: true });
  y += 105;
  y = sectionBar(doc, "SUMMARY", "Appraisal Summary", y);
  const cards = [
    ["Opinion of Market Value", view.opinionOfValue],
    ["Effective Date", view.effectiveDate],
    ["Assignment Reason", view.assignmentReason],
    ["Valuation Method", view.valuationMethod],
    ["Overall Quality", view.quality],
    ["Overall Condition", view.condition],
    ["Contract Price", view.contractPrice],
    ["Appraisal Version", String(view.workfile.current_revision)],
  ];
  for (let index = 0; index < cards.length; index += 2) {
    y = ensureSpace(doc, y, 43);
    for (let column = 0; column < 2; column += 1) {
      const card = cards[index + column];
      if (!card) continue;
      const x = PAGE.margin + (column * ((CONTENT_WIDTH / 2) + 8));
      const width = (CONTENT_WIDTH / 2) - 8;
      doc.font("Helvetica-Bold").fontSize(7).fillColor("#252122").text(card[0], x, y + 4, { width: 118 });
      doc.font("Helvetica").fontSize(8).fillColor("#252122").text(cleanText(card[1]), x + 120, y + 4, {
        width: width - 120,
        height: 28,
        ellipsis: true,
      });
      doc.moveTo(x, y + 34).lineTo(x + width, y + 34).lineWidth(0.4).strokeColor("#888888").stroke();
    }
    y += 43;
  }
  y += 12;
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, 84).fill("#f2f2f2");
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#252122")
    .text("Revision-bound report", PAGE.margin + 10, y + 10, { width: CONTENT_WIDTH - 20 });
  doc.font("Helvetica").fontSize(8).fillColor("#3f3f46")
    .text(
      "This report renders the saved UAD 3.6 workfile revision. Every displayed appraisal fact comes from the canonical UAD workfile; protected software and package metadata are generated server-side.",
      PAGE.margin + 10,
      y + 29,
      { width: CONTENT_WIDTH - 20, lineGap: 2 },
    );
}

function renderSections(doc, view) {
  let y = addPage(doc);
  for (const section of view.sections) {
    y = ensureSpace(doc, y, 90);
    y = sectionBar(doc, section.number, section.title, y);
    const continueSection = (nextY) => sectionBar(
      doc,
      section.number,
      `${section.title} (continued)`,
      nextY,
    );
    for (const group of section.groups) {
      y = subsectionBar(doc, group.name, group.entity, y, continueSection);
      const continueGroup = (nextY) => subsectionBar(
        doc,
        `${group.name} (continued)`,
        group.entity,
        continueSection(nextY),
      );
      for (const row of group.rows) y = fieldRow(doc, row, y, continueGroup);
      y += 8;
    }
    if (section.assets.length) {
      const exhibitsTitle = `${section.title} Exhibits`;
      y = subsectionBar(doc, exhibitsTitle, null, y, continueSection);
      const continueExhibits = (nextY) => subsectionBar(
        doc,
        `${exhibitsTitle} (continued)`,
        null,
        continueSection(nextY),
      );
      for (const asset of section.assets) y = imageCard(doc, asset, y, continueExhibits);
    }
    y += 18;
  }
  return y;
}

function renderSignatures(doc, view, startY) {
  if (!view.signers.length) return startY;
  let y = ensureSpace(doc, startY, 190);
  y = subsectionBar(doc, "Signature", null, y);
  for (const signer of view.signers) {
    y = ensureSpace(doc, y, 150);
    const snapshot = signer.credential_snapshot || {};
    const person = snapshot.signer || {};
    const license = snapshot.license || {};
    const organization = snapshot.organization || {};
    const name = [person.first_name, person.middle_name, person.last_name, person.suffix_name]
      .filter(Boolean).join(" ");
    y = subsectionBar(doc, signer.signer_role === "appraiser" ? "Appraiser" : "Supervisory Appraiser", null, y);
    for (const row of [
      ["Name", name],
      ["Company", organization.display_name || organization.legal_name],
      ["Credential", `${titleCase(license.license_type)} | ${license.license_number}`],
      ["State / Expires", `${license.jurisdiction || ""} | ${dateText(license.expires_on)}`],
      ["Date of Signature and Report", dateText(signer.execution_date)],
    ]) {
      y = fieldRow(doc, { label: row[0], value: row[1], confirmed: true }, y);
    }
    y += 12;
  }
  return y;
}

function decoratePages(doc, view) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const page = index - range.start + 1;
    doc.save();
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#252122")
      .text("Uniform Residential Appraisal Report", PAGE.margin, 28, { width: 330 });
    doc.font("Helvetica").fontSize(7.5).fillColor("#252122")
      .text(`Page ${page} of ${range.count}`, PAGE.width - PAGE.margin - 90, 29, { width: 90, align: "right" });
    doc.moveTo(PAGE.margin, 44).lineTo(PAGE.width - PAGE.margin, 44)
      .lineWidth(0.5).strokeColor("#737373").stroke();
    const footerY = PAGE.height - 45;
    doc.moveTo(PAGE.margin, footerY - 10).lineTo(PAGE.width - PAGE.margin, footerY - 10)
      .lineWidth(1.2).strokeColor("#252122").stroke();
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#252122")
      .text(`Appraisal Version #${view.workfile.current_revision}`, PAGE.margin, footerY, { width: 180 })
      .text(`Appraiser Reference ID  ${cleanText(view.workfile.file_number, "Unassigned")}`, PAGE.width - PAGE.margin - 230, footerY, {
        width: 230,
        align: "right",
      });
    doc.font("Helvetica").fontSize(6.2).fillColor("#555555")
      .text("Fannie Mae | Freddie Mac", PAGE.margin, footerY + 15, { width: 160 })
      .text(UAD_SYSTEM_PACKAGE_PROFILE.documentFormIssuingEntityVersionIdentifier, PAGE.margin, footerY + 25, { width: 160 });
    doc.restore();
  }
  return range.count;
}

export async function renderUadNativePdf(editor, options = {}) {
  const view = createUadPdfViewModel(editor, options);
  const updatedAt = new Date(view.workfile.updated_at || "2000-01-01T00:00:00.000Z");
  const timestamp = Number.isNaN(updatedAt.valueOf()) ? new Date("2000-01-01T00:00:00.000Z") : updatedAt;
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: `${view.workfile.file_number || view.workfile.id} Uniform Residential Appraisal Report`,
      Author: REPORT_ENGINE,
      Subject: `${view.address} UAD 3.6 appraisal`,
      Keywords: "UAD 3.6, URAR, appraisal, MISMO 3.6",
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
  summaryPage(doc, view);
  const sectionEnd = renderSections(doc, view);
  renderSignatures(doc, view, sectionEnd);
  const pageCount = decoratePages(doc, view);
  doc.end();
  const content = await complete;
  return {
    content,
    checksum_sha256: createHash("sha256").update(content).digest("hex"),
    byte_size: content.length,
    page_count: pageCount,
    file_name: view.fileName,
    renderer: REPORT_ENGINE,
    renderer_version: REPORT_ENGINE_VERSION,
    rendered_sections: view.sections.map((section) => section.number),
    rendered_asset_count: view.reportAssets.length,
    signer_count: view.signers.length,
  };
}

export const UAD_NATIVE_PDF_PAGE_SIZE = Object.freeze([PAGE.width, PAGE.height]);
export const UAD_NATIVE_PDF_RENDERER_VERSION = REPORT_ENGINE_VERSION;
