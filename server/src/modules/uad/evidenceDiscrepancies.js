// Review prompts only. These comparisons never alter the document, public record,
// or appraisal. A conflict can reflect a real change between effective dates.
const MAX_DOCUMENTS = 100;
const MAX_CANDIDATES = 5_000;
const MAX_PAGES = 1_000;
const PAGE_TEXT_LIMIT = 12_000;

const LABELS = Object.freeze({
  legal_description: "Legal description",
  county: "County",
  city: "City",
  postal_code: "ZIP code",
  owner_name: "Owner of record",
  zoning_code: "Zoning code",
  year_built: "Year built",
  bedrooms: "Bedrooms",
  full_baths: "Full bathrooms",
  half_baths: "Half bathrooms",
  unit_count: "Dwelling units",
  living_area_sqft: "Living area",
  site_area_sqft: "Site area",
  attachment_type: "Attached or detached",
  stories: "Stories",
  garage_spaces: "Garage spaces",
  foundation_type: "Foundation",
  roof_material: "Roof material",
  exterior_material: "Exterior material",
  solar_panels: "Solar panels",
  outbuildings: "Outbuildings",
});

function clean(value, limit = 600) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function numeric(value) {
  const source = clean(value, 80).replace(/,/g, "");
  return /^\d+(?:\.\d+)?$/.test(source) ? Number(source) : null;
}

function normalize(field, value) {
  const source = clean(value);
  if (!source) return null;
  if (field === "county") return source.toLowerCase().replace(/\s+county$/i, "").trim();
  if (field === "postal_code") {
    const match = source.match(/^\d{5}(?:-?\d{4})?$/);
    return match ? source.slice(0, 5) : null;
  }
  if (field === "site_area_sqft") {
    const area = source.match(/^([\d,]+(?:\.\d+)?)\s*(acres?|ac|sq\.?\s*ft\.?|square\s+feet|sf)$/i);
    if (!area) return null;
    const amount = numeric(area[1]);
    const squareFeet = /^ac/i.test(area[2]) ? amount * 43_560 : amount;
    return Number.isFinite(squareFeet) && squareFeet > 0 ? String(Math.round(squareFeet)) : null;
  }
  if (["year_built", "bedrooms", "full_baths", "half_baths", "unit_count", "living_area_sqft", "stories", "garage_spaces"].includes(field)) {
    const number = numeric(source);
    return number !== null && Number.isFinite(number) && number >= 0 ? String(number) : null;
  }
  if (field === "attachment_type") {
    const type = source.toLowerCase();
    return ["attached", "detached"].includes(type) ? type : null;
  }
  if (field === "solar_panels") {
    const state = source.toLowerCase();
    if (["yes", "y", "present", "installed", "true"].includes(state)) return "yes";
    if (["no", "n", "none", "absent", "false"].includes(state)) return "no";
    return null;
  }
  return source.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || null;
}

function addClaim(claims, document, field, value, pageNumber, origin, coverage = null) {
  if (!LABELS[field]) return;
  const display = clean(value, field === "legal_description" ? 1_000 : 300);
  const normalized = normalize(field, display);
  if (!normalized) return;
  // A document can repeat one fact on many pages. A different value in the
  // same document is retained and reported too, rather than being hidden.
  const sameField = claims.filter((claim) => claim.document_id === document.id && claim.field_key === field);
  if (sameField.some((claim) => claim.normalized_value === normalized)) return;
  if (sameField.length >= (field === "owner_name" && document.id === null ? 20 : 2)) {
    if (coverage) coverage.incomplete = true;
    return;
  }
  claims.push({
    document_id: document.id,
    document_title: clean(document.title, 200),
    field_key: field,
    value: display,
    normalized_value: normalized,
    page_number: pageNumber == null ? null : Number(pageNumber),
    origin,
  });
}

function addressParts(value) {
  const source = clean(value, 400);
  const match = source.match(/,\s*([^,]+?),?\s+[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/i);
  return match ? { city: clean(match[1]), postal_code: match[2] } : null;
}

function pageClaims(claims, document, page, coverage, candidateFields) {
  if (["zoning_map", "zoning_ordinance", "map"].includes(document.document_type)) return;
  const lines = String(page.extracted_text || "").split(/\r?\n/).slice(0, 2_000);
  const definitions = [
    ["legal_description", /^(?:subject\s+)?legal(?:\s+(?:description|desc\.?))?[\s:#-]+(.+)$/i],
    ["county", /^(?:(?:subject|property|site)\s+)?county[\s:#-]+(.+)$/i],
    ["city", /^(?:subject|property|site|situs)\s+city[\s:#-]+(.+)$/i],
    ["postal_code", /^(?:subject|property|site|situs)\s+(?:zip(?:\s+code)?|postal\s+code)[\s:#-]+(\d{5}(?:-?\d{4})?)\b/i],
    ["owner_name", /^(?:(?:current|public\s+record)\s+)?owner(?:\s+of\s+(?:public\s+)?record)?(?:\s+name|\(s\))?[\s:#-]+(.+)$/i],
    ["zoning_code", /^(?:(?:subject|property|current)\s+)?zoning(?:\s+(?:district|code|classification))?[\s:#-]+([A-Za-z0-9-]+)\b/i],
    ["year_built", /^(?:subject\s+)?(?:year|yr)\s+built[\s:#-]+(\d{4})\b/i],
    ["bedrooms", /^(?:subject\s+)?(?:bedrooms?|beds?)[\s:#-]+(\d+)\b/i],
    ["full_baths", /^(?:subject\s+)?full\s+(?:baths?|bathrooms?)[\s:#-]+(\d+)\b/i],
    ["half_baths", /^(?:subject\s+)?half\s+(?:baths?|bathrooms?)[\s:#-]+(\d+)\b/i],
    ["unit_count", /^(?:subject\s+)?(?:number\s+of\s+units|dwelling\s+units|unit\s+count)[\s:#-]+(\d+)\b/i],
    ["living_area_sqft", /^(?:subject\s+)?(?:gross\s+living\s+area|living\s+area|gla)[\s:#-]+([\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*ft\.?|square\s+feet|sf)?\b/i],
    ["site_area_sqft", /^(?:subject\s+)?(?:site\s+area|lot\s+size|land\s+area)[\s:#-]+([\d,]+(?:\.\d+)?)\s*(acres?|ac|sq\.?\s*ft\.?|square\s+feet|sf)\b/i],
    ["attachment_type", /^(?:subject\s+)?(?:attachment\s+type|attached\s+or\s+detached)[\s:#-]+(attached|detached)\b/i],
    ["stories", /^(?:subject\s+)?(?:stories|number\s+of\s+stories)[\s:#-]+(\d+(?:\.\d+)?)\b/i],
    ["garage_spaces", /^(?:subject\s+)?(?:garage\s+spaces|garage\s+capacity)[\s:#-]+(\d+)\b/i],
    ["foundation_type", /^(?:subject\s+)?foundation(?:\s+type)?[\s:#-]+(.+)$/i],
    ["roof_material", /^(?:subject\s+)?roof\s+(?:material|covering)[\s:#-]+(.+)$/i],
    ["exterior_material", /^(?:subject\s+)?exterior\s+(?:wall\s+)?material[\s:#-]+(.+)$/i],
    ["solar_panels", /^(?:subject\s+)?solar\s+panels?[\s:#-]+(yes|no|present|installed|none|absent)\b/i],
    ["outbuildings", /^(?:subject\s+)?outbuildings?[\s:#-]+(.+)$/i],
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = clean(lines[index], 1_200);
    if (!line) continue;
    if (/^(?:subject\s+)?legal(?:\s+(?:description|desc\.?))?\s*[:#-]?$/i.test(line)) {
      const continuation = [];
      for (const next of lines.slice(index + 1, index + 4)) {
        const text = clean(next, 300);
        if (!text || /^[\w\s]{2,40}\s*[:#-]\s*\S/.test(text)) break;
        continuation.push(text);
      }
      if (continuation.length) addClaim(claims, document, "legal_description",
        continuation.join(" "), page.page_number, "labeled_text", coverage);
    }
    for (const [field, pattern] of definitions) {
      if (field === "zoning_code" && candidateFields.has("zoning_code")) continue;
      const match = line.match(pattern);
      if (match) addClaim(claims, document, field,
        field === "site_area_sqft" ? `${match[1]} ${match[2]}` : match[1],
        page.page_number, "labeled_text", coverage);
    }
    const address = line.match(/^(?:subject|property|situs)\s+address[\s:#-]+(.+)$/i);
    const parts = address && !candidateFields.has("subject_property_address") && addressParts(address[1]);
    if (parts) {
      addClaim(claims, document, "city", parts.city, page.page_number, "subject_address", coverage);
      addClaim(claims, document, "postal_code", parts.postal_code, page.page_number, "subject_address", coverage);
    }
  }
}

function snapshotClaims(snapshot, coverage) {
  const account = snapshot?.account || {};
  const improvement = snapshot?.primary_improvements || {};
  const legal = snapshot?.legal_description || {};
  const legalText = legal.legal_text || (Array.isArray(legal.legal_lines)
    && legal.legal_lines.every((line) => typeof line === "string")
    ? legal.legal_lines.filter((line) => line.trim()).join(" ") : null);
  const source = { id: null, title: "Saved HomeNode subject record" };
  const claims = [];
  for (const [field, value] of [
    ["county", account.county], ["city", account.city], ["postal_code", account.postal_code],
    ["legal_description", legalText || account.legal_description],
    ["year_built", improvement.year_built], ["bedrooms", improvement.bedroom_count],
    ["full_baths", improvement.baths_full], ["half_baths", improvement.baths_half],
    ["unit_count", improvement.number_units],
    ["attachment_type", snapshot?.housing_profile?.attachment_type],
  ]) addClaim(claims, source, field, value, null, "subject_snapshot", coverage);
  const owners = Array.isArray(snapshot?.owner_parties) ? snapshot.owner_parties : [];
  if (owners.length) {
    for (const owner of owners) addClaim(claims, source, "owner_name", owner.owner_name, null, "subject_snapshot", coverage);
  } else {
    addClaim(claims, source, "owner_name", snapshot?.owner_summary?.owner_name, null, "subject_snapshot", coverage);
  }
  return claims;
}

export function buildUadEvidenceDiscrepancies({ documents = [], candidates = [], pages = [], snapshot = null, incomplete = false } = {}) {
  const byId = new Map(documents.map((document) => [Number(document.id), document]));
  const claims = [];
  const coverage = { incomplete: Boolean(incomplete) };
  const candidateFieldsByDocument = new Map();
  for (const candidate of candidates) {
    const document = byId.get(Number(candidate.document_id));
    if (!document) continue;
    if (!candidateFieldsByDocument.has(document.id)) candidateFieldsByDocument.set(document.id, new Set());
    candidateFieldsByDocument.get(document.id).add(candidate.field_key);
    if (candidate.review_status === "rejected") continue;
    const value = candidate.review_status === "confirmed"
      ? candidate.confirmed_value || candidate.normalized_value || candidate.raw_value
      : candidate.normalized_value || candidate.raw_value;
    if (candidate.field_key === "zoning_code") {
      addClaim(claims, document, "zoning_code", value, candidate.page_number, "extracted_candidate", coverage);
    } else if (candidate.field_key === "subject_property_address") {
      const parts = addressParts(value);
      if (parts) {
        addClaim(claims, document, "city", parts.city, candidate.page_number, "subject_address", coverage);
        addClaim(claims, document, "postal_code", parts.postal_code, candidate.page_number, "subject_address", coverage);
      }
    }
  }
  for (const page of pages) {
    const document = byId.get(Number(page.document_id));
    if (document) pageClaims(claims, document, page, coverage,
      candidateFieldsByDocument.get(document.id) || new Set());
  }
  const reference = snapshotClaims(snapshot, coverage);
  const discrepancies = Object.fromEntries(documents.map((document) => [document.id, []]));
  const compared = [...claims, ...reference];
  const byField = new Map();
  for (const item of compared) {
    if (!byField.has(item.field_key)) byField.set(item.field_key, []);
    byField.get(item.field_key).push(item);
  }
  const ownerNamesByDocument = new Map();
  for (const item of byField.get("owner_name") || []) {
    if (!ownerNamesByDocument.has(item.document_id)) ownerNamesByDocument.set(item.document_id, new Set());
    ownerNamesByDocument.get(item.document_id).add(item.normalized_value);
  }
  for (const claim of claims) {
    for (const other of byField.get(claim.field_key) || []) {
      if (claim === other
        || claim.document_id === other.document_id
        || claim.normalized_value === other.normalized_value) continue;
      // Several owners may legitimately appear in one record. A name present
      // among the saved owners is enough; never compare seller with owner.
      if (claim.field_key === "owner_name" && other.document_id === null
        && reference.some((item) => item.field_key === "owner_name" && item.normalized_value === claim.normalized_value)) continue;
      if (claim.field_key === "owner_name" && other.document_id !== null
        && [...(ownerNamesByDocument.get(claim.document_id) || [])].some((name) => (
          ownerNamesByDocument.get(other.document_id)?.has(name)
        ))) continue;
      const items = discrepancies[claim.document_id];
      if (items.length >= 40) {
        coverage.incomplete = true;
        continue;
      }
      if (items.some((item) => item.field_key === claim.field_key
        && item.other_document_id === other.document_id && item.other_value === other.value)) continue;
      items.push({
        field_key: claim.field_key,
        field_label: LABELS[claim.field_key],
        document_value: claim.value,
        document_page: claim.page_number,
        other_document_id: other.document_id,
        other_document_title: other.document_title,
        other_value: other.value,
        other_page: other.page_number,
        source: other.document_id === null ? "saved_subject_record" : "uploaded_document",
      });
    }
  }
  return { discrepancies, incomplete: coverage.incomplete };
}

export async function loadUadEvidenceDiscrepancies(pool, workfileId) {
  const documentsResult = await pool.query(
    `SELECT id, title, document_type, processing_status
       FROM app.assignment_documents
      WHERE uad_workfile_id = $1
      ORDER BY id DESC LIMIT $2`,
    [workfileId, MAX_DOCUMENTS + 1],
  );
  const overflow = documentsResult.rows.length > MAX_DOCUMENTS;
  const documents = documentsResult.rows.slice(0, MAX_DOCUMENTS);
  if (!documents.length) return { discrepancies: {}, incomplete: false };
  // The document-detail endpoint is polled during extraction. Wait until all
  // visible documents finish before reading their pages and candidates; the
  // next completed response performs the full comparison.
  if (documents.some((document) => ["uploaded", "processing"].includes(document.processing_status))) {
    return { discrepancies: {}, incomplete: true };
  }
  const ids = documents.map((document) => document.id);
  const [candidateResult, pageResult, snapshotResult] = await Promise.all([
    pool.query(
      `SELECT document_id, field_key, raw_value, normalized_value, confirmed_value,
              review_status, page_number
         FROM app.assignment_document_field_candidates
        WHERE document_id = ANY($1::bigint[])
          AND field_key IN ('zoning_code', 'subject_property_address')
        ORDER BY document_id, id LIMIT $2`, [ids, MAX_CANDIDATES + 1],
    ),
    pool.query(
      `SELECT document_id, page_number, left(extracted_text, $2) AS extracted_text,
              char_length(extracted_text) > $2 AS text_truncated
         FROM app.assignment_document_pages
        WHERE document_id = ANY($1::bigint[])
        ORDER BY document_id, page_number LIMIT $3`, [ids, PAGE_TEXT_LIMIT, MAX_PAGES + 1],
    ),
    pool.query(
      `SELECT subject_data FROM appraisal.uad_subject_snapshots
        WHERE workfile_id = $1 ORDER BY snapshot_version DESC LIMIT 1`, [workfileId],
    ),
  ]);
  const incomplete = overflow || candidateResult.rows.length > MAX_CANDIDATES
    || pageResult.rows.length > MAX_PAGES
    || pageResult.rows.some((page) => page.text_truncated)
    || documents.some((document) => ["uploaded", "processing", "ocr_required", "extraction_failed"].includes(document.processing_status));
  return buildUadEvidenceDiscrepancies({
    documents,
    candidates: candidateResult.rows.slice(0, MAX_CANDIDATES),
    pages: pageResult.rows.slice(0, MAX_PAGES),
    snapshot: snapshotResult.rows[0]?.subject_data,
    incomplete,
  });
}
