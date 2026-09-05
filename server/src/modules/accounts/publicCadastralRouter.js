import express from "express";

import { authorizePublicCadastralCatalogRead } from "../../security/publicCadastralCatalog.js";
import { getPublicCadastralSubjectSummary } from "../../services/publicCadastralCatalog.js";

function publicCadastralError(error) {
  const code = String(error?.message || "");
  if (code === "public_cadastral_authentication_required") {
    return { status: 401, error: "authentication_required" };
  }
  if (code === "public_cadastral_access_denied") {
    return { status: 403, error: "application_access_denied" };
  }
  if (code === "invalid_account_id") return { status: 400, error: code };
  if (code === "public_cadastral_account_not_found") {
    return { status: 404, error: "not_found" };
  }
  return { status: 500, error: "public_cadastral_lookup_failed" };
}

export function createPublicCadastralRouter({
  pool,
  authorizePublicAccount = (auth, accountId) => authorizePublicCadastralCatalogRead(
    auth,
    accountId,
    { workflows: ["uad_3_6"] },
  ),
  loadSubjectSummary = getPublicCadastralSubjectSummary,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("public_cadastral_query_client_required");
  }
  if (typeof authorizePublicAccount !== "function") {
    throw new TypeError("public_cadastral_authorizer_required");
  }
  if (typeof loadSubjectSummary !== "function") {
    throw new TypeError("public_cadastral_subject_loader_required");
  }

  const router = express.Router();

  router.get("/api/public-cadastral/accounts/:accountId/subject-summary", async (req, res) => {
    try {
      const grant = authorizePublicAccount(req.mobileAuth, req.params.accountId);
      const subject = await loadSubjectSummary(pool, grant);
      return res.set("cache-control", "no-store").json({
        subject,
        data_scope: grant.scope,
      });
    } catch (error) {
      const response = publicCadastralError(error);
      if (response.status === 500) {
        logger.error?.("public cadastral lookup failed", error?.code || "unknown_error");
      }
      return res.set("cache-control", "no-store")
        .status(response.status)
        .json({ error: response.error });
    }
  });

  return router;
}

export default createPublicCadastralRouter;
