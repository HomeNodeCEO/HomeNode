import assert from "node:assert/strict";

import { reportDestination } from "../src/lib/reportDestinations.ts";

const subject = {
  accountId: "123 456",
  ownerName: "Example Owner & Co.",
};

assert.equal(reportDestination("custom-appraisal", subject), "/report/123%20456");
assert.equal(reportDestination("uad-3.6", subject), "/uad-3.6/123%20456");
assert.equal(
  reportDestination("property-tax-protest", subject),
  "/PropertyTaxProtest?propertyId=123+456&ownerName=Example+Owner+%26+Co.",
);
assert.equal(reportDestination("custom-appraisal", { accountId: " " }), "/");

console.log("Report destination tests passed.");
