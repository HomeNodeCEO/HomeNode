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

// Persist this with every extraction so documents created before a parser
// improvement can be upgraded exactly once from their immutable source PDF.
export const DOCUMENT_EXTRACTION_SCHEMA_VERSION = "2026-09-02-v3";

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

function normalizedInteger(value, maximum = 9_999) {
  const match = String(value || "").match(/\b(\d{1,6})\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum
    ? String(parsed)
    : null;
}

function mlsListingLifecycle(value) {
  const source = cleanText(value, 100).toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!source) return null;
  if (/^(?:p|pend|pnd|pending|cont|contingent|uc|under contract|aoc|active option|active option contract|active contingent|active under contract|option pending|pending continue to show|pending taking backups)$/.test(source)) return "pending";
  if (/^(?:s|sld|sold|cls|closed)$/.test(source)) return "sold";
  if (/^(?:tom|temporarily off market|off market|exp|expired|wdn|withdrawn|can|cancelled|canceled)$/.test(source)) return "offmarket";
  if (/^(?:a|act|active|available|cs|coming soon)$/.test(source)) return "active";
  return null;
}

function normalizedListingStatus(value) {
  const lifecycle = mlsListingLifecycle(value);
  if (lifecycle === "active") return "Active";
  if (lifecycle === "pending") return "Pending";
  if (["sold", "offmarket"].includes(lifecycle)) return "OffMarket";
  return null;
}

function isoDateFromExposure(startDate, daysOnMarket) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return null;
  const days = Number(daysOnMarket);
  if (!Number.isSafeInteger(days) || days < 0 || days > 9_999) return null;
  const instant = new Date(`${startDate}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) return null;
  instant.setUTCDate(instant.getUTCDate() + Math.max(0, days - 1));
  return instant.toISOString().slice(0, 10);
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

function firstMlsLabeledCandidate(entries, {
  fieldKey,
  labelSource,
  valueSource,
  confidence = 0.94,
  normalize = (value) => value,
  reject = () => false,
}) {
  const inlinePattern = new RegExp(
    `(?:^|[\\s|])(${labelSource})\\s*(?:[:=#-]\\s*)?(${valueSource})`,
    "ig",
  );
  const labelOnlyPattern = new RegExp(`^(?:${labelSource})\\s*(?:[:=#-])?\\s*$`, "i");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    for (const inline of entry.line.matchAll(inlinePattern)) {
      if (reject(entry, inline)) continue;
      const rawValue = cleanText(inline[2], 2_000);
      const normalizedValue = normalize(rawValue);
      if (rawValue && normalizedValue != null && normalizedValue !== "") {
        return {
          field_key: fieldKey,
          raw_value: rawValue,
          normalized_value: String(normalizedValue),
          page_number: entry.pageNumber,
          confidence,
          evidence_excerpt: entry.line.slice(0, 2_000),
          extraction_method: "mls_labeled_text",
        };
      }
    }
    if (!labelOnlyPattern.test(entry.line)) continue;
    const nextEntry = entries[index + 1];
    if (!nextEntry || nextEntry.pageNumber !== entry.pageNumber) continue;
    const rawValue = cleanText(nextEntry.line.match(new RegExp(`^(${valueSource})`, "i"))?.[1], 2_000);
    const normalizedValue = normalize(rawValue);
    if (!rawValue || normalizedValue == null || normalizedValue === "") continue;
    return {
      field_key: fieldKey,
      raw_value: rawValue,
      normalized_value: String(normalizedValue),
      page_number: entry.pageNumber,
      confidence,
      evidence_excerpt: `${entry.line} ${nextEntry.line}`.slice(0, 2_000),
      extraction_method: "mls_labeled_text",
    };
  }
  return null;
}

function buildMlsSheetCandidates(entries) {
  const money = "\\$?\\s*[0-9][0-9,]*(?:\\.\\d{1,2})?";
  const date = "(?:\\d{1,2}[/-]\\d{1,2}[/-](?:\\d{4}|\\d{2})|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})";
  const status = [
    "PENDING CONTINUE TO SHOW", "PENDING TAKING BACKUPS", "ACTIVE OPTION CONTRACT",
    "ACTIVE UNDER CONTRACT", "ACTIVE CONTINGENT", "TEMPORARILY OFF MARKET",
    "OPTION PENDING", "ACTIVE OPTION", "UNDER CONTRACT", "COMING SOON", "OFF MARKET",
    "CONTINGENT", "AVAILABLE", "WITHDRAWN", "CANCELLED", "CANCELED", "EXPIRED",
    "PENDING", "CLOSED", "ACTIVE", "SOLD", "AOC", "CONT", "PEND", "PND", "ACT",
    "TOM", "EXP", "WDN", "CAN", "CLS", "SLD", "UC", "CS", "A", "P", "S",
  ].join("|");
  const candidates = [
    firstMlsLabeledCandidate(entries, {
      fieldKey: "listing_status",
      labelSource: "(?:(?:CURRENT|MLS|LIST(?:ING)?|LSTG|LST|PROPERTY)\\s+)?STATUS(?:\\s+CODE)?|(?:MLS\\s+)?ST|STAT",
      valueSource: `(?:${status})`,
      normalize: normalizedListingStatus,
    }),
    firstMlsLabeledCandidate(entries, {
      fieldKey: "mls_number",
      labelSource: "(?:MLS\\s*(?:#|NO\\.?|NUMBER|ID)|LISTING\\s*(?:#|NO\\.?|NUMBER|ID))",
      valueSource: "[A-Z0-9][A-Z0-9-]{2,44}",
    }),
    firstMlsLabeledCandidate(entries, {
      fieldKey: "list_date",
      labelSource: "(?:ORIGINAL\\s+LIST(?:ING)?\\s+DATE|LIST(?:ING)?\\s+DATE|LD)",
      valueSource: date,
      normalize: normalizedDate,
    }),
    firstMlsLabeledCandidate(entries, {
      fieldKey: "days_on_market",
      labelSource: "(?:DAYS\\s+ON\\s+MARKET|DOM)(?:\\s*[/&]\\s*CDOM)?",
      valueSource: "\\d{1,4}",
      normalize: normalizedInteger,
    }),
    firstMlsLabeledCandidate(entries, {
      fieldKey: "original_list_price",
      labelSource: "(?:ORIGINAL\\s+LIST\\s+PRICE|OLP)",
      valueSource: money,
      normalize: normalizedMoney,
    }),
    firstMlsLabeledCandidate(entries, {
      fieldKey: "list_price",
      labelSource: "(?:CURRENT\\s+LIST\\s+PRICE|FINAL\\s+LIST\\s+PRICE|LIST\\s+PRICE|LP)",
      valueSource: money,
      normalize: normalizedMoney,
      reject: (entry, match) => /original\s*$/i.test(entry.line.slice(0, match.index)),
    }),
  ].filter(Boolean);

  const listingStatus = candidates.find((candidate) => candidate.field_key === "listing_status");
  const lifecycle = mlsListingLifecycle(listingStatus?.raw_value || listingStatus?.normalized_value);
  const contractDate = firstMlsLabeledCandidate(entries, {
    fieldKey: "listing_end_date",
    labelSource: "(?:CONTRACT(?:ED)?\\s+(?:DATE|DT)|CTD|CD)",
    valueSource: date,
    normalize: normalizedDate,
  });
  const soldDate = firstMlsLabeledCandidate(entries, {
    fieldKey: "listing_end_date",
    labelSource: "(?:CLOSE(?:D|ING)?\\s+(?:DATE|DT)|SOLD\\s+(?:DATE|DT)|SD)",
    valueSource: date,
    normalize: normalizedDate,
  });
  const explicitEndDate = firstMlsLabeledCandidate(entries, {
    fieldKey: "listing_end_date",
    labelSource: "(?:MOST\\s+RECENT\\s+LIST\\s+DATE|LAST\\s+LIST\\s+DATE|STATUS\\s+DATE|LAST\\s+UPDATE(?:D)?\\s+DATE|END\\s+DATE)",
    valueSource: date,
    normalize: normalizedDate,
    confidence: 0.9,
  });
  const conditionalContractDate = ["pending", "sold"].includes(lifecycle) && contractDate
    ? {
        ...contractDate,
        evidence_excerpt: `Used as Listing End Date because the MLS status is ${lifecycle === "sold" ? "Sold" : "Pending"}. ${contractDate.evidence_excerpt}`.slice(0, 2_000),
        extraction_method: "mls_contract_date_as_listing_end_date",
      }
    : null;
  const endDate = conditionalContractDate
    || (lifecycle === "sold" ? soldDate : null)
    || explicitEndDate;
  if (endDate) {
    candidates.splice(3, 0, endDate);
  } else if (lifecycle === "active") {
    const start = candidates.find((candidate) => candidate.field_key === "list_date");
    const dom = candidates.find((candidate) => candidate.field_key === "days_on_market");
    const derivedEndDate = isoDateFromExposure(start?.normalized_value, dom?.normalized_value);
    if (derivedEndDate) {
      candidates.splice(3, 0, {
        field_key: "listing_end_date",
        raw_value: derivedEndDate,
        normalized_value: derivedEndDate,
        page_number: start.page_number,
        confidence: 0.8,
        evidence_excerpt: `Derived from ${start.evidence_excerpt} and ${dom.evidence_excerpt}`.slice(0, 2_000),
        extraction_method: "mls_list_date_dom_derivation",
      });
    }
  }
  return candidates;
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

function compactEvidence(value) {
  return cleanText(value, 2_000).replace(/\s+/g, " ").trim();
}

function firstContractPatternCandidate(pages, {
  fieldKey,
  pattern,
  normalize = (value) => value,
  confidence = 0.97,
  extractionMethod = "trec_contract_section",
}) {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = cleanText(pages[pageIndex], 500_000);
    const match = page.match(pattern);
    if (!match?.[1]) continue;
    const rawValue = compactEvidence(match[1]);
    const normalizedValue = normalize(rawValue);
    if (!rawValue || normalizedValue == null || normalizedValue === "") continue;
    return {
      field_key: fieldKey,
      raw_value: rawValue,
      normalized_value: String(normalizedValue),
      page_number: pageIndex + 1,
      confidence,
      evidence_excerpt: compactEvidence(match[0]),
      extraction_method: extractionMethod,
    };
  }
  return null;
}

function trecEffectiveDateCandidate(pages) {
  const numeric = firstContractPatternCandidate(pages, {
    fieldKey: "contract_date",
    pattern: /EXECUTED[\s\S]{0,180}?(\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4}))[\s\S]{0,100}?\(Effective Date\)/i,
    normalize: normalizedDate,
    confidence: 0.99,
    extractionMethod: "trec_effective_date",
  });
  if (numeric) return numeric;
  return firstContractPatternCandidate(pages, {
    fieldKey: "contract_date",
    pattern: /EXECUTED\s+the\s+(\d{1,2}(?:st|nd|rd|th)?\s+day\s+of\s+[A-Za-z]+,?\s+\d{4})[\s\S]{0,100}?\(Effective Date\)/i,
    normalize: (value) => normalizedDate(value.replace(/(?:st|nd|rd|th)\b/i, "")),
    confidence: 0.98,
    extractionMethod: "trec_effective_date",
  });
}

function trecPartyCandidates(pages) {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = cleanText(pages[pageIndex], 500_000);
    const match = page.match(
      /parties\s*:\s*The parties to this contract are\s+([\s\S]{1,500}?)\s*\(Seller\)\s*and\s+([\s\S]{1,300}?)\s*\(Buyer\)/i,
    );
    if (!match) continue;
    const evidence = compactEvidence(match[0]);
    return [
      {
        field_key: "seller_name",
        raw_value: compactEvidence(match[1]),
        normalized_value: compactEvidence(match[1]),
        page_number: pageIndex + 1,
        confidence: 0.98,
        evidence_excerpt: evidence,
        extraction_method: "trec_contract_parties",
      },
      {
        field_key: "buyer_name",
        raw_value: compactEvidence(match[2]),
        normalized_value: compactEvidence(match[2]),
        page_number: pageIndex + 1,
        confidence: 0.98,
        evidence_excerpt: evidence,
        extraction_method: "trec_contract_parties",
      },
    ];
  }
  return [];
}

function trecPropertyConditionCandidates(pages) {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = cleanText(pages[pageIndex], 500_000);
    const asIsSelected = /(?:^|\n)\s*(?:X|x|☒|✓)\s*\(1\)\s*Buyer accepts the Property As Is\./i.test(page);
    const repairsSelected = /(?:^|\n)\s*(?:X|x|☒|✓)\s*\(2\)\s*Buyer accepts the Property As Is provided Seller/i.test(page);
    if (!asIsSelected && !repairsSelected) continue;
    const candidates = [{
      field_key: "contract_property_condition",
      raw_value: repairsSelected
        ? "Buyer accepts the Property As Is subject to seller repairs"
        : "Buyer accepts the Property As Is",
      normalized_value: repairsSelected ? "seller_repairs" : "as_is",
      page_number: pageIndex + 1,
      confidence: 0.99,
      evidence_excerpt: repairsSelected
        ? "Selected: (2) Buyer accepts the Property As Is provided Seller completes specific repairs and treatments."
        : "Selected: (1) Buyer accepts the Property As Is.",
      extraction_method: "trec_property_condition_checkbox",
    }];
    if (repairsSelected) {
      const repairMatch = page.match(
        /following specific repairs and treatments:\s*([\s\S]{1,2000}?)(?=\(Do not insert general phrases|E\.\s+LENDER REQUIRED REPAIRS)/i,
      );
      const repairText = compactEvidence(repairMatch?.[1]);
      if (repairText) {
        candidates.push({
          field_key: "contract_repairs",
          raw_value: repairText,
          normalized_value: repairText,
          page_number: pageIndex + 1,
          confidence: 0.94,
          evidence_excerpt: compactEvidence(repairMatch[0]),
          extraction_method: "trec_property_condition_repairs",
        });
      }
    }
    return candidates;
  }
  return [];
}

function trecSection2dExclusionsCandidate(pages) {
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = cleanText(pages[pageIndex], 500_000);
    const match = page.match(
      /(?:^|\n)\s*D\.\s*EXCLUSIONS:\s*([\s\S]*?)(?=\n\s*E\.\s*RESERVATIONS:)/i,
    );
    if (!match) continue;
    const sectionText = compactEvidence(match[1])
      .replace(
        /^The following improvements and accessories will be retained by Seller and must be removed prior to delivery of possession:\s*/i,
        "",
      )
      .replace(/^[\s._-]+|[\s._-]+$/g, "")
      .trim();
    if (!sectionText) return null;
    return {
      field_key: "contract_exclusions",
      raw_value: sectionText,
      normalized_value: sectionText,
      page_number: pageIndex + 1,
      confidence: 0.96,
      evidence_excerpt: compactEvidence(match[0]),
      extraction_method: "trec_section_2d_exclusions",
    };
  }
  return null;
}

function contractPersonalPropertyCandidates(pages, exclusionsCandidate = null) {
  const affirmativePatterns = [
    /\b(?:shall|will|must|to)?\s*(?:stay|remain|convey|transfer)s?\s+with\s+(?:the\s+)?(?:property|sale|home|house)\b/i,
    /\b(?:included|conveyed|transferred)\s+(?:in|with)\s+(?:the\s+)?(?:sale|property)\b/i,
    /\b(?:to\s+be|will\s+be|shall\s+be)\s+left\s+with\s+(?:the\s+)?(?:property|sale|home|house)\b/i,
  ];
  const negativePattern = /\b(?:not|does\s+not|do\s+not|will\s+not|shall\s+not|won't|excluded?|removed?|retained\s+by\s+seller)\b/i;
  const containsAffirmativeLanguage = (value) => (
    affirmativePatterns.some((pattern) => pattern.test(value))
  );
  const findings = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const sourceLines = cleanText(pages[pageIndex], 500_000)
      .split(/\n/)
      .map((line) => compactEvidence(line))
      .filter(Boolean);
    const wrappedLines = sourceLines.slice(0, -1)
      .map((line, index) => ({ line, next: sourceLines[index + 1] }))
      .filter(({ line, next }) => (
        !containsAffirmativeLanguage(line)
        && !containsAffirmativeLanguage(next)
        && containsAffirmativeLanguage(`${line} ${next}`)
      ))
      .map(({ line, next }) => `${line} ${next}`);
    const lines = [
      ...sourceLines,
      ...wrappedLines,
      ...(exclusionsCandidate?.page_number === pageIndex + 1
        ? [exclusionsCandidate.raw_value]
        : []),
    ];
    for (const line of lines) {
      const value = line
        .replace(/^D\.\s*EXCLUSIONS:\s*/i, "")
        .replace(
          /^The following improvements and accessories will be retained by Seller and must be removed prior to delivery of possession:\s*/i,
          "",
        )
        .replace(/^[\s._-]+|[\s._-]+$/g, "")
        .trim();
      if (!value) continue;
      if (!containsAffirmativeLanguage(value)) continue;
      if (negativePattern.test(value)) continue;
      const identity = value.toLowerCase();
      if (!findings.some((finding) => finding.identity === identity)) {
        findings.push({ identity, value, pageNumber: pageIndex + 1 });
      }
      if (findings.length >= 8) break;
    }
    if (findings.length >= 8) break;
  }
  if (findings.length) {
    const details = findings.map((finding) => finding.value).join("; ").slice(0, 2_000);
    const evidence = findings
      .map((finding) => `Page ${finding.pageNumber}: ${finding.value}`)
      .join(" ")
      .slice(0, 2_000);
    return [
      {
        field_key: "contract_personal_property_included",
        raw_value: "Yes",
        normalized_value: "Yes",
        page_number: findings[0].pageNumber,
        confidence: 0.92,
        evidence_excerpt: evidence,
        extraction_method: "contract_personal_property_inclusion_phrase",
      },
      {
        field_key: "contract_personal_property_details",
        raw_value: details,
        normalized_value: details,
        page_number: findings[0].pageNumber,
        confidence: 0.9,
        evidence_excerpt: evidence,
        extraction_method: "contract_personal_property_inclusion_phrase",
      },
    ];
  }
  const evidencePage = exclusionsCandidate?.page_number || 1;
  const exclusionContext = exclusionsCandidate?.raw_value
    ? `Section 2D states: ${exclusionsCandidate.raw_value}`
    : "No affirmative 'stay with property' or equivalent inclusion language was found in the extracted contract text.";
  return [{
    field_key: "contract_personal_property_included",
    raw_value: "No",
    normalized_value: "No",
    page_number: evidencePage,
    confidence: 0.76,
    evidence_excerpt: `${exclusionContext} Appraiser confirmation is required.`,
    extraction_method: "contract_personal_property_negative_review",
  }];
}

function buildPurchaseContractCandidates(pages) {
  const candidates = [
    firstContractPatternCandidate(pages, {
      fieldKey: "down_payment",
      pattern: /Cash portion of (?:the )?Sales Price payable by Buyer at closing[\s\S]{0,160}?\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
      normalize: normalizedMoney,
    }),
    firstContractPatternCandidate(pages, {
      fieldKey: "loan_amount",
      pattern: /Sum of all financing described[\s\S]{0,280}?\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
      normalize: normalizedMoney,
    }),
    firstContractPatternCandidate(pages, {
      fieldKey: "contract_price",
      pattern: /Sales Price\s*\(Sum of A and B\)[\s\S]{0,120}?\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
      normalize: normalizedMoney,
    }),
    firstContractPatternCandidate(pages, {
      fieldKey: "earnest_money",
      pattern: /\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s+as earnest money\b/i,
      normalize: normalizedMoney,
    }),
    firstContractPatternCandidate(pages, {
      fieldKey: "closing_date",
      pattern: /closing of the sale will be on or before\s+((?:[A-Za-z]+\s+\d{1,2},?\s+\d{4})|(?:\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})))/i,
      normalize: normalizedDate,
      extractionMethod: "trec_closing_date",
    }),
    trecEffectiveDateCandidate(pages),
    firstContractPatternCandidate(pages, {
      fieldKey: "seller_concessions",
      pattern: /\(b\)\s+an amount not to exceed\s*\$\s*(N\/?A|NONE|NO|[0-9][0-9,]*(?:\.\d{1,2})?)/i,
      normalize: normalizedMoney,
      extractionMethod: "trec_seller_expense_concession",
    }),
  ].filter(Boolean);
  candidates.push(...trecPartyCandidates(pages));
  candidates.push(...trecPropertyConditionCandidates(pages));
  const exclusionsCandidate = trecSection2dExclusionsCandidate(pages);
  if (exclusionsCandidate) candidates.push(exclusionsCandidate);
  candidates.push(...contractPersonalPropertyCandidates(pages, exclusionsCandidate));
  return candidates;
}

function normalizedPostalAddress(value) {
  const source = cleanText(value, 2_000).replace(/\s+/g, " ");
  if (!source) return null;
  return source.replace(/\b(\d{5})(\d{4})\b/g, "$1-$2");
}

function labeledPartyValues(line) {
  const source = cleanText(line, 2_000);
  const pattern = /(?:^|\s)(client|lender|prepared\s+for)\s*[:#-]\s*/gi;
  const matches = [...source.matchAll(pattern)];
  return matches.map((match, index) => ({
    label: String(match[1] || "").toLowerCase().replace(/\s+/g, "_"),
    value: cleanText(source.slice(
      Number(match.index || 0) + match[0].length,
      matches[index + 1]?.index ?? source.length,
    ), 2_000),
  })).filter((entry) => entry.value);
}

function valueBeforeRepeatedAddressLabel(value) {
  return cleanText(value, 2_000)
    .replace(/\s+(?:(?:client|lender)\s+)?address\s*[:#-].*$/i, "")
    .trim();
}

function addressCandidateFromEntries(entries, {
  fieldKey,
  labels,
  startIndex = 0,
  endIndex = entries.length,
  confidence = 0.94,
}) {
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index];
    const label = labels.find((candidate) => candidate.test(entry.line));
    if (!label) continue;
    const match = entry.line.match(label);
    const street = valueBeforeRepeatedAddressLabel(match?.[1] || "");
    if (!street) continue;
    const nextEntry = entries[index + 1];
    const continuation = nextEntry?.pageNumber === entry.pageNumber
      ? valueBeforeRepeatedAddressLabel(nextEntry.line)
      : "";
    const continuationLooksLabeled = /^[A-Za-z][A-Za-z /().'&-]{0,50}:/.test(continuation);
    const rawValue = [street, continuation && !continuationLooksLabeled ? continuation : ""]
      .filter(Boolean)
      .join(", ");
    return {
      field_key: fieldKey,
      raw_value: rawValue,
      normalized_value: normalizedPostalAddress(rawValue),
      page_number: entry.pageNumber,
      confidence,
      evidence_excerpt: [entry.line, continuation && !continuationLooksLabeled ? nextEntry.line : ""]
        .filter(Boolean)
        .join(" ")
        .slice(0, 2_000),
      extraction_method: "labeled_multiline_address",
    };
  }
  return null;
}

function buildEngagementLetterCandidates(entries) {
  const candidates = [];
  const serviceProviderIndex = entries.findIndex((entry) => (
    /service\s+provider\s+information/i.test(entry.line)
  ));
  const partySectionEnd = serviceProviderIndex >= 0 ? serviceProviderIndex : entries.length;
  const partyIndex = entries.findIndex((entry, index) => (
    index < partySectionEnd && /(?:^|\s)(?:client|lender|prepared\s+for)\s*[:#-]/i.test(entry.line)
  ));
  if (partyIndex >= 0) {
    const partyEntry = entries[partyIndex];
    const parties = labeledPartyValues(partyEntry.line);
    const selectedParty = parties.find((entry) => entry.label === "client")
      || parties.find((entry) => entry.label === "lender")
      || parties[0];
    if (selectedParty?.value) {
      candidates.push({
        field_key: "lender_client_name",
        raw_value: selectedParty.value,
        normalized_value: selectedParty.value,
        page_number: partyEntry.pageNumber,
        confidence: 0.96,
        evidence_excerpt: partyEntry.line.slice(0, 2_000),
        extraction_method: "engagement_party_labels",
      });
    }
    const clientAddress = addressCandidateFromEntries(entries, {
      fieldKey: "lender_client_address",
      labels: [/^(?:(?:client|lender)\s+)?address\s*[:#-]\s*(.+)$/i],
      startIndex: partyIndex + 1,
      endIndex: partySectionEnd,
      confidence: 0.96,
    });
    if (clientAddress) candidates.push(clientAddress);
  }
  const subjectAddress = addressCandidateFromEntries(entries, {
    fieldKey: "subject_property_address",
    labels: [/^(?:property|subject)\s+address\s*[:#-]\s*(.+)$/i],
    confidence: 0.98,
  });
  if (subjectAddress) candidates.push(subjectAddress);
  return candidates;
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
  if (/one\s+to\s+four\s+family\s+residential\s+contract|earnest\s+money|purchase\s+contract/.test(sample)) {
    return "purchase_contract";
  }
  if (/engagement\s+letter|appraisal\s+assignment|scope\s+of\s+work/.test(sample)) {
    return "engagement_letter";
  }
  const explicitMlsIdentity = /multiple\s+listing\s+service|\bmls\s*(?:#|number\b|no\.?)/.test(sample);
  const mlsSignals = [
    /\b(?:dom|days\s+on\s+market)\b/.test(sample),
    /\bolp\b/.test(sample),
    /\b(?:ld|list(?:ing)?\s+date)\b/.test(sample),
  ].filter(Boolean).length;
  if (explicitMlsIdentity || /\bmls(?:[-_\s]+)(?:sheet|listing|report)\b/.test(sample) || mlsSignals >= 2) {
    return "mls_sheet";
  }
  if (/zoning\s+(?:map|district)|official\s+zoning\s+map/.test(sample)) return "zoning_map";
  if (/zoning\s+(?:ordinance|code)|development\s+code/.test(sample)) return "zoning_ordinance";
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
  const specializedCandidates = documentType === "engagement_letter"
    ? buildEngagementLetterCandidates(entries)
    : documentType === "purchase_contract"
      ? buildPurchaseContractCandidates(pages)
    : documentType === "mls_sheet"
      ? buildMlsSheetCandidates(entries)
      : [];
  const specializedFields = new Set(specializedCandidates.map((candidate) => candidate.field_key));
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
    engagement_letter: new Set([
      "lender_client_name", "lender_client_address", "subject_property_address", "assignment_type",
    ]),
    mls_sheet: new Set([
      "listing_status", "mls_number", "list_price", "list_date", "listing_end_date",
      "days_on_market", "original_list_price", "financing_type", "seller_concessions",
    ]),
  }[documentType] || null;
  const candidates = definitions
    .filter((definition) => (
      (!allowedFields || allowedFields.has(definition.fieldKey))
      && !specializedFields.has(definition.fieldKey)
    ))
    .map((definition) => firstLabeledCandidate(entries, definition))
    .filter(Boolean);
  candidates.unshift(...specializedCandidates);

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
