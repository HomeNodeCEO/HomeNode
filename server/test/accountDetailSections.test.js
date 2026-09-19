import assert from "node:assert/strict";
import test from "node:test";
import { loadAccountDetailSections } from "../src/services/accountDetailSections.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("account detail sections launch independent indexed lookups concurrently", async () => {
  const calls = [];
  const pending = [];
  const pool = {
    query(sql, params) {
      const request = deferred();
      calls.push({ sql, params });
      pending.push(request);
      return request.promise;
    },
  };

  const loading = loadAccountDetailSections(pool, "26572500130160000", {
    fetchImpl: async () => ({ ok: true, json: async () => ({ features: [] }) }),
  });
  assert.equal(calls.length, 9);
  assert.ok(calls.every((call) => call.params[0] === "26572500130160000"));

  const responses = [
    [{ living_area_sqft: 1800 }],
    [{ housing_type: "Single Family Detached" }],
    [{ owner_name: "OWNER", owner_parties: [{ owner_name: "OWNER" }] }],
    [{ legal_text: "LOT 1" }],
    [{ legal_text: "PRIOR LOT" }],
    [
      { tax_year: 2026, homestead_exemption: "100000" },
      { tax_year: 2026, homestead_exemption: "0" },
      { tax_year: 2025, homestead_exemption: "90000" },
    ],
    [{ number: 1, area_sqft: 9000 }],
    [{ number: 1, improvement_type: "Attached Garage" }],
    [],
  ];
  pending.forEach((request, index) => request.resolve({ rows: responses[index] }));

  const result = await loading;
  assert.equal(result.primaryImprovement.living_area_sqft, 1800);
  assert.equal(result.housingProfile.housing_type, "Single Family Detached");
  assert.equal(result.owner.owner_name, "OWNER");
  assert.equal(result.exemptionYear, 2026);
  assert.equal(result.exemptions.length, 2);
  assert.equal(result.homesteadYes, true);
  assert.equal(result.landRows.length, 1);
  assert.equal(result.additionalImprovements.length, 1);

  const landCalls = calls.filter((call) => /FROM core\.land_detail/.test(call.sql));
  assert.equal(landCalls.length, 1);
  assert.match(landCalls[0].sql, /SELECT MAX\(latest\.tax_year\)/);
});

test("latest raw DCAD snapshot fills normalized CAD fields that are still blank", async () => {
  const pool = {
    query(sql) {
      if (/FROM core\.primary_improvements/.test(sql)) {
        return Promise.resolve({ rows: [{ living_area_sqft: 1812, building_class: null }] });
      }
      if (/FROM core\.owner_summary/.test(sql)) {
        return Promise.resolve({ rows: [{
          owner_name: null,
          mailing_address: null,
          tax_year: 2026,
          owner_parties: [],
        }] });
      }
      if (/FROM core\.legal_description_current/.test(sql)) {
        return Promise.resolve({ rows: [{ legal_text: "LOT 19", deed_transfer_date: null }] });
      }
      if (/FROM core\.dcad_json_raw/.test(sql)) {
        return Promise.resolve({ rows: [{
          tax_year: 2026,
          detail: {
            primary_improvements: { living_area_sqft: 1700, building_class: null },
            owner: {
              owner_name: null,
              mailing_address: "1402 AARON PL, DUNCANVILLE, TX 75137",
              multi_owner: [{ owner_name: "AARON PLACE OWNER", ownership_pct: "100%" }],
            },
            legal_description: {
              lines: ["LOT 19"],
              deed_transfer_date: "2020-05-14",
            },
            land_detail: [{ number: 1, zoning: "PD, Planned Development District" }],
          },
          source_attributes: {
            OWNERNME1: "AARON PLACE OWNER",
            PSTLADDRESS: "1402 AARON PL",
            PSTLCITY: "DUNCANVILLE",
            PSTLSTATE: "TX",
            PSTLZIP5: "75137",
            PSTLZIP4: "4907",
            STRCLASS: "14",
          },
        }] });
      }
      if (/FROM core\.land_detail/.test(sql)) {
        return Promise.resolve({ rows: [{ number: 1, area_sqft: 9000, zoning: null }] });
      }
      return Promise.resolve({ rows: [] });
    },
  };

  const result = await loadAccountDetailSections(pool, "221508800I0190000");
  assert.equal(result.primaryImprovement.living_area_sqft, 1812);
  assert.equal(result.primaryImprovement.building_class, "14");
  assert.equal(result.owner.owner_name, "AARON PLACE OWNER");
  assert.equal(result.owner.mailing_address, "1402 AARON PL, DUNCANVILLE, TX 75137");
  assert.equal(result.owner.owner_parties[0].ownership_pct, "100%");
  assert.equal(result.owner.source_year, null);
  assert.equal(result.owner.tax_year, null, "valuation year does not prove the raw owner year");
  assert.equal(result.legalCurrent.legal_text, "LOT 19");
  assert.equal(result.legalCurrent.deed_transfer_date, "2020-05-14");
  assert.equal(result.landRows[0].area_sqft, 9000);
  assert.equal(result.landRows[0].zoning, "PD, Planned Development District");
});

test("missing historical fields use the official DCAD parcel fallback", async () => {
  const pool = {
    query(sql) {
      if (/FROM core\.primary_improvements/.test(sql)) {
        return Promise.resolve({ rows: [{ building_class: null }] });
      }
      if (/FROM core\.owner_summary/.test(sql)) {
        return Promise.resolve({ rows: [{ owner_name: null, owner_parties: [] }] });
      }
      if (/FROM core\.dcad_json_raw/.test(sql)) {
        return Promise.resolve({ rows: [{ tax_year: 2026, detail: {}, source_attributes: {} }] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const fetchCalls = [];
  const result = await loadAccountDetailSections(pool, "221508800I0190000", {
    fetchImpl: async (_url, options) => {
      fetchCalls.push(options);
      return {
        ok: true,
        json: async () => ({ features: [{ attributes: {
          STRCLASS: "14",
          OWNERNME1: "LAM DUNG LY",
          PSTLADDRESS: "1402 AARON PL",
          PSTLCITY: "DUNCANVILLE",
          PSTLSTATE: "TX",
          PSTLZIP5: "75137",
          PSTLZIP4: "4907",
        } }] }),
      };
    },
  });

  assert.equal(fetchCalls.length, 1);
  assert.match(String(fetchCalls[0].body), /221508800I0190000/);
  assert.equal(result.primaryImprovement.building_class, "14");
  assert.equal(result.owner.owner_name, "LAM DUNG LY");
  assert.equal(result.owner.owner_parties[0].ownership_pct, null);
  assert.equal(result.owner.source_year, null);
  assert.equal(result.owner.tax_year, null);
  assert.equal(result.owner.mailing_address, "1402 AARON PL, DUNCANVILLE, TX 75137-4907");
});
test("optional land and secondary-improvement failures preserve the account response", async () => {
  const errors = [];
  const pool = {
    query(sql) {
      if (/FROM core\.land_detail/.test(sql)) return Promise.reject(new Error("land unavailable"));
      if (/FROM core\.secondary_improvements/.test(sql)) {
        return Promise.reject(new Error("secondary unavailable"));
      }
      return Promise.resolve({ rows: [] });
    },
  };

  const result = await loadAccountDetailSections(pool, "ACCOUNT", {
    logger: { error: (...args) => errors.push(args) },
    fetchImpl: async () => { throw new Error("should not query for a non-DCAD id"); },
  });

  assert.deepEqual(result.landRows, []);
  assert.deepEqual(result.additionalImprovements, []);
  assert.equal(errors.length, 2);
});

test("required section failures still fail the account request", async () => {
  const pool = {
    query(sql) {
      if (/FROM core\.owner_summary/.test(sql)) return Promise.reject(new Error("owner failed"));
      return Promise.resolve({ rows: [] });
    },
  };

  await assert.rejects(
    () => loadAccountDetailSections(pool, "ACCOUNT", { logger: { error() {} } }),
    /owner failed/,
  );
});

function currentRawOwner(overrides = {}) {
  return { owner_name: "RAW OWNER", mailing_address: "200 RAW ST", source_year: 2027,
    source_heading: "Owner (Current 2027)", parties_source_heading: "Multi-Owner (Current 2027)",
    multi_owner: [{ owner_name: "RAW OWNER", ownership_pct: "50%" }], ...overrides };
}

async function ownerSections({ normalized, raw, attributes = {}, snapshotYear = 2026,
  improvement = { building_class: "14" }, live, detail, accountId = "ACCOUNT" } = {}) {
  const queries = [], fetches = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (/FROM core\.primary_improvements/.test(sql)) return { rows: [improvement] };
    if (/FROM core\.owner_summary/.test(sql)) return { rows: normalized ? [normalized] : [] };
    if (/FROM core\.dcad_json_raw/.test(sql)) return { rows: [{ tax_year: snapshotYear,
      detail: detail === undefined ? { owner: raw } : detail, source_attributes: attributes }] };
    if (/FROM core\.legal_description_current/.test(sql)) return { rows: [{ tax_year: 2026, legal_text: "LOT 1" }] };
    if (/FROM core\.exemptions_summary/.test(sql)) return { rows: [{ tax_year: 2026, homestead_exemption: "100000" }] };
    return { rows: [] };
  } };
  const result = await loadAccountDetailSections(pool, accountId, { logger: { warn() {}, error() {} },
    fetchImpl: async (...args) => {
      fetches.push(args);
      if (!live) throw new Error("unexpected_external_fallback");
      return { ok: true, json: async () => ({ features: [{ attributes: live }] }) };
    } });
  return { result, queries, fetches };
}

test("normalized owner parties are bound to the selected summary year, not an independent latest year", async () => {
  const normalized = { owner_name: "STORED OWNER", mailing_address: "100 STORED ST", tax_year: 2026,
    owner_parties: [{ owner_name: "STORED OWNER", ownership_pct: "100", tax_year: 2026 }] };
  const { result, queries } = await ownerSections({ normalized });
  const sql = queries.find(query => /FROM core\.owner_summary/.test(query.sql)).sql;
  assert.match(sql, /op\.tax_year = os\.tax_year/);
  assert.doesNotMatch(sql, /MAX\(latest\.tax_year\)/);
  assert.match(sql, /ORDER BY os\.tax_year DESC\s+LIMIT 1/);
  assert.deepEqual(result.owner, { ...normalized, source_year: 2026 });
  assert.equal(queries.length, 9, "no additional owner query is needed");
});

test("a newer explicitly proven raw owner replaces the entire older group without changing valuation-based sections", async () => {
  const normalized = { owner_name: "OLD OWNER", mailing_address: "OLD MAILING", tax_year: 2026,
    owner_parties: [{ owner_name: "OLD OWNER", ownership_pct: "100", tax_year: 2026 }] };
  const raw = currentRawOwner({ mailing_address: null, multi_owner: [] });
  const before = structuredClone({ normalized, raw });
  const { result } = await ownerSections({ normalized, raw,
    attributes: { OWNERNME1: "GIS OWNER", PSTLADDRESS: "GIS MAILING" } });
  assert.deepEqual(result.owner, { owner_name: "RAW OWNER", mailing_address: null,
    tax_year: 2027, source_year: 2027, owner_parties: [] });
  assert.equal(result.legalCurrent.tax_year, 2026);
  assert.equal(result.exemptionYear, 2026);
  assert.equal(result.homesteadYes, true);
  assert.deepEqual(result.primaryImprovement, { building_class: "14" });
  assert.deepEqual({ normalized, raw }, before, "source rows are not mutated");
});

test("same-year and older raw groups cannot fill a different normalized owner's missing fields", async () => {
  const normalized = { owner_name: "STORED OWNER", mailing_address: null, tax_year: 2027, owner_parties: [] };
  for (const year of [2026, 2027]) {
    const { result } = await ownerSections({ normalized, raw: currentRawOwner({ source_year: year,
      source_heading: `Owner (Current ${year})`, parties_source_heading: `Multi-Owner (Current ${year})` }),
    attributes: { OWNERNME1: "GIS OWNER", PSTLADDRESS: "GIS MAILING" } });
    assert.deepEqual(result.owner, { ...normalized, source_year: 2027 });
  }
});

test("unproven raw year never displaces a good normalized owner even under a newer valuation snapshot", async () => {
  const normalized = { owner_name: "STORED OWNER", mailing_address: null, tax_year: 2026, owner_parties: [] };
  const invalidProvenance = [
    { source_year: undefined }, { source_year: true }, { source_year: "2027.0" },
    { source_year: "20270" }, { source_year: 2027.5 }, { source_year: {} },
    { source_heading: undefined }, { source_heading: "Owner (Current 2026)" },
    { source_heading: "Valuation (Current 2027)" }, { source_heading: "x".repeat(201) },
    { source_heading: ["Owner (Current 2027)"] }, { parties_source_heading: "Multi-Owner (Current 2026)" },
    { parties_source_heading: "" }, { parties_source_heading: {} },
  ];
  for (const invalid of invalidProvenance) {
    const { result } = await ownerSections({ normalized, snapshotYear: 2099, raw: currentRawOwner(invalid) });
    assert.deepEqual(result.owner, { ...normalized, source_year: 2026 }, JSON.stringify(invalid));
  }
});

test("raw current-owner heading accepts bounded whitespace and an optional absent party heading", async () => {
  const { result } = await ownerSections({ snapshotYear: 2026, raw: currentRawOwner({ source_year: "2027",
    source_heading: "  Owner ( Current 2027 ) ", parties_source_heading: undefined }) });
  assert.equal(result.owner.tax_year, 2027);
  assert.equal(result.owner.source_year, 2027);
  assert.deepEqual(result.owner.owner_parties, [{ owner_name: "RAW OWNER", ownership_pct: "50%" }]);
});

test("unknown-year raw and GIS fallbacks stay coherent and never borrow a valuation year", async () => {
  const { result: rawResult } = await ownerSections({ raw: currentRawOwner({ source_year: undefined,
    tax_year: 2027, mailing_address: null, multi_owner: [] }), snapshotYear: 2026,
  attributes: { OWNERNME1: "GIS OWNER", PSTLADDRESS: "GIS MAILING" } });
  assert.deepEqual(rawResult.owner, { owner_name: "RAW OWNER", mailing_address: null,
    source_year: null, tax_year: null, owner_parties: [] });
  const { result: gisResult } = await ownerSections({ snapshotYear: 2026,
    attributes: { OWNERNME1: "GIS OWNER", PSTLADDRESS: "GIS MAILING" } });
  assert.deepEqual(gisResult.owner, { owner_name: "GIS OWNER", mailing_address: "GIS MAILING",
    source_year: null, tax_year: null, owner_parties: [{ owner_name: "GIS OWNER", ownership_pct: null }] });
});

test("a live building lookup does not blend cached and live GIS owner groups", async () => {
  const { result, fetches } = await ownerSections({ accountId: "12345678901234567", improvement: {},
    attributes: { OWNERNME1: "CACHED OWNER" },
    live: { OWNERNME1: "LIVE OWNER", PSTLADDRESS: "LIVE MAILING", STRCLASS: "14" } });
  assert.equal(fetches.length, 1);
  assert.equal(result.primaryImprovement.building_class, "14");
  assert.equal(result.owner.owner_name, "CACHED OWNER");
  assert.equal(result.owner.mailing_address, null);
  assert.equal(result.owner.tax_year, null);
});

test("malformed or withheld raw owner groups cannot supply a partial alternate group", async () => {
  const withheld = "Owner withheld per Sec.# 25.025 or 25.026 of Texas Property Tax Code";
  const invalidOwners = [null, [], "owner", 42,
    currentRawOwner({ owner_name: {} }), currentRawOwner({ owner_name: withheld }),
    currentRawOwner({ owner_name: "CONFIDENTIAL" }), currentRawOwner({ multi_owner: {} }),
    currentRawOwner({ multi_owner: [null] }), currentRawOwner({ multi_owner: [{ owner_name: {} }] }),
    currentRawOwner({ multi_owner: [{ owner_name: withheld }] }),
    currentRawOwner({ multi_owner: [{ owner_name: "RAW OWNER", tax_year: 2026 }] }),
  ];
  for (const raw of invalidOwners) {
    const { result } = await ownerSections({ raw });
    assert.equal(result.owner, null, JSON.stringify(raw));
  }
  for (const malformed of [null, "null", "[]", "42", [], 42, "not json"]) {
    const { result } = await ownerSections({ detail: malformed, attributes: malformed });
    assert.equal(result.owner, null);
  }
});

test("normalized owner and party year disagreement fails closed rather than mixing years", async () => {
  const { result } = await ownerSections({ normalized: { owner_name: "STORED OWNER", tax_year: 2026,
    owner_parties: [{ owner_name: "NEW PARTY", tax_year: 2027 }] } });
  assert.equal(result.owner, null);
});

test("a truncated newer raw owner cannot displace a complete normalized owner or borrow its parties", async () => {
  const normalized = { owner_name: "COMPLETE STORED OWNER", mailing_address: "100 STORED ST", tax_year: 2026,
    owner_parties: [{ owner_name: "COMPLETE STORED OWNER", ownership_pct: "100", tax_year: 2026 }] };
  const raw = currentRawOwner({ owner_name: "TRUNCATED &", multi_owner: [{ owner_name: "OTHER RAW PARTY" }] });
  const { result } = await ownerSections({ normalized, raw });
  assert.deepEqual(result.owner, { ...normalized, source_year: 2026 });
});

test("a truncated normalized summary cannot win a tie against a complete proven raw group", async () => {
  const { result } = await ownerSections({ normalized: { owner_name: "TRUNCATED &", mailing_address: "STALE MAILING",
    tax_year: 2027, owner_parties: [{ owner_name: "OLD PARTY", tax_year: 2027 }] },
  raw: currentRawOwner({ owner_name: "A & B", mailing_address: null,
    multi_owner: [{ owner_name: "A", ownership_pct: null }, { owner_name: "B", ownership_pct: null }] }) });
  assert.deepEqual(result.owner, { owner_name: "A & B", mailing_address: null, source_year: 2027, tax_year: 2027,
    owner_parties: [{ owner_name: "A", ownership_pct: null }, { owner_name: "B", ownership_pct: null }] });
});
