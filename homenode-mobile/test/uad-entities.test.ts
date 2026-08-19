import assert from "node:assert/strict";
import test from "node:test";

import type { UadEntity, UadEntityGroup } from "../src/api/client";
import {
  entityDisplayLabel,
  entityMatchesGroup,
  parentCandidates,
  suggestedEntityLabel,
} from "../src/uadEntities/model";

const unit: UadEntity = {
  id: "unit-1",
  workfile_id: "workfile-1",
  parent_entity_id: "dwelling-1",
  entity_type: "unit",
  entity_identifier: "unit-1",
  ordinal: 1,
  label: "Main Unit",
  data: {},
  created_at: "2026-08-19T00:00:00.000Z",
  updated_at: "2026-08-19T00:00:00.000Z",
};

const roomGroup: UadEntityGroup = {
  key: "unit_room",
  entity_type: "unit_room",
  title: "Rooms",
  add_label: "Add room",
  min_items: 0,
  max_items: null,
  parent_entity_types: ["unit"],
  create_enabled: true,
  data: {},
};

test("UAD entity model chooses valid parents and stable labels", () => {
  assert.deepEqual(parentCandidates([unit], roomGroup), [unit]);
  assert.equal(entityDisplayLabel(unit), "Main Unit");
  assert.equal(suggestedEntityLabel(roomGroup, []), "Room 1");
});

test("UAD amenity variants filter by their official category data", () => {
  const amenity = { ...unit, entity_type: "amenity", data: { amenity_category: "OutdoorLiving" } };
  const group = { ...roomGroup, entity_type: "amenity", data: { amenity_category: "OutdoorLiving" } };
  assert.equal(entityMatchesGroup(amenity, group), true);
  assert.equal(entityMatchesGroup({ ...amenity, data: { amenity_category: "WaterFeatures" } }, group), false);
});
