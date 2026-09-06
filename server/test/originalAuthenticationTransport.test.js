import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createMobileAuthenticator,
  createOidcAccessTokenVerifier,
  getOriginalMobileAuthentication,
} from "../src/modules/mobile/auth.js";
import {
  createWebSessionAuthenticator,
  getOriginalWebSessionAuthentication,
  WEB_SESSION_COOKIE,
} from "../src/security/webAuth.js";

const IDS = Object.freeze({
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  otherUser: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  identity: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  otherIdentity: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  session: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  otherSession: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  organization: "11111111-1111-4111-8111-111111111111",
});
const ISSUER = "https://identity.transport.example.test";
const AUDIENCE = "homenode-synthetic-mobile";
const CLIENT = "client_synthetic_transport";
const SUBJECT = "synthetic-subject-A";
const COOKIE = "synthetic-browser-session-A";
const FRONTEND = "https://frontend.transport.example.test";
const NOW = 1_800_000_000;
const JWKS_URI = "https://keys.transport.example.test/jwks";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = Object.freeze({ ...publicKey.export({ format: "jwk" }), kid: "synthetic-transport-key", alg: "RS256", use: "sig" });
const sha256 = value => createHash("sha256").update(value).digest("hex");
const compactSql = value => String(value).replace(/\s+/g, " ").trim();
const copy = value => structuredClone(value);

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function atBarrier(entered, release, pending, action) {
  try {
    const reached = await Promise.race([entered.promise.then(() => true), pending.then(() => false)]);
    assert.equal(reached, true, "authentication completed before reaching the required synthetic barrier");
    await action();
  } finally {
    release.resolve();
    await pending;
  }
}

function claims(overrides = {}) {
  return { iss: ISSUER, aud: AUDIENCE, client_id: CLIENT, sub: SUBJECT,
    exp: NOW + 300.25, nbf: NOW - 10.5, iat: NOW - 30.25, ...overrides };
}

function token(payload = claims(), header = { alg: "RS256", kid: JWK.kid }) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
  const body = `${encodedHeader}.${encodedPayload}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body, "ascii"), privateKey).toString("base64url")}`;
}

function realVerifier({ issuer = ISSUER, audience = AUDIENCE, clientId = CLIENT,
  now = () => NOW * 1000, clockToleranceSeconds = 60, onFetch } = {}) {
  const fetches = [];
  const contractFailures = [];
  const verifier = createOidcAccessTokenVerifier({ issuer, audience, clientId, now,
    clockToleranceSeconds, jwksUri: JWKS_URI,
    fetchImpl: async (url, options) => {
      try {
        assert.equal(url, JWKS_URI, "only the synthetic JWKS endpoint is used");
        assert.equal(options.headers.accept, "application/json");
        assert.ok(options.signal instanceof AbortSignal);
      } catch (error) { contractFailures.push(error); throw error; }
      fetches.push({ url, headers: copy(options.headers) });
      if (onFetch) await onFetch();
      return { ok: true, async json() { return { keys: [{ ...JWK }] }; } };
    },
  });
  return { verifier, fetches, contractFailures };
}

function rows(overrides = {}) {
  return [{ user_id: IDS.user, identity_id: IDS.identity, session_id: IDS.session,
    email: "synthetic@example.test", display_name: "Synthetic Transport User",
    organization_id: IDS.organization, organization_display_name: "Synthetic Organization",
    role_code: "appraiser", ...overrides }];
}

function identityPool(kind, { resultRows = rows(), issuer = ISSUER, subject = SUBJECT,
  cookie = COOKIE, onSelect, selectError, updateError } = {}) {
  const calls = [];
  const contractFailures = [];
  return {
    calls, contractFailures,
    async query(sql, parameters = []) {
      const text = compactSql(sql);
      let phase;
      try {
        assert.equal(typeof sql, "string");
        assert.ok(Array.isArray(parameters));
        if (kind === "mobile" && text.includes("FROM app_auth.oidc_identities identities")) {
          phase = "select";
          assert.match(text, /\bidentities\.id AS identity_id\b/);
          assert.match(text, /users\.id AS user_id/);
          assert.match(text, /users\.active = true/);
          assert.match(text, /memberships\.status = 'active'/);
          assert.match(text, /WHERE identities\.issuer = \$1 AND identities\.subject = \$2/);
          assert.deepEqual(parameters, [issuer, subject]);
        } else if (kind === "mobile" && text.startsWith("UPDATE app_auth.oidc_identities")) {
          phase = "update";
          assert.equal(text, "UPDATE app_auth.oidc_identities SET last_authenticated_at = now(), updated_at = now() WHERE issuer = $1 AND subject = $2");
          assert.deepEqual(parameters, [issuer, subject]);
        } else if (kind === "web" && text.includes("FROM app_auth.web_sessions sessions")) {
          phase = "select";
          assert.match(text, /\bsessions\.id AS session_id\b/);
          assert.match(text, /users\.id AS user_id/);
          assert.match(text, /users\.active = true/);
          assert.match(text, /memberships\.status = 'active'/);
          assert.match(text, /WHERE sessions\.token_sha256 = \$1 AND sessions\.revoked_at IS NULL AND sessions\.expires_at > now\(\)/);
          assert.deepEqual(parameters, [sha256(cookie)]);
        } else {
          assert.fail(`unexpected synthetic identity query: ${text}`);
        }
      } catch (error) { contractFailures.push(error); throw error; }
      calls.push({ phase, sql: text, parameters: copy(parameters) });
      if (phase === "select") {
        if (onSelect) await onSelect();
        if (selectError) throw selectError;
        return { rows: copy(resultRows) };
      }
      if (updateError) throw updateError;
      return { rows: [] };
    },
  };
}

class Request extends EventEmitter {
  constructor(headers = {}, method = "GET") {
    super();
    this.headers = { ...headers };
    this.method = method;
    this.aborted = false;
    this.destroyed = false;
    this.headerReads = [];
  }
  get(name) { this.headerReads.push(name.toLowerCase()); return this.headers[name.toLowerCase()] ?? ""; }
  abort() { this.aborted = true; this.emit("aborted"); }
}

class Response extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.body = null;
    this.clearedCookies = [];
    this.writableEnded = false;
    this.writableFinished = false;
    this.destroyed = false;
  }
  set(name, value) { this.headers[name.toLowerCase()] = value; return this; }
  status(value) { this.statusCode = value; return this; }
  json(body) { this.body = body; this.finish(); return this; }
  clearCookie(name, options) { this.clearedCookies.push({ name, options: copy(options) }); return this; }
  finish() { this.writableEnded = true; this.writableFinished = true; this.emit("finish"); }
  close() { this.destroyed = true; this.emit("close"); }
}

const getters = { mobile: getOriginalMobileAuthentication, web: getOriginalWebSessionAuthentication };
function fixture(kind, options = {}) {
  const jwt = options.jwt ?? token();
  const cryptography = options.cryptography ?? (kind === "mobile" ? realVerifier(options.verifierOptions) : null);
  const pool = options.pool ?? identityPool(kind, options.poolOptions);
  const req = options.req ?? new Request(kind === "mobile"
    ? { authorization: `Bearer ${jwt}` }
    : { cookie: `${WEB_SESSION_COOKIE}=${encodeURIComponent(options.cookie ?? COOKIE)}` });
  const res = options.res ?? new Response();
  const authenticate = kind === "mobile"
    ? createMobileAuthenticator({ pool, verifier: options.verifier ?? cryptography.verifier })
    : createWebSessionAuthenticator({ pool, environment: { WEB_APP_URL: FRONTEND } });
  const value = { kind, jwt, pool, cryptography, req, res, authenticate, nextCalls: 0 };
  value.run = async () => { await authenticate(req, res, () => { value.nextCalls += 1; }); return value; };
  value.original = () => getters[kind](req);
  return value;
}

function healthy(value) {
  assert.deepEqual(value.pool.contractFailures, [], "lookup failures must not conceal a broken SQL oracle");
  if (value.cryptography) assert.deepEqual(value.cryptography.contractFailures, [], "503 handling must not conceal an unexpected provider call");
}
function successful(value, expectedUser = IDS.user) {
  healthy(value);
  assert.equal(value.nextCalls, 1);
  assert.equal(value.res.statusCode, 200);
  assert.equal(value.req.mobileAuth.userId, expectedUser);
  assert.deepEqual(value.pool.calls.map(call => call.phase), value.kind === "mobile" ? ["select", "update"] : ["select"]);
}
function noListeners(value) {
  assert.equal(value.req.listenerCount("aborted"), 0);
  assert.equal(value.res.listenerCount("finish"), 0);
  assert.equal(value.res.listenerCount("close"), 0);
}
function closedRecord(record) {
  assert.ok(record);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.getOwnPropertySymbols(record).length, 0);
  assert.equal(Object.values(record).some(value => value !== null && typeof value === "object"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 16_384);
  assert.throws(() => { record.user_id = IDS.otherUser; }, TypeError);
}

test("native provenance comes from real RS256 verification and exact local identity without changing public auth", async () => {
  const clockReads = [];
  const clockValues = [(NOW - 2) * 1000, (NOW - 1) * 1000, NOW * 1000];
  const value = fixture("mobile", { verifierOptions: {
    clockToleranceSeconds: "37.5",
    now() { const index = clockReads.length; assert.ok(index < 3, "verification must not sample a second decision time"); clockReads.push(clockValues[index]); return clockValues[index]; },
  } });
  await value.run();
  successful(value);
  const record = value.original();
  closedRecord(record);
  assert.deepEqual(record, {
    version: 1, transport: "oidc_bearer", user_id: IDS.user, identity_id: IDS.identity,
    issuer: ISSUER, subject: SUBJECT, token_sha256: sha256(value.jwt),
    verification_policy: "homenode-rs256-access-token-v1", expected_audience: AUDIENCE,
    expected_client_id: CLIENT, clock_tolerance_seconds: 37.5, signature_algorithm: "RS256",
    signing_key_id_sha256: sha256(JWK.kid), verified_at_unix_seconds: NOW,
    expires_at_unix_seconds: NOW + 300.25, not_before_state: "finite",
    not_before_unix_seconds: NOW - 10.5, issued_at_state: "finite", issued_at_unix_seconds: NOW - 30.25,
  });
  assert.deepEqual(clockReads, clockValues);
  assert.equal(value.cryptography.fetches.length, 1);
  assert.deepEqual(value.req.headerReads, ["authorization"], "parse the original incoming bearer only once");
  assert.deepEqual(Reflect.ownKeys(value.req.mobileAuth).sort(), ["userId", "email", "displayName", "issuer", "subject", "organizations"].sort());
  assert.deepEqual(JSON.parse(JSON.stringify(value.req.mobileAuth)), {
    userId: IDS.user, email: "synthetic@example.test", displayName: "Synthetic Transport User",
    issuer: ISSUER, subject: SUBJECT,
    organizations: [{ organizationId: IDS.organization, displayName: "Synthetic Organization", roles: ["appraiser"] }],
  });
  assert.equal(getOriginalWebSessionAuthentication(value.req), null);
  value.res.finish();
  assert.equal(value.original(), null);
  noListeners(value);
});

test("browser hydration binds the exact session/digest without changing cookie user JSON", async () => {
  const value = await fixture("web").run();
  successful(value);
  const record = value.original();
  closedRecord(record);
  assert.deepEqual(record, { version: 1, transport: "browser_session", user_id: IDS.user,
    session_id: IDS.session, session_token_sha256: sha256(COOKIE),
    verification_policy: "homenode-local-web-session-v1" });
  assert.deepEqual(value.pool.calls[0].parameters, [record.session_token_sha256]);
  assert.deepEqual(Reflect.ownKeys(value.req.mobileAuth).sort(), ["userId", "email", "displayName", "organizations"].sort());
  assert.deepEqual(JSON.parse(JSON.stringify(value.req.mobileAuth)), {
    userId: IDS.user, email: "synthetic@example.test", displayName: "Synthetic Transport User",
    organizations: [{ organizationId: IDS.organization, displayName: "Synthetic Organization", roles: ["appraiser"] }],
  });
  assert.equal(getOriginalMobileAuthentication(value.req), null);
  value.res.finish();
  noListeners(value);
});

test("a header changed while real verification waits cannot change the original token binding", async () => {
  const entered = deferred(), release = deferred();
  const value = fixture("mobile", { verifierOptions: { onFetch: async () => { entered.resolve(); await release.promise; } } });
  const pending = value.run();
  await atBarrier(entered, release, pending, () => {
    value.req.headers.authorization = `Bearer ${token(claims({ sub: "different-later-token" }))}`;
  });
  successful(value);
  assert.equal(value.original().token_sha256, sha256(value.jwt));
  assert.deepEqual(value.req.headerReads, ["authorization"]);
  value.res.finish();
});

for (const form of ["plausible fake", "wrapped real verifier", "copied genuine claims", "borrowed other-token proof", "borrowed verify method"]) {
  test(`${form} preserves ordinary injected authentication but cannot mint native provenance`, async () => {
    const crypto = realVerifier();
    const originalToken = token();
    const genuineClaims = await crypto.verifier.verify(originalToken);
    const jwt = form === "borrowed other-token proof" ? token(claims({ custom_marker: "other-token" })) : originalToken;
    const verifier = {
      configured: true, issuer: ISSUER, audience: AUDIENCE,
      verify: form === "wrapped real verifier" ? supplied => crypto.verifier.verify(supplied)
        : form === "borrowed verify method" ? crypto.verifier.verify
          : async () => form === "copied genuine claims" ? Object.freeze({ ...genuineClaims })
            : form === "plausible fake" ? Object.freeze(claims()) : genuineClaims,
    };
    const value = await fixture("mobile", { jwt, verifier, cryptography: crypto }).run();
    successful(value);
    assert.equal(value.original(), null);
    value.res.finish();
    noListeners(value);
  });
}

for (const kind of ["mobile", "web"]) {
  test(`${kind} rejects copied request/auth/record shapes and permanently retires an observed replacement`, async () => {
    const value = await fixture(kind).run();
    successful(value);
    const originalAuth = value.req.mobileAuth;
    const record = value.original();
    closedRecord(record);
    for (const candidate of [undefined, null, false, 7, "request", {}, [],
      { mobileAuth: originalAuth }, { ...value.req }, { mobileAuth: copy(originalAuth) },
      { mobileAuth: copy(record) }]) assert.equal(getters[kind](candidate), null);
    const anotherRequest = new Request();
    anotherRequest.mobileAuth = originalAuth;
    assert.equal(getters[kind](anotherRequest), null);
    value.req.mobileAuth = Object.freeze({ ...originalAuth });
    assert.equal(value.original(), null);
    value.req.mobileAuth = originalAuth;
    assert.equal(value.original(), null, "restoring a replacement already observed by the accessor cannot revive provenance");
    noListeners(value);
    value.res.finish();
  });

  for (const ending of ["finish", "close", "aborted"]) {
    test(`${kind} provenance and owned listeners retire on ${ending}`, async () => {
      const value = await fixture(kind).run();
      successful(value);
      closedRecord(value.original());
      if (ending === "aborted") value.req.abort(); else value.res[ending]();
      assert.equal(value.original(), null);
      noListeners(value);
    });
    test(`${kind} ${ending} during an awaited identity lookup cannot create late provenance`, async () => {
      const entered = deferred(), release = deferred();
      const pool = identityPool(kind, { onSelect: async () => { entered.resolve(); await release.promise; } });
      const value = fixture(kind, { pool });
      const pending = value.run();
      await atBarrier(entered, release, pending, () => {
        if (ending === "aborted") value.req.abort(); else value.res[ending]();
      });
      successful(value);
      assert.equal(value.original(), null);
      noListeners(value);
    });
  }

  test(`${kind} ignores ordinary request.destroyed but not completed response/abort flags`, async () => {
    const live = fixture(kind);
    live.req.destroyed = true;
    await live.run();
    successful(live);
    closedRecord(live.original());
    live.res.finish();
    for (const flag of ["writableEnded", "writableFinished", "destroyed", "aborted"]) {
      const value = fixture(kind);
      if (flag === "aborted") value.req.aborted = true; else value.res[flag] = true;
      await value.run();
      successful(value);
      assert.equal(value.original(), null, flag);
      noListeners(value);
    }
  });

  test(`${kind} incomplete emitter doubles retain ordinary authentication without provenance`, async () => {
    for (const side of ["request", "response"]) {
      const value = fixture(kind);
      if (side === "request") value.req.once = undefined; else value.res.once = undefined;
      await value.run();
      successful(value);
      assert.equal(value.original(), null);
      value.res.finish();
      noListeners(value);
    }
  });

  test(`${kind} newer successful attempt survives stale completion and stale cleanup`, async () => {
    const entered = deferred(), release = deferred();
    const older = fixture(kind, { pool: identityPool(kind, { onSelect: async () => { entered.resolve(); await release.promise; } }) });
    const olderPending = older.run();
    let newer, newestAuth, newestRecord;
    await atBarrier(entered, release, olderPending, async () => {
      const oldCleanup = [...older.res.listeners("finish"), ...older.res.listeners("close"), ...older.req.listeners("aborted")];
      assert.ok(oldCleanup.length > 0, "lifetime is established before the awaited lookup");
      const otherCookie = "synthetic-browser-session-B";
      const otherSubject = "synthetic-subject-B";
      if (kind === "mobile") older.req.headers.authorization = `Bearer ${token(claims({ sub: otherSubject }))}`;
      else older.req.headers.cookie = `${WEB_SESSION_COOKIE}=${otherCookie}`;
      newer = fixture(kind, { req: older.req, res: older.res,
        pool: identityPool(kind, { subject: otherSubject, cookie: otherCookie,
          resultRows: rows({ user_id: IDS.otherUser, identity_id: IDS.otherIdentity, session_id: IDS.otherSession }) }) });
      await newer.run();
      successful(newer, IDS.otherUser);
      newestAuth = newer.req.mobileAuth;
      newestRecord = newer.original();
      closedRecord(newestRecord);
      assert.equal(newestRecord.user_id, IDS.otherUser);
      if (kind === "mobile") {
        assert.equal(newestRecord.identity_id, IDS.otherIdentity);
        assert.equal(newestRecord.subject, otherSubject);
        assert.equal(newestRecord.token_sha256, sha256(older.req.headers.authorization.slice("Bearer ".length)));
      } else {
        assert.equal(newestRecord.session_id, IDS.otherSession);
        assert.equal(newestRecord.session_token_sha256, sha256(otherCookie));
      }
      for (const cleanup of oldCleanup) cleanup();
      assert.strictEqual(newer.original(), newestRecord, "retired callbacks cannot delete the active attempt");
    });
    healthy(older);
    assert.equal(older.nextCalls, 1);
    assert.strictEqual(newer.req.mobileAuth, newestAuth, "superseded completion cannot overwrite the newer public identity");
    assert.strictEqual(newer.original(), newestRecord);
    newer.res.finish();
    noListeners(newer);
  });

  test(`${kind} a newer unsuccessful attempt cannot be replaced by an older pending success`, async () => {
    const entered = deferred(), release = deferred();
    const older = fixture(kind, { pool: identityPool(kind, { onSelect: async () => { entered.resolve(); await release.promise; } }) });
    const pending = older.run();
    await atBarrier(entered, release, pending, async () => {
      const newer = fixture(kind, { req: older.req, res: older.res,
        pool: identityPool(kind, { resultRows: [] }) });
      await newer.run();
      healthy(newer);
      assert.equal(newer.res.statusCode, kind === "mobile" ? 403 : 200);
      assert.equal(newer.original(), null);
    });
    healthy(older);
    assert.equal(older.nextCalls, 1);
    assert.equal(older.req.mobileAuth, undefined, "superseded success must not replace the newer authentication outcome");
    assert.equal(older.original(), null);
    older.res.finish();
    noListeners(older);
  });
}

test("closure during the verifier's awaited JWKS fetch does not revive native provenance", async () => {
  const entered = deferred(), release = deferred();
  const value = fixture("mobile", { verifierOptions: { onFetch: async () => { entered.resolve(); await release.promise; } } });
  const pending = value.run();
  await atBarrier(entered, release, pending, () => value.res.close());
  successful(value);
  assert.equal(value.original(), null);
  noListeners(value);
});

test("browser Bearer and prepopulated identity precedence do not acquire session provenance", async () => {
  for (const mode of ["bearer", "prepopulated", "no cookie"]) {
    const value = fixture("web");
    if (mode === "bearer") value.req.headers.authorization = "Bearer ordinary-native-request";
    if (mode === "prepopulated") value.req.mobileAuth = Object.freeze({ userId: IDS.user });
    if (mode === "no cookie") delete value.req.headers.cookie;
    const before = value.req.mobileAuth;
    await value.run();
    healthy(value);
    assert.equal(value.nextCalls, 1);
    assert.strictEqual(value.req.mobileAuth, before);
    assert.equal(value.pool.calls.length, 0);
    assert.equal(value.original(), null);
    noListeners(value);
  }
});

test("browser unsafe methods preserve exact Origin rejection before any session lookup", async () => {
  for (const origin of [undefined, "https://attacker.example.test", `${FRONTEND}/`]) {
    const value = fixture("web");
    value.req.method = "POST";
    if (origin !== undefined) value.req.headers.origin = origin;
    await value.run();
    healthy(value);
    assert.equal(value.nextCalls, 0);
    assert.equal(value.res.statusCode, 403);
    assert.deepEqual(value.res.body, { error: "csrf_origin_denied" });
    assert.equal(value.res.headers["cache-control"], "no-store");
    assert.equal(value.pool.calls.length, 0);
    assert.equal(value.original(), null);
    noListeners(value);
  }
  const allowed = fixture("web");
  allowed.req.method = "POST";
  allowed.req.headers.origin = FRONTEND;
  await allowed.run();
  successful(allowed);
  closedRecord(allowed.original());
  allowed.res.finish();
});

test("browser and native bindings remain distinct on the same genuine request", async () => {
  const web = await fixture("web").run();
  successful(web);
  closedRecord(web.original());
  web.req.headers.authorization = `Bearer ${token()}`;
  const mobile = await fixture("mobile", { req: web.req, res: web.res }).run();
  successful(mobile);
  closedRecord(mobile.original());
  assert.equal(web.original(), null);
  assert.ok(mobile.original(), "retiring browser provenance must not retire the native binding");
  mobile.res.finish();
  noListeners(mobile);
});

test("normal native 401/403/503 failures never create private provenance", async () => {
  const tampered = token().split(".");
  tampered[2] = `${tampered[2][0] === "A" ? "B" : "A"}${tampered[2].slice(1)}`;
  for (const [label, options, status, code, phases] of [
    ["unsupported algorithm", { jwt: token(claims(), { alg: "none", kid: JWK.kid }) }, 401, "invalid_access_token", []],
    ["invalid signature", { jwt: tampered.join(".") }, 401, "invalid_access_token", []],
    ["unmapped identity", { poolOptions: { resultRows: [] } }, 403, "mobile_identity_not_provisioned", ["select"]],
    ["no membership", { poolOptions: { resultRows: rows({ organization_id: null }) } }, 403, "mobile_organization_membership_required", ["select"]],
    ["lookup outage", { poolOptions: { selectError: new Error("synthetic_lookup_outage") } }, 503, "mobile_auth_unavailable", ["select"]],
    ["update outage", { poolOptions: { updateError: new Error("synthetic_update_outage") } }, 503, "mobile_auth_unavailable", ["select", "update"]],
    ["unconfigured verifier", { verifier: createOidcAccessTokenVerifier() }, 503, "mobile_oidc_not_configured", []],
  ]) {
    const value = await fixture("mobile", options).run();
    healthy(value);
    assert.equal(value.nextCalls, 0, label);
    assert.equal(value.res.statusCode, status, label);
    assert.deepEqual(value.res.body, { error: code }, label);
    assert.deepEqual(value.pool.calls.map(call => call.phase), phases, label);
    assert.equal(value.original(), null, label);
    noListeners(value);
  }
});

test("absent browser session and lookup outage preserve ordinary clearing/failure behavior", async () => {
  const missing = await fixture("web", { poolOptions: { resultRows: [] } }).run();
  healthy(missing);
  assert.equal(missing.nextCalls, 1);
  assert.equal(missing.req.mobileAuth, undefined);
  assert.equal(missing.res.clearedCookies[0].name, WEB_SESSION_COOKIE);
  assert.equal(missing.original(), null);
  missing.res.finish();
  noListeners(missing);
  const failed = await fixture("web", { poolOptions: { selectError: new Error("synthetic_lookup_outage") } }).run();
  healthy(failed);
  assert.equal(failed.nextCalls, 0);
  assert.equal(failed.res.statusCode, 503);
  assert.deepEqual(failed.res.body, { error: "authentication_unavailable" });
  assert.equal(failed.original(), null);
  noListeners(failed);
});

for (const kind of ["mobile", "web"]) {
  test(`${kind} unsupported local IDs do not strengthen or break ordinary authentication`, async () => {
    const rowKey = kind === "mobile" ? "identity_id" : "session_id";
    for (const key of ["user_id", rowKey]) {
      for (const invalid of [undefined, null, "legacy-id", IDS.user.toUpperCase(),
        "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa", 123, new String(IDS.user)]) {
        const value = await fixture(kind, { poolOptions: { resultRows: rows({ [key]: invalid }) } }).run();
        healthy(value);
        assert.equal(value.nextCalls, 1);
        assert.equal(value.res.statusCode, 200);
        assert.equal(value.original(), null, `${key}: ${typeof invalid}`);
        value.res.finish();
        noListeners(value);
      }
    }
    const supported = await fixture(kind, { poolOptions: { resultRows: rows({
      user_id: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa",
      identity_id: "cccccccc-cccc-7ccc-bccc-cccccccccccc",
      session_id: "eeeeeeee-eeee-1eee-aeee-eeeeeeeeeeee",
    }) } }).run();
    successful(supported, "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa");
    closedRecord(supported.original());
    supported.res.finish();
  });
}

test("native optional times retain exact absent, finite, and present-invalid distinctions", async () => {
  for (const optional of [undefined, null, "1800000000", false, [], {}, NOW - 1.125]) {
    const value = await fixture("mobile", { jwt: token(claims({ nbf: optional, iat: optional })) }).run();
    successful(value);
    const record = value.original();
    closedRecord(record);
    const expectedState = optional === undefined ? "absent" : Number.isFinite(optional) ? "finite" : "ignored_invalid";
    assert.equal(record.not_before_state, expectedState);
    assert.equal(record.issued_at_state, expectedState);
    assert.equal(record.not_before_unix_seconds, Number.isFinite(optional) ? optional : null);
    assert.equal(record.issued_at_unix_seconds, Number.isFinite(optional) ? optional : null);
    value.res.finish();
  }
  const raw = JSON.stringify(claims({ nbf: 0, iat: 0 })).replace('"nbf":0', '"nbf":1e400').replace('"iat":0', '"iat":-1e400');
  const nonfinite = await fixture("mobile", { jwt: token(raw) }).run();
  successful(nonfinite);
  assert.equal(nonfinite.original().not_before_state, "ignored_invalid");
  assert.equal(nonfinite.original().issued_at_state, "ignored_invalid");
  assert.equal(nonfinite.original().not_before_unix_seconds, null);
  assert.equal(nonfinite.original().issued_at_unix_seconds, null);
  nonfinite.res.finish();
});

test("native expiry and optional-time tolerance equality semantics remain unchanged", async () => {
  const accepted = await fixture("mobile", { jwt: token(claims({ exp: NOW - 60, nbf: NOW + 60, iat: NOW + 60 })) }).run();
  successful(accepted);
  assert.equal(accepted.original().expires_at_unix_seconds, NOW - 60);
  accepted.res.finish();
  for (const change of [{ exp: NOW - 60.25 }, { nbf: NOW + 60.25 }, { iat: NOW + 60.25 }, { exp: null }]) {
    const value = await fixture("mobile", { jwt: token(claims(change)) }).run();
    healthy(value);
    assert.equal(value.res.statusCode, 401);
    assert.equal(value.nextCalls, 0);
    assert.equal(value.pool.calls.length, 0);
    assert.equal(value.original(), null);
    noListeners(value);
  }
  for (const [input, expected] of [[Infinity, 300], [-20, 0], ["invalid", 0]]) {
    const value = await fixture("mobile", { verifierOptions: { clockToleranceSeconds: input } }).run();
    successful(value);
    assert.equal(value.original().clock_tolerance_seconds, expected);
    value.res.finish();
  }
});

test("unsupported private text bounds preserve otherwise accepted native authentication", async () => {
  const cases = [
    { issuer: `https://identity.example.test/${"x".repeat(2001)}` },
    { subject: "subject\u0000control" }, { subject: "subject\u0085control" }, { subject: "subject\ud800" },
    { audience: "audience\u0001control" }, { audience: "audience\udc00" },
    { clientId: "client\u007fcontrol" }, { clientId: "client\ud800" },
  ];
  for (const item of cases) {
    const issuer = item.issuer ?? ISSUER, subject = item.subject ?? SUBJECT;
    const audience = item.audience ?? AUDIENCE, clientId = item.clientId ?? CLIENT;
    const value = await fixture("mobile", {
      jwt: token(claims({ iss: issuer, sub: subject, aud: audience, client_id: clientId })),
      verifierOptions: { issuer, audience, clientId }, poolOptions: { issuer, subject },
    }).run();
    successful(value);
    assert.equal(value.original(), null);
    value.res.finish();
  }
});

test("largest admitted primitive texts produce a bounded closed record and optional client stays null", async () => {
  const issuerPrefix = "https://identity.example.test/";
  const issuer = `${issuerPrefix}${"x".repeat(2000 - Buffer.byteLength(issuerPrefix))}`;
  const subject = "\u4e2d".repeat(500), audience = "a".repeat(500), clientId = "c".repeat(500);
  const value = await fixture("mobile", {
    jwt: token(claims({ iss: issuer, sub: subject, aud: audience, client_id: clientId })),
    verifierOptions: { issuer, audience, clientId }, poolOptions: { issuer, subject },
  }).run();
  successful(value);
  closedRecord(value.original());
  assert.equal(value.original().issuer, issuer);
  assert.equal(value.original().subject, subject);
  assert.equal(value.original().expected_audience, audience);
  assert.equal(value.original().expected_client_id, clientId);
  value.res.finish();
  const noClient = await fixture("mobile", { verifierOptions: { clientId: "" }, jwt: token(claims({ client_id: undefined })) }).run();
  successful(noClient);
  assert.equal(noClient.original().expected_client_id, null);
  noClient.res.finish();
});

test("nonfinite or unsafe sampled decision seconds cannot become native provenance", async () => {
  for (const milliseconds of [NaN, (Number.MAX_SAFE_INTEGER + 1) * 1000]) {
    const value = await fixture("mobile", { verifierOptions: { now: () => milliseconds },
      jwt: token(claims({ exp: Number.MAX_VALUE, nbf: undefined, iat: undefined })) }).run();
    successful(value);
    assert.equal(value.original(), null);
    value.res.finish();
  }
});
