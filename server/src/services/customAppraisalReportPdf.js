import { createHash } from "node:crypto";

import PDFDocument from "pdfkit";

import { getAccountPropertyActivityHistory } from "./accountSalesHistory.js";

const PAGE = Object.freeze({ width: 612, height: 792, margin: 42 });
const CONTENT_WIDTH = PAGE.width - (PAGE.margin * 2);
const REPORT_VERSION = 1;
const REPORT_PAGE_COUNT = 9;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const REPORT_ENGINE = "HomeNode Custom Appraisal Report Engine";
const artifactSchemaReadyByPool = new WeakMap();

export async function ensureCustomAppraisalReportArtifactSchema(pool) {
  const existing = artifactSchemaReadyByPool.get(pool);
  if (existing) return existing;
  const pending = pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.custom_appraisal_report_artifacts (
      assignment_file_id bigint PRIMARY KEY
        REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
      signed_snapshot_id uuid NOT NULL UNIQUE
        REFERENCES app.custom_appraisal_signed_snapshots(id) ON DELETE RESTRICT,
      canonical_file_name text NOT NULL UNIQUE,
      report_version integer NOT NULL DEFAULT 1,
      workfile_checksum_sha256 text NOT NULL,
      content_sha256 text NOT NULL,
      content bytea NOT NULL,
      byte_size bigint NOT NULL,
      page_count integer NOT NULL,
      generated_by text NOT NULL DEFAULT 'HomeNode report engine',
      generated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (report_version >= 1),
      CHECK (workfile_checksum_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      CHECK (octet_length(content) = byte_size),
      CHECK (byte_size > 0),
      CHECK (page_count > 0)
    );
    CREATE INDEX IF NOT EXISTS custom_appraisal_report_artifacts_generated_idx
      ON app.custom_appraisal_report_artifacts (generated_at DESC, assignment_file_id);
  `).catch((error) => {
    artifactSchemaReadyByPool.delete(pool);
    throw error;
  });
  artifactSchemaReadyByPool.set(pool, pending);
  return pending;
}

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

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  const parsed = numberValue(value);
  return parsed === null
    ? "Not reported"
    : new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(parsed);
}

function count(value, suffix = "") {
  const parsed = numberValue(value);
  return parsed === null
    ? "Not reported"
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(parsed)}${suffix}`;
}

function percent(value) {
  const parsed = numberValue(value);
  return parsed === null ? "Not reported" : `${parsed.toFixed(1).replace(/\.0$/, "")}%`;
}

function dateText(value) {
  if (!value) return "Not reported";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return cleanText(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function booleanText(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null || value === undefined || value === "") return "Not reported";
  return /^(true|t|yes|y|1)$/i.test(String(value)) ? "Yes" : /^(false|f|no|n|0)$/i.test(String(value)) ? "No" : cleanText(value);
}

function titleCase(value) {
  return cleanText(value)
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sectionValue(snapshot, sectionKey) {
  return snapshot?.sections?.[sectionKey]?.value || snapshot?.sections?.[sectionKey] || {};
}

function assignmentRecord(snapshot, property) {
  return snapshot?.assignment || property?.assignment || {};
}

function assignmentDetails(snapshot, property) {
  return assignmentRecord(snapshot, property)?.assignment_details || {};
}

function canonicalPdfFileName(snapshot) {
  const jsonName = cleanText(snapshot?.canonical_file_name || "custom-appraisal.homenode-appraisal.json");
  return jsonName.endsWith(".homenode-appraisal.json")
    ? jsonName.replace(/\.homenode-appraisal\.json$/i, ".appraisal-report.pdf")
    : `${jsonName.replace(/\.json$/i, "")}.pdf`;
}

export function customAppraisalReportFileName(snapshot) {
  return canonicalPdfFileName(snapshot);
}

export function customAppraisalReportReadinessErrors(snapshot, property = {}) {
  const errors = [];
  const details = assignmentDetails(snapshot, property);
  const sales = sectionValue(snapshot, "sales_comparison");
  const market = sectionValue(snapshot, "market_conditions");
  if (!Array.isArray(details.assignment_types) || !details.assignment_types.length) {
    errors.push("Select an assignment type.");
  }
  if (!details.neighborhood_boundary_confirmed) {
    errors.push("Confirm the neighborhood boundary.");
  }
  for (const direction of ["north", "east", "south", "west"]) {
    if (!String(details[`neighborhood_boundary_${direction}`] || "").trim()) {
      errors.push(`Enter the ${direction} neighborhood boundary.`);
    }
  }
  if (!Array.isArray(sales.comparables) || !sales.comparables.length) {
    errors.push("Select and save at least one comparable sale.");
  }
  if (!(numberValue(sales.opinionOfValue) > 0)) {
    errors.push("Reconcile a positive Sales Comparison Approach value.");
  }
  if (!Array.isArray(market?.response?.analyses) || !market.response.analyses.length) {
    errors.push("Complete and save at least one market conditions study.");
  }
  if (!String(market?.reconciliation?.trendConclusion || "").trim()) {
    errors.push("Complete the market trend conclusion.");
  }
  return errors;
}

async function optionalRows(client, tableName, sql, params) {
  const table = await client.query("SELECT to_regclass($1) AS name", [tableName]);
  if (!table.rows[0]?.name) return [];
  return (await client.query(sql, params)).rows;
}

export async function loadCustomAppraisalPropertySnapshot(client, { accountId, assignmentFileId }) {
  const [accountResult, improvementResult, housingResult, ownerResult, legalResult, landResult,
    exemptionResult, additionalResult, locationResult, assignmentResult, manualRows] = await Promise.all([
    client.query(
      `SELECT a.account_id, a.address, a.city, a.postal_code, a.county,
              a.neighborhood_code, a.subdivision, a.legal_description,
              COALESCE(v.certified_year, mv.tax_year) AS latest_tax_year,
              COALESCE(v.market_value, mv.total_value) AS market_value,
              COALESCE(v.improvement_value, mv.imp_value) AS improvement_value,
              COALESCE(v.land_value, mv.land_value) AS land_value,
              COALESCE(v.capped_value, mv.homestead_cap_value) AS capped_value
         FROM core.accounts a
         LEFT JOIN core.value_summary_current v ON v.account_id = a.account_id
         LEFT JOIN LATERAL (
           SELECT * FROM core.market_values WHERE account_id = a.account_id
           ORDER BY tax_year DESC LIMIT 1
         ) mv ON true
        WHERE a.account_id = $1`,
      [accountId],
    ),
    client.query("SELECT * FROM core.primary_improvements WHERE account_id = $1 LIMIT 1", [accountId]),
    optionalRows(client, "core.v_account_housing_profiles", "SELECT * FROM core.v_account_housing_profiles WHERE account_id = $1 LIMIT 1", [accountId]),
    client.query(
      `SELECT summary.owner_name, summary.mailing_address, summary.tax_year,
              COALESCE((SELECT json_agg(json_build_object(
                'owner_name', party.owner_name, 'ownership_pct', party.ownership_pct
              ) ORDER BY party.id) FROM core.owner_parties party
               WHERE party.account_id = summary.account_id
                 AND party.tax_year = (SELECT max(recent.tax_year) FROM core.owner_parties recent WHERE recent.account_id = summary.account_id)), '[]'::json) AS parties
         FROM core.owner_summary summary WHERE summary.account_id = $1
         ORDER BY summary.tax_year DESC LIMIT 1`,
      [accountId],
    ),
    client.query("SELECT * FROM core.legal_description_current WHERE account_id = $1 LIMIT 1", [accountId]),
    client.query(
      `SELECT line_number, state_code, zoning, frontage_ft, depth_ft, area_sqft,
              pricing_method, unit_price, market_adjustment_pct, adjusted_price, ag_land
         FROM core.land_detail WHERE account_id = $1
           AND tax_year = (SELECT max(tax_year) FROM core.land_detail WHERE account_id = $1)
         ORDER BY line_number`,
      [accountId],
    ),
    client.query(
      `SELECT tax_year, jurisdiction_key, taxing_jurisdiction, homestead_exemption,
              disabled_vet, taxable_value
         FROM core.exemptions_summary WHERE account_id = $1
           AND tax_year = (SELECT max(tax_year) FROM core.exemptions_summary WHERE account_id = $1)
         ORDER BY taxing_jurisdiction`,
      [accountId],
    ),
    client.query(
      `SELECT sec_imp_number AS number, sec_imp_type AS improvement_type,
              sec_imp_cons_type AS construction, sec_imp_floor AS floor,
              sec_imp_ext_wall AS exterior_wall, sec_imp_sqft AS area_sqft,
              sec_imp_value AS value, sec_imp_year_built AS year_built
         FROM core.secondary_improvements WHERE account_id = $1
         ORDER BY sec_imp_number NULLS LAST, id`,
      [accountId],
    ),
    optionalRows(client, "core.account_locations", "SELECT latitude, longitude, geocode_source, geocoded_at FROM core.account_locations WHERE account_id = $1", [accountId]),
    client.query(
      `SELECT id, account_id, file_number, revision, assignment_details, reviewer,
              created_at, updated_at FROM app.assignment_files
        WHERE id = $1 AND account_id = $2`,
      [assignmentFileId, accountId],
    ),
    optionalRows(client, "app.property_attribute_manual_values", `SELECT attribute_key, attribute_value, revision, reviewer, updated_at
       FROM app.property_attribute_manual_values WHERE account_id = $1 AND attribute_key LIKE 'report.%'`, [accountId]),
  ]);
  if (!accountResult.rows.length || !assignmentResult.rows.length) throw new Error("assignment_file_not_found");
  const activity = await getAccountPropertyActivityHistory(client, accountId).catch(() => []);
  return {
    account: accountResult.rows[0],
    improvement: improvementResult.rows[0] || null,
    housing_profile: housingResult[0] || null,
    owner: ownerResult.rows[0] || null,
    legal: legalResult.rows[0] || null,
    land: landResult.rows,
    exemptions: exemptionResult.rows,
    additional_improvements: additionalResult.rows,
    location: locationResult[0] || null,
    assignment: assignmentResult.rows[0],
    property_activity_history: activity,
    sales_history: activity.filter((row) => row.record_type === "closed_sale"),
    report_manual_values: Object.fromEntries(manualRows.map((row) => [row.attribute_key, row])),
    captured_at: new Date().toISOString(),
  };
}

function safeMediaUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local")) return null;
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function loadReportImage(urlValue) {
  const url = safeMediaUrl(urlValue);
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) return null;
    const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    if (!["image/jpeg", "image/png"].includes(contentType)) return null;
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_MEDIA_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > 0 && buffer.length <= MAX_MEDIA_BYTES ? buffer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function reportImages(client, snapshot, property) {
  const sales = sectionValue(snapshot, "sales_comparison");
  const comparableIds = (sales.comparables || [])
    .map((item) => item?.sale?.primary_account_id)
    .filter(Boolean)
    .slice(0, 6);
  const accountIds = [property.account.account_id, ...comparableIds];
  const mediaRows = await optionalRows(
    client,
    "core.sales_source_media",
    `SELECT DISTINCT ON (source.primary_account_id)
            source.primary_account_id AS account_id, media.media_url
       FROM core.sales_source_records source
       JOIN core.sales_source_media media ON media.source_record_id = source.id
      WHERE source.primary_account_id = ANY($1::text[])
        AND media.media_category = 'image'
        AND COALESCE(media.permission, '') !~* 'prohibit|deny'
      ORDER BY source.primary_account_id, media.preferred_photo_yn DESC,
               media.order_number NULLS LAST, media.id`,
    [accountIds],
  );
  const buffers = await Promise.all(mediaRows.map((row) => loadReportImage(row.media_url)));
  return Object.fromEntries(mediaRows.map((row, index) => [row.account_id, buffers[index]]).filter(([, buffer]) => buffer));
}

function reportMeta(snapshot, property, checksum) {
  const account = property.account || {};
  const assignment = assignmentRecord(snapshot, property);
  return {
    address: cleanText(account.address, "Property address unavailable"),
    accountId: cleanText(account.account_id),
    fileNumber: cleanText(assignment.file_number, "Unassigned"),
    status: snapshot.status === "signed" ? "SIGNED" : "DRAFT",
    signedBy: snapshot.signed_by || null,
    signedAt: snapshot.signed_at || null,
    checksum: checksum || snapshot.checksum_sha256 || null,
  };
}

function pageHeader(doc, meta, title, page) {
  doc.fillColor("#0f766e").font("Helvetica-Bold").fontSize(8)
    .text("HOMENODE APPRAISAL REPORT", PAGE.margin, 28, { characterSpacing: 1.2 });
  doc.fillColor("#0f172a").fontSize(17).text(title, PAGE.margin, 42, { width: 350 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(meta.status === "SIGNED" ? "#047857" : "#b45309")
    .text(meta.status, 440, 30, { width: 130, align: "right" });
  doc.font("Helvetica").fontSize(7).fillColor("#64748b")
    .text(meta.address, 390, 43, { width: 180, align: "right", ellipsis: true })
    .text(`Page ${page} of ${REPORT_PAGE_COUNT}`, 440, 55, { width: 130, align: "right" });
  doc.moveTo(PAGE.margin, 70).lineTo(PAGE.width - PAGE.margin, 70).lineWidth(1.5).strokeColor("#0f766e").stroke();
}

function pageFooter(doc, meta) {
  const y = PAGE.height - 31;
  doc.moveTo(PAGE.margin, y - 7).lineTo(PAGE.width - PAGE.margin, y - 7).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
  doc.font("Helvetica").fontSize(6.5).fillColor("#64748b")
    .text(`${meta.fileNumber} | Parcel ${meta.accountId}`, PAGE.margin, y, { width: 270 })
    .text(meta.status === "SIGNED" ? `Signed ${dateText(meta.signedAt)} by ${cleanText(meta.signedBy)}` : "Draft workfile - appraiser review required", 300, y, { width: 270, align: "right" });
}

function addPage(doc, meta, title, page) {
  doc.addPage({ size: "LETTER", margin: 0 });
  doc.save();
  pageHeader(doc, meta, title, page);
  pageFooter(doc, meta);
  doc.restore();
}

function sectionTitle(doc, title, y) {
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#0f172a")
    .text(cleanText(title).toUpperCase(), PAGE.margin, y, { characterSpacing: 0.8 });
  return y + 15;
}

function noteBox(doc, textValue, y, { color = "#0f766e", height = 44 } = {}) {
  doc.roundedRect(PAGE.margin, y, CONTENT_WIDTH, height, 5).fillAndStroke("#f8fafc", "#cbd5e1");
  doc.rect(PAGE.margin, y, 3, height).fill(color);
  doc.font("Helvetica").fontSize(8).fillColor("#334155")
    .text(cleanText(textValue), PAGE.margin + 12, y + 9, { width: CONTENT_WIDTH - 23, height: height - 16, ellipsis: true, lineGap: 1.5 });
  return y + height + 10;
}

function factsGrid(doc, facts, y, columns = 4) {
  const gap = 8;
  const width = (CONTENT_WIDTH - (gap * (columns - 1))) / columns;
  const rowHeight = 48;
  facts.forEach((fact, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = PAGE.margin + (column * (width + gap));
    const top = y + (row * (rowHeight + 7));
    doc.roundedRect(x, top, width, rowHeight, 4).fillAndStroke("#f8fafc", "#e2e8f0");
    doc.font("Helvetica-Bold").fontSize(6).fillColor("#64748b")
      .text(cleanText(fact.label).toUpperCase(), x + 7, top + 7, { width: width - 14, height: 8, ellipsis: true });
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#0f172a")
      .text(cleanText(fact.value), x + 7, top + 20, { width: width - 14, height: 23, ellipsis: true, lineGap: 1 });
  });
  return y + (Math.ceil(facts.length / columns) * (rowHeight + 7));
}

function drawTable(doc, { columns, rows, y, rowHeight = 34, fontSize = 7, headerHeight = 23 }) {
  const widths = columns.map((column) => column.width);
  let x = PAGE.margin;
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, headerHeight).fill("#e2e8f0");
  columns.forEach((column, index) => {
    doc.font("Helvetica-Bold").fontSize(6).fillColor("#334155")
      .text(cleanText(column.label).toUpperCase(), x + 5, y + 7, { width: widths[index] - 10, height: 10, align: column.align || "left", ellipsis: true });
    x += widths[index];
  });
  let top = y + headerHeight;
  rows.forEach((row, rowIndex) => {
    doc.rect(PAGE.margin, top, CONTENT_WIDTH, rowHeight).fill(rowIndex % 2 ? "#f8fafc" : "#ffffff");
    doc.moveTo(PAGE.margin, top).lineTo(PAGE.width - PAGE.margin, top).lineWidth(0.35).strokeColor("#e2e8f0").stroke();
    x = PAGE.margin;
    columns.forEach((column, index) => {
      doc.font(column.bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor("#0f172a")
        .text(cleanText(row[column.key]), x + 5, top + 6, { width: widths[index] - 10, height: rowHeight - 10, align: column.align || "left", ellipsis: true, lineGap: 1 });
      x += widths[index];
    });
    top += rowHeight;
  });
  doc.rect(PAGE.margin, y, CONTENT_WIDTH, headerHeight + (rows.length * rowHeight)).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
  return top + 10;
}

function drawImageOrPlaceholder(doc, buffer, x, y, width, height, label) {
  doc.roundedRect(x, y, width, height, 6).fillAndStroke("#e2e8f0", "#cbd5e1");
  if (buffer) {
    try {
      doc.image(buffer, x, y, { fit: [width, height], align: "center", valign: "center" });
      return;
    } catch {
      // A corrupt or unsupported source image never blocks the signed report.
    }
  }
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b")
    .text(cleanText(label), x + 12, y + (height / 2) - 5, { width: width - 24, align: "center" });
}

function geometryPoints(geometry) {
  const coordinates = geometry?.type === "Polygon" ? geometry.coordinates?.[0] : null;
  return Array.isArray(coordinates)
    ? coordinates.map((point) => ({ longitude: numberValue(point?.[0]), latitude: numberValue(point?.[1]) })).filter((point) => point.latitude !== null && point.longitude !== null)
    : [];
}

function plotPoints(doc, points, frame, { connect = false, labels = true } = {}) {
  if (!points.length) {
    doc.roundedRect(frame.x, frame.y, frame.width, frame.height, 5).fillAndStroke("#f8fafc", "#cbd5e1");
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text("Coordinate exhibit unavailable", frame.x, frame.y + (frame.height / 2), { width: frame.width, align: "center" });
    return;
  }
  const lats = points.map((point) => point.latitude);
  const lons = points.map((point) => point.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const latRange = Math.max(0.0001, maxLat - minLat);
  const lonRange = Math.max(0.0001, maxLon - minLon);
  const mapped = points.map((point) => ({
    ...point,
    x: frame.x + 12 + (((point.longitude - minLon) / lonRange) * (frame.width - 24)),
    y: frame.y + frame.height - 12 - (((point.latitude - minLat) / latRange) * (frame.height - 24)),
  }));
  doc.roundedRect(frame.x, frame.y, frame.width, frame.height, 5).fillAndStroke("#f8fafc", "#cbd5e1");
  if (connect && mapped.length > 1) {
    doc.save().moveTo(mapped[0].x, mapped[0].y);
    mapped.slice(1).forEach((point) => doc.lineTo(point.x, point.y));
    doc.closePath().fillOpacity(0.12).fillAndStroke("#14b8a6", "#0f766e").fillOpacity(1).restore();
  }
  mapped.forEach((point, index) => {
    const subject = point.subject || index === 0;
    doc.circle(point.x, point.y, subject ? 4.5 : 3.5).fill(subject ? "#dc2626" : "#0f766e");
    if (labels) {
      const x = subject ? Math.max(frame.x + 3, point.x - 48) : point.x + 5;
      const y = subject ? point.y + 7 : point.y + (index % 2 ? -13 : 4);
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor("#0f172a")
        .text(cleanText(point.label || String(index)), x, y, { width: subject ? 44 : 80, ellipsis: true });
    }
  });
}

function comparableRows(sales) {
  return (sales.comparables || []).slice(0, 6).map((item, index) => {
    const sale = item.sale || {};
    const adjustment = numberValue(item.netAdjustment) || 0;
    return {
      number: String(index + 1),
      comparable: cleanText([sale.address, sale.city].filter(Boolean).join(", "), sale.primary_account_id || "Not reported"),
      date: dateText(sale.closing_date),
      sale_price: money(sale.sale_price),
      gla: count(sale.mls_living_area || sale.cad_living_area_sqft, " sf"),
      rating: `${cleanText(item.condition, "Unrated")} / ${cleanText(item.quality, "Unrated")}`,
      adjustment: `${adjustment > 0 ? "+" : adjustment < 0 ? "-" : ""}${money(Math.abs(adjustment))}`,
      indicated: money(item.indicatedValue),
    };
  });
}

function reportCoordinates(property, sales) {
  const subjectLat = numberValue(property.location?.latitude);
  const subjectLon = numberValue(property.location?.longitude);
  const points = subjectLat !== null && subjectLon !== null
    ? [{ latitude: subjectLat, longitude: subjectLon, label: "Subject", subject: true }]
    : [];
  (sales.comparables || []).slice(0, 6).forEach((item, index) => {
    const sale = item.sale || {};
    const latitude = numberValue(sale.latitude);
    const longitude = numberValue(sale.longitude);
    if (latitude !== null && longitude !== null) points.push({ latitude, longitude, label: `Comp ${index + 1}` });
  });
  return points;
}

function renderPropertyPage(doc, meta, snapshot, property, images) {
  addPage(doc, meta, "Property Report", 1);
  const account = property.account || {};
  const details = assignmentDetails(snapshot, property);
  doc.roundedRect(PAGE.margin, 88, CONTENT_WIDTH, 142, 8).fillAndStroke("#f0fdfa", "#99f6e4");
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text(meta.address, 56, 105, { width: 315, height: 44, ellipsis: true });
  doc.font("Helvetica").fontSize(8).fillColor("#475569")
    .text(`${cleanText(account.city)} | ${cleanText(account.county)} County | ${cleanText(account.postal_code)}`, 56, 157, { width: 315 })
    .text(`Parcel: ${meta.accountId}`, 56, 174, { width: 315 })
    .text(`Neighborhood: ${cleanText(account.neighborhood_code)}`, 56, 189, { width: 315 })
    .text(`Prepared For: ${cleanText(details.lender_client_name)}`, 56, 204, { width: 315 });
  drawImageOrPlaceholder(doc, images[meta.accountId], 392, 101, 158, 112, "Property photo unavailable");
  let y = sectionTitle(doc, "Subject Identification", 251);
  y = factsGrid(doc, [
    { label: "File Number", value: meta.fileNumber },
    { label: "Assignment Type", value: (details.assignment_types || []).map(titleCase).join(", ") },
    { label: "Occupancy", value: titleCase(details.occupancy) },
    { label: "County", value: account.county },
    { label: "Owner", value: property.owner?.owner_name },
    { label: "Ownership", value: (property.owner?.parties || []).map((party) => `${party.owner_name} ${party.ownership_pct || ""}`).join("; ") },
    { label: "Subdivision", value: account.subdivision },
    { label: "Legal Description", value: property.legal?.legal_text || account.legal_description },
  ], y, 4);
  y = sectionTitle(doc, "CAD Values, Taxes, and Exemptions", y + 3);
  factsGrid(doc, [
    { label: "Tax Year", value: account.latest_tax_year },
    { label: "CAD Market Value", value: money(account.market_value) },
    { label: "CAD Land Value", value: money(account.land_value) },
    { label: "CAD Improvement Value", value: money(account.improvement_value) },
    { label: "Assessed / Capped", value: money(account.capped_value || account.market_value) },
    { label: "Homestead", value: property.exemptions?.some((row) => numberValue(row.homestead_exemption) > 0) ? "Yes" : "No" },
    { label: "Latest Deed Transfer", value: dateText(property.legal?.deed_transfer_date) },
    { label: "Signed Status", value: meta.status },
  ], y, 4);
}

function renderCharacteristicsPage(doc, meta, property) {
  addPage(doc, meta, "Property Characteristics", 2);
  const improvement = property.improvement || {};
  const housing = property.housing_profile || {};
  const landArea = (property.land || []).reduce((total, row) => total + (numberValue(row.area_sqft) || 0), 0);
  let y = sectionTitle(doc, "Building Characteristics", 90);
  y = factsGrid(doc, [
    { label: "Living Area", value: count(improvement.living_area_sqft || improvement.total_living_area, " sf") },
    { label: "Bedrooms", value: improvement.bedroom_count },
    { label: "Bathrooms", value: improvement.baths_full != null || improvement.baths_half != null ? `${cleanText(improvement.baths_full, "0")} full / ${cleanText(improvement.baths_half, "0")} half` : improvement.bath_count },
    { label: "Stories", value: improvement.stories },
    { label: "Year Built", value: improvement.year_built },
    { label: "Effective Year", value: improvement.effective_year_built },
    { label: "Housing Type", value: housing.housing_type },
    { label: "Attachment", value: housing.attachment_type },
    { label: "Architecture", value: housing.architectural_style },
    { label: "Construction", value: improvement.construction_type },
    { label: "Foundation", value: improvement.foundation },
    { label: "Exterior", value: improvement.exterior_material },
    { label: "Heating", value: improvement.heating },
    { label: "Air Conditioning", value: improvement.air_conditioning },
    { label: "Fireplaces", value: improvement.fireplaces },
    { label: "Pool", value: booleanText(improvement.pool) },
  ], y, 4);
  y = sectionTitle(doc, "Land Details and Zoning", y + 3);
  y = factsGrid(doc, [
    { label: "Total Site Area", value: count(landArea, " sf") },
    { label: "Primary Zoning", value: property.land?.find((row) => row.zoning)?.zoning },
    { label: "CAD Land Value", value: money(property.account?.land_value) },
    { label: "Land Lines", value: property.land?.length || 0 },
  ], y, 4);
  y = drawTable(doc, {
    y,
    rowHeight: 31,
    columns: [
      { key: "use", label: "Use / State Code", width: 110 },
      { key: "zoning", label: "Zoning", width: 80 },
      { key: "area", label: "Area", width: 82, align: "right" },
      { key: "dimensions", label: "Frontage x Depth", width: 95, align: "right" },
      { key: "pricing", label: "CAD Pricing", width: 91 },
      { key: "value", label: "Adjusted", width: 70, align: "right" },
    ],
    rows: (property.land || []).slice(0, 6).map((row) => ({
      use: row.state_code,
      zoning: row.zoning,
      area: count(row.area_sqft, " sf"),
      dimensions: `${count(row.frontage_ft, " ft")} x ${count(row.depth_ft, " ft")}`,
      pricing: row.pricing_method,
      value: money(row.adjusted_price),
    })),
  });
  sectionTitle(doc, "Additional Improvements", y);
  drawTable(doc, {
    y: y + 15,
    rowHeight: 28,
    columns: [
      { key: "type", label: "Improvement", width: 160 },
      { key: "construction", label: "Construction", width: 125 },
      { key: "area", label: "Area", width: 90, align: "right" },
      { key: "year", label: "Year Built", width: 75, align: "right" },
      { key: "value", label: "CAD Value", width: 78, align: "right" },
    ],
    rows: (property.additional_improvements || []).slice(0, 4).map((row) => ({
      type: row.improvement_type,
      construction: row.construction,
      area: count(row.area_sqft, " sf"),
      year: row.year_built,
      value: money(row.value),
    })),
  });
}

function renderNeighborhoodPage(doc, meta, snapshot, property) {
  addPage(doc, meta, "Neighborhood Characteristics", 3);
  const details = assignmentDetails(snapshot, property);
  let y = sectionTitle(doc, "Neighborhood Boundaries", 90);
  y = factsGrid(doc, [
    { label: "North", value: details.neighborhood_boundary_north },
    { label: "East", value: details.neighborhood_boundary_east },
    { label: "South", value: details.neighborhood_boundary_south },
    { label: "West", value: details.neighborhood_boundary_west },
  ], y, 4);
  const boundaryPoints = geometryPoints(details.neighborhood_boundary_geometry).map((point) => ({ ...point, label: "" }));
  plotPoints(doc, boundaryPoints, { x: PAGE.margin, y, width: 252, height: 160 }, { connect: true, labels: false });
  doc.roundedRect(306, y, 264, 160, 5).fillAndStroke("#f8fafc", "#cbd5e1");
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#0f172a").text("Boundary and Data-Relevance Distinction", 320, y + 13, { width: 235 });
  doc.font("Helvetica").fontSize(7.5).fillColor("#334155").text(cleanText(details.neighborhood_boundary_engine_disclosure || details.neighborhood_boundary_exclusions || "The neighborhood boundary is intentionally broad. Comparable relevance is analyzed separately from boundary membership."), 320, y + 34, { width: 235, height: 110, ellipsis: true, lineGap: 2 });
  y += 176;
  y = sectionTitle(doc, "Present Land Use and Neighborhood Factors", y);
  y = factsGrid(doc, [
    { label: "One-Unit", value: percent(details.neighborhood_land_use_one_unit_pct) },
    { label: "2-4 Unit", value: percent(details.neighborhood_land_use_two_to_four_pct) },
    { label: "Multi-Family", value: percent(details.neighborhood_land_use_multifamily_pct) },
    { label: "Commercial", value: percent(details.neighborhood_land_use_commercial_pct) },
    { label: "Other / Vacant", value: percent(details.neighborhood_land_use_other_vacant_pct) },
    { label: "Location Type", value: titleCase(details.neighborhood_location_type) },
    { label: "Built-Up", value: titleCase(details.neighborhood_built_up) },
    { label: "Growth", value: titleCase(details.neighborhood_growth) },
    { label: "Market Trend", value: titleCase(details.neighborhood_market_trend) },
    { label: "Demand / Supply", value: titleCase(details.neighborhood_demand_supply) },
    { label: "Marketing Time", value: titleCase(details.neighborhood_marketing_time) },
    { label: "Sales Representativeness", value: percent(details.neighborhood_sales_representativeness_score) },
  ], y, 4);
  y = sectionTitle(doc, "Neighborhood Sales vs. All-Property Profile", y + 2);
  drawTable(doc, {
    y,
    rowHeight: 30,
    columns: [
      { key: "measure", label: "Measure", width: 120 },
      { key: "sale_low", label: "Sales Low", width: 82, align: "right" },
      { key: "sale_med", label: "Sales Median", width: 88, align: "right" },
      { key: "all_low", label: "All Low", width: 78, align: "right" },
      { key: "all_med", label: "All Median", width: 88, align: "right" },
      { key: "deviation", label: "Deviation", width: 72, align: "right" },
    ],
    rows: [
      ["Sale Price", "neighborhood_price_low", "neighborhood_price_predominant", "neighborhood_all_price_low", "neighborhood_all_price_predominant", "neighborhood_representativeness_price_deviation_pct", money],
      ["Price / SF", "neighborhood_ppsf_low", "neighborhood_ppsf_predominant", "neighborhood_all_ppsf_low", "neighborhood_all_ppsf_predominant", "neighborhood_representativeness_ppsf_deviation_pct", money],
      ["Age", "neighborhood_age_low", "neighborhood_age_predominant", "neighborhood_all_age_low", "neighborhood_all_age_predominant", "neighborhood_representativeness_age_deviation_pct", count],
      ["GLA", "neighborhood_gla_low", "neighborhood_gla_predominant", "neighborhood_all_gla_low", "neighborhood_all_gla_predominant", "neighborhood_representativeness_gla_deviation_pct", count],
    ].map(([measure, saleLow, saleMed, allLow, allMed, deviation, formatter]) => ({
      measure,
      sale_low: formatter(details[saleLow]),
      sale_med: formatter(details[saleMed]),
      all_low: formatter(details[allLow]),
      all_med: formatter(details[allMed]),
      deviation: percent(details[deviation]),
    })),
  });
}

function renderMarketPage(doc, meta, snapshot) {
  addPage(doc, meta, "Market Conditions", 4);
  const market = sectionValue(snapshot, "market_conditions");
  const analyses = market?.response?.analyses || [];
  let y = noteBox(doc, analyses.length
    ? `${analyses.length} independent market studies cover ${market.periodMonths || "the selected"} complete months as of ${dateText(market.asOfDate)}. Study areas remain separate from the comparable-sales inventory.`
    : "No completed market conditions analysis was saved for this appraisal file.", 90, { height: 52 });
  y = sectionTitle(doc, "Study Comparison", y);
  y = drawTable(doc, {
    y,
    rowHeight: 36,
    columns: [
      { key: "area", label: "Study Area", width: 170, bold: true },
      { key: "sales", label: "Sales", width: 55, align: "right" },
      { key: "price", label: "Median Price", width: 90, align: "right" },
      { key: "dom", label: "Median DOM", width: 70, align: "right" },
      { key: "ratio", label: "Sale / List", width: 70, align: "right" },
      { key: "ppsf", label: "Price / SF", width: 73, align: "right" },
    ],
    rows: analyses.slice(0, 8).map((analysis) => ({
      area: analysis.market?.label,
      sales: count(analysis.population?.eligible_sale_count),
      price: money(analysis.summary?.median_sale_price),
      dom: count(analysis.summary?.median_days_on_market),
      ratio: percent(analysis.summary?.median_sale_to_list_ratio),
      ppsf: money(analysis.summary?.median_price_per_square_foot),
    })),
  });
  y = sectionTitle(doc, "Monthly Median Sale Price", y + 3);
  const primaryKey = market?.reconciliation?.reliedUponAreaKeys?.[0];
  const primary = analyses.find((analysis) => analysis.market?.key === primaryKey) || analyses[0];
  const monthly = (primary?.series?.monthly || []).filter((point) => numberValue(point.median_sale_price) !== null).slice(-12);
  const maxPrice = Math.max(...monthly.map((point) => numberValue(point.median_sale_price) || 0), 1);
  const chartY = y;
  doc.roundedRect(PAGE.margin, chartY, CONTENT_WIDTH, 160, 5).fillAndStroke("#f8fafc", "#cbd5e1");
  monthly.forEach((point, index) => {
    const width = (CONTENT_WIDTH - 28) / Math.max(monthly.length, 1);
    const value = numberValue(point.median_sale_price) || 0;
    const height = Math.max(4, (value / maxPrice) * 105);
    const x = PAGE.margin + 14 + (index * width);
    doc.rect(x + 2, chartY + 125 - height, Math.max(6, width - 7), height).fill("#0f766e");
    doc.font("Helvetica").fontSize(5.5).fillColor("#475569")
      .text(cleanText(point.period_start || "").slice(5, 7), x, chartY + 131, { width: width, align: "center" });
  });
  y = chartY + 175;
  y = sectionTitle(doc, "Market Reconciliation", y);
  factsGrid(doc, [
    { label: "Trend Conclusion", value: titleCase(market?.reconciliation?.trendConclusion) },
    { label: "Studies Given Weight", value: (market?.reconciliation?.reliedUponAreaKeys || []).join(", ") },
    { label: "Total Studies", value: analyses.length },
    { label: "Analysis As Of", value: dateText(market?.asOfDate) },
  ], y, 4);
  noteBox(doc, market?.reconciliation?.explanation || "The appraiser has not entered a market reconciliation explanation.", y + 64, { height: 58 });
}

function renderSalesPage(doc, meta, snapshot, property) {
  addPage(doc, meta, "Sales Comparison Approach", 5);
  const sales = sectionValue(snapshot, "sales_comparison");
  let y = sectionTitle(doc, "Comparable Location Exhibit", 90);
  plotPoints(doc, reportCoordinates(property, sales), { x: PAGE.margin, y, width: CONTENT_WIDTH, height: 146 });
  y += 160;
  y = sectionTitle(doc, "Comparable Sales Grid", y);
  y = drawTable(doc, {
    y,
    rowHeight: 42,
    fontSize: 6.5,
    columns: [
      { key: "number", label: "#", width: 24 },
      { key: "comparable", label: "Comparable", width: 138, bold: true },
      { key: "date", label: "Sale Date", width: 63 },
      { key: "sale_price", label: "Sale Price", width: 68, align: "right" },
      { key: "gla", label: "GLA", width: 55, align: "right" },
      { key: "rating", label: "C / Q", width: 58 },
      { key: "adjustment", label: "Net Adj.", width: 58, align: "right" },
      { key: "indicated", label: "Indicated", width: 64, align: "right" },
    ],
    rows: comparableRows(sales),
  });
  y = sectionTitle(doc, "Sales Reconciliation", y + 3);
  y = factsGrid(doc, [
    { label: "Selected Comparables", value: (sales.comparables || []).length },
    { label: "Indicated Value", value: money(sales.opinionOfValue) },
    { label: "After Cost to Cure", value: money(sales.opinionAfterCostToCure) },
    { label: "Saved", value: dateText(sales.savedAt) },
  ], y, 4);
  noteBox(doc, sales.salesNotes || sales.adjustmentNotes || "No final sales-comparison narrative was saved.", y, { height: 60 });
}

function renderAdjustmentPage(doc, meta, snapshot, property, images) {
  addPage(doc, meta, "Adjustments, Condition, and Evidence", 6);
  const sales = sectionValue(snapshot, "sales_comparison");
  let y = sectionTitle(doc, "Applied Adjustment Summary", 90);
  y = noteBox(doc, sales.adjustmentNotes || "No adjustment methodology narrative was saved.", y, { height: 66 });
  const adjustmentTotals = {};
  (sales.comparables || []).forEach((item) => Object.entries(item.adjustments || {}).forEach(([key, value]) => {
    adjustmentTotals[key] = (adjustmentTotals[key] || 0) + Math.abs(numberValue(value) || 0);
  }));
  y = factsGrid(doc, Object.entries(adjustmentTotals).slice(0, 8).map(([key, value]) => ({ label: titleCase(key), value: money(value) })), y, 4);
  y = sectionTitle(doc, "Cost to Cure", y + 3);
  y = drawTable(doc, {
    y,
    rowHeight: 30,
    columns: [
      { key: "item", label: "Repair / Deficiency", width: 398 },
      { key: "cost", label: "Cost", width: 130, align: "right" },
    ],
    rows: (sales.costToCure?.items || []).slice(0, 7).map((item) => ({ item: item.description, cost: money(item.cost) })),
  });
  y = factsGrid(doc, [
    { label: "Total Cost to Cure", value: money(sales.costToCure?.total) },
    { label: "Subject Condition", value: sales.subject?.condition },
    { label: "Subject Quality", value: sales.subject?.quality },
    { label: "Opinion After Repairs", value: money(sales.opinionAfterCostToCure) },
  ], y, 4);
  y = sectionTitle(doc, "Comparable Photo References", y + 4);
  const comparableAccounts = (sales.comparables || []).slice(0, 6).map((item) => item.sale?.primary_account_id);
  comparableAccounts.forEach((accountId, index) => {
    const width = 80;
    const gap = 9.6;
    const x = PAGE.margin + (index * (width + gap));
    drawImageOrPlaceholder(doc, images[accountId], x, y, width, 68, `Comp ${index + 1}`);
    doc.font("Helvetica-Bold").fontSize(6).fillColor("#334155").text(`Comp ${index + 1}`, x, y + 72, { width, align: "center" });
  });
}

function approachPage(doc, meta, snapshot, property, type, page) {
  const section = sectionValue(snapshot, `${type}_approach`);
  const developed = Boolean(section?.developed || numberValue(section?.indicated_value) > 0);
  addPage(doc, meta, type === "income" ? "Income Approach" : "Cost Approach", page);
  doc.roundedRect(PAGE.margin, 96, CONTENT_WIDTH, 116, 8).fillAndStroke("#f8fafc", "#cbd5e1");
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a")
    .text(developed ? `${titleCase(type)} Approach Indication` : `${titleCase(type)} Approach Not Developed`, 58, 119, { width: 480 });
  doc.font("Helvetica").fontSize(9).fillColor("#475569")
    .text(cleanText(section?.summary || (type === "income"
      ? "No market rent, vacancy, operating expense, GRM, or capitalization inputs were saved. This approach receives no reconciliation weight."
      : "No replacement cost, site value, depreciation, or obsolescence inputs were saved. This approach receives no reconciliation weight.")), 58, 151, { width: 480, height: 45, ellipsis: true, lineGap: 2 });
  let y = sectionTitle(doc, developed ? "Developed Inputs" : "Required Inputs", 238);
  const cards = type === "income" ? [
    ["Market Rent", section.market_rent],
    ["Vacancy and Collection", section.vacancy_rate == null ? null : percent(section.vacancy_rate)],
    ["Operating Expenses", money(section.operating_expenses)],
    ["GRM / Cap Rate", section.cap_rate == null ? section.grm : percent(section.cap_rate)],
    ["Net Operating Income", money(section.net_operating_income)],
    ["Income Indication", money(section.indicated_value)],
    ["Reconciliation Weight", section.weight == null ? "0%" : percent(section.weight)],
    ["Status", developed ? "Developed" : "Not developed"],
  ] : [
    ["Site Value", money(section.site_value || property.account?.land_value)],
    ["Replacement Cost New", money(section.replacement_cost_new)],
    ["Physical Depreciation", money(section.physical_depreciation)],
    ["Functional Obsolescence", money(section.functional_obsolescence)],
    ["External Obsolescence", money(section.external_obsolescence)],
    ["Cost Indication", money(section.indicated_value)],
    ["Reconciliation Weight", section.weight == null ? "0%" : percent(section.weight)],
    ["Status", developed ? "Developed" : "Not developed"],
  ];
  y = factsGrid(doc, cards.map(([label, value]) => ({ label, value })), y, 4);
  y = sectionTitle(doc, "Methodology and Support", y + 8);
  y = noteBox(doc, section.methodology || (developed
    ? "The saved workfile contains developed inputs. Review the supporting evidence and calculations before delivery."
    : "This reserved section will populate automatically when the approach is developed in the assignment workfile."), y, { height: 88 });
  y = sectionTitle(doc, "Current Conclusion", y + 4);
  factsGrid(doc, [
    { label: "Approach Status", value: developed ? "Developed" : "Not developed" },
    { label: "Indicated Value", value: money(section.indicated_value) },
    { label: "Weight", value: section.weight == null ? "0%" : percent(section.weight) },
    { label: "Appraiser Review", value: developed ? "Required before signing" : "No indication relied upon" },
  ], y, 4);
}

function renderReconciliationPage(doc, meta, snapshot, property) {
  addPage(doc, meta, "Final Reconciliation and Certification", 9);
  const sales = sectionValue(snapshot, "sales_comparison");
  const income = sectionValue(snapshot, "income_approach");
  const cost = sectionValue(snapshot, "cost_approach");
  const final = sectionValue(snapshot, "final_reconciliation");
  const finalValue = numberValue(final.final_value) || numberValue(sales.opinionOfValue);
  let y = sectionTitle(doc, "Approach Reconciliation", 90);
  y = factsGrid(doc, [
    { label: "Sales Comparison", value: money(sales.opinionOfValue) },
    { label: "Income Approach", value: money(income.indicated_value) },
    { label: "Cost Approach", value: money(cost.indicated_value) },
    { label: "Final Opinion of Value", value: money(finalValue) },
  ], y, 4);
  y = noteBox(doc, final.explanation || sales.salesNotes || "The final value is reconciled to the Sales Comparison Approach because no other developed approach was saved in this workfile.", y + 8, { height: 86 });
  y = sectionTitle(doc, "Appraiser Certification", y + 4);
  const certification = final.certification || "I certify that, to the best of my knowledge and belief, the statements of fact contained in this report are true and correct; the analyses, opinions, and conclusions are limited only by the reported assumptions and limiting conditions; and I have no undisclosed present or prospective interest in the property that is the subject of this report.";
  y = noteBox(doc, certification, y, { height: 112 });
  y = sectionTitle(doc, "Signature and Immutable Record", y + 4);
  y = factsGrid(doc, [
    { label: "Appraiser", value: meta.signedBy },
    { label: "Signed", value: dateText(meta.signedAt) },
    { label: "File Number", value: meta.fileNumber },
    { label: "Report Status", value: meta.status },
  ], y, 4);
  doc.font("Helvetica-Bold").fontSize(7).fillColor("#64748b").text("WORKFILE SHA-256", PAGE.margin, y + 12);
  doc.font("Courier").fontSize(6.5).fillColor("#0f172a").text(cleanText(meta.checksum, "Draft - checksum assigned at finalization"), PAGE.margin, y + 26, { width: CONTENT_WIDTH, characterSpacing: 0.3 });
  y += 58;
  const readiness = customAppraisalReportReadinessErrors(snapshot, property);
  noteBox(doc, readiness.length ? `E&O REVIEW INCOMPLETE: ${readiness.join(" ")}` : "E&O READINESS COMPLETE: assignment type, confirmed neighborhood boundary, market conditions, comparable selection, and value reconciliation were present when this report was generated.", y, { color: readiness.length ? "#dc2626" : "#047857", height: 64 });
}

export async function renderCustomAppraisalReportPdf({ snapshot, property, images = {}, checksum = null }) {
  if (!snapshot || !property?.account) throw new Error("invalid_custom_appraisal_report_payload");
  const meta = reportMeta(snapshot, property, checksum);
  const timestampValue = snapshot.signed_at || property.captured_at || "2000-01-01T00:00:00.000Z";
  const timestamp = new Date(timestampValue);
  const safeTimestamp = Number.isNaN(timestamp.valueOf()) ? new Date("2000-01-01T00:00:00.000Z") : timestamp;
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: true,
    info: {
      Title: `${meta.fileNumber} Appraisal Report`,
      Author: REPORT_ENGINE,
      Subject: `${meta.address} Custom Appraisal`,
      Keywords: "appraisal, workfile, sales comparison, market conditions",
      CreationDate: safeTimestamp,
      ModDate: safeTimestamp,
    },
  });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  renderPropertyPage(doc, meta, snapshot, property, images);
  renderCharacteristicsPage(doc, meta, property);
  renderNeighborhoodPage(doc, meta, snapshot, property);
  renderMarketPage(doc, meta, snapshot);
  renderSalesPage(doc, meta, snapshot, property);
  renderAdjustmentPage(doc, meta, snapshot, property, images);
  approachPage(doc, meta, snapshot, property, "income", 7);
  approachPage(doc, meta, snapshot, property, "cost", 8);
  renderReconciliationPage(doc, meta, snapshot, property);
  doc.end();
  return complete;
}

export async function buildCustomAppraisalReportPdf(client, {
  accountId,
  assignmentFileId,
  snapshot,
  workfileChecksum = null,
  includeExternalImages = true,
}) {
  const property = snapshot?.evidence?.property_report_data || await loadCustomAppraisalPropertySnapshot(client, { accountId, assignmentFileId });
  const images = includeExternalImages ? await reportImages(client, snapshot, property).catch(() => ({})) : {};
  const content = await renderCustomAppraisalReportPdf({ snapshot, property, images, checksum: workfileChecksum });
  return {
    content,
    content_sha256: createHash("sha256").update(content).digest("hex"),
    canonical_file_name: canonicalPdfFileName(snapshot),
    page_count: REPORT_PAGE_COUNT,
    report_version: REPORT_VERSION,
    generated_by: REPORT_ENGINE,
  };
}

export async function ensureSignedCustomAppraisalReportArtifact(pool, {
  accountId,
  assignmentFileId,
  snapshot,
  signedSnapshotId,
  workfileChecksum,
}) {
  await ensureCustomAppraisalReportArtifactSchema(pool);
  const existing = await pool.query(
    `SELECT canonical_file_name, report_version, workfile_checksum_sha256,
            content_sha256, content, byte_size, page_count, generated_by, generated_at
       FROM app.custom_appraisal_report_artifacts WHERE assignment_file_id = $1`,
    [assignmentFileId],
  );
  if (existing.rows.length) return existing.rows[0];
  const report = await buildCustomAppraisalReportPdf(pool, {
    accountId,
    assignmentFileId,
    snapshot,
    workfileChecksum,
  });
  const inserted = await pool.query(
    `INSERT INTO app.custom_appraisal_report_artifacts (
       assignment_file_id, signed_snapshot_id, canonical_file_name, report_version,
       workfile_checksum_sha256, content_sha256, content, byte_size, page_count, generated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (assignment_file_id) DO UPDATE SET assignment_file_id = EXCLUDED.assignment_file_id
     RETURNING canonical_file_name, report_version, workfile_checksum_sha256,
               content_sha256, content, byte_size, page_count, generated_by, generated_at`,
    [assignmentFileId, signedSnapshotId, report.canonical_file_name, report.report_version,
      workfileChecksum, report.content_sha256, report.content, report.content.length,
      report.page_count, report.generated_by],
  );
  return inserted.rows[0];
}

export async function getCustomAppraisalReportPdf(pool, {
  accountId,
  assignmentFileId,
  download,
}) {
  await ensureCustomAppraisalReportArtifactSchema(pool);
  if (download.immutable) {
    const signed = await pool.query(
      `SELECT id, snapshot, checksum_sha256 FROM app.custom_appraisal_signed_snapshots
        WHERE assignment_file_id = $1`,
      [assignmentFileId],
    );
    if (!signed.rows.length) throw new Error("custom_appraisal_signed_snapshot_not_found");
    const artifact = await ensureSignedCustomAppraisalReportArtifact(pool, {
      accountId,
      assignmentFileId,
      snapshot: signed.rows[0].snapshot,
      signedSnapshotId: signed.rows[0].id,
      workfileChecksum: signed.rows[0].checksum_sha256,
    });
    return { ...artifact, immutable: true };
  }
  const property = await loadCustomAppraisalPropertySnapshot(pool, { accountId, assignmentFileId });
  const draftSnapshot = {
    ...download.snapshot,
    status: "draft",
    assignment: property.assignment,
    evidence: { ...(download.snapshot.evidence || {}), property_report_data: property },
  };
  const report = await buildCustomAppraisalReportPdf(pool, {
    accountId,
    assignmentFileId,
    snapshot: draftSnapshot,
    includeExternalImages: true,
  });
  return { ...report, byte_size: report.content.length, generated_at: new Date().toISOString(), immutable: false };
}

export const CUSTOM_APPRAISAL_REPORT_PAGE_COUNT = REPORT_PAGE_COUNT;
