import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildDeterministicZip } from "../src/modules/uad/uadDeliveryPackage.js";
import { runUadRedTeamArtifactResilience } from "../src/modules/uad/uadRedTeamArtifactResilience.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const zip = buildDeterministicZip([{ path: "report.xml", body: "<MESSAGE/>" }]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function artifact() {
  return {
    id: ARTIFACT_ID,
    revision_number: 3,
    generation_status: "ready",
    ready_for_download: true,
    byte_size: zip.byte_size,
    checksum_sha256: zip.checksum_sha256,
    metadata: {
      streamed_generation: true,
      entry_count: 1,
      image_count: 0,
    },
    download: {
      url: "https://bucket.account.r2.cloudflarestorage.com/private/package.zip?X-Amz-Signature=redacted",
    },
  };
}

test("hosted artifact runner proves streamed single-flight generation and recovery", async () => {
  let performanceCalls = 0;
  let packagePosts = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname.endsWith(".r2.cloudflarestorage.com")) {
      return new Response(zip.content, {
        status: 200,
        headers: { "content-length": String(zip.byte_size) },
      });
    }
    assert.equal(init.headers.authorization, "Bearer synthetic-token");
    if (url.pathname.endsWith("/accounts/UAD-REDTEAM-SFR-0001/workfiles")) {
      return json({ workfiles: [{ id: WORKFILE_ID, file_number: "HN-REDTEAM-DELIVERY-A-0001" }] });
    }
    if (url.pathname === "/api/system/performance") {
      performanceCalls += 1;
      return json({
        artifact_executor: {
          completed: performanceCalls === 1 ? 0 : 1,
          active: 0,
          queued: 0,
        },
      });
    }
    if (url.pathname.endsWith("/artifacts/submission-package")) {
      if (init.method === "POST") packagePosts += 1;
      return json({ package: artifact(), manifest: { ready_for_download: true } }, init.method === "POST" ? 201 : 200);
    }
    if (url.pathname === "/ready") {
      return json({ ok: true, checks: { artifact_executor: { active: 0, queued: 0 } } });
    }
    throw new Error(`unexpected_path:${url.pathname}`);
  };
  const result = await runUadRedTeamArtifactResilience({
    getAccessToken: async () => "synthetic-token",
    fetchImpl,
    checkedAt: "2026-08-25T20:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(packagePosts, 2);
  assert.equal(result.request_count, 8);
  assert.equal(result.executor.completed_after, 1);
  assert.deepEqual(Object.values(result.checks), [true, true, true, true, true]);
  assert.equal(result.artifact.checksum_sha256, createHash("sha256").update(zip.content).digest("hex"));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token|X-Amz-Signature|cloudflarestorage/i);
});

test("hosted artifact runner cannot target staging or a non-synthetic fixture", async () => {
  await assert.rejects(
    () => runUadRedTeamArtifactResilience({
      baseUrl: "https://homenode-api-staging.onrender.com",
      getAccessToken: async () => "token",
      fetchImpl: async () => json({}),
    }),
    /invalid_uad_redteam_api_url/,
  );
  await assert.rejects(
    () => runUadRedTeamArtifactResilience({
      fixtureAccountId: "UAD-STAGING-SFR-0001",
      getAccessToken: async () => "token",
      fetchImpl: async () => json({}),
    }),
    /invalid_uad_redteam_artifact_fixture/,
  );
});
