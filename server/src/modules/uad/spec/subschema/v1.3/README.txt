Uniform Appraisal Dataset (UAD) 3.6 Schema v1.3 ZIP File

This ZIP file contains the Uniform Appraisal Dataset (UAD) 3.6 schema that is consistent with the larger MISMO 3.6 schema. However, it is specific to UAD 3.6 (e.g., the enumerated values included for a given “Type” element are those specific to UAD and may be a subset of the MISMO 3.6 set of values).

The file includes the following:

1. "Individal" subfolder: This folder contains nine XML schema definition (XSD) files. These XSD files define the UAD 3.6 schema.
2. "Combined" subfolder: This folder is functionally identical to the "Individual" folder, except that the nine XSD files are combined into three files.
3. This readme.txt file.

Assign the "GSE_UAD_3.6.0_v1.3.xsd" schema (in either the Combined or the Individual folders) to any UAD 3.6 .xml file to validate it.

The XSD files included in this ZIP file define the various containers, elements, and attributes of the UAD 3.6 schema.

Changes made for v1.2:

1. Removed nillable = "true" from the following data elements: DocumentType, ServiceType, and ValuationSoftwareVendorName. (Change #2023-072)
2. Updated the definition of the FreddieMacCHOICEHome enumerated value. (Change #2023-041)
3. Updated the definition for FactoryBuiltCertificationExaminedIndicator. (Change #2023-041)
4. Removed "Other" as an enumerated value from the ProjectParkingSpaceAssignmentType. (Change #2023-032)
5. Removed the ProjectParkingSpaceAssignmentTypeOtherDescription as 'Other' is no longer supported enumeration of ProjectParkingSpaceAssignmentType. (Change #2023-032)
6. Removed the following data elements: PropertyConformsToSurroundingAreaIndicator, PropertyNonConformingToSurroundingAreaDescription, PropertyNonConformingToSurroundingAreaReasonType, and PropertyNonConformingToSurroundingAreaReasonTypeOtherDescription. (Change #2023-031)
7. Removed the following containers: PROPERTY_NONCONFORMING_SURROUNDING_AREA_REASON, PROPERTY_NONCONFORMING_SURROUNDING_AREA_REASONS, PROPERTY_NONCONFORMING_SURROUNDING_AREA_REASON_EXTENSION, and PROPERTY_NONCONFORMING_SURROUNDING_AREA_REASONS_EXTENSION. (Change #2023-031)
8. Removed "DetachedGarage" as an enumerated value from OutbuildingType. (Change #2023-017)
9. Removed supported enumerated definitions from CarStorageAttachmentType. (Change #2023-047)

Changes made for v1.3:

1. Made ADDITIONAL_IDENTIFIERS optional (added minOccurs="0" to <xsd:element name="ADDITIONAL_IDENTIFIERS" type="ADDITIONAL_IDENTIFIERS" minOccurs="0">). (Change #2024-002)
2. Removed MarketPropertyValueTrendType. (Change #2024-024)
3. Removed ValuationReconciliationConditionsCommentDescription. (Change #2024-021)
4. Removed SubjectToExtraordinaryAssumptions and SubjectToHypotheticalConditions enumerations from PropertyValuationConditionalConclusionType. (Change #2024-021)
5. Added containers and elements for Reconsideration of Value (ROV). (Change #2024-043)

