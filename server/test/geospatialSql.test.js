import assert from "node:assert/strict";
import test from "node:test";

import { greatCircleDistanceMilesSql } from "../src/services/geospatialSql.js";

test("great-circle SQL composes only the supplied server-owned coordinate expressions", () => {
  assert.equal(greatCircleDistanceMilesSql({
    subjectLatitude: "subject.latitude",
    subjectLongitude: "subject.longitude",
    comparableLatitude: "comparable.latitude",
    comparableLongitude: "comparable.longitude",
  }), `3958.7613 * ACOS(
    LEAST(1, GREATEST(-1,
      COS(RADIANS(subject.latitude)) *
      COS(RADIANS(comparable.latitude)) *
      COS(RADIANS(comparable.longitude) - RADIANS(subject.longitude)) +
      SIN(RADIANS(subject.latitude)) *
      SIN(RADIANS(comparable.latitude))
    ))
  )`);
});
