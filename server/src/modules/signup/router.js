import express from "express";
import nodemailer from "nodemailer";

import { authorizePropertyTaxProtestFile } from "../../security/assignmentAccess.js";
import {
  normalizeSignupPayload,
  signupAuthorizationSha256,
  signupDeliveryStatus,
  signupRequestMetadata,
  verifySignupSignaturePng,
} from "../../security/signupSecurity.js";

function safeErrorCode(error) {
  return /^[A-Z0-9_]{1,32}$/i.test(String(error?.code || ""))
    ? String(error.code)
    : "unknown";
}

export function createSignupRouter({
  pool,
  signupRateLimiter,
  environment = process.env,
  mailer = nodemailer,
  logger = console,
  authorizePropertyTaxFile = authorizePropertyTaxProtestFile,
  verifySignature = verifySignupSignaturePng,
} = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("signup_pool_required");
  if (typeof signupRateLimiter !== "function") {
    throw new TypeError("signup_rate_limiter_required");
  }
  if (!mailer || typeof mailer.createTransport !== "function") {
    throw new TypeError("signup_mailer_required");
  }
  if (typeof authorizePropertyTaxFile !== "function") {
    throw new TypeError("signup_property_tax_authorizer_required");
  }
  if (typeof verifySignature !== "function") {
    throw new TypeError("signup_signature_verifier_required");
  }

  const router = express.Router();
  router.get("/api/signup/smtp-status", (_req, res) => {
    const usingUrl = Boolean(environment.SMTP_URL || environment.SMTP_CONNECTION_URL);
    const hasHost = Boolean(environment.SMTP_HOST);
    const port = environment.SMTP_PORT ? parseInt(environment.SMTP_PORT, 10) : null;
    const secure = environment.SMTP_SECURE === "1" || environment.SMTP_SECURE === "true";
    const hasUser = Boolean(environment.SMTP_USER);
    const hasPass = Boolean(environment.SMTP_PASS);
    const fromSet = Boolean(environment.MAIL_FROM || environment.SMTP_FROM);
    const cors = environment.CORS_ORIGIN || environment.CORS_ORIGINS || null;
    return res.json({
      ok: true,
      smtp: {
        configured: usingUrl || hasHost,
        using_url: usingUrl,
        has_host: hasHost,
        port,
        secure,
        has_user: hasUser,
        has_pass: hasPass,
        from_set: fromSet,
      },
      cors_origin: cors,
    });
  });

  router.post("/api/signup/email", signupRateLimiter, async (req, res) => {
    try {
      if (!req.mobileAuth) {
        return res
          .status(401)
          .set("cache-control", "no-store")
          .json({ error: "authentication_required" });
      }
      let payload;
      try {
        payload = normalizeSignupPayload(req.body);
      } catch (error) {
        return res
          .status(400)
          .set("cache-control", "no-store")
          .json({ error: error?.message || "invalid_signup_payload" });
      }
      let propertyTaxAccess;
      try {
        propertyTaxAccess = await authorizePropertyTaxFile(pool, req.mobileAuth, {
          accountId: payload.accountId,
          propertyTaxFileId: payload.propertyTaxFileId,
          permission: "write",
        });
      } catch (error) {
        const notFound = error?.message === "property_tax_protest_file_not_found";
        return res
          .status(notFound ? 404 : 403)
          .set("cache-control", "no-store")
          .json({
            error: notFound
              ? "property_tax_protest_file_not_found"
              : "property_tax_protest_file_access_denied",
          });
      }
      let signature;
      try {
        signature = await verifySignature(payload.signaturePng);
      } catch (error) {
        const code = error?.message === "signature_image_blank"
          ? "signature_image_blank"
          : "invalid_signature_image";
        return res.status(400).set("cache-control", "no-store").json({ error: code });
      }
      const {
        accountId,
        authorization,
        clientSubmissionId,
        propertyTaxFileId,
      } = payload;
      const { ownerName, ownerTelephone, signerPrintedName, signerRole, signerTitle } = authorization;
      const authorizationSha256 = signupAuthorizationSha256(payload, signature.sha256);
      const submittedByUserId = String(req.mobileAuth.userId || "").trim();
      const organizationId = String(propertyTaxAccess?.organization_id || "").trim();
      if (!submittedByUserId || !organizationId) {
        return res.status(403).set("cache-control", "no-store").json({
          error: "property_tax_protest_file_access_denied",
        });
      }
      const smtpUrl = environment.SMTP_URL || environment.SMTP_CONNECTION_URL;
      const attestationAcceptedAt = new Date().toISOString();
      let stored;
      try {
        const metadata = signupRequestMetadata(req);
        const { rows } = await pool.query(
          `INSERT INTO app.signups (
             source, submission_id, account_id, property_tax_file_id,
             organization_id, submitted_by_user_id,
             owner_name, owner_telephone, owner_email,
             signer_printed_name, signer_title, signer_role,
             signature_sha256, signature_png, authorization_sha256,
             attestation_accepted_at, verification_status,
             user_agent, ip, meta
           )
           SELECT
             $1,$2,report_file.account_id,protest.id,report_file.organization_id,$6,$7,$8,$9,$10,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$20
             FROM app.report_files report_file
             JOIN app.tax_protest_files protest
               ON protest.id = report_file.tax_protest_file_id
              AND protest.organization_id = report_file.organization_id
            WHERE protest.id = $4
              AND report_file.account_id = $3
              AND report_file.organization_id = $5
              AND report_file.workflow_type = 'property_tax_protest'
           ON CONFLICT (submission_id) WHERE submission_id IS NOT NULL
           DO UPDATE SET submission_id = EXCLUDED.submission_id
             WHERE app.signups.authorization_sha256 = EXCLUDED.authorization_sha256
               AND app.signups.submitted_by_user_id = EXCLUDED.submitted_by_user_id
           RETURNING id, verification_status, (xmax = 0) AS created`,
          [
            "web-authorization-request",
            clientSubmissionId,
            accountId,
            propertyTaxFileId,
            organizationId,
            submittedByUserId,
            ownerName,
            ownerTelephone,
            null,
            signerPrintedName,
            signerTitle,
            signerRole,
            signature.sha256,
            signature.content,
            authorizationSha256,
            attestationAcceptedAt,
            "pending_manual_verification",
            metadata.userAgent,
            metadata.ip,
            JSON.stringify({
              authorization,
              referer: metadata.referer,
              signature: {
                height: signature.height,
                mime_type: "image/png",
                width: signature.width,
              },
            }),
          ],
        );
        stored = rows?.[0] || null;
        if (!stored) {
          return res.status(409).set("cache-control", "no-store").json({
            error: "signup_submission_conflict",
          });
        }
      } catch (error) {
        logger.error?.("[signup] DB insert failed", { code: safeErrorCode(error) });
        return res.status(503).set("cache-control", "no-store").json({
          error: "signup_persistence_unavailable",
        });
      }

      const created = stored.created === true;
      let transporter;
      try {
        if (created && smtpUrl) {
          transporter = mailer.createTransport(smtpUrl);
        } else if (created && environment.SMTP_HOST) {
          transporter = mailer.createTransport({
            host: environment.SMTP_HOST,
            port: parseInt(environment.SMTP_PORT || "587", 10),
            secure: environment.SMTP_SECURE === "1" || environment.SMTP_SECURE === "true",
            auth: environment.SMTP_USER
              ? { user: environment.SMTP_USER, pass: environment.SMTP_PASS || "" }
              : undefined,
          });
        }
      } catch {
        logger.warn?.("[signup] SMTP transport unavailable");
      }

      let emailSent = false;
      if (transporter) {
        try {
          await transporter.sendMail({
            to: "homenodeceo@gmail.com",
            from: environment.MAIL_FROM || environment.SMTP_FROM || "no-reply@homenode",
            subject: `[UNVERIFIED — MANUAL REVIEW REQUIRED] Authorization Request - ${accountId}`,
            text: `A property-tax authorization request is pending manual identity and signature verification. Do not treat this request as authorization until verification is recorded.\n\nAccount ID: ${accountId}\nProperty Tax File ID: ${propertyTaxFileId}\nOwner Name: ${ownerName}\nTelephone: ${ownerTelephone}\nSigner: ${signerPrintedName}\nSigner Role: ${signerRole}\nAuthorization SHA-256: ${authorizationSha256}\n`,
          });
          emailSent = true;
        } catch {
          logger.warn?.("[signup] SMTP delivery failed");
        }
      }

      return res.status(created ? 202 : 200).set("cache-control", "no-store").json({
        ok: true,
        id: stored.id,
        idempotent: !created,
        verification_status: stored.verification_status,
        email_sent: emailSent,
        email_status: created
          ? signupDeliveryStatus({ configured: Boolean(transporter), sent: emailSent })
          : "not_repeated",
      });
    } catch (error) {
      logger.error?.("/api/signup/email failed", { code: safeErrorCode(error) });
      return res
        .status(500)
        .set("cache-control", "no-store")
        .json({ error: "email_failed" });
    }
  });

  return router;
}
