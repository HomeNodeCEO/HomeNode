import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  isPublicNetworkAddress,
  loadRemoteImage,
  parsePublicHttpsUrl,
} from "../src/security/remoteImageLoader.js";

const PUBLIC_IPV4 = "93.184.216.34";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]);

function response(statusCode, headers = {}, chunks = []) {
  const stream = Readable.from(chunks);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

function publicLookup(address = PUBLIC_IPV4) {
  return async () => [{ address, family: 4 }];
}

test("remote image URLs require ordinary credential-free HTTPS on port 443", () => {
  assert.equal(parsePublicHttpsUrl("http://images.example.test/photo.png"), null);
  assert.equal(parsePublicHttpsUrl("https://user:password@images.example.test/photo.png"), null);
  assert.equal(parsePublicHttpsUrl("https://images.example.test:8443/photo.png"), null);
  assert.equal(parsePublicHttpsUrl("https://localhost/photo.png"), null);
  assert.equal(parsePublicHttpsUrl("https://metadata.service.internal/photo.png"), null);
  assert.equal(parsePublicHttpsUrl("https://images.example.test/photo.png")?.hostname, "images.example.test");
});

test("network-address validation rejects private, metadata, mapped, and reserved ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.10",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "2001::1",
    "2002:0a00:0001::",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ]) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
  assert.equal(isPublicNetworkAddress(PUBLIC_IPV4), true);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);
});

test("direct private destinations are rejected before a request is opened", async () => {
  let opened = false;
  const result = await loadRemoteImage("https://169.254.169.254/latest/meta-data", {
    openResponse: async () => {
      opened = true;
      throw new Error("must not open");
    },
  });
  assert.equal(result, null);
  assert.equal(opened, false);
});

test("DNS answers are rejected if any candidate address is not public", async () => {
  let opened = false;
  const result = await loadRemoteImage("https://images.example.test/photo.png", {
    lookup: async () => [
      { address: PUBLIC_IPV4, family: 4 },
      { address: "10.0.0.8", family: 4 },
    ],
    openResponse: async () => {
      opened = true;
      throw new Error("must not open");
    },
  });
  assert.equal(result, null);
  assert.equal(opened, false);
});

test("every redirect destination is DNS-validated before it is fetched", async () => {
  const opened = [];
  const result = await loadRemoteImage("https://images.example.test/photo.png", {
    lookup: async (hostname) => [{
      address: hostname === "metadata.example.test" ? "169.254.169.254" : PUBLIC_IPV4,
      family: 4,
    }],
    openResponse: async ({ url, target }) => {
      opened.push({ hostname: url.hostname, address: target.address });
      return response(302, { location: "https://metadata.example.test/latest/meta-data" });
    },
  });
  assert.equal(result, null);
  assert.deepEqual(opened, [{ hostname: "images.example.test", address: PUBLIC_IPV4 }]);
});

test("a bounded public redirect can return a signature-verified image", async () => {
  const opened = [];
  const result = await loadRemoteImage("https://images.example.test/start", {
    lookup: publicLookup(),
    openResponse: async ({ url, target }) => {
      opened.push({ hostname: url.hostname, address: target.address });
      if (url.pathname === "/start") {
        return response(307, { location: "https://cdn.example.test/photo.png" });
      }
      return response(200, {
        "content-type": "image/png; charset=binary",
        "content-length": String(PNG.length),
      }, [PNG]);
    },
  });
  assert.deepEqual(result, PNG);
  assert.deepEqual(opened, [
    { hostname: "images.example.test", address: PUBLIC_IPV4 },
    { hostname: "cdn.example.test", address: PUBLIC_IPV4 },
  ]);
});

test("redirect chains stop at the configured limit", async () => {
  let requests = 0;
  const result = await loadRemoteImage("https://images.example.test/start", {
    maxRedirects: 1,
    lookup: publicLookup(),
    openResponse: async () => {
      requests += 1;
      return response(302, { location: "https://images.example.test/again" });
    },
  });
  assert.equal(result, null);
  assert.equal(requests, 2);
});

test("streaming image reads stop when the byte limit is exceeded", async () => {
  const result = await loadRemoteImage("https://images.example.test/photo.png", {
    maxBytes: PNG.length,
    lookup: publicLookup(),
    openResponse: async () => response(200, { "content-type": "image/png" }, [PNG, Buffer.from([0x02])]),
  });
  assert.equal(result, null);
});

test("declared oversize responses and content-type signature mismatches are rejected", async () => {
  const oversized = await loadRemoteImage("https://images.example.test/photo.jpg", {
    maxBytes: 8,
    lookup: publicLookup(),
    openResponse: async () => response(200, {
      "content-type": "image/jpeg",
      "content-length": "9",
    }, [JPEG]),
  });
  assert.equal(oversized, null);

  const disguised = await loadRemoteImage("https://images.example.test/photo.jpg", {
    lookup: publicLookup(),
    openResponse: async () => response(200, { "content-type": "image/jpeg" }, [PNG]),
  });
  assert.equal(disguised, null);
});

test("valid JPEG content remains supported", async () => {
  const result = await loadRemoteImage("https://images.example.test/photo.jpg", {
    lookup: publicLookup(),
    openResponse: async ({ target }) => {
      assert.deepEqual(target, {
        hostname: "images.example.test",
        address: PUBLIC_IPV4,
        family: 4,
      });
      return response(200, { "content-type": "image/jpeg" }, [JPEG]);
    },
  });
  assert.deepEqual(result, JPEG);
});

test("the global timeout also bounds stalled DNS resolution", async () => {
  let opened = false;
  const result = await loadRemoteImage("https://images.example.test/photo.jpg", {
    timeoutMs: 5,
    lookup: async () => new Promise(() => {}),
    openResponse: async () => {
      opened = true;
      throw new Error("must not open");
    },
  });
  assert.equal(result, null);
  assert.equal(opened, false);
});
