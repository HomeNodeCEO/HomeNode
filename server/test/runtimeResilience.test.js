import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";

import {
  createResilientHttpServer,
  createRuntimeResilienceConfiguration,
  installGracefulShutdown,
} from "../src/security/runtimeResilience.js";

test("runtime resilience bounds slow clients and database resource use", () => {
  const defaults = createRuntimeResilienceConfiguration({});
  assert.deepEqual(defaults.http, {
    requestTimeoutMs: 30_000,
    headersTimeoutMs: 15_000,
    keepAliveTimeoutMs: 5_000,
    connectionsCheckingIntervalMs: 1_000,
    maxHeadersCount: 100,
    maxRequestsPerSocket: 500,
  });
  assert.equal(defaults.database.max, 10);
  assert.equal(defaults.database.statement_timeout, 120_000);
  assert.equal(defaults.database.query_timeout, 125_000);
  assert.equal(defaults.database.idle_in_transaction_session_timeout, 60_000);

  const bounded = createRuntimeResilienceConfiguration({
    HTTP_REQUEST_TIMEOUT_MS: "1000",
    HTTP_HEADERS_TIMEOUT_MS: "60000",
    HTTP_MAX_HEADERS_COUNT: "999999",
    HTTP_MAX_REQUESTS_PER_SOCKET: "1",
    DATABASE_POOL_SIZE: "999",
    DATABASE_STATEMENT_TIMEOUT_MS: "900000",
    DATABASE_QUERY_TIMEOUT_MS: "5000",
    DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "0",
  });
  assert.equal(bounded.http.requestTimeoutMs, 5_000);
  assert.equal(bounded.http.headersTimeoutMs, 5_000);
  assert.equal(bounded.http.maxHeadersCount, 1_000);
  assert.equal(bounded.http.maxRequestsPerSocket, 10);
  assert.equal(bounded.database.max, 50);
  assert.equal(bounded.database.statement_timeout, 900_000);
  assert.equal(bounded.database.query_timeout, 900_000);
  assert.equal(bounded.database.idle_in_transaction_session_timeout, 5_000);
});

test("resilient HTTP server applies socket and reuse ceilings", () => {
  let captured = null;
  const server = {};
  const listener = () => undefined;
  const configuration = createRuntimeResilienceConfiguration({});
  const result = createResilientHttpServer(listener, configuration, {
    httpModule: {
      createServer(options, requestListener) {
        captured = { options, requestListener };
        return server;
      },
    },
  });
  assert.equal(result, server);
  assert.equal(captured.requestListener, listener);
  assert.equal(captured.options.requestTimeout, 30_000);
  assert.equal(captured.options.connectionsCheckingInterval, 1_000);
  assert.equal(server.maxHeadersCount, 100);
  assert.equal(server.maxRequestsPerSocket, 500);
});

test("slow incomplete request bodies are closed at the configured deadline", {
  timeout: 3_000,
}, async () => {
  const server = createResilientHttpServer((request, response) => {
    request.resume();
    request.on("end", () => response.end("ok"));
  }, {
    http: {
      requestTimeoutMs: 250,
      headersTimeoutMs: 250,
      keepAliveTimeoutMs: 250,
      connectionsCheckingIntervalMs: 50,
      maxHeadersCount: 20,
      maxRequestsPerSocket: 10,
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const outcome = await new Promise((resolve, reject) => {
      const socket = net.createConnection(server.address().port, "127.0.0.1");
      let response = "";
      socket.setEncoding("utf8");
      socket.setTimeout(2_000, () => socket.destroy(new Error("slow_request_not_closed")));
      socket.on("connect", () => {
        socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nx");
      });
      socket.on("data", (chunk) => { response += chunk; });
      socket.on("end", () => resolve(response));
      socket.on("close", () => resolve(response));
      socket.on("error", reject);
    });
    assert.match(outcome, /^HTTP\/1\.1 408 Request Timeout/m);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("graceful shutdown drains once, closes idle sockets, and releases the pool", async () => {
  const processTarget = new EventEmitter();
  processTarget.exitCode = 0;
  let closeCallback = null;
  let idleCloseCount = 0;
  let poolEndCount = 0;
  const controller = installGracefulShutdown({
    server: {
      close(callback) { closeCallback = callback; },
      closeIdleConnections() { idleCloseCount += 1; },
    },
    pool: { async end() { poolEndCount += 1; } },
    graceMs: 5_000,
    processTarget,
    logger: {},
  });
  try {
    assert.equal(controller.begin("test"), true);
    assert.equal(controller.begin("duplicate"), false);
    assert.equal(controller.isShuttingDown(), true);
    assert.equal(idleCloseCount, 1);
    closeCallback(null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(poolEndCount, 1);
    assert.equal(processTarget.exitCode, 0);
  } finally {
    controller.dispose();
  }
});
