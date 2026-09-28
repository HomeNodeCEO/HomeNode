import assert from "node:assert/strict";
import test from "node:test";

import { PaginationError, parsePagination } from "../src/util/pagination.js";

test("pagination preserves configured defaults, ceilings, and the offset boundary", () => {
  assert.deepEqual(parsePagination({}, { defaultLimit: 25 }), { limit: 25, offset: 0 });
  assert.deepEqual(parsePagination({ limit: "", offset: "" }, { defaultLimit: 25 }), {
    limit: 25, offset: 0,
  });
  assert.deepEqual(parsePagination({ limit: "999", offset: "10000" }, { defaultLimit: 25 }), {
    limit: 100, offset: 10_000,
  });
  assert.deepEqual(parsePagination({ limit: "999", offset: 0 }, {
    defaultLimit: 25, maxLimit: 200,
  }), { limit: 200, offset: 0 });
  assert.deepEqual(parsePagination({ limit: 20, offset: 50 }, { defaultLimit: 20 }), {
    limit: 20, offset: 50,
  });
});

test("pagination rejects non-integers and excessive offsets with stable codes", () => {
  for (const [field, values, code] of [
    ["limit", ["0", "-1", "1.5", "1e3", "abc", "Infinity", "99999999999999999999", ["1", "2"]], "invalid_limit"],
    ["offset", ["-1", "1.5", "1e3", "abc", "Infinity", "10001", "99999999999999999999", ["1", "2"]], "invalid_offset"],
  ]) {
    for (const value of values) {
      assert.throws(
        () => parsePagination({ [field]: value }, { defaultLimit: 25 }),
        (error) => error instanceof PaginationError && error.message === code,
        `${field}=${String(value)}`,
      );
    }
  }
});

test("pagination rejects hostile accessors and invalid internal configuration", () => {
  assert.throws(
    () => parsePagination({ get limit() { throw new Error("private detail"); } }, { defaultLimit: 25 }),
    (error) => error instanceof PaginationError && error.message === "invalid_limit",
  );
  assert.throws(
    () => parsePagination({ get offset() { throw new Error("private detail"); } }, { defaultLimit: 25 }),
    (error) => error instanceof PaginationError && error.message === "invalid_offset",
  );
  assert.throws(() => parsePagination({}, {}), /pagination_config_invalid/);
});
