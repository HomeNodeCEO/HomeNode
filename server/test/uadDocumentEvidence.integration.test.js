import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { synchronizeUadPurchaseContract } from "../src/modules/uad/documentEvidence.js";
import { createUadWorkfile } from "../src/modules/uad/workfiles.js";

const databaseUrl = process.env.DATABASE_URL;

async function cleanup(pool, accountId) {
  await pool.query("DELETE FROM app.assignment_documents WHERE account_id = $1", [accountId]);
  await pool.query(
    `UPDATE app.report_files
        SET subject_snapshot_id = NULL, previous_report_file_id = NULL
      WHERE account_id = $1`,
    [accountId],
  );
  await pool.query(
    `DELETE FROM app.appraisal_subject_snapshots
      WHERE appraisal_case_id IN (SELECT id FROM app.appraisal_cases WHERE account_id = $1)`,
    [accountId],
  );
  await pool.query("DELETE FROM app.report_files WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM app.appraisal_cases WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM appraisal.uad_workfiles WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM core.primary_improvements WHERE account_id = $1", [accountId]);
  await pool.query("DELETE FROM core.accounts WHERE account_id = $1", [accountId]);
}

test("confirmed purchase-contract sellers populate repeatable Section 2 parties idempotently", {
  skip: !databaseUrl,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const accountId = `98${String(Date.now()).slice(-15)}`;
  try {
    await pool.query(
      `INSERT INTO core.accounts (
         account_id, county, address, city, postal_code, legal_description
       ) VALUES ($1, 'Test County', '513 Seller Test Drive', 'Garland', '75044', 'LOT 1 BLOCK A')`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO core.primary_improvements (
         account_id, year_built, living_area_sqft, bedroom_count, bath_count, number_units
       ) VALUES ($1, 2001, 1800, 3, 2, 1)`,
      [accountId],
    );
    const workfile = await createUadWorkfile(pool, accountId, {
      file_number: `UAD-SELLER-INT-${Date.now()}`,
      assignment_purpose: "Purchase",
    });
    const report = await pool.query(
      "SELECT id FROM app.report_files WHERE uad_workfile_id = $1",
      [workfile.id],
    );
    const content = Buffer.from("%PDF-1.4 seller integration fixture");
    const checksum = createHash("sha256").update(content).digest("hex");
    const insertedDocument = await pool.query(
      `INSERT INTO app.assignment_documents (
         account_id, uad_workfile_id, report_file_id, document_type, title,
         file_name, content_type, content, checksum_sha256, file_size_bytes,
         processing_status
       ) VALUES ($1, $2, $3, 'purchase_contract', 'Seller contract',
         'seller-contract.pdf', 'application/pdf', $4, $5, $6, 'reviewed')
       RETURNING id`,
      [accountId, workfile.id, report.rows[0].id, content, checksum, content.length],
    );
    const documentId = insertedDocument.rows[0].id;
    await pool.query(
      `INSERT INTO app.assignment_document_field_candidates (
         document_id, field_key, raw_value, normalized_value, review_status,
         confirmed_value, reviewer, reviewed_at
       ) VALUES
         ($1, 'buyer_name', 'Zachary Thames', 'Zachary Thames', 'confirmed', 'Zachary Thames', 'Integration Reviewer', now()),
         ($1, 'seller_name', 'Lorenzo Jr Loredo and Andi Li-Kay Thompson',
          'Lorenzo Jr Loredo and Andi Li-Kay Thompson', 'confirmed',
          'Lorenzo Jr Loredo and Andi Li-Kay Thompson', 'Integration Reviewer', now())`,
      [documentId],
    );

    const first = await synchronizeUadPurchaseContract(pool, workfile.id, documentId);
    assert.equal(first.applied, true);
    const firstEntities = await pool.query(
      `SELECT id, ordinal, label
         FROM appraisal.uad_entities
        WHERE workfile_id = $1 AND entity_type = 'assignment_seller'
        ORDER BY ordinal, id`,
      [workfile.id],
    );
    assert.deepEqual(firstEntities.rows.map((row) => row.label), [
      "Lorenzo Jr Loredo",
      "Andi Li-Kay Thompson",
    ]);
    const firstSellerValues = await pool.query(
      `SELECT entity_id, uad_uid, value
         FROM appraisal.uad_field_values
        WHERE workfile_id = $1
          AND entity_id = ANY($2::uuid[])
          AND field_context = 'seller'`,
      [workfile.id, firstEntities.rows.map((row) => row.id)],
    );
    assert.equal(firstSellerValues.rows.filter((row) => row.uad_uid === "1000.0021" && row.value === "PropertySeller").length, 2);
    assert.equal(firstSellerValues.rows.filter((row) => row.uad_uid === "1000.0019" && ["Loredo", "Thompson"].includes(row.value)).length, 2);

    const repeated = await synchronizeUadPurchaseContract(pool, workfile.id, documentId);
    assert.equal(repeated.changed_field_count, 0);
    const repeatedEntities = await pool.query(
      `SELECT id FROM appraisal.uad_entities
        WHERE workfile_id = $1 AND entity_type = 'assignment_seller'
        ORDER BY ordinal, id`,
      [workfile.id],
    );
    assert.deepEqual(repeatedEntities.rows.map((row) => row.id), firstEntities.rows.map((row) => row.id));

    await pool.query(
      `UPDATE app.assignment_document_field_candidates
          SET confirmed_value = 'Example Seller LLC', normalized_value = 'Example Seller LLC'
        WHERE document_id = $1 AND field_key = 'seller_name'`,
      [documentId],
    );
    await synchronizeUadPurchaseContract(pool, workfile.id, documentId);
    const corrected = await pool.query(
      `SELECT entity.id, entity.label, value.uad_uid, value.value
         FROM appraisal.uad_entities entity
         JOIN appraisal.uad_field_values value ON value.entity_id = entity.id
        WHERE entity.workfile_id = $1 AND entity.entity_type = 'assignment_seller'
        ORDER BY value.uad_uid`,
      [workfile.id],
    );
    assert.equal(new Set(corrected.rows.map((row) => row.id)).size, 1);
    assert.ok(corrected.rows.every((row) => row.label === "Example Seller LLC"));
    assert.equal(corrected.rows.find((row) => row.uad_uid === "1000.0020")?.value, "Example Seller LLC");
    assert.equal(corrected.rows.find((row) => row.uad_uid === "1000.0116")?.value, "PropertySeller");
    assert.equal(corrected.rows.find((row) => row.uad_uid === "1000.0018")?.value, null);
    assert.equal(corrected.rows.find((row) => row.uad_uid === "1000.0019")?.value, null);
  } finally {
    await cleanup(pool, accountId).catch(() => {});
    await pool.end();
  }
});
