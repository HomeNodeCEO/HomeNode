import { createHash } from "node:crypto";
import { isIP } from "node:net";
import sharp from "sharp";

const FIELD_LIMITS = Object.freeze({
  accountId: 128,
  additionalSheets: 4_000,
  address: 300,
  authorityEnds: 100,
  city: 100,
  districtName: 200,
  legalDescription: 2_000,
  propertyAccountId: 128,
  ownerName: 200,
  ownerTelephone: 64,
  representSpecificText: 4_000,
  signerName: 200,
  signerTitle: 200,
  state: 50,
  zip: 20,
});
const SIGNATURE_DATA_URL_LIMIT = 350_000;
const SIGNATURE_BYTE_LIMIT = 256 * 1_024;
const SIGNATURE_PIXEL_LIMIT = 1_600 * 600;
const SIGNATURE_ROLES = new Set(["owner", "authorized-agent", "other"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SIGNATURE_DATA_URL_PATTERN = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u;
const AUTHORIZATION_KEYS = new Set([
  "additionalSheets",
  "agentAddress",
  "agentCity",
  "agentName",
  "agentState",
  "agentTelephone",
  "agentZip",
  "allPropertyAtAddress",
  "appraisalDistrictName",
  "authorityEnds",
  "communicationsAllTaxingUnits",
  "communicationsChiefAppraiser",
  "communicationsReviewBoard",
  "consentConfidentialInfo",
  "listedProperties",
  "ownerAddress",
  "ownerCity",
  "ownerName",
  "ownerState",
  "ownerTelephone",
  "ownerZip",
  "representAll",
  "representSpecificText",
  "signatureDate",
  "signerPrintedName",
  "signerRole",
  "signerTitle",
]);
const SIGNUP_KEYS = new Set([
  "accountId",
  "authorization",
  "clientSubmissionId",
  "propertyTaxFileId",
  "signatureAttestation",
  "signatureDataUrl",
]);

function normalizeText(value, {
  field,
  required = false,
  maximumLength,
} = {}) {
  if (value == null || value === "") {
    if (required) throw new Error(`missing_${field}`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`invalid_${field}`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw new Error(`missing_${field}`);
    return null;
  }
  if (normalized.length > maximumLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function exactKeys(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(code);
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`invalid_${field}`);
  return value;
}

function normalizeUuid(value, field) {
  const normalized = normalizeText(value, {
    field,
    required: true,
    maximumLength: 36,
  });
  if (!UUID_PATTERN.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized.toLowerCase();
}

function optionalText(value, field, maximumLength) {
  return normalizeText(value, { field, maximumLength });
}

function normalizeIsoDate(value, field) {
  const normalized = normalizeText(value, { field, required: true, maximumLength: 10 });
  if (!ISO_DATE_PATTERN.test(normalized)) throw new Error(`invalid_${field}`);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function normalizeListedProperties(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error("invalid_listed_properties");
  return Object.freeze(value.map((entry) => {
    exactKeys(entry, new Set(["accountNumber", "legalDescription", "situsAddress"]), "invalid_listed_property");
    return Object.freeze({
      accountNumber: optionalText(
        entry.accountNumber,
        "listed_property_account_number",
        FIELD_LIMITS.propertyAccountId,
      ),
      legalDescription: optionalText(
        entry.legalDescription,
        "listed_property_legal_description",
        FIELD_LIMITS.legalDescription,
      ),
      situsAddress: optionalText(
        entry.situsAddress,
        "listed_property_situs_address",
        FIELD_LIMITS.address,
      ),
    });
  }));
}

function normalizeAuthorization(value) {
  exactKeys(value, AUTHORIZATION_KEYS, "invalid_signup_authorization");
  const signerRole = normalizeText(value.signerRole, {
    field: "signer_role",
    required: true,
    maximumLength: 32,
  });
  if (!SIGNATURE_ROLES.has(signerRole)) throw new Error("invalid_signer_role");
  return Object.freeze({
    appraisalDistrictName: optionalText(value.appraisalDistrictName, "appraisal_district_name", FIELD_LIMITS.districtName),
    ownerName: normalizeText(value.ownerName, { field: "owner_name", required: true, maximumLength: FIELD_LIMITS.ownerName }),
    ownerTelephone: normalizeText(value.ownerTelephone, { field: "owner_telephone", required: true, maximumLength: FIELD_LIMITS.ownerTelephone }),
    ownerAddress: optionalText(value.ownerAddress, "owner_address", FIELD_LIMITS.address),
    ownerCity: optionalText(value.ownerCity, "owner_city", FIELD_LIMITS.city),
    ownerState: optionalText(value.ownerState, "owner_state", FIELD_LIMITS.state),
    ownerZip: optionalText(value.ownerZip, "owner_zip", FIELD_LIMITS.zip),
    allPropertyAtAddress: requiredBoolean(value.allPropertyAtAddress, "all_property_at_address"),
    listedProperties: normalizeListedProperties(value.listedProperties),
    additionalSheets: optionalText(value.additionalSheets, "additional_sheets", FIELD_LIMITS.additionalSheets),
    agentName: optionalText(value.agentName, "agent_name", FIELD_LIMITS.ownerName),
    agentTelephone: optionalText(value.agentTelephone, "agent_telephone", FIELD_LIMITS.ownerTelephone),
    agentAddress: optionalText(value.agentAddress, "agent_address", FIELD_LIMITS.address),
    agentCity: optionalText(value.agentCity, "agent_city", FIELD_LIMITS.city),
    agentState: optionalText(value.agentState, "agent_state", FIELD_LIMITS.state),
    agentZip: optionalText(value.agentZip, "agent_zip", FIELD_LIMITS.zip),
    representAll: requiredBoolean(value.representAll, "represent_all"),
    representSpecificText: optionalText(value.representSpecificText, "represent_specific_text", FIELD_LIMITS.representSpecificText),
    consentConfidentialInfo: requiredBoolean(value.consentConfidentialInfo, "consent_confidential_info"),
    communicationsChiefAppraiser: requiredBoolean(value.communicationsChiefAppraiser, "communications_chief_appraiser"),
    communicationsReviewBoard: requiredBoolean(value.communicationsReviewBoard, "communications_review_board"),
    communicationsAllTaxingUnits: requiredBoolean(value.communicationsAllTaxingUnits, "communications_all_taxing_units"),
    authorityEnds: optionalText(value.authorityEnds, "authority_ends", FIELD_LIMITS.authorityEnds),
    signatureDate: normalizeIsoDate(value.signatureDate, "signature_date"),
    signerPrintedName: normalizeText(value.signerPrintedName, { field: "signer_printed_name", required: true, maximumLength: FIELD_LIMITS.signerName }),
    signerTitle: optionalText(value.signerTitle, "signer_title", FIELD_LIMITS.signerTitle),
    signerRole,
  });
}

export function normalizeSignupPayload(value) {
  exactKeys(value, SIGNUP_KEYS, "invalid_signup_payload");
  const accountId = normalizeText(value.accountId, {
    field: "account_id",
    required: true,
    maximumLength: FIELD_LIMITS.accountId,
  });
  const propertyTaxFileId = normalizeUuid(value.propertyTaxFileId, "property_tax_file_id");
  const clientSubmissionId = normalizeUuid(value.clientSubmissionId, "client_submission_id");
  if (value.signatureAttestation !== true) throw new Error("signature_attestation_required");
  const signatureDataUrl = normalizeText(value.signatureDataUrl, {
    field: "signature_data",
    required: true,
    maximumLength: SIGNATURE_DATA_URL_LIMIT,
  });
  const match = SIGNATURE_DATA_URL_PATTERN.exec(signatureDataUrl);
  if (!match || match[1].length % 4 !== 0) throw new Error("invalid_signature_data");
  const signaturePng = Buffer.from(match[1], "base64");
  if (
    signaturePng.length < 64
    || signaturePng.length > SIGNATURE_BYTE_LIMIT
    || signaturePng.toString("base64") !== match[1]
  ) throw new Error("invalid_signature_data");
  const authorization = normalizeAuthorization(value.authorization);
  return Object.freeze({
    accountId,
    authorization,
    clientSubmissionId,
    propertyTaxFileId,
    signaturePng,
  });
}

export async function verifySignupSignaturePng(signaturePng, imageProcessor = sharp) {
  if (!Buffer.isBuffer(signaturePng)) throw new Error("invalid_signature_data");
  try {
    const decoder = imageProcessor(signaturePng, {
      failOn: "error",
      limitInputPixels: SIGNATURE_PIXEL_LIMIT,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== "png"
      || !Number.isInteger(metadata.width)
      || !Number.isInteger(metadata.height)
      || metadata.width < 80
      || metadata.height < 20
      || metadata.width > 1_600
      || metadata.height > 600
    ) throw new Error("invalid_signature_image");
    const { data, info } = await decoder.clone().ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    let inkPixels = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      const opacity = data[index + 3];
      const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
      if (opacity >= 32 && brightness <= 235) inkPixels += 1;
    }
    if (inkPixels < 16) throw new Error("signature_image_blank");
    const content = await decoder.clone().png({ compressionLevel: 9 }).toBuffer();
    if (content.length > SIGNATURE_BYTE_LIMIT) throw new Error("invalid_signature_image");
    return Object.freeze({
      content,
      height: metadata.height,
      sha256: createHash("sha256").update(content).digest("hex"),
      width: metadata.width,
    });
  } catch (error) {
    if (error?.message === "signature_image_blank") throw error;
    throw new Error("invalid_signature_image");
  }
}

export function signupAuthorizationSha256(payload, signatureSha256) {
  if (!payload?.authorization || !/^[a-f0-9]{64}$/u.test(String(signatureSha256 || ""))) {
    throw new Error("invalid_signup_authorization_digest");
  }
  return createHash("sha256").update(JSON.stringify({
    accountId: payload.accountId,
    authorization: payload.authorization,
    propertyTaxFileId: payload.propertyTaxFileId,
    signatureSha256,
  })).digest("hex");
}

function boundedMetadata(value, maximumLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

export function signupRequestMetadata(req) {
  const ip = boundedMetadata(req?.ip, 64);
  return Object.freeze({
    ip: ip && isIP(ip) ? ip : null,
    userAgent: boundedMetadata(req?.get?.("user-agent"), 512),
    referer: boundedMetadata(req?.get?.("referer"), 2_048),
  });
}

export function signupDeliveryStatus({ configured, sent }) {
  if (!configured) return "not_configured";
  return sent ? "sent" : "failed";
}
