import assert from "node:assert/strict";
import test from "node:test";

import { runUadRedTeamDeliveryChecks } from "../src/modules/uad/uadRedTeamDelivery.js";

const DELIVERY_ID = "11111111-1111-4111-8111-111111111113";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const CHECKSUM = "a".repeat(64);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deliveryFetch({ acceptPrivatePortal = false } = {}) {
  let attempt = null;
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init.method || "GET";
    const persona = new Headers(init.headers).get("authorization")?.replace("Bearer redteam-token-", "");
    const body = init.body ? JSON.parse(init.body) : {};

    if (path.includes("/accounts/") && path.endsWith("/workfiles")) {
      return json({ workfiles: [
        { id: DELIVERY_ID, file_number: "HN-REDTEAM-DELIVERY-A-0001", status: "exported" },
        { id: OTHER_ID, file_number: "HN-REDTEAM-ORG-B-0001", status: "draft" },
      ] });
    }
    if (path === `/api/uad/workfiles/${DELIVERY_ID}/artifacts/submission-package`) {
      return json({ artifact: {
        id: ARTIFACT_ID,
        ready_for_download: true,
        generation_status: "ready",
        content_type: "application/zip",
        is_current_revision: true,
        revision_number: 9,
        byte_size: 8_192,
        checksum_sha256: CHECKSUM,
      } });
    }
    if (path === "/api/uad/delivery/resolve") {
      if (acceptPrivatePortal && body.portal_url === "https://127.0.0.1/login") {
        return json({ destination: { platform_key: "generic_manual" } });
      }
      return json({ error: "delivery_portal_url_invalid" }, 400);
    }
    if (path === `/api/uad/workfiles/${OTHER_ID}/delivery-attempts`) {
      return json({ error: "uad_workfile_access_denied" }, 403);
    }
    if (path === `/api/uad/workfiles/${DELIVERY_ID}/delivery-attempts`) {
      if (persona === "appraiser_b" || (persona === "reviewer_a" && method === "POST")) {
        return json({ error: "uad_workfile_access_denied" }, 403);
      }
      if (method === "GET") return json({ attempts: attempt ? [attempt] : [] });
      if (method === "POST") {
        attempt ||= {
          id: ATTEMPT_ID,
          workfile_id: DELIVERY_ID,
          revision_number: 9,
          artifact_id: ARTIFACT_ID,
          status: "prepared",
          package_byte_size: 8_192,
          package_checksum_sha256: CHECKSUM,
        };
        return json({
          attempt,
          plan: {
            mode: "guided_manual",
            automated_submission: false,
            package: { checksum_sha256: CHECKSUM },
          },
        }, 201);
      }
    }
    const patchMatch = path.match(new RegExp(`^/api/uad/workfiles/${DELIVERY_ID}/delivery-attempts/(.+)$`));
    if (patchMatch && method === "PATCH") {
      if (persona === "appraiser_b" || persona === "reviewer_a") {
        return json({ error: "uad_workfile_access_denied" }, 403);
      }
      if (patchMatch[1] !== ATTEMPT_ID) return json({ error: "delivery_attempt_id_invalid" }, 400);
      if (body.status === "delivered" && !body.external_delivery_id && !body.receipt_reference) {
        return json({ error: "delivery_receipt_required" }, 400);
      }
      if (body.status === "failed" && !body.failure_code) {
        return json({ error: "delivery_failure_code_required" }, 400);
      }
      if (body.status === "failed" && body.failure_code?.includes(" ")) {
        return json({ error: "delivery_failure_code_invalid" }, 400);
      }
      if (attempt?.status !== "prepared") {
        return json({ error: "delivery_attempt_not_found_or_completed" }, 409);
      }
      attempt = { ...attempt, status: "cancelled" };
      return json({ attempt });
    }
    throw new Error(`unexpected_request:${method}:${path}`);
  };
}

const getAccessToken = async (persona) => `redteam-token-${persona}`;

test("hosted delivery runner proves authorization, package binding, and finality without submission", async () => {
  const result = await runUadRedTeamDeliveryChecks({
    fetchImpl: deliveryFetch(),
    getAccessToken,
    checkedAt: "2026-08-25T12:00:00.000Z",
    idempotencyKey: "redteam-delivery-unit-test-0001",
  });
  assert.equal(result.ok, true);
  assert.equal(result.external_submission_attempted, false);
  assert.equal(result.request_count, 27);
  assert.equal(result.checks.authorization.ready, true);
  assert.equal(result.checks.portal_target_validation.attempted_count, 8);
  assert.equal(result.checks.idempotent_package_binding.same_attempt_id, true);
  assert.equal(result.checks.idempotent_package_binding.checksum_bound, true);
  assert.equal(result.checks.cancellation_finality.final_status, "cancelled");
  assert.doesNotMatch(JSON.stringify(result), /redteam-token-|synthetic-secret|Bearer\s/i);
});

test("hosted delivery runner fails if a private portal target is accepted", async () => {
  const result = await runUadRedTeamDeliveryChecks({
    fetchImpl: deliveryFetch({ acceptPrivatePortal: true }),
    getAccessToken,
    idempotencyKey: "redteam-delivery-unit-test-0002",
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.portal_target_validation.ready, false);
});
