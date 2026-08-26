import "dotenv/config";

import { createUadObjectStorage } from "../src/modules/uad/r2Storage.js";
import { verifyUadObjectStorage } from "../src/modules/uad/uadObjectStorageProbe.js";

const isolatedBucket = String(process.env.UAD_R2_BUCKET || "").trim();
const sharedBucket = String(process.env.R2_BUCKET || "").trim();
const storage = createUadObjectStorage(process.env, {
  bucket: isolatedBucket || sharedBucket,
  isolated: Boolean(isolatedBucket && isolatedBucket !== sharedBucket),
});
const requireIsolated = process.env.NODE_ENV === "production"
  || /^(1|true|yes|on)$/i.test(String(process.env.UAD_OBJECT_STORAGE_REQUIRE_ISOLATION || ""));

const result = await verifyUadObjectStorage(storage, { requireIsolated });
console.log(JSON.stringify(result));
