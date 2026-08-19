import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  uadFieldIsVisible,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_MARKETING_TIMES,
  UAD_MARKET_CAPTION_TYPES,
  UAD_MARKET_ENTITY_GROUPS,
  UAD_MARKET_SUPPLY_TRENDS,
  isVerifiedMarketAsset,
} from "../src/modules/uad/marketCatalog.js";

test("adds official always-displayed URAR Section 17", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "market");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  );
  assert.equal(section?.title, "Market");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "market").length, 19);
});

test("maps Section 17 search metrics to official UIDs and conditionality", () => {
  const activeCount = getUadField("market_active_listings", "3000.0018");
  const activeMedian = getUadField("market_active_listings", "3000.0022");
  const salesMedian = getUadField("market_total_sales", "3000.0029");
  assert.equal(activeCount?.reportFieldId, "17.005");
  assert.equal(activeCount?.required, true);
  assert.equal(activeMedian?.reportFieldId, "17.008");
  assert.equal(activeMedian?.dataType, "currency");
  assert.equal(uadFieldIsVisible(activeMedian, (key) => key === "market_active_listings:3000.0018" ? 0 : undefined), false);
  assert.equal(uadFieldIsRequired(activeMedian, (key) => key === "market_active_listings:3000.0018" ? 3 : undefined), true);
  assert.equal(salesMedian?.reportFieldId, "17.014");
  assert.equal(normalizeAndValidateUadValue(salesMedian, 418000.25).error, null);
  assert.equal(normalizeAndValidateUadValue(salesMedian, 0).error?.code, "currency");
});

test("uses the exact UAD market trend enumerations", () => {
  assert.deepEqual(UAD_MARKET_SUPPLY_TRENDS, ["InBalance", "OverSupply", "Shortage"]);
  assert.deepEqual(UAD_MARKETING_TIMES, ["UnderThreeMonths", "ThreeToSixMonths", "OverSixMonths"]);
  const supply = getUadField("market", "3000.0033");
  const marketing = getUadField("market", "3000.0031");
  assert.equal(normalizeAndValidateUadValue(supply, "OverSupply").error, null);
  assert.equal(normalizeAndValidateUadValue(supply, "Oversupply").error?.code, "enumeration");
  assert.equal(normalizeAndValidateUadValue(marketing, "UnderThreeMonths").error, null);
});

test("models each price trend source as a required repeatable DATA_SOURCE", () => {
  assert.equal(UAD_MARKET_ENTITY_GROUPS.market_price_trend_source.minItems, 1);
  assert.equal(UAD_MARKET_ENTITY_GROUPS.market_price_trend_source.maxItems, 10);
  const source = getUadField("market_price_trend_source", "3000.0051");
  assert.equal(source?.entityType, "market_price_trend_source");
  assert.equal(source?.maxLength, 33);
  const entityId = "14f35f87-e06d-4aef-b150-256f407eec5d";
  const valid = validateUadSectionValues("market", [{
    context_key: "market_price_trend_source",
    uid: "3000.0051",
    entity_id: entityId,
    value: "MLS and HomeNode",
  }], {
    entityTypesById: new Map([[entityId, "market_price_trend_source"]]),
    entityDataById: new Map([[entityId, {}]]),
  });
  assert.equal(valid.errors.length, 0);
});

test("recognizes only verified Section 17 market images", () => {
  assert.ok(UAD_MARKET_CAPTION_TYPES.includes("PriceTrendGraph"));
  assert.ok(UAD_MARKET_CAPTION_TYPES.includes("MarketAnalysisExhibit"));
  const asset = {
    section_number: 17,
    caption_type: "PriceTrendGraph",
    content_type: "image/png",
    status: "verified",
  };
  assert.equal(isVerifiedMarketAsset(asset), true);
  assert.equal(isVerifiedMarketAsset(asset, "PriceTrendGraph"), true);
  assert.equal(isVerifiedMarketAsset(asset, "MedianDaysOnMarketGraph"), false);
  assert.equal(isVerifiedMarketAsset({ ...asset, content_type: "application/pdf" }), false);
  assert.equal(isVerifiedMarketAsset({ ...asset, status: "pending_upload" }), false);
});

test("seeds all Section 17 fields, report locations, and current rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260830_uad_market.sql"), "utf8");
  assert.match(sql, /MarketBoundariesDescription/);
  assert.match(sql, /MarketInventorySearchParameterDescription/);
  assert.match(sql, /DataSourceName/);
  assert.match(sql, /PriceTrendGraph/);
  assert.match(sql, /17\.024\.2/);
  for (const ruleId of [
    "UAD1626", "UAD1627", "UAD1629", "UAD1630", "UAD1631", "UAD1632", "UAD1633",
    "UAD1634", "UAD1635", "UAD1636", "UAD1639", "UAD1642", "UAD1643", "UAD1644",
    "UAD1645", "UAD1646", "UAD1647", "UAD1648", "UAD1652", "UAD1653", "UAD1656", "UAD1657",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /HN-UAD-MARKET-005/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server, shared-data adapter, and frontend enforce the Section 17 workflow", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const shared = fs.readFileSync(path.resolve(directory, "../src/modules/uad/sharedData.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(editor, /market_price_trend_commentary_required/);
  assert.match(editor, /market_active_price_order/);
  assert.match(editor, /market_sale_price_order/);
  assert.match(assets, /invalid_uad_market_content_type/);
  assert.match(assets, /invalid_uad_market_asset_entity/);
  assert.match(shared, /market_fields: marketSuggestions/);
  assert.match(frontend, /Market graphs and exhibits/);
  assert.match(frontend, /existing market and neighborhood tools/);
});
