import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUadObjectStorage } from "../src/modules/uad/r2Storage.js";

const ENVIRONMENT = Object.freeze({
  UAD_OBJECT_STORAGE_PROVIDER: "r2",
  R2_ACCOUNT_ID: "example-account",
  R2_ACCESS_KEY_ID: "example-key",
  R2_SECRET_ACCESS_KEY: "example-secret",
  R2_BUCKET: "homenode-uad-redteam",
  R2_REQUEST_TIMEOUT_MS: "1000",
  R2_MAX_ATTEMPTS: "3",
  R2_RETRY_BASE_MS: "25",
});

test("R2 operations retry bounded transient responses and expose safe resilience settings", async () => {
  let calls = 0;
  const sleeps = [];
  const storage = createUadObjectStorage(ENVIRONMENT, {
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response(null, { status: 503 });
      return new Response(null, { status: 200, headers: { etag: '"ok"' } });
    },
  });
  const uploaded = await storage.putObject({
    objectKey: "organizations/org/generated/report.xml",
    contentType: "application/xml",
    body: "<MESSAGE/>",
  });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(uploaded.etag, '"ok"');
  assert.deepEqual(storage.resilience, {
    request_timeout_ms: 1000,
    stream_timeout_ms: 120000,
    max_attempts: 3,
    max_buffered_download_bytes: 64 * 1024 * 1024,
  });
});

test("R2 timeouts fail with a bounded public-safe error after the configured attempts", async () => {
  let calls = 0;
  const timeout = new Error("upstream details must not escape");
  timeout.name = "TimeoutError";
  const storage = createUadObjectStorage(ENVIRONMENT, {
    sleep: async () => undefined,
    fetchImpl: async () => {
      calls += 1;
      throw timeout;
    },
  });
  await assert.rejects(
    () => storage.inspectObject({ objectKey: "private/probe" }),
    (error) => error.message === "uad_object_verification_timeout",
  );
  assert.equal(calls, 3);
});

test("buffered R2 downloads stop before an advertised oversized body is allocated", async () => {
  const storage = createUadObjectStorage(ENVIRONMENT, {
    fetchImpl: async () => new Response("x", {
      status: 200,
      headers: { "content-length": "1000" },
    }),
  });
  await assert.rejects(
    () => storage.getObject({ objectKey: "private/large", maxBytes: 10 }),
    /uad_object_download_too_large/,
  );
});

test("R2 downloads reject truncated bodies and remove partial disk output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uad-r2-truncated-test-"));
  try {
    const filePath = path.join(directory, "partial.bin");
    const storage = createUadObjectStorage(ENVIRONMENT, {
      fetchImpl: async () => new Response("short", {
        status: 200,
        headers: { "content-length": "10" },
      }),
    });
    await assert.rejects(
      () => storage.getObject({ objectKey: "private/truncated", maxBytes: 1024 }),
      /uad_object_download_size_mismatch/,
    );
    await assert.rejects(
      () => storage.downloadObjectToFile({
        objectKey: "private/truncated",
        filePath,
        maxBytes: 1024,
      }),
      /uad_object_download_size_mismatch/,
    );
    await assert.rejects(() => readFile(filePath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("R2 downloads treat an explicit zero content length as an integrity boundary", async () => {
  const storage = createUadObjectStorage(ENVIRONMENT, {
    fetchImpl: async () => new Response("unexpected", {
      status: 200,
      headers: { "content-length": "0" },
    }),
  });
  await assert.rejects(
    () => storage.getObject({ objectKey: "private/zero-length", maxBytes: 1024 }),
    /uad_object_download_size_mismatch/,
  );
});

test("R2 file downloads and uploads stream through disk with exact size and checksum", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "uad-r2-stream-test-"));
  try {
    const downloadPath = path.join(directory, "download.bin");
    const uploadPath = path.join(directory, "upload.bin");
    const expected = Buffer.from("streamed-uad-package");
    await writeFile(uploadPath, expected);
    let uploaded = Buffer.alloc(0);
    const storage = createUadObjectStorage(ENVIRONMENT, {
      fetchImpl: async (_url, init) => {
        if (init.method === "GET") {
          return new Response(expected, {
            status: 200,
            headers: { "content-length": String(expected.length), "content-type": "application/zip" },
          });
        }
        for await (const chunk of init.body) uploaded = Buffer.concat([uploaded, chunk]);
        return new Response(null, { status: 200, headers: { etag: '"streamed"' } });
      },
    });
    const downloaded = await storage.downloadObjectToFile({
      objectKey: "private/package.zip",
      filePath: downloadPath,
      maxBytes: 1024,
    });
    assert.deepEqual(await readFile(downloadPath), expected);
    assert.equal(downloaded.byte_size, expected.length);
    assert.match(downloaded.checksum_sha256, /^[a-f0-9]{64}$/);

    const result = await storage.putFile({
      objectKey: "private/upload.zip",
      contentType: "application/zip",
      filePath: uploadPath,
      byteSize: expected.length,
    });
    assert.deepEqual(uploaded, expected);
    assert.equal(result.byte_size, expected.length);
    assert.equal(result.etag, '"streamed"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
