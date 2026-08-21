import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { getUadField } from "./fieldCatalog.js";

const require = createRequire(import.meta.url);
const deliveryMapping = require("./spec/delivery-mapping-v1.4.json");

const XML_NAMESPACE = "http://www.mismo.org/residential/2009/schemas";
const GSE_NAMESPACE = "http://www.datamodelextension.org";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const repeatableElements = new Set(deliveryMapping.repeatable_elements);
const MAX_SORT = Number.MAX_SAFE_INTEGER;

export const UAD_XML_GENERATOR_VERSION = "homenode-uad-mismo-v2";
export const UAD_XML_DELIVERY_SPECIFICATION_VERSION = deliveryMapping.delivery_specification_version;
export const UAD_XML_SUBSCHEMA_VERSION = deliveryMapping.subschema_version;

function xmlNode(name, { sort = MAX_SORT, key = "singleton", order = 0, attributes = {} } = {}) {
  return {
    name,
    key,
    sort,
    order,
    attributes: { ...attributes },
    text: null,
    children: [],
    childrenByKey: new Map(),
  };
}

function ensureChild(parent, name, { sort, key = "singleton", order = 0, attributes = {} } = {}) {
  const indexKey = `${name}:${key}`;
  let child = parent.childrenByKey.get(indexKey);
  if (!child) {
    child = xmlNode(name, { sort, key, order, attributes });
    parent.childrenByKey.set(indexKey, child);
    parent.children.push(child);
  } else {
    child.sort = Math.min(child.sort, sort ?? MAX_SORT);
    child.order = Math.min(child.order, order);
    Object.assign(child.attributes, attributes);
  }
  return child;
}

function isPresent(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return value.amount !== null && value.amount !== undefined && value.amount !== "" && Boolean(value.unit);
  }
  return true;
}

function entityChain(entity, entitiesById) {
  if (!entity) return [];
  const chain = [];
  const seen = new Set();
  let current = entity;
  while (current) {
    if (seen.has(current.id)) throw new Error("uad_xml_entity_parent_cycle");
    seen.add(current.id);
    chain.push(current);
    current = current.parent_entity_id ? entitiesById.get(current.parent_entity_id) : null;
  }
  return chain.reverse();
}

function assignedEntityAnchors(path, chain) {
  const assignments = new Map();
  let afterIndex = path.indexOf("VALUATION_ANALYSIS");
  for (const entity of chain) {
    const anchors = deliveryMapping.entity_anchor_elements[entity.entity_type] || [];
    let selectedIndex = -1;
    for (let index = afterIndex + 1; index < path.length; index += 1) {
      if (anchors.includes(path[index])) {
        selectedIndex = index;
        break;
      }
    }
    if (selectedIndex < 0) continue;
    assignments.set(selectedIndex, entity);
    afterIndex = selectedIndex;
  }
  return assignments;
}

function labelSuffix(value) {
  const words = String(value || "entity").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((word) => `${word[0]?.toUpperCase() || ""}${word.slice(1)}`).join("") || "Entity";
}

function structuralAttributes(name, assignedEntity, isSubjectProperty) {
  if (name !== "PROPERTY") return {};
  if (isSubjectProperty) return { "xlink:label": "PROPERTY_SubjectProperty" };
  if (!assignedEntity) return {};
  const suffix = labelSuffix(assignedEntity.entity_identifier || assignedEntity.id);
  if (assignedEntity.entity_type === "sales_comparable") {
    return { ValuationUseType: "SalesComparable", "xlink:label": `PROPERTY_${suffix}` };
  }
  if (assignedEntity.entity_type === "sales_comparison_additional_property") {
    return { ValuationUseType: "PropertyAnalyzedNotUsed", "xlink:label": `PROPERTY_${suffix}` };
  }
  return {};
}

function textValue(field, value) {
  if (field.dataType === "measurement") return String(value.amount);
  if (field.dataType === "boolean") return value ? "true" : "false";
  return String(value);
}

function dataPointAttributes(field, mapping, value, entity) {
  if (!mapping.attribute) return {};
  if (field.dataType === "measurement") return { [mapping.attribute]: String(value.unit) };
  if (mapping.attribute === "xlink:label") {
    const falseOnly = /only when[^.]*=\s*["']?false/i.test(mapping.implementation_notes || "");
    if (falseOnly && value !== false) return {};
    const template = mapping.attribute_enumerations[0] || `${mapping.element}_n`;
    const suffix = labelSuffix(entity?.entity_identifier || "SubjectProperty");
    return { "xlink:label": template.includes("_n") ? template.replace("_n", `_${suffix}`) : template };
  }
  if (mapping.attribute_enumerations.length === 1) {
    return { [mapping.attribute]: mapping.attribute_enumerations[0] };
  }
  throw new Error(`uad_xml_attribute_value_required:${field.key}`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serializeNode(node, depth = 0) {
  const indent = "  ".repeat(depth);
  const attributes = Object.entries(node.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join("");
  const children = [...node.children].sort((left, right) => (
    left.sort - right.sort || left.order - right.order || left.name.localeCompare(right.name) || left.key.localeCompare(right.key)
  ));
  if (!children.length) {
    if (node.text === null) return `${indent}<${node.name}${attributes}/>`;
    return `${indent}<${node.name}${attributes}>${escapeXml(node.text)}</${node.name}>`;
  }
  const body = children.map((child) => serializeNode(child, depth + 1)).join("\n");
  return `${indent}<${node.name}${attributes}>\n${body}\n${indent}</${node.name}>`;
}

function repeatOwnerKey({ pathIndex, path, assignments, lastAssignedEntity, currentEntity, field, occurrenceIndex }) {
  const assigned = assignments.get(pathIndex);
  if (assigned) return { key: `entity:${assigned.id}`, entity: assigned, order: Number(assigned.ordinal || 0) };
  if (path[pathIndex] === "PROPERTY") return { key: "subject-property", entity: null, order: 0 };
  const owner = lastAssignedEntity || currentEntity;
  const occurrence = field.dataType === "multi_enum" ? `:occurrence:${occurrenceIndex}` : "";
  return {
    key: `owned:${owner?.id || "root"}:${path[pathIndex]}${occurrence}`,
    entity: owner || null,
    order: Number(owner?.ordinal || 0),
  };
}

function appendValue(root, editorValue, entitiesById, occurrenceValue, occurrenceIndex) {
  const field = getUadField(editorValue.context_key, editorValue.uid);
  const mapping = deliveryMapping.fields[editorValue.uid];
  if (!field || !mapping) throw new Error(`uad_xml_mapping_missing:${editorValue.context_key}:${editorValue.uid}`);
  if (!mapping.path.length || mapping.path[0] !== "MESSAGE") throw new Error(`uad_xml_mapping_path_invalid:${field.key}`);

  const currentEntity = editorValue.entity_id ? entitiesById.get(editorValue.entity_id) : null;
  if (editorValue.entity_id && !currentEntity) throw new Error(`uad_xml_entity_missing:${editorValue.entity_id}`);
  const chain = entityChain(currentEntity, entitiesById);
  const assignments = assignedEntityAnchors(mapping.path, chain);
  let parent = root;
  let lastAssignedEntity = null;

  for (let index = 1; index < mapping.path.length; index += 1) {
    const name = mapping.path[index];
    let key = "singleton";
    let order = 0;
    let assignedEntity = assignments.get(index) || null;
    const afterAnalysis = index > mapping.path.indexOf("VALUATION_ANALYSIS");
    if (afterAnalysis && repeatableElements.has(name)) {
      const owner = repeatOwnerKey({
        pathIndex: index,
        path: mapping.path,
        assignments,
        lastAssignedEntity,
        currentEntity,
        field,
        occurrenceIndex,
      });
      key = owner.key;
      order = owner.order;
      assignedEntity = assignedEntity || owner.entity;
    }
    const attributes = structuralAttributes(name, assignments.get(index), name === "PROPERTY" && !assignments.get(index));
    parent = ensureChild(parent, name, { sort: mapping.sort, key, order, attributes });
    parent.sort = Math.min(parent.sort, mapping.sort);
    if (assignments.get(index)) lastAssignedEntity = assignments.get(index);
  }

  const attributes = dataPointAttributes(field, mapping, occurrenceValue, currentEntity);
  const repeatDataPoint = field.dataType === "multi_enum" && !mapping.path.some((name, index) => (
    index > mapping.path.indexOf("VALUATION_ANALYSIS")
      && repeatableElements.has(name)
      && name !== "PROPERTY"
      && !assignments.has(index)
  ));
  const child = ensureChild(parent, mapping.element, {
    sort: mapping.sort,
    key: repeatDataPoint ? `occurrence:${occurrenceIndex}` : "data",
    order: occurrenceIndex,
    attributes,
  });
  const serialized = textValue(field, occurrenceValue);
  if (child.text !== null && child.text !== serialized) throw new Error(`uad_xml_duplicate_data_point:${field.key}`);
  child.text = serialized;
}

function ensureStructuralPath(root, path, { sort, key = "singleton", order = 0 } = {}) {
  let parent = root;
  for (const name of path) {
    parent = ensureChild(parent, name, { sort, key, order });
  }
  return parent;
}

function appendText(parent, name, value, { sort, key = "data", order = 0, attributes = {} } = {}) {
  if (!isPresent(value)) return null;
  const child = ensureChild(parent, name, { sort, key, order, attributes });
  child.text = String(value);
  return child;
}

function appendSigner(root, signer, order) {
  const snapshot = signer?.credential_snapshot;
  const role = signer?.signer_role;
  const appraiserRole = role === "appraiser" ? "Appraiser" : "AppraiserSupervisor";
  const roleLabel = role === "appraiser" ? "ROLE_Appraiser" : "ROLE_AppraiserSupervisor";
  const signatoryLabel = role === "appraiser" ? "SIGNATORY_Appraiser" : "SIGNATORY_AppraiserSupervisor";
  if (!snapshot?.signer?.first_name || !snapshot?.signer?.last_name) {
    throw new Error(`uad_xml_signer_name_missing:${role || "unknown"}`);
  }
  if (!snapshot?.license?.license_number || !snapshot?.license?.license_type) {
    throw new Error(`uad_xml_signer_license_missing:${role || "unknown"}`);
  }
  if (!signer.execution_date) throw new Error(`uad_xml_signer_execution_date_missing:${role || "unknown"}`);

  const service = ensureStructuralPath(root, [
    "DOCUMENT_SETS", "DOCUMENT_SET", "DOCUMENTS", "DOCUMENT", "DEAL_SETS", "DEAL_SET",
    "DEALS", "DEAL", "SERVICES", "SERVICE",
  ], { sort: 2860 });
  const parties = ensureChild(service, "PARTIES", { sort: 2860 });
  const party = ensureChild(parties, "PARTY", { sort: 2860 + order, key: `signer:${role}`, order });

  const individual = ensureChild(party, "INDIVIDUAL", { sort: 2861 });
  const name = ensureChild(individual, "NAME", { sort: 2862 });
  appendText(name, "FirstName", snapshot.signer.first_name, { sort: 2863 });
  appendText(name, "MiddleName", snapshot.signer.middle_name, { sort: 2864 });
  appendText(name, "LastName", snapshot.signer.last_name, { sort: 2865 });
  appendText(name, "SuffixName", snapshot.signer.suffix_name, { sort: 2866 });

  const address = ensureStructuralPath(party, ["ADDRESSES", "ADDRESS"], { sort: 2870 });
  appendText(address, "AddressLineText", snapshot.organization?.address_line_1, { sort: 2871 });
  appendText(address, "CityName", snapshot.organization?.city, { sort: 2872 });
  appendText(address, "PostalCode", snapshot.organization?.postal_code, { sort: 2873 });
  appendText(address, "StateCode", snapshot.organization?.state_code, { sort: 2874 });

  const roles = ensureChild(party, "ROLES", { sort: 2900 });
  const roleNode = ensureChild(roles, "ROLE", {
    sort: 2901,
    key: `signer:${role}`,
    order,
    attributes: { "xlink:label": roleLabel },
  });
  const appraiser = ensureChild(roleNode, "APPRAISER", { sort: 2902 });
  const appraiserDetail = ensureChild(appraiser, "APPRAISER_DETAIL", { sort: 2903 });
  appendText(
    appraiserDetail,
    "AppraiserCompanyName",
    snapshot.organization?.display_name || snapshot.organization?.legal_name,
    { sort: 2904 },
  );
  const licenseNode = ensureStructuralPath(roleNode, ["LICENSES", "LICENSE"], { sort: 2910 });
  const appraiserLicense = ensureChild(licenseNode, "APPRAISER_LICENSE", { sort: 2911 });
  appendText(appraiserLicense, "AppraiserLicenseType", snapshot.license.license_type, { sort: 2912 });
  appendText(
    appraiserLicense,
    "AppraiserLicenseTypeOtherDescription",
    snapshot.license.license_type_other_description,
    { sort: 2913 },
  );
  const licenseDetail = ensureChild(licenseNode, "LICENSE_DETAIL", { sort: 2920 });
  appendText(licenseDetail, "LicenseExpirationDate", snapshot.license.expires_on, { sort: 2921 });
  appendText(licenseDetail, "LicenseIdentifier", snapshot.license.license_number, { sort: 2922 });
  appendText(licenseDetail, "LicenseIssuingAuthorityStateCode", snapshot.license.jurisdiction, { sort: 2923 });
  const roleDetail = ensureChild(roleNode, "ROLE_DETAIL", { sort: 2930 });
  appendText(roleDetail, "PartyRoleType", appraiserRole, { sort: 2931 });

  const relationships = ensureChild(service, "RELATIONSHIPS", { sort: 3220 });
  ensureChild(relationships, "RELATIONSHIP", {
    sort: 3221 + order,
    key: `signer:${role}`,
    order,
    attributes: {
      "xlink:arcrole": "urn:fdc:mismo.org:2009:residential/SIGNATORY_IsAssociatedWith_ROLE",
      "xlink:from": signatoryLabel,
      "xlink:to": roleLabel,
    },
  });

  const document = ensureStructuralPath(root, ["DOCUMENT_SETS", "DOCUMENT_SET", "DOCUMENTS", "DOCUMENT"], { sort: 3300 });
  const signatories = ensureChild(document, "SIGNATORIES", { sort: 3300 });
  const signatory = ensureChild(signatories, "SIGNATORY", {
    sort: 3301,
    key: `signer:${role}`,
    order,
    attributes: { "xlink:label": signatoryLabel },
  });
  const execution = ensureStructuralPath(signatory, ["EXECUTION", "EXECUTION_DETAIL"], { sort: 3302 });
  appendText(execution, "ExecutionDate", signer.execution_date, { sort: 3304 + order });
}

export function buildUadMismoXml(editor, { signers = [] } = {}) {
  if (editor?.workfile?.specification_release_key !== deliveryMapping.specification_release_key) {
    throw new Error("uad_xml_specification_release_mismatch");
  }
  const root = xmlNode("MESSAGE", {
    sort: 0,
    attributes: {
      xmlns: XML_NAMESPACE,
      "xmlns:gse": GSE_NAMESPACE,
      "xmlns:xlink": XLINK_NAMESPACE,
      MISMOReferenceModelIdentifier: deliveryMapping.mismo_reference_model_identifier,
    },
  });
  const entitiesById = new Map((editor.entities || []).map((entity) => [entity.id, entity]));
  const values = [...(editor.values || [])]
    .filter((value) => isPresent(value.value))
    .sort((left, right) => {
      const leftSort = deliveryMapping.fields[left.uid]?.sort ?? MAX_SORT;
      const rightSort = deliveryMapping.fields[right.uid]?.sort ?? MAX_SORT;
      return leftSort - rightSort
        || String(left.entity_id || "").localeCompare(String(right.entity_id || ""))
        || String(left.context_key).localeCompare(String(right.context_key))
        || String(left.uid).localeCompare(String(right.uid));
    });
  for (const value of values) {
    const occurrences = Array.isArray(value.value) ? value.value : [value.value];
    occurrences.forEach((occurrence, index) => appendValue(root, value, entitiesById, occurrence, index));
  }
  [...signers]
    .sort((left, right) => (
      (left.signer_role === "appraiser" ? 0 : 1) - (right.signer_role === "appraiser" ? 0 : 1)
    ))
    .forEach((signer, index) => appendSigner(root, signer, index));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${serializeNode(root)}\n`;
  return {
    xml,
    byte_size: Buffer.byteLength(xml, "utf8"),
    checksum_sha256: createHash("sha256").update(xml, "utf8").digest("hex"),
    generator_version: UAD_XML_GENERATOR_VERSION,
    delivery_specification_version: UAD_XML_DELIVERY_SPECIFICATION_VERSION,
    subschema_version: UAD_XML_SUBSCHEMA_VERSION,
    mapped_value_count: values.length,
    signer_count: signers.length,
  };
}

export function getUadXmlMappingSummary() {
  return {
    specification_release_key: deliveryMapping.specification_release_key,
    delivery_specification_version: deliveryMapping.delivery_specification_version,
    subschema_version: deliveryMapping.subschema_version,
    mismo_reference_model_identifier: deliveryMapping.mismo_reference_model_identifier,
    source_sha256: deliveryMapping.source_sha256,
    mapped_unique_ids: Object.keys(deliveryMapping.fields).length,
    mapped_entity_types: Object.keys(deliveryMapping.entity_anchor_elements).length,
  };
}
