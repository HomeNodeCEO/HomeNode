import express from "express";
import nodemailer from "nodemailer";

import {
  normalizeSignupPayload,
  signupDeliveryStatus,
  signupRequestMetadata,
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
} = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("signup_pool_required");
  if (typeof signupRateLimiter !== "function") {
    throw new TypeError("signup_rate_limiter_required");
  }
  if (!mailer || typeof mailer.createTransport !== "function") {
    throw new TypeError("signup_mailer_required");
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
      let payload;
      try {
        payload = normalizeSignupPayload(req.body);
      } catch (error) {
        return res
          .status(400)
          .set("cache-control", "no-store")
          .json({ error: error?.message || "invalid_signup_payload" });
      }
      const { accountId, ownerEmail, ownerName, ownerTelephone } = payload;
      const smtpUrl = environment.SMTP_URL || environment.SMTP_CONNECTION_URL;
      let transporter;
      if (smtpUrl) {
        transporter = mailer.createTransport(smtpUrl);
      } else if (environment.SMTP_HOST) {
        transporter = mailer.createTransport({
          host: environment.SMTP_HOST,
          port: parseInt(environment.SMTP_PORT || "587", 10),
          secure: environment.SMTP_SECURE === "1" || environment.SMTP_SECURE === "true",
          auth: environment.SMTP_USER
            ? { user: environment.SMTP_USER, pass: environment.SMTP_PASS || "" }
            : undefined,
        });
      }

      const subject = `New Enrollment Submission${accountId ? ` - ${accountId}` : ""}`;
      const text = `A new enrollment was submitted.\n\nOwner Name: ${ownerName}\nTelephone: ${ownerTelephone}\n${accountId ? `Account ID: ${accountId}\n` : ""}`;
      let id = null;
      try {
        const metadata = signupRequestMetadata(req);
        const { rows } = await pool.query(
          `INSERT INTO app.signups (source, account_id, owner_name, owner_telephone, owner_email, user_agent, ip, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            "web-signup",
            accountId || null,
            ownerName,
            ownerTelephone,
            ownerEmail,
            metadata.userAgent,
            metadata.ip,
            { referer: metadata.referer },
          ],
        );
        id = rows?.[0]?.id ?? null;
      } catch (error) {
        logger.error?.("[signup] DB insert failed", { code: safeErrorCode(error) });
      }

      let emailSent = false;
      if (transporter) {
        try {
          await transporter.sendMail({
            to: "homenodeceo@gmail.com",
            from: environment.MAIL_FROM || environment.SMTP_FROM || "no-reply@homenode",
            subject,
            text,
          });
          emailSent = true;
        } catch {
          logger.warn?.("[signup] SMTP delivery failed");
        }
      }

      return res.set("cache-control", "no-store").json({
        ok: true,
        id,
        email_sent: emailSent,
        email_status: signupDeliveryStatus({ configured: Boolean(transporter), sent: emailSent }),
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
