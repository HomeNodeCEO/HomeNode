import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertUadAssetsApplicable,
} from "../src/modules/uad/assetApplicability.js";
import {
  createUadAssetUpload,
  verifyUadAssetUpload,
} from "../src/modules/uad/assets.js";

const WORKFILE_ID = "00000000-0000-4000-8000-000000000001";
const ASSET_ID = "00000000-0000-4000-8000-000000000002";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";

const RULES = [
  [7, "3300.0002", "uad_sketch_asset_inapplicable"],
  [20, "0600.0016", "uad_sales_contract_asset_inapplicable"],
  [22, "1000.0032", "uad_sales_comparison_asset_inapplicable"],
];

function validAssetRequest(sectionNumber) {
  const bySection = {
    7: { asset_kind: "floor_plan", caption_type: "FloorPlan", caption: null },
    20: { asset_kind: "photo", caption_type: "SalesContractExhibit", caption: "Contract" },
    22: {
      asset_kind: "photo",
      caption_type: "SalesComparisonApproachExhibit",
      caption: "Sales comparison",
    },
  };
  return {
    ...bySection[sectionNumber],
    section_number: sectionNumber,
    content_type: "image/png",
    file_name: `section-${sectionNumber}.png`,
    byte_size: 100,
  };
}

test("canonical UAD facts gate Sections 7, 20, and 22", async () => {
  const enabledPool = {
    async query(_sql, params) {
      return {
        rows: RULES
          .filter(([, uid]) => params[1].includes(uid))
          .map(([, uid]) => ({ uad_uid: uid, value: true })),
      };
    },
  };
  await assert.doesNotReject(() => assertUadAssetsApplicable(
    enabledPool,
    WORKFILE_ID,
    RULES.map(([sectionNumber]) => ({ section_number: sectionNumber })),
  ));

  for (const [sectionNumber, uid, errorCode] of RULES) {
    const disabledPool = {
      async query() {
        return { rows: [{ uad_uid: uid, value: false }] };
      },
    };
    await assert.rejects(
      () => assertUadAssetsApplicable(
        disabledPool,
        WORKFILE_ID,
        [{ section_number: sectionNumber }],
      ),
      new RegExp(errorCode),
    );
  }
});

test("direct upload requests cannot bypass any gated UAD section", async () => {
  for (const [sectionNumber, uid, errorCode] of RULES) {
    const queries = [];
    let released = false;
    const client = {
      async query(statement, parameters = []) {
        const sql = statement.replace(/\s+/g, " ").trim();
        queries.push(sql);
        if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED" || sql === "ROLLBACK") {
          assert.deepEqual(parameters, []);
          return { rows: [] };
        }
        if (sql === "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE") {
          assert.deepEqual(parameters, [WORKFILE_ID]);
          return { rows: [{ id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "draft", signed_at: null }] };
        }
        if (sql === "SELECT EXISTS ( SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1 ) AS has_signatures") {
          assert.deepEqual(parameters, [WORKFILE_ID]);
          return { rows: [{ has_signatures: false }] };
        }
        if (/FROM appraisal\.uad_field_values/.test(sql)) {
          assert.deepEqual(parameters, [WORKFILE_ID, [uid]]);
          return { rows: [{ uad_uid: uid, value: false }] };
        }
        assert.fail(`inapplicable asset reached mutation SQL: ${sql}`);
      },
      release() { assert.equal(released, false); released = true; },
    };
    const pool = {
      connect: async () => client,
      query: async () => assert.fail("creation must use its acquired transaction client"),
    };
    await assert.rejects(
      () => createUadAssetUpload(
        pool,
        { createUploadUrl: () => assert.fail("inapplicable asset received a storage capability") },
        WORKFILE_ID,
        validAssetRequest(sectionNumber),
      ),
      new RegExp(errorCode),
    );
    assert.equal(queries[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
    assert.equal(queries.at(-1), "ROLLBACK");
    assert.equal(queries.length, 5);
    assert.equal(queries.includes("COMMIT"), false);
    assert.equal(released, true);
  }
});

test("verification rechecks applicability before reading uploaded bytes", async () => {
  const pool = {
    async query(sql) {
      if (/JOIN appraisal\.uad_workfiles/.test(sql)) {
        return { rows: [{
          id: ASSET_ID,
          section_number: 20,
          object_key: "pending/contract.png",
          original_file_name: "contract.png",
          content_type: "image/png",
          capture_metadata: { expected_byte_size: 100 },
          organization_id: ORGANIZATION_ID,
          workfile_status: "draft",
        }] };
      }
      if (/FROM appraisal\.uad_field_values/.test(sql)) {
        return { rows: [{ uad_uid: "0600.0016", value: false }] };
      }
      assert.fail(`inapplicable asset reached verification SQL: ${sql}`);
    },
  };
  await assert.rejects(
    () => verifyUadAssetUpload(
      pool,
      { inspectObject: () => assert.fail("inapplicable asset bytes were inspected") },
      WORKFILE_ID,
      ASSET_ID,
    ),
    /uad_sales_contract_asset_inapplicable/,
  );
});

test("XML, PDF, and package artifact loaders revalidate verified asset applicability", async () => {
  const sources = await Promise.all([
    readFile(new URL("../src/modules/uad/uadArtifacts.js", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/uad/uadPdfArtifacts.js", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/uad/uadPackageArtifacts.js", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    assert.match(source, /await assertUadAssetsApplicable\(queryable, workfileId, result\.rows\)/);
  }
  const routerSource = await readFile(
    new URL("../src/modules/uad/router.js", import.meta.url),
    "utf8",
  );
  assert.match(routerSource, /message\.endsWith\("_asset_inapplicable"\)\) return 409/);
});
