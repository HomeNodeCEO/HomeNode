import { isIP } from "node:net";

const FIELD_LIMITS = Object.freeze({
  accountId: 128,
  ownerEmail: 320,
  ownerName: 200,
  ownerTelephone: 64,
});
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

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

export function normalizeSignupPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_signup_payload");
  }
  const ownerName = normalizeText(value.ownerName, {
    field: "owner_name",
    required: true,
    maximumLength: FIELD_LIMITS.ownerName,
  });
  const ownerTelephone = normalizeText(value.ownerTelephone, {
    field: "owner_telephone",
    required: true,
    maximumLength: FIELD_LIMITS.ownerTelephone,
  });
  const accountId = normalizeText(value.accountId, {
    field: "account_id",
    maximumLength: FIELD_LIMITS.accountId,
  });
  const ownerEmail = normalizeText(value.ownerEmail, {
    field: "owner_email",
    maximumLength: FIELD_LIMITS.ownerEmail,
  });
  if (ownerEmail && !EMAIL_PATTERN.test(ownerEmail)) throw new Error("invalid_owner_email");
  return Object.freeze({ accountId, ownerEmail, ownerName, ownerTelephone });
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
