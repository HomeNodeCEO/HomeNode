import assert from "node:assert/strict";
import test from "node:test";

import { settleGeneratedArtifactUploads } from "../src/modules/uad/uadPackageArtifacts.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("failed package uploads wait for their sibling and remove only completed objects", async () => {
  const manifest = deferred();
  const archive = deferred();
  const deleted = [];
  const storage = {
    async deleteObject({ objectKey }) {
      deleted.push(objectKey);
    },
  };
  const failure = new Error("synthetic_manifest_upload_failed");
  const settled = settleGeneratedArtifactUploads(storage, [
    { objectKey: "attempt/manifest.json", upload: manifest.promise },
    { objectKey: "attempt/package.zip", upload: archive.promise },
  ]);

  manifest.reject(failure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deleted, [], "cleanup must wait until every in-flight upload settles");
  archive.resolve({ etag: "package-etag" });

  await assert.rejects(settled, failure);
  assert.deepEqual(deleted, ["attempt/package.zip"]);
});

test("aborted package uploads use the stable error and remove every completed attempt object", async () => {
  const controller = new AbortController();
  controller.abort();
  const deleted = [];
  const storage = {
    async deleteObject({ objectKey }) {
      deleted.push(objectKey);
    },
  };

  await assert.rejects(
    () => settleGeneratedArtifactUploads(storage, [
      { objectKey: "attempt/manifest.json", upload: Promise.resolve({ etag: "manifest-etag" }) },
      { objectKey: "attempt/package.zip", upload: Promise.resolve({ etag: "package-etag" }) },
    ], controller.signal),
    (error) => error.name === "AbortError" && error.message === "uad_artifact_request_aborted",
  );
  assert.deepEqual(deleted.sort(), ["attempt/manifest.json", "attempt/package.zip"]);
});
