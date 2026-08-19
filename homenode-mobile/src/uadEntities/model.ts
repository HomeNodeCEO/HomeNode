import type { UadEntity, UadEntityGroup } from "../api/client";

export function entityMatchesGroup(entity: UadEntity, group: UadEntityGroup) {
  if (entity.entity_type !== group.entity_type) return false;
  return Object.entries(group.data).every(([key, value]) => entity.data[key] === value);
}

export function parentCandidates(entities: UadEntity[], group: UadEntityGroup) {
  if (!group.parent_entity_types.length) return [];
  return entities.filter((entity) => group.parent_entity_types.includes(entity.entity_type));
}

export function entityDisplayLabel(entity: UadEntity) {
  return entity.label || entity.entity_identifier || `${entity.entity_type} ${entity.ordinal}`;
}

export function suggestedEntityLabel(group: UadEntityGroup, entities: UadEntity[]) {
  const count = entities.filter((entity) => entityMatchesGroup(entity, group)).length + 1;
  const singular = group.title.replace(/ies$/i, "y").replace(/s$/i, "");
  return `${singular} ${count}`;
}
