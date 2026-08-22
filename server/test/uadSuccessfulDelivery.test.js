import assert from "node:assert/strict";
import test from "node:test";

import { verifyUadSuccessfulDelivery } from "../scripts/verifyUadSuccessfulDelivery.js";

test("builds a deterministic schema-valid signed synthetic UAD delivery package", async () => {
  const evidence = await verifyUadSuccessfulDelivery();

  assert.equal(evidence.ok, true);
  assert.equal(evidence.fixture.synthetic_only, true);
  assert.equal(evidence.fixture.workfile_status, "signed");
  assert.equal(evidence.xml.schema_valid, true);
  assert.equal(evidence.xml.schema_error_count, 0);
  assert.equal(evidence.xml.image_reference_count, 1);
  assert.ok(evidence.pdf.page_count > 0);
  assert.equal(evidence.pdf.signer_count, 1);
  assert.equal(evidence.pdf.rendered_asset_count, 1);
  assert.equal(evidence.manifest.private_object_keys_excluded, true);
  assert.equal(evidence.package.deterministic, true);
  assert.deepEqual(evidence.package.entries, [
    "Images/001-100000000000-subject-front.png",
    "UAD-STAGING-SFR-0001.pdf",
    "UAD-STAGING-SFR-0001.xml",
  ]);
});
