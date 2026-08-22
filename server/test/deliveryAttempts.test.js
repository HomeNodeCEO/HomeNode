import assert from "node:assert/strict";
import test from "node:test";

import { createGuidedDeliveryAttempt } from "../src/modules/delivery/deliveryAttempts.js";

const WORKFILE_ID = "23dcf1af-f754-4a48-90db-f74a851042f3";
const ORGANIZATION_ID = "0b66a510-c524-439d-872a-17c670178bb4";
const ARTIFACT_ID = "4c4e7e82-fcc9-42d1-a7d2-b0d3b8f528a9";
const DESTINATION_ID = "67ea2826-d1c4-4c6d-99b8-eed058fef0e7";
const ATTEMPT_ID = "5ef7598f-53c2-44fc-8417-d538446dcb12";

function deliveryPool({ workfileStatus = "signed" } = {}) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM appraisal.uad_workfiles")) {
        return {
          rows: [{
            id: WORKFILE_ID,
            organization_id: ORGANIZATION_ID,
            current_revision: 3,
            status: workfileStatus,
          }],
        };
      }
      if (sql.includes("FROM appraisal.uad_generated_artifacts")) {
        return {
          rows: [{
            id: ARTIFACT_ID,
            workfile_id: WORKFILE_ID,
            revision_number: 3,
            artifact_type: "submission_package",
            generation_status: "ready",
            content_type: "application/zip",
            byte_size: 4096,
            checksum_sha256: "b".repeat(64),
          }],
        };
      }
      if (sql.includes("INSERT INTO appraisal.delivery_destinations")) {
        return {
          rows: [{
            id: DESTINATION_ID,
            organization_id: ORGANIZATION_ID,
            platform_key: "valuelink_spur",
            tenant_key: "amerimac",
            display_name: "AmeriMac Appraisal Management",
            base_url: "https://amerimacamc.spurams.com/login.aspx",
            delivery_mode: "guided_manual",
            direct_integration: "partner_documentation_required",
          }],
        };
      }
      if (sql.includes("INSERT INTO appraisal.delivery_attempts")) {
        return {
          rows: [{
            id: ATTEMPT_ID,
            destination_id: DESTINATION_ID,
            workfile_id: WORKFILE_ID,
            revision_number: 3,
            artifact_id: ARTIFACT_ID,
            status: "prepared",
            delivery_mode: "guided_manual",
            external_order_id: "AM-3003",
            package_byte_size: 4096,
            package_checksum_sha256: "b".repeat(64),
            prepared_at: "2026-08-22T12:00:00.000Z",
            metadata: { known_tenant: true },
          }],
        };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
    release() {},
  };
  return {
    queries,
    pool: { async connect() { return client; } },
  };
}

test("prepares an AmeriMac guided delivery against the signed package checksum", async () => {
  const fixture = deliveryPool();
  const result = await createGuidedDeliveryAttempt(fixture.pool, WORKFILE_ID, {
    portal_url: "https://amerimacamc.spurams.com/login.aspx",
    external_order_id: "AM-3003",
    idempotency_key: "desktop-AM-3003-revision-3",
  });
  assert.equal(result.attempt.destination.platform_key, "valuelink_spur");
  assert.equal(result.attempt.destination.tenant_key, "amerimac");
  assert.equal(result.attempt.status, "prepared");
  assert.equal(result.plan.package.artifact_id, ARTIFACT_ID);
  assert.equal(result.plan.package.checksum_sha256, "b".repeat(64));
  assert.ok(fixture.queries.some(({ sql }) => sql === "COMMIT"));
});

test("refuses to prepare delivery before the workfile revision is signed", async () => {
  const fixture = deliveryPool({ workfileStatus: "draft" });
  await assert.rejects(
    createGuidedDeliveryAttempt(fixture.pool, WORKFILE_ID, {
      portal_url: "https://amerimacamc.spurams.com/login.aspx",
    }),
    /delivery_signed_revision_required/,
  );
  assert.ok(fixture.queries.some(({ sql }) => sql === "ROLLBACK"));
  assert.equal(fixture.queries.some(({ sql }) => sql.includes("INSERT INTO appraisal.delivery_attempts")), false);
});
