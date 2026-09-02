import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  confirmedDocumentFieldApplications,
} from "../../dcad-frontend/src/lib/propertyReportPresentation.ts";
import {
  assignmentTypesFromConfirmedDocument,
  subjectUnderContractFromConfirmedDocument,
} from "../../dcad-frontend/src/lib/propertyReportAssignment.ts";

test("document imports reapply every confirmed field including a previously confirmed assignment type", () => {
  assert.deepEqual(
    confirmedDocumentFieldApplications([
      {
        field_key: "assignment_type",
        review_status: "confirmed",
        confirmed_value: "purchase_transaction",
        raw_value: "Purchase",
      },
      {
        field_key: "lender_client_address",
        review_status: "confirmed",
        normalized_value: "100 North Tryon Street, Charlotte, NC 28255",
      },
      {
        field_key: "subject_property_address",
        review_status: "rejected",
        raw_value: "513 Hardy Dr",
      },
    ]),
    [
      { fieldKey: "assignment_type", value: "purchase_transaction" },
      {
        fieldKey: "lender_client_address",
        value: "100 North Tryon Street, Charlotte, NC 28255",
      },
    ],
  );
});

test("an engagement letter replaces a stale assignment type while other evidence remains additive", () => {
  assert.deepEqual(
    assignmentTypesFromConfirmedDocument(
      ["heloc"],
      "purchase_transaction",
      "engagement_letter",
    ),
    ["purchase_transaction"],
  );
  assert.deepEqual(
    assignmentTypesFromConfirmedDocument(
      ["bridge_loan"],
      "purchase_transaction",
      "purchase_contract",
    ),
    ["bridge_loan", "purchase_transaction"],
  );
});

test("only a purchase contract confirms that the subject is under contract", () => {
  assert.equal(
    subjectUnderContractFromConfirmedDocument(
      false,
      "purchase_transaction",
      "engagement_letter",
    ),
    false,
  );
  assert.equal(
    subjectUnderContractFromConfirmedDocument(
      false,
      "purchase_transaction",
      "purchase_contract",
    ),
    true,
  );
  assert.equal(
    subjectUnderContractFromConfirmedDocument(true, "heloc", "engagement_letter"),
    true,
  );
});

test("contract fields remain visible without manually selecting Subject Under Contract", () => {
  const source = readFileSync(new URL(
    "../../dcad-frontend/src/components/ListingsContractsSalesContent.tsx",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(source, /Contract terms remain hidden until Subject Under Contract/);
  assert.match(source, /contract_closing_date/);
  assert.match(source, /contract_property_condition/);
  assert.match(source, /contract_repairs/);
  assert.match(source, /approved purchase contract will add Purchase Transaction automatically/i);
});
