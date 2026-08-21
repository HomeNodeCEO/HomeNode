import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentOcrProvider } from "../src/services/documentOcr.js";

test("OCR remains disabled until an explicit provider, HTTPS endpoint, and key exist", () => {
  assert.equal(createDocumentOcrProvider({}).configured, false);
  assert.equal(createDocumentOcrProvider({ DOCUMENT_OCR_PROVIDER: "azure" }).configured, false);
  assert.throws(
    () => createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "http://insecure.example",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    }),
    /must_use_https/,
  );
});

test("Azure Read OCR submits PDF bytes and returns page-preserving text", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (init.method === "POST") {
      return new Response(null, {
        status: 202,
        headers: {
          "operation-location": "https://example.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read/analyzeResults/operation-123?api-version=2024-11-30",
        },
      });
    }
    return Response.json({
      status: "succeeded",
      analyzeResult: {
        content: "Page One\nPage Two",
        pages: [
          { pageNumber: 1, lines: [{ content: "Page One" }] },
          { pageNumber: 2, lines: [{ content: "Page Two" }] },
        ],
      },
    });
  };
  try {
    const provider = createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.cognitiveservices.azure.com",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    });
    const result = await provider.analyzePdf(Buffer.from("%PDF-scanned"));
    assert.equal(provider.configured, true);
    assert.deepEqual(result.pages, ["Page One", "Page Two"]);
    assert.equal(result.operation_id, "operation-123");
    assert.match(requests[0].url, /prebuilt-read:analyze/);
    assert.equal(requests[0].init.headers["content-type"], "application/pdf");
    assert.equal(requests[0].init.headers["ocp-apim-subscription-key"], "secret");
    assert.equal(requests[1].init.method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OCR rejects a provider-directed polling URL outside the configured Azure origin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 202,
    headers: { "operation-location": "https://attacker.example/analyzeResults/1" },
  });
  try {
    const provider = createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.cognitiveservices.azure.com",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    });
    await assert.rejects(provider.analyzePdf(Buffer.from("%PDF-scanned")), /untrusted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

