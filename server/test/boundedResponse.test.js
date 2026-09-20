import assert from "node:assert/strict";
import test from "node:test";

import {
  readBoundedJsonResponse,
  readBoundedResponseBuffer,
} from "../src/util/boundedResponse.js";

test("bounded response rejects and cancels an oversized declared body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: { "content-length": "9" },
  });
  await assert.rejects(
    () => readBoundedResponseBuffer(response, {
      maximumBytes: 8,
      tooLargeCode: "fixture_too_large",
    }),
    { message: "fixture_too_large" },
  );
  assert.equal(cancelled, true);
});

test("bounded response rejects and cancels an oversized streamed body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200 });
  await assert.rejects(
    () => readBoundedResponseBuffer(response, {
      maximumBytes: 8,
      tooLargeCode: "fixture_too_large",
    }),
    { message: "fixture_too_large" },
  );
  assert.equal(cancelled, true);
});

test("bounded response returns exact bytes and parses bounded JSON", async () => {
  const bytes = await readBoundedResponseBuffer(new Response("12345678"), {
    maximumBytes: 8,
  });
  assert.equal(bytes.toString("utf8"), "12345678");
  const payload = await readBoundedJsonResponse(new Response(JSON.stringify({ ok: true })), {
    maximumBytes: 32,
  });
  assert.deepEqual(payload, { ok: true });
});

test("bounded response refuses missing streams and invalid limits", async () => {
  await assert.rejects(
    () => readBoundedResponseBuffer({ headers: new Headers() }, {
      maximumBytes: 8,
      unavailableCode: "fixture_unavailable",
    }),
    { message: "fixture_unavailable" },
  );
  await assert.rejects(
    () => readBoundedResponseBuffer(new Response("ok"), { maximumBytes: 0 }),
    { message: "invalid_response_byte_limit" },
  );
});

test("bounded response normalizes consumed and locked body failures", async () => {
  const consumed = new Response("already read");
  await consumed.text();
  await assert.rejects(
    () => readBoundedResponseBuffer(consumed, {
      maximumBytes: 32,
      unavailableCode: "fixture_unavailable",
    }),
    { message: "fixture_unavailable" },
  );

  const locked = new Response("locked");
  const reader = locked.body.getReader();
  try {
    await assert.rejects(
      () => readBoundedResponseBuffer(locked, {
        maximumBytes: 32,
        unavailableCode: "fixture_unavailable",
      }),
      { message: "fixture_unavailable" },
    );
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  await assert.rejects(
    () => readBoundedResponseBuffer({
      bodyUsed: false,
      body: {
        locked: false,
        getReader() {
          throw new TypeError("synthetic reader acquisition failure");
        },
      },
    }, {
      maximumBytes: 32,
      unavailableCode: "fixture_unavailable",
    }),
    { message: "fixture_unavailable" },
  );
});
