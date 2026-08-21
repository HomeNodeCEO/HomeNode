import { extractText, getDocumentProxy } from "unpdf";

export const DOCUMENT_TYPES = Object.freeze([
  "zoning_map",
  "zoning_ordinance",
  "purchase_contract",
  "engagement_letter",
  "mls_sheet",
  "map",
  "other",
]);

const DOCUMENT_TYPE_SET = new Set(DOCUMENT_TYPES);
const MAX_PDF_PAGES = 250;
const MAX_EXTRACTED_TEXT_LENGTH = 4_000_000;

function cleanText(value, maximum = MAX_EXTRACTED_TEXT_LENGTH) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maximum);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedMoney(value) {
  if (/^(?:none|no|n\/a|not applicable|zero)$/i.test(String(value || "").trim())) return "0.00";
  if (/%/.test(String(value || "")) && !/\$/.test(String(value || ""))) return null;
  const match = String(value || "").match(/\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount.toFixed(2) : null;
}

function normalizedDate(value) {
  const source = cleanText(value, 200);
  if (!source) return null;
  const numeric = source.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\b/);
  let year;
  let month;
  let day;
  if (numeric) {
    month = Number(numeric[1]);
    day = Number(numeric[2]);
    year = Number(numeric[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
  } else {
    const parsed = new Date(source);
    if (Number.isNaN(parsed.getTime())) return null;
    year = parsed.getUTCFullYear();
    month = parsed.getUTCMonth() + 1;
    day = parsed.getUTCDate();
  }
  const verified = new Date(Date.UTC(year, month - 1, day));
  if (
    verified.getUTCFullYear() !== year ||
    verified.getUTCMonth() + 1 !== month ||
    verified.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizedAssignmentType(value) {
  const source = cleanText(value, 300).toLowerCase();
  if (/\bpurchase\b|acquisition/.test(source)) return "purchase_transaction";
  if (/\brefinance\b|\brefi\b/.test(source)) return "refinance";
  if (/\bheloc\b|home\s+equity\s+line/.test(source)) return "heloc";
  if (/\brtl\b|residential\s+transition/.test(source)) return "rtl";
  if (/\brehab\b|renovation/.test(source)) return "rehab";
  if (/bridge/.test(source)) return "bridge_loan";
  if (/new\s+construction|construction\s+loan/.test(source)) return "new_construction";
  if (/\bdscr\b|debt\s+service\s+coverage/.test(source)) return "dscr";
  return null;
}

function pageLines(pages) {
  return pages.flatMap((text, pageIndex) => cleanText(text, 500_000)
    .split("\n")
    .map((line, lineIndex) => ({
      pageNumber: pageIndex + 1,
      lineIndex,
      line: line.trim(),
    }))
    .filter((entry) => entry.line));
}

function firstLabeledCandidate(entries, {
  fieldKey,
  labels,
  confidence = 0.86,
  normalize = (value) => value,
}) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    for (const label of labels) {
      const match = entry.line.match(label);
      if (!match) continue;
      const sameLineValue = cleanText(match[1] || "", 2_000);
      const nextEntry = entries[index + 1];
      const rawValue = sameLineValue || (
        nextEntry?.pageNumber === entry.pageNumber ? cleanText(nextEntry.line, 2_000) : ""
      );
      if (!rawValue) continue;
      const normalizedValue = normalize(rawValue);
      if (normalizedValue == null || normalizedValue === "") continue;
      return {
        field_key: fieldKey,
        raw_value: rawValue,
        normalized_value: String(normalizedValue),
        page_number: entry.pageNumber,
        confidence,
        evidence_excerpt: sameLineValue
          ? entry.line
          : `${entry.line} ${nextEntry.line}`.slice(0, 2_000),
        extraction_method: "labeled_text",
      };
    }
  }
  return null;
}

export function normalizeDocumentType(value) {
  const normalized = String(value || "other").trim().toLowerCase();
  if (!DOCUMENT_TYPE_SET.has(normalized)) throw new Error("invalid_document_type");
  return normalized;
}

export function classifyDocument({ requestedType = "other", fileName = "", pages = [] } = {}) {
  const normalizedRequested = normalizeDocumentType(requestedType);
  if (normalizedRequested !== "other") return normalizedRequested;
  const sample = `${fileName}\n${pages.join("\n").slice(0, 80_000)}`.toLowerCase();
  if (/zoning\s+(?:map|district)|official\s+zoning\s+map/.test(sample)) return "zoning_map";
  if (/zoning\s+(?:ordinance|code)|development\s+code/.test(sample)) return "zoning_ordinance";
  if (/one\s+to\s+four\s+family\s+residential\s+contract|earnest\s+money|purchase\s+contract/.test(sample)) {
    return "purchase_contract";
  }
  if (/engagement\s+letter|appraisal\s+assignment|scope\s+of\s+work/.test(sample)) {
    return "engagement_letter";
  }
  if (/multiple\s+listing\s+service|\bmls\s*(?:#|number|no\.)|days\s+on\s+market/.test(sample)) {
    return "mls_sheet";
  }
  return "other";
}

export function findZoningDescriptionInPages(pages, zoningCode) {
  const code = cleanText(zoningCode, 200);
  if (!code) return null;
  const codePattern = new RegExp(
    `(?:^|\\s)${escapeRegExp(code)}(?:\\s|$|[-:\u2013\u2014])`,
    "i",
  );
  const entries = pageLines(pages);
  for (const entry of entries) {
    if (!codePattern.test(entry.line)) continue;
    const direct = entry.line.match(new RegExp(
      `(?:^|\\s)${escapeRegExp(code)}\\s*(?:-|:|\\u2013|\\u2014)\\s*(.{3,})$`,
      "i",
    ));
    if (direct?.[1]) {
      return {
        field_key: "zoning_description",
        raw_value: cleanText(direct[1], 2_000),
        normalized_value: cleanText(direct[1], 2_000),
        page_number: entry.pageNumber,
        confidence: 0.78,
        evidence_excerpt: entry.line.slice(0, 2_000),
        extraction_method: "zoning_code_context",
      };
    }
  }
  return null;
}

export function buildDocumentFieldCandidates({ documentType, pages }) {
  const entries = pageLines(pages);
  const definitions = [
    {
      fieldKey: "zoning_code",
      labels: [
        /^(?:current\s+)?zoning(?:\s+(?:district|code|classification))?\s*(?:[:#-]|\bis\b)\s*(.+)$/i,
      ],
    },
    {
      fieldKey: "zoning_description",
      labels: [/^(?:zoning|district)\s+(?:description|name|use)\s*[:#-]\s*(.+)$/i],
    },
    {
      fieldKey: "contract_price",
      labels: [/^(?:sales?|contract|purchase)\s+price\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedMoney,
    },
    {
      fieldKey: "contract_date",
      labels: [/^(?:contract|effective)\s+date\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedDate,
    },
    {
      fieldKey: "closing_date",
      labels: [/^(?:closing|settlement)\s+date\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedDate,
    },
    {
      fieldKey: "loan_amount",
      labels: [/^loan\s+amount\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedMoney,
    },
    {
      fieldKey: "down_payment",
      labels: [/^down\s+payment\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedMoney,
    },
    {
      fieldKey: "earnest_money",
      labels: [/^earnest\s+money\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedMoney,
    },
    {
      fieldKey: "seller_concessions",
      labels: [/^(?:seller\s+)?concessions?\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedMoney,
    },
    {
      fieldKey: "seller_name",
      labels: [/^seller(?:\(s\))?\s*[:#-]\s*(.+)$/i],
    },
    {
      fieldKey: "buyer_name",
      labels: [/^(?:buyer|borrower)(?:\(s\))?\s*[:#-]\s*(.+)$/i],
    },
    {
      fieldKey: "lender_client_name",
      labels: [/^(?:lender|client|prepared\s+for)\s*[:#-]\s*(.+)$/i],
    },
    {
      fieldKey: "lender_client_address",
      labels: [/^(?:lender|client)\s+address\s*[:#-]\s*(.+)$/i],
    },
    {
      fieldKey: "assignment_type",
      labels: [/^(?:assignment|transaction|loan)\s+(?:type|purpose)\s*[:#-]\s*(.+)$/i],
      normalize: normalizedAssignmentType,
    },
    {
      fieldKey: "mls_number",
      labels: [/^(?:mls|listing)\s*(?:#|number|no\.)\s*[:#-]?\s*(.+)$/i],
    },
    {
      fieldKey: "list_price",
      labels: [/^(?:original\s+)?list\s+price\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedMoney,
    },
    {
      fieldKey: "list_date",
      labels: [/^list(?:ing)?\s+date\s*[:#-]?\s*(.+)$/i],
      normalize: normalizedDate,
    },
    {
      fieldKey: "financing_type",
      labels: [/^(?:financing|loan)\s+type\s*[:#-]?\s*(.+)$/i],
    },
  ];
  const allowedFields = {
    zoning_map: new Set(["zoning_code", "zoning_description"]),
    zoning_ordinance: new Set(["zoning_code", "zoning_description"]),
    purchase_contract: new Set([
      "contract_price", "contract_date", "closing_date", "loan_amount",
      "down_payment", "earnest_money", "seller_concessions", "seller_name",
      "buyer_name", "financing_type",
    ]),
    engagement_letter: new Set(["lender_client_name", "lender_client_address", "assignment_type"]),
    mls_sheet: new Set([
      "mls_number", "list_price", "list_date", "contract_date", "closing_date",
      "financing_type", "seller_concessions",
    ]),
  }[documentType] || null;
  const candidates = definitions
    .filter((definition) => !allowedFields || allowedFields.has(definition.fieldKey))
    .map((definition) => firstLabeledCandidate(entries, definition))
    .filter(Boolean);

  if (documentType === "purchase_contract" && !candidates.some((candidate) => candidate.field_key === "assignment_type")) {
    const purchaseEvidence = entries.find((entry) => (
      /one\s+to\s+four\s+family\s+residential\s+contract|purchase\s+contract|earnest\s+money/i.test(entry.line)
    ));
    if (purchaseEvidence) {
      candidates.push({
        field_key: "assignment_type",
        raw_value: "Purchase Transaction",
        normalized_value: "purchase_transaction",
        page_number: purchaseEvidence.pageNumber,
        confidence: 0.95,
        evidence_excerpt: purchaseEvidence.line.slice(0, 2_000),
        extraction_method: "document_classification",
      });
    }
  }

  if (["zoning_map", "zoning_ordinance"].includes(documentType)) {
    const zoning = candidates.find((candidate) => candidate.field_key === "zoning_code");
    if (zoning && !candidates.some((candidate) => candidate.field_key === "zoning_description")) {
      const suggestion = findZoningDescriptionInPages(pages, zoning.raw_value);
      if (suggestion) candidates.push(suggestion);
    }
  }
  return candidates;
}

export async function extractPdfEvidence(buffer, {
  requestedType = "other",
  fileName = "",
  ocrProvider = null,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("document_not_pdf");
  }
  const bytes = new Uint8Array(buffer);
  const pdf = await getDocumentProxy(bytes);
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error("document_page_limit_exceeded");
    const extracted = await extractText(pdf, { mergePages: false });
    let pages = (Array.isArray(extracted.text) ? extracted.text : [extracted.text])
      .map((text) => cleanText(text, 500_000));
    let textLength = pages.reduce((sum, text) => sum + text.length, 0);
    let extractionMethod = textLength >= 40 ? "pdf_text" : "none";
    let ocrMetadata = null;
    if (textLength < 40 && ocrProvider?.configured) {
      const ocrResult = await ocrProvider.analyzePdf(buffer);
      pages = (Array.isArray(ocrResult?.pages) ? ocrResult.pages : [])
        .slice(0, MAX_PDF_PAGES)
        .map((text) => cleanText(text, 500_000));
      textLength = pages.reduce((sum, text) => sum + text.length, 0);
      extractionMethod = textLength >= 40
        ? cleanText(ocrResult?.extraction_method, 100) || "configured_ocr"
        : "ocr_no_reliable_text";
      ocrMetadata = {
        provider: ocrResult?.provider || "configured_ocr",
        model_id: ocrResult?.model_id || null,
        api_version: ocrResult?.api_version || null,
        operation_id: ocrResult?.operation_id || null,
      };
    }
    const documentType = classifyDocument({ requestedType, fileName, pages });
    const candidates = buildDocumentFieldCandidates({ documentType, pages })
      .map((candidate) => (ocrMetadata ? {
        ...candidate,
        extraction_method: `${extractionMethod}:${candidate.extraction_method}`,
      } : candidate));
    return {
      document_type: documentType,
      page_count: extracted.totalPages,
      extraction_status: textLength >= 40 ? "review_required" : "ocr_required",
      extraction_method: extractionMethod,
      text_length: textLength,
      pages,
      candidates,
      ocr_metadata: ocrMetadata,
      review_reason: textLength >= 40
        ? `${ocrMetadata ? "OCR-extracted" : "Machine-extracted"} values are suggestions and require appraiser confirmation.`
        : "No reliable text was found after available extraction. Visual review is required.",
    };
  } finally {
    await pdf.cleanup?.();
    await pdf.destroy?.();
  }
}
