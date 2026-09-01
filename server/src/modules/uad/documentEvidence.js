import { createUadEntityWithClient } from "./entities.js";
import { saveUadSection } from "./editor.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const SUPPORTED_DOCUMENT_FIELDS = new Set([
  "assignment_type",
  "buyer_name",
  "seller_name",
  "lender_client_name",
  "lender_client_address",
  "contract_price",
  "contract_date",
]);

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanText(value, maximum = 4_000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function sourceReference(row) {
  const page = row.page_number == null ? "unknown" : Number(row.page_number);
  return `assignment_document:${row.document_id}:candidate:${row.id}:page:${page}:sha256:${row.checksum_sha256}`;
}

function assignmentReason(value) {
  const normalized = cleanText(value, 300).toLowerCase().replace(/[\s-]+/g, "_");
  if (["purchase", "purchase_transaction"].includes(normalized)) return "Purchase";
  if (["refinance", "refi"].includes(normalized)) return "Refinance";
  if (["heloc", "home_equity", "home_equity_line"].includes(normalized)) return "HomeEquity";
  if (["construction", "new_construction", "construction_loan"].includes(normalized)) return "Construction";
  return null;
}

function structuredPartyName(value, role) {
  const name = cleanText(value, 300);
  if (!name) return null;
  const business = /\b(?:bank|company|co\.?|corp(?:oration)?\.?|inc(?:orporated)?\.?|llc|l\.l\.c\.|llp|lp|ltd\.?|trust|association|holdings?)\b/i.test(name);
  const multiplePeople = /\s(?:&|and)\s|;/i.test(name);
  const prefixes = role === "borrower"
    ? { first: "1000.0101", middle: "1000.0170", last: "1000.0102", suffix: "1000.0171", legal: "1000.0104" }
    : { first: "1000.0018", middle: "1000.0172", last: "1000.0019", suffix: "1000.0173", legal: "1000.0020" };
  if (multiplePeople) return null;
  const partyRole = role === "borrower" ? "Borrower" : "PropertySeller";
  if (business) {
    return [
      { uid: role === "borrower" ? "1000.0105" : "1000.0116", context_key: role, value: partyRole },
      { uid: prefixes.legal, context_key: role, value: name },
    ];
  }
  const parts = name.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return null;
  const suffixPattern = /^(?:jr\.?|sr\.?|ii|iii|iv|v)$/i;
  const suffix = suffixPattern.test(parts.at(-1) || "") ? parts.pop() : null;
  const first = parts.shift();
  const last = parts.pop();
  if (!first || !last) return null;
  return [
    { uid: role === "borrower" ? "1000.0103" : "1000.0021", context_key: role, value: partyRole },
    { uid: prefixes.first, context_key: role, value: first },
    ...(parts.length ? [{ uid: prefixes.middle, context_key: role, value: parts.join(" ") }] : []),
    { uid: prefixes.last, context_key: role, value: last },
    ...(suffix ? [{ uid: prefixes.suffix, context_key: role, value: suffix.replace(/\.$/, "") }] : []),
  ];
}

export function parseUadClientAddress(value) {
  const address = cleanText(value, 1_000);
  const match = address.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  if (!match) return null;
  return {
    addressLine: cleanText(match[1], 100),
    city: cleanText(match[2], 50),
    state: String(match[3] || "").toUpperCase(),
    postalCode: match[4],
  };
}

async function findOrCreateClientContact(pool, workfileId, documentId, actorUserId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`uad-document-contact:${workfileId}:${documentId}`],
    );
    const repeated = await client.query(
      `SELECT id
         FROM appraisal.uad_entities
        WHERE workfile_id = $1
          AND entity_type = 'assignment_contact'
          AND data->>'source_document_id' = $2
        ORDER BY ordinal, id
        LIMIT 1
        FOR UPDATE`,
      [workfileId, String(documentId)],
    );
    if (repeated.rows[0]) {
      await client.query("COMMIT");
      return repeated.rows[0].id;
    }
    const entity = await createUadEntityWithClient(client, workfileId, {
      entity_type: "assignment_contact",
      label: "Lender / client",
      data: {
        source: "assignment_document",
        source_document_id: String(documentId),
        client: true,
      },
    }, { actorUserId });
    await client.query("COMMIT");
    return entity.id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function clientRoleValues(entityId) {
  return [
    { uid: "2400.0018", context_key: "assignment_client_primary_role", entity_id: entityId, value: "Client" },
    { uid: "2400.0017", context_key: "assignment_client_type_role", entity_id: entityId, value: "Lender" },
  ];
}

export function uadDocumentCandidateIsApplicable(fieldKey) {
  return SUPPORTED_DOCUMENT_FIELDS.has(String(fieldKey || "").trim());
}

export async function applyConfirmedUadDocumentCandidate(
  pool,
  workfileIdValue,
  documentIdValue,
  candidateIdValue,
  actorUserId = null,
) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const documentId = positiveInteger(documentIdValue);
  const candidateId = positiveInteger(candidateIdValue);
  if (!documentId || !candidateId) throw new Error("invalid_document_candidate");
  const { rows } = await pool.query(
    `SELECT candidate.*, document.uad_workfile_id, document.checksum_sha256
       FROM app.assignment_document_field_candidates candidate
       JOIN app.assignment_documents document ON document.id = candidate.document_id
      WHERE candidate.id = $2
        AND document.id = $1
        AND document.uad_workfile_id = $3`,
    [documentId, candidateId, workfileId],
  );
  const candidate = rows[0];
  if (!candidate) throw new Error("document_candidate_not_found");
  if (candidate.review_status !== "confirmed") throw new Error("uad_document_candidate_confirmation_required");
  if (!uadDocumentCandidateIsApplicable(candidate.field_key)) {
    return { applied: false, reason: "no_direct_uad_mapping", field_key: candidate.field_key };
  }

  const value = cleanText(candidate.confirmed_value || candidate.normalized_value || candidate.raw_value);
  let section = "assignment";
  let values = [];
  if (candidate.field_key === "assignment_type") {
    const reason = assignmentReason(value);
    if (!reason) throw new Error("uad_document_assignment_reason_requires_manual_entry");
    values = [{ uid: "1000.0034", context_key: "assignment", value: reason }];
  } else if (["buyer_name", "seller_name"].includes(candidate.field_key)) {
    values = structuredPartyName(value, candidate.field_key === "buyer_name" ? "borrower" : "seller");
    if (!values) throw new Error("uad_document_party_name_requires_manual_entry");
  } else if (["lender_client_name", "lender_client_address"].includes(candidate.field_key)) {
    const address = candidate.field_key === "lender_client_address" ? parseUadClientAddress(value) : null;
    if (candidate.field_key === "lender_client_name" && !value) {
      throw new Error("uad_document_client_name_requires_manual_entry");
    }
    if (candidate.field_key === "lender_client_address" && !address) {
      throw new Error("uad_document_client_address_requires_manual_entry");
    }
    const entityId = await findOrCreateClientContact(pool, workfileId, documentId, actorUserId);
    values = clientRoleValues(entityId);
    if (candidate.field_key === "lender_client_name") {
      values.push({
        uid: "2400.0013",
        context_key: "assignment_client_name",
        entity_id: entityId,
        value,
      });
    } else {
      values.push(
        { uid: "2400.0001", context_key: "assignment_client_address", entity_id: entityId, value: address.addressLine },
        { uid: "2400.0002", context_key: "assignment_client_address", entity_id: entityId, value: address.city },
        { uid: "2400.0004", context_key: "assignment_client_address", entity_id: entityId, value: address.state },
        { uid: "2400.0003", context_key: "assignment_client_address", entity_id: entityId, value: address.postalCode },
      );
    }
  } else if (candidate.field_key === "contract_price") {
    section = "sales_contract";
    const amount = Number(value.replace(/[$,]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("uad_document_contract_price_requires_manual_entry");
    values = [{ uid: "0600.0008", context_key: "sales_contract", value: amount }];
  } else if (candidate.field_key === "contract_date") {
    section = "sales_contract";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("uad_document_contract_date_requires_manual_entry");
    values = [{ uid: "0600.0009", context_key: "sales_contract", value }];
  }

  const revision = await pool.query(
    "SELECT current_revision FROM appraisal.uad_workfiles WHERE id = $1",
    [workfileId],
  );
  if (!revision.rows[0]) throw new Error("uad_workfile_not_found");
  const provenance = sourceReference(candidate);
  const result = await saveUadSection(pool, workfileId, section, {
    expected_revision: Number(revision.rows[0].current_revision),
    save_reason: "autosave",
    values,
  }, actorUserId, {
    sourceType: "document",
    sourceReference: provenance,
    changeSummary: `Applied appraiser-confirmed document evidence to ${section}`,
  });
  return {
    applied: true,
    field_key: candidate.field_key,
    section,
    source_reference: provenance,
    current_revision: result.current_revision,
    changed_field_count: result.changed_field_count,
    applied_fields: values.map((item) => ({
      uid: item.uid,
      context_key: item.context_key,
      entity_id: item.entity_id || null,
      value: item.value,
    })),
  };
}
