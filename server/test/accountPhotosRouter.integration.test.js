import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createAccountPhotosRouter } from "../src/modules/accounts/photosRouter.js";

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    accountIdAllowed: (value) => /^\d+$/.test(value),
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(createAccountPhotosRouter(options));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

test("account photos reject invalid account identifiers before querying", async (context) => {
  let queries = 0;
  const server = await startRouter(baseOptions({
    pool: { query: async () => { queries += 1; return { rows: [] }; } },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/not-valid/photos`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_account_id" });
  assert.equal(queries, 0);
});

test("account photos preserve the exact empty-gallery response", async (context) => {
  const calls = [];
  const server = await startRouter(baseOptions({
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123/photos`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account_id: "123",
    source_record_id: null,
    listing_key: null,
    listing_id: null,
    source_name: null,
    photos: [],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["123"]);
  assert.match(calls[0].sql, /JOIN core\.v_sales_media_summary/);
  assert.match(calls[0].sql, /COALESCE\(src\.close_date, src\.listing_contract_date\) DESC NULLS LAST/);
  assert.match(calls[0].sql, /\(src\.record_type = 'listing'\) DESC/);
  assert.match(calls[0].sql, /LIMIT 1/);
});

test("account photos retain source identity and deterministic image ordering", async (context) => {
  const calls = [];
  const source = {
    source_record_id: 91,
    listing_key: "key-91",
    listing_id: "MLS-91",
    source_name: "NTREIS",
    record_type: "closed_sale",
    activity_date: "2026-08-20",
  };
  const photos = [
    { id: 4, source_record_id: 91, media_url: "https://images.example/primary.jpg", is_primary: true },
    { id: 8, source_record_id: 91, media_url: "https://images.example/second.jpg", is_primary: false },
  ];
  const server = await startRouter(baseOptions({
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        if (/FROM core\.sales_source_records/.test(sql)) return { rows: [source] };
        if (/FROM core\.sales_source_media/.test(sql)) return { rows: photos };
        throw new Error("unexpected_query");
      },
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123/photos`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { account_id: "123", ...source, photos });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, [91]);
  assert.match(calls[1].sql, /media_category = 'image'/);
  assert.match(calls[1].sql, /preferred_photo_yn DESC/);
  assert.match(calls[1].sql, /order_number NULLS LAST/);
});

test("account photo failures stay bounded and do not expose diagnostics", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    pool: {
      async query() {
        throw Object.assign(new Error("database_password=secret"), { code: "XX000" });
      },
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123/photos`);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: "account_photos_failed" });
  assert.doesNotMatch(JSON.stringify(body), /password|secret|XX000/);
  assert.equal(errors.length, 1);
});

test("account photo composition and entrypoint position remain explicit", () => {
  assert.throws(() => createAccountPhotosRouter(), /account_photos_query_client_required/);
  assert.throws(
    () => createAccountPhotosRouter(baseOptions({ accountIdAllowed: null })),
    /account_photos_account_policy_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const accountDetail = source.indexOf("app.use(createAccountDetailRouter(");
  const accountPhotos = source.indexOf("app.use(createAccountPhotosRouter(");
  const housingProfile = source.indexOf("app.use(createHousingProfileRouter(");
  assert.ok(accountPhotos > accountDetail);
  assert.ok(housingProfile > accountPhotos);
});
