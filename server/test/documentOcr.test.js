import assert from "node:assert/strict";
import test from "node:test";

import {
  createDocumentOcrProvider,
  documentOcrInternals,
} from "../src/services/documentOcr.js";

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
  assert.throws(
    () => createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT:
        "https://user:password@example.cognitiveservices.azure.com?leak=true",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    }),
    /document_ocr_endpoint_invalid/,
  );
  assert.throws(
    () => createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://[invalid",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    }),
    { message: "document_ocr_endpoint_invalid" },
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
    assert.equal(requests[0].init.redirect, "manual");
    assert.equal(requests[1].init.method, "GET");
    assert.equal(requests[1].init.redirect, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OCR rejects same-origin polling URLs outside the Azure result path", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
  }), {
      status: 202,
      headers: {
        "operation-location":
          "https://example.cognitiveservices.azure.com/admin/operation-1?api-version=2024-11-30",
      },
    });
  try {
    const provider = createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.cognitiveservices.azure.com",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    });
    await assert.rejects(
      provider.analyzePdf(Buffer.from("%PDF-scanned")),
      { message: "document_ocr_operation_location_untrusted" },
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OCR refuses redirects and sanitizes provider and transport errors", async () => {
  const originalFetch = globalThis.fetch;
  let redirectCalls = 0;
  globalThis.fetch = async (_url, init) => {
    redirectCalls += 1;
    assert.equal(init.redirect, "manual");
    return Response.json(
      { error: { code: "Redirected", message: "sensitive provider detail" } },
      {
        status: 302,
        headers: { location: "https://attacker.example/steal-key" },
      },
    );
  };
  try {
    const provider = createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.cognitiveservices.azure.com",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    });
    await assert.rejects(
      provider.analyzePdf(Buffer.from("%PDF-scanned")),
      (error) => {
        assert.equal(error.message, "document_ocr_submit_failed_http_302_Redirected");
        assert.equal(error.message.includes("sensitive provider detail"), false);
        return true;
      },
    );
    assert.equal(redirectCalls, 1);

    const transportDetail = "socket failure exposing a private hostname";
    globalThis.fetch = async () => {
      throw new Error(transportDetail);
    };
    await assert.rejects(
      provider.analyzePdf(Buffer.from("%PDF-scanned")),
      (error) => {
        assert.equal(error.message, "document_ocr_submit_unavailable");
        assert.equal(error.message.includes(transportDetail), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OCR bounds and cancels oversized polling results", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(null, {
        status: 202,
        headers: {
          "operation-location":
            "https://example.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read/analyzeResults/operation-large?api-version=2024-11-30",
        },
      });
    }
    return new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }), {
      headers: {
        "content-length": String(
          documentOcrInternals.MAX_OCR_RESULT_RESPONSE_BYTES + 1,
        ),
      },
    });
  };
  try {
    const provider = createDocumentOcrProvider({
      DOCUMENT_OCR_PROVIDER: "azure",
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.cognitiveservices.azure.com",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "secret",
    });
    await assert.rejects(
      provider.analyzePdf(Buffer.from("%PDF-scanned")),
      { message: "document_ocr_poll_response_too_large" },
    );
    assert.equal(cancelled, true);
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
