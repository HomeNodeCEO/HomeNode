function identity(value) {
  return String(value || "").trim();
}

export function evaluateUadSignatureQuorum(workfile = {}, signatures = [], {
  revisionNumber = null,
  inputDigest = null,
} = {}) {
  const assignedAppraiserUserId = identity(workfile.assigned_appraiser_user_id);
  const supervisoryAppraiserUserId = identity(workfile.supervisory_appraiser_user_id);
  const rows = (Array.isArray(signatures) ? signatures : []).filter((row) => (
    (revisionNumber == null || Number(row?.revision_number) === Number(revisionNumber))
    && (inputDigest == null || row?.workfile_input_digest_sha256 === inputDigest)
  ));
  const hasSignature = (role, userId) => Boolean(userId) && rows.some((row) => (
    row?.signer_role === role && identity(row?.signer_user_id) === userId
  ));
  const appraiserSigned = hasSignature("appraiser", assignedAppraiserUserId);
  const supervisorRequired = Boolean(supervisoryAppraiserUserId);
  const supervisoryAppraiserSigned = !supervisorRequired
    || hasSignature("supervisory_appraiser", supervisoryAppraiserUserId);
  const missingRoles = [
    appraiserSigned ? null : "appraiser",
    supervisoryAppraiserSigned ? null : "supervisory_appraiser",
  ].filter(Boolean);
  return Object.freeze({
    complete: missingRoles.length === 0,
    appraiser_signed: appraiserSigned,
    supervisory_appraiser_required: supervisorRequired,
    supervisory_appraiser_signed: supervisoryAppraiserSigned,
    missing_roles: Object.freeze(missingRoles),
  });
}
