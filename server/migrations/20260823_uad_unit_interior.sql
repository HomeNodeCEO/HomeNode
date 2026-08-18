ALTER TABLE appraisal.uad_entities
  DROP CONSTRAINT IF EXISTS uad_entities_entity_type_check;

ALTER TABLE appraisal.uad_entities
  ADD CONSTRAINT uad_entities_entity_type_check
  CHECK (entity_type IN (
    'property',
    'dwelling',
    'manufactured_home',
    'unit',
    'adu',
    'outbuilding',
    'vehicle_storage',
    'amenity',
    'sales_comparable',
    'rental_comparable',
    'grm_comparable',
    'land_comparable',
    'analyzed_not_used',
    'site_parcel',
    'site_influence',
    'site_view',
    'site_encumbrance',
    'site_feature',
    'site_utility',
    'site_defect',
    'renewable_energy_component',
    'green_building_certification',
    'green_efficiency_rating',
    'dwelling_exterior_feature',
    'dwelling_noncontinuous_room',
    'dwelling_exterior_defect',
    'manufactured_home_skirting_material',
    'manufactured_home_modification',
    'manufactured_home_hud_label',
    'manufactured_home_financing_program',
    'unit_area_data_source',
    'unit_adu_data_source',
    'unit_level',
    'unit_room',
    'unit_interior_feature',
    'unit_interior_defect'
  ));

WITH catalog AS (
  SELECT *
    FROM jsonb_to_recordset($catalog$
[
  {
    "uid": "0700.0114",
    "rfid": "10.002",
    "context": "unit",
    "name": "UnitIdentifier",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 25
  },
  {
    "uid": "0700.0140",
    "rfid": "10.003",
    "context": "unit",
    "name": "UnitStandardAboveGradeFinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0141",
    "rfid": "10.004",
    "context": "unit",
    "name": "UnitNonStandardAboveGradeFinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0142",
    "rfid": "10.005",
    "context": "unit",
    "name": "UnitAboveGradeUnfinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0143",
    "rfid": "10.006",
    "context": "unit",
    "name": "UnitStandardBelowGradeFinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "1800.0398",
    "rfid": "10.007",
    "context": "unit",
    "name": "UnitNonStandardBelowGradeFinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0144",
    "rfid": "10.008",
    "context": "unit",
    "name": "UnitBelowGradeUnfinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0064",
    "rfid": "10.010",
    "context": "unit",
    "name": "UnitBelowGradeFinishComparisonType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": [
      "Inferior",
      "Similar",
      "Superior"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0125",
    "rfid": "10.009",
    "context": "unit_area_data_source",
    "name": "DataSourceType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "AssessorRecord",
      "BuilderOrDeveloper",
      "CondominiumQuestionnaire",
      "CooperativeBoard",
      "CooperativeQuestionnaire",
      "CostService",
      "CostSurvey",
      "DataAggregator",
      "Deed",
      "ExteriorInspection",
      "HomeownersAssociation",
      "InteriorInspection",
      "LandSurvey",
      "Lender",
      "MLS",
      "Other",
      "PhysicalMeasurement",
      "PlansAndSpecifications",
      "PlatMap",
      "PreviousAppraisalFile",
      "PropertyDataReport",
      "PropertyManagementCompany",
      "PropertyOwner",
      "PropertyTenant",
      "RealEstateAgent",
      "ThreeDimensionalScan",
      "Zoning"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0126",
    "rfid": "10.009",
    "context": "unit_area_data_source",
    "name": "DataSourceTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 66
  },
  {
    "uid": "0700.0089",
    "rfid": "10.011",
    "context": "unit",
    "name": "AccessoryDwellingUnitIndicator",
    "type": "Boolean",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0098",
    "rfid": "10.012",
    "context": "unit",
    "name": "AccessoryDwellingUnitLegallyRentableIndicator",
    "type": "Boolean",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0125",
    "rfid": "10.013",
    "context": "unit_adu_data_source",
    "name": "DataSourceType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "AssessorRecord",
      "BuilderOrDeveloper",
      "CondominiumQuestionnaire",
      "CooperativeBoard",
      "CooperativeQuestionnaire",
      "CostService",
      "CostSurvey",
      "DataAggregator",
      "Deed",
      "ExteriorInspection",
      "HomeownersAssociation",
      "InteriorInspection",
      "LandSurvey",
      "Lender",
      "MLS",
      "Other",
      "PhysicalMeasurement",
      "PlansAndSpecifications",
      "PlatMap",
      "PreviousAppraisalFile",
      "PropertyDataReport",
      "PropertyManagementCompany",
      "PropertyOwner",
      "PropertyTenant",
      "RealEstateAgent",
      "ThreeDimensionalScan",
      "Zoning"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0126",
    "rfid": "10.013",
    "context": "unit_adu_data_source",
    "name": "DataSourceTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 66
  },
  {
    "uid": "0700.0088",
    "rfid": "10.014",
    "context": "unit",
    "name": "AccessoryDwellingUnitTypicalToMarketIndicator",
    "type": "Boolean",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0091",
    "rfid": "10.015",
    "context": "unit",
    "name": "AccessType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": [
      "ExteriorAccessOnly",
      "InteriorAccessOnly",
      "InteriorAndExteriorAccess"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0090",
    "rfid": "10.016",
    "context": "unit",
    "name": "SeparatePostalAddressIndicator",
    "type": "Boolean",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0063",
    "rfid": "10.017",
    "context": "unit",
    "name": "LevelCount",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0060",
    "rfid": "10.018",
    "context": "unit",
    "name": "FloorIdentifier",
    "type": "String",
    "requirement": "Optional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 3
  },
  {
    "uid": "0700.0058",
    "rfid": "10.019",
    "context": "unit",
    "name": "CornerUnitIndicator",
    "type": "Boolean",
    "requirement": "Optional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0070",
    "rfid": "10.020",
    "context": "unit",
    "name": "UnitOccupancyType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": [
      "OwnerOccupied",
      "Tenant",
      "Vacant"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0072",
    "rfid": "10.021",
    "context": "unit",
    "name": "UtilitiesMeteredSeparatelyIndicator",
    "type": "Boolean",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0068",
    "rfid": "10.022",
    "context": "unit",
    "name": "UnitUtilitiesOperatingIndicator",
    "type": "Boolean",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0118",
    "rfid": "10.023",
    "context": "unit",
    "name": "BedroomCount",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0119",
    "rfid": "10.024",
    "context": "unit",
    "name": "FullBathroomCount",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0120",
    "rfid": "10.025",
    "context": "unit",
    "name": "HalfBathroomCount",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0130",
    "rfid": "10.026",
    "context": "unit",
    "name": "UnitMixedUsageIndicator",
    "type": "Boolean",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0100",
    "rfid": "10.027",
    "context": "unit",
    "name": "AllowableLiveWorkSpaceIndicator",
    "type": "Boolean",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0101",
    "rfid": "10.028",
    "context": "unit",
    "name": "AllowableWorkSpaceAreaMeasure",
    "type": "Numeric",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0030",
    "rfid": "10.029",
    "context": "unit_level",
    "name": "LevelType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "BelowGradeFive",
      "BelowGradeFour",
      "BelowGradeOne",
      "BelowGradeThree",
      "BelowGradeTwo",
      "LevelEight",
      "LevelFive",
      "LevelFour",
      "LevelNine",
      "LevelOne",
      "LevelSeven",
      "LevelSix",
      "LevelTen",
      "LevelThree",
      "LevelTwo"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0029",
    "rfid": "10.030",
    "context": "unit_level",
    "name": "GradeLevelType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "AboveGrade",
      "FullyBelowGrade",
      "PartiallyBelowGrade"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0026",
    "rfid": "10.030",
    "context": "unit_level",
    "name": "AccessType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "ExteriorAccessOnly",
      "InteriorAccessOnly",
      "InteriorAndExteriorAccess"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0027",
    "rfid": "10.030",
    "context": "unit_level",
    "name": "BelowGradeExteriorAccessType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "CellarDoor",
      "Other",
      "WalkOut",
      "WalkUp"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0028",
    "rfid": "10.030",
    "context": "unit_level",
    "name": "BelowGradeExteriorAccessTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 36
  },
  {
    "uid": "0700.0137",
    "rfid": "10.032",
    "context": "unit_level",
    "name": "LevelFinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0138",
    "rfid": "10.032",
    "context": "unit_level",
    "name": "LevelUnfinishedAreaMeasure",
    "type": "Numeric",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "0700.0035",
    "rfid": "10.033",
    "context": "unit_room",
    "name": "RoomType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "Bedroom",
      "BreakfastRoom",
      "Den",
      "DiningRoom",
      "FamilyRoom",
      "FullBathroom",
      "HalfBathroom",
      "Kitchen",
      "LaundryRoom",
      "LivingRoom",
      "Loft",
      "MediaRoom",
      "Mudroom",
      "Other",
      "RecreationRoom",
      "Sunroom",
      "UtilityRoom",
      "WalkInPantry",
      "Workshop"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0087",
    "rfid": "10.033",
    "context": "unit_room",
    "name": "RoomTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 33
  },
  {
    "uid": "0700.0121",
    "rfid": "10.037",
    "context": "unit_room",
    "name": "LevelType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "BelowGradeFive",
      "BelowGradeFour",
      "BelowGradeOne",
      "BelowGradeThree",
      "BelowGradeTwo",
      "LevelEight",
      "LevelFive",
      "LevelFour",
      "LevelNine",
      "LevelOne",
      "LevelSeven",
      "LevelSix",
      "LevelTen",
      "LevelThree",
      "LevelTwo"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0036",
    "rfid": "10.038",
    "context": "unit_room",
    "name": "RoomUpdateStatusType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "FullyUpdated",
      "NotUpdated",
      "PartiallyUpdated"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0034",
    "rfid": "10.039",
    "context": "unit_room",
    "name": "RoomUpdatedTimeframeType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "FiveToTenYears",
      "LessThanOneYear",
      "OneToFiveYears",
      "TenOrMoreYears"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0044",
    "rfid": "10.040",
    "context": "unit_room",
    "name": "RoomQualityDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 120
  },
  {
    "uid": "0700.0033",
    "rfid": "10.041",
    "context": "unit_room",
    "name": "RoomConditionStatusType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "DamagedAndFunctional",
      "DamagedAndNonfunctional",
      "NewOrLikeNew",
      "TypicalWearAndTear"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0113",
    "rfid": "10.042",
    "context": "unit_room",
    "name": "RoomConditionAdditionalDescription",
    "type": "String",
    "requirement": "Optional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 120
  },
  {
    "uid": "0700.0067",
    "rfid": "10.034",
    "context": "unit",
    "name": "InteriorQualityRatingCode",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": [
      "Q1",
      "Q2",
      "Q3",
      "Q4",
      "Q5",
      "Q6"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0066",
    "rfid": "10.035",
    "context": "unit",
    "name": "InteriorConditionRatingCode",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": [
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      "C6"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0117",
    "rfid": "10.043",
    "context": "unit",
    "name": "OverallBathroomsUpdateStatusType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": [
      "FullyUpdated",
      "SignificantlyUpdated",
      "ModeratelyUpdated",
      "NotUpdated"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0122",
    "rfid": "10.049",
    "context": "unit",
    "name": "OverallFlooringUpdateStatusType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": [
      "FullyUpdated",
      "SignificantlyUpdated",
      "ModeratelyUpdated",
      "NotUpdated"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0005",
    "rfid": "10.050",
    "context": "unit_accessibility",
    "name": "AccessibilityFeatureType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "Appliances",
      "Auditory",
      "Bathtub",
      "Cabinets",
      "Counters",
      "Doorways",
      "ElectricalSwitches",
      "GrabBars",
      "Handrails",
      "Hardware",
      "Lighting",
      "None",
      "Other",
      "Ramps",
      "Shower",
      "Sink",
      "Toilet"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0006",
    "rfid": "10.050",
    "context": "unit_accessibility",
    "name": "AccessibilityFeatureTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 33
  },
  {
    "uid": "0700.0007",
    "rfid": "10.051",
    "context": "unit_accessibility",
    "name": "AccessibilityModificationDescription",
    "type": "String",
    "requirement": "Optional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 296
  },
  {
    "uid": "0700.0046",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "Flooring",
      "Other",
      "WallsAndCeiling"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0047",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 36
  },
  {
    "uid": "0700.0043",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentTypeAdditionalDescription",
    "type": "String",
    "requirement": "Optional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 70
  },
  {
    "uid": "0700.0041",
    "rfid": "10.045",
    "context": "unit_interior_feature",
    "name": "FlooringType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "Carpet",
      "CeramicTile",
      "EngineeredWood",
      "FinishedConcrete",
      "Hardwood",
      "Laminate",
      "Marble",
      "Other",
      "SubflooringOnly",
      "Vinyl"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0042",
    "rfid": "10.045",
    "context": "unit_interior_feature",
    "name": "FlooringTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 36
  },
  {
    "uid": "0700.0106",
    "rfid": "10.046",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentQualityDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 144
  },
  {
    "uid": "0700.0104",
    "rfid": "10.047",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentConditionStatusType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "DamagedAndFunctional",
      "DamagedAndNonfunctional",
      "NewOrLikeNew",
      "NoFinish",
      "TypicalWearAndTear"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0111",
    "rfid": "10.048",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentConditionDescription",
    "type": "String",
    "requirement": "Optional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 144
  },
  {
    "uid": "0700.0050",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "ApproximateCeilingHeightType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "EightFeet",
      "LessThanSevenFeet",
      "NineFeet",
      "SevenFeet",
      "TenFeetAndAbove",
      "TwoOrMoreStories"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0108",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "CeilingStyleType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "Barrel",
      "Beams",
      "Cathedral",
      "Coffered",
      "Drop",
      "Flat",
      "Other",
      "Tray",
      "Vaulted"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0109",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "CeilingStyleTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 36
  },
  {
    "uid": "0700.0107",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentQualityDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 144
  },
  {
    "uid": "0700.0045",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentConditionStatusType",
    "type": "Enumerated",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": [
      "DamagedAndFunctional",
      "DamagedAndNonfunctional",
      "NewOrLikeNew",
      "NoFinish",
      "TypicalWearAndTear"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0112",
    "rfid": "10.044",
    "context": "unit_interior_feature",
    "name": "ImprovementComponentConditionDescription",
    "type": "String",
    "requirement": "Optional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 144
  },
  {
    "uid": "3900.0107",
    "rfid": "10.055",
    "context": "unit",
    "name": "UnitInteriorDefectsExistIndicator",
    "type": "Boolean",
    "requirement": "Required",
    "cardinality": "1:1",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "3900.0130",
    "rfid": "10.056",
    "context": "unit_interior_defect",
    "name": "DefectComponentLabelType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "Flooring",
      "Other",
      "WallsAndCeiling"
    ],
    "maxLength": null
  },
  {
    "uid": "3900.0131",
    "rfid": "10.056",
    "context": "unit_interior_defect",
    "name": "DefectComponentLabelTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 62
  },
  {
    "uid": "3900.0135",
    "rfid": "10.057",
    "context": "unit_interior_defect",
    "name": "DefectItemLocationType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "FullBathroom",
      "HalfBathroom",
      "Kitchen",
      "Other"
    ],
    "maxLength": null
  },
  {
    "uid": "3900.0160",
    "rfid": "10.057",
    "context": "unit_interior_defect",
    "name": "DefectItemLocationTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 31
  },
  {
    "uid": "3900.0133",
    "rfid": "10.058",
    "context": "unit_interior_defect",
    "name": "DefectItemDescription",
    "type": "String",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": 520
  },
  {
    "uid": "3900.0132",
    "rfid": "10.059",
    "context": "unit_interior_defect",
    "name": "DefectItemAffectsSoundnessStructuralIntegrityIndicator",
    "type": "Boolean",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": null,
    "maxLength": null
  },
  {
    "uid": "3900.0136",
    "rfid": "10.060",
    "context": "unit_interior_defect",
    "name": "DefectItemRecommendedActionType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "0:unbounded",
    "options": [
      "Completion",
      "Inspection",
      "None",
      "Repair"
    ],
    "maxLength": null
  },
  {
    "uid": "0700.0115",
    "rfid": "10.061",
    "context": "unit",
    "name": "UnitValuationCommentText",
    "type": "String",
    "requirement": "Optional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 5000
  },
  {
    "uid": "1400.0780",
    "rfid": "10.033.2",
    "context": "unit_room_asset",
    "name": "ImageCaptionCommentDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 100
  },
  {
    "uid": "1400.0774",
    "rfid": "10.044.2",
    "context": "unit_feature_asset",
    "name": "ImageCaptionCommentDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 100
  },
  {
    "uid": "1400.0929",
    "rfid": "10.056.2",
    "context": "unit_defect_asset",
    "name": "ImageCaptionCommentDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 100
  },
  {
    "uid": "1400.0640",
    "rfid": "10.062.2",
    "context": "unit_asset",
    "name": "ImageCaptionCommentDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 100
  }
]
    $catalog$::jsonb
  ) AS item(
    uid text,
    rfid text,
    context text,
    name text,
    type text,
    requirement text,
    cardinality text,
    options jsonb,
    "maxLength" integer
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 10, 'Unit Interior',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 7,
    'entity_type', CASE WHEN context IN (
      'unit_area_data_source', 'unit_adu_data_source', 'unit_level',
      'unit_room', 'unit_interior_feature', 'unit_interior_defect'
    ) THEN context ELSE NULL END,
    'options', options,
    'max_length', "maxLength",
    'source', 'Appendix A-1 URAR Delivery Specification 1.4'
  ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET report_field_id = EXCLUDED.report_field_id,
    section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    data_point_name = EXCLUDED.data_point_name,
    data_type = EXCLUDED.data_type,
    requirement = EXCLUDED.requirement,
    cardinality = EXCLUDED.cardinality,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.enumerations (
  release_key, uid, property_context, value, display_label, sort_order, metadata
)
SELECT
  field.release_key,
  field.uid,
  field.property_context,
  option.value,
  regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
  option.ordinality,
  '{"phase":7,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 10
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1138','fatal','unit_accessibility','Provide the type of accessibility feature. Select ''None'' if there are no accessibility features.','If ((ImprovementType = "Dwelling" ) or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and
If (at least one instance of ACCESSIBILITY_FEATURE is not provided or AccessibilityFeatureType is not provided in a given instance of ACCESSIBILITY_FEATURE)',ARRAY['10.050'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1139','fatal','unit_level','Provide the primary exterior access method (e.g., walk-out, walk-up) for the below grade area.','If (ImprovementType = "Dwelling" and (AccessType = "ExteriorAccessOnly" or "InteriorAndExteriorAccess")) or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true" and (AccessType = "ExteriorAccessOnly" or "InteriorAndExteriorAccess")), and BelowGradeExteriorAccessType is not provided in a given instance of LEVEL',ARRAY['10.030'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1140','fatal','unit_level','Provide a description when ''Grade Level'' = ''Other''.','If BelowGradeExteriorAccessType = "Other" and BelowGradeExteriorAccessTypeOtherDescription is not provided in a given instance of LEVEL',ARRAY['10.030'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1141','fatal','unit_level','Provide the Grade Level Type (i.e., Above Grade, Fully Below Grade, Partially Below Grade) for the level.','If (ImprovementType = "Dwelling") or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and GradeLevelType is not provided in a given instance of LEVEL',ARRAY['10.030'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1142','fatal','unit_level','Provide the level type (e.g., Level 1, Level 2, Level B1).','If (ImprovementType = "Dwelling") or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and (at least one instance of LEVEL is not provided or LevelType is not provided in a given instance of LEVEL)',ARRAY['10.029'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1143','warning','unit_room','Provide at least one instance of ''Kitchen'' for each living unit.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and (at least one instance of ROOM_DETAIL with RoomType = "Kitchen" is not provided)
',ARRAY['10.033'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1144','fatal','unit_room','Provide a description when room type = ''Other''.','If RoomType = "Other" and RoomTypeOtherDescription is not provided in a given instance of ROOM_DETAIL',ARRAY['10.033'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1145','fatal','unit_room','Provide the ''Condition Status'' for the room.','If (ImprovementType = "Dwelling") or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true") and (RoomType = "FullBathroom" or "HalfBathroom" or "Kitchen"), and RoomConditionStatusType is not provided in a given instance of ROOM_DETAIL',ARRAY['10.041'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1146','fatal','unit_room','Provide the ''Update Status'' for the room.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")) and RoomType = ("FullBathroom" or "HalfBathroom" or "Kitchen"), and RoomUpdateStatusType is not provided in a given instance of ROOM_DETAIL',ARRAY['10.038'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1147','fatal','unit_room','Provide the timeframe in which the room was updated.','If RoomType = "FullBathroom" or "HalfBathroom" or "Kitchen", and RoomUpdateStatusType = "FullyUpdated" or "PartiallyUpdated", and RoomUpdatedTimeframeType is not provided in a given instance of ROOM_DETAIL',ARRAY['10.039'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1148','fatal','unit_interior_feature','The interior feature type must be included.','If (ImprovementType = "Dwelling") or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and ImprovementComponentType is not provided in a given instance of INTERIOR_COMPONENT_DETAIL',ARRAY['10.044'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1149','fatal','unit_interior_feature','Provide the flooring details (e.g., material, condition) for the living unit.','If (ImprovementType = "Dwelling") or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and ImprovementComponentType = "Flooring" is not provided in INTERIOR_COMPONENT_DETAIL for a given instance of PROPERTY_UNIT',ARRAY['10.044'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1150','fatal','unit_interior_feature','Provide the flooring material(s).','If ImprovementComponentType = "Flooring" and (at least one instance of FLOOR_COVERING is not provided or FlooringType is not provided in a given instance of FLOOR_COVERING)',ARRAY['10.045'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1151','fatal','unit_interior_feature','Provide a description when flooring material = ''Other''.','If FlooringType = "Other" and FlooringTypeOtherDescription is not provided in a given instance of FLOOR_COVERING',ARRAY['10.045'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1152','fatal','unit_interior_feature','Provide the walls and ceiling details (e.g., style, height) for the living unit.','If (ImprovementType = "Dwelling") or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and ImprovementComponentType = "WallsAndCeiling" is not provided in INTERIOR_COMPONENT_DETAIL in a given instance of PROPERTY_UNIT',ARRAY['10.044'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1153','fatal','unit_interior_feature','Provide a description when ''Feature Type'' = ''Other''.','If ImprovementComponentType = "Other" and ImprovementComponentTypeOtherDescription is not provided in a given instance of INTERIOR_COMPONENT_DETAIL',ARRAY['10.044'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1154','fatal','unit_interior_feature','Provide the approximate ceiling height(s) for the living unit.','If ImprovementComponentType = "WallsAndCeiling" and (at least one instance of CEILING_HEIGHT is not provided or ApproximateCeilingHeightType is not provided in a given instance of CEILING_HEIGHT)',ARRAY['10.044'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1155','warning','unit_interior_feature','Provide additional description for the interior feature being referenced.','If ImprovementComponentType = "Other" and ImprovementComponentTypeAdditionalDescription is not provided in a given instance of INTERIOR_COMPONENT_DETAIL',ARRAY['10.044'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1156','fatal','unit_interior_feature','Provide the ''Condition Status''.','If ImprovementComponentType = "WallsAndCeiling" or "Other", and ImprovementComponentConditionStatusType is not provided in a given instance of INTERIOR_COMPONENT_DETAIL',ARRAY['10.044'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1157','fatal','unit','Indicate whether the subject property is a corner unit.','If StructuralDesignType = "Lowrise" or "Highrise" or "Midrise", and CornerUnitIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.019'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1158','fatal','unit','Provide the ''Floor Number''.','If ImprovementType = "Dwelling" and AttachmentType = "Attached" and StructuralDesignType = ("Lowrise" or "Highrise" or "Midrise"), and FloorIdentifier is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.018'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1160','fatal','unit','Provide the interior condition rating.','If (ImprovementType = "Dwelling") or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and InteriorConditionRatingCode is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.035'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1161','fatal','unit','Provide the interior quality rating.','If (ImprovementType = "Dwelling") OR (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and InteriorQualityRatingCode is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.034'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1162','warning','unit','Indicate whether the living unit utilities are metered separately.','If (LivingUnitExcludingADUCount > 1 or AccessoryDwellingUnitTotalCount > 0), and UtilitiesMeteredSeparatelyIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.021'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1163','fatal','unit','Indicate whether ADUs are typical to the market.','If AccessoryDwellingUnitIndicator = "true" and AccessoryDwellingUnitTypicalToMarketIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.014'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1164','fatal','unit','Indicate whether the living unit is an ADU.','if AccessoryDwellingUnitIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL when STRUCTURE_DETAIL/LivingUnitCount > 0',ARRAY['10.011'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1165','fatal','unit','Indicate whether the ADU has a separate postal address.','If AccessoryDwellingUnitIndicator = "true" and SeparatePostalAddressIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.016'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1166','fatal','unit','Provide ingress/egress to the ADU (i.e., Interior Access Only, Exterior Access Only, Interior and Exterior Access).','If AccessoryDwellingUnitIndicator = "true" and AccessType is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.015'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1167','fatal','unit','Indicate whether the ADU is legally rentable.','If AccessoryDwellingUnitIndicator = "true" and AccessoryDwellingUnitLegallyRentableIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.012'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1168','fatal','unit','Indicate whether the living unit has any Live/Work space.','If LandOwnedInCommonIndicator = "true" and AllowableLiveWorkSpaceIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.027'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1169','fatal','unit_interior_feature','Provide the ''Condition Status'' for each floor covering.','If ImprovementComponentType = "Flooring" and ImprovementComponentConditionStatusType is not provided in FLOOR_COVERING in a given instance of PROPERTY_UNIT',ARRAY['10.047'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1170','fatal','unit','Unit Identifier must be provided when multiple living units are identified in the appraisal.','If (LivingUnitExcludingADUCount > 1 or AccessoryDwellingUnitTotalCount > 0), and UnitIdentifier is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.002'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1171','fatal','unit','The unit identifier must be unique.','If UnitIdentifier is not unique across all instances of PROPERTY_UNIT_DETAIL',ARRAY['10.002'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1173','fatal','unit','Provide the ''Overall Update Status for Bathrooms''.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and OverallBathroomsUpdateStatusType is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.043'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1174','fatal','unit','Provide the number of bedrooms in the living unit, even if the value is 0.','If ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and BedroomCount is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.023'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1175','fatal','unit','Provide the number of full bathrooms in the living unit, even if the value is 0.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and FullBathroomCount is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.024'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1176','fatal','unit','Provide the number of half bathrooms in the living unit, even if the value is 0.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and HalfBathroomCount is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.025'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1177','fatal','unit_room','Provide the level type (e.g., Level 1, Level 2, Level B1).','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and LevelType is not provided in a given instance ROOM_DETAIL',ARRAY['10.037'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1178','fatal','unit','Provide the ''Overall Update Status for Flooring''.','If ImprovementComponentType = "Flooring" and OverallFlooringUpdateStatusType is not provided in a given instance of INTERIOR_COMPONENT_DETAIL',ARRAY['10.049'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1182','warning','unit','Indicate whether the living unit has any non-residential uses.','If LandOwnedInCommonIndicator = "true" and UnitMixedUsageIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.026'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1184','fatal','unit_level','Provide the finished area of each level in the living unit.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and LevelFinishedAreaMeasure is not provided in a given instance of LEVEL',ARRAY['10.032'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1185','warning','unit_level','Provide the unfinished area of each level in the living unit.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and LevelUnfinishedAreaMeasure is not provided in a given instance of LEVEL',ARRAY['10.032'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1186','fatal','unit','Provide the ''Finished Above Grade'' Area, even if the value is 0.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and UnitStandardAboveGradeFinishedAreaMeasure is not provided in a given instance of PROPERTY_UNIT_AREA',ARRAY['10.003'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1187','fatal','unit','Provide the ''Finished Above Grade (Nonstandard)'' Area, even if the value is 0.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and UnitNonStandardAboveGradeFinishedAreaMeasure is not provided in a given instance of PROPERTY_UNIT_AREA',ARRAY['10.004'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1188','warning','unit','Provide the ''Unfinished Above Grade'' Area, even if the value is 0.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and UnitAboveGradeUnfinishedAreaMeasure is not provided in a given instance of PROPERTY_UNIT_AREA',ARRAY['10.005'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1189','fatal','unit','Provide the ''Finished Below Grade'' Area, even if the value is 0.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and UnitStandardBelowGradeFinishedAreaMeasure is not provided in a given instance of PROPERTY_UNIT_AREA',ARRAY['10.006'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1190','fatal','unit','Provide the ''Unfinished Below Grade'' Area, even if the value is 0.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and UnitBelowGradeUnfinishedAreaMeasure is not provided in a given instance of PROPERTY_UNIT_AREA',ARRAY['10.008'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1484','fatal','unit','Provide the ''Finished Below Grade (Nonstandard)'' Area, even if the value is 0.','If ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true"), and UnitNonStandardBelowGradeFinishedAreaMeasure is not provided in a given instance of PROPERTY_UNIT_AREA',ARRAY['10.007'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1688','fatal','unit','Indicate whether the living unit has any defects, damages, or deficiencies.','If (ImprovementType = "Dwelling" or (ImprovementType = "Outbuilding" and OutbuildingRealPropertyIndicator = "true" and AccessoryDwellingUnitIndicator = "true")), and UnitInteriorDefectsExistIndicator is not provided in a given instance of PROPERTY_UNIT_DETAIL',ARRAY['10.055'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1694','fatal','unit','Each dwelling must contain at least one living unit that is not an ADU.','For each instance of IMPROVEMENT_DETAIL with ImprovementType = "Dwelling", if there is no occurrences of PROPERTY_UNIT_DETAIL with AccessoryDwellingUnitIndicator = "false"',ARRAY['10.011'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1730','warning','unit','There is an indicator of a living unit in an outbuilding, and it was not identified as an ADU. Any living unit in an outbuilding is considered an ADU, or it would have to be identified as a dwelling.','If AccessoryDwellingUnitIndicator = "false" for a given instance of PROPERTY_UNIT_DETAIL in IMPROVEMENT with ImprovementType = "Outbuilding"',ARRAY['10.011'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1764','fatal','unit','Each dwelling must contain at least one living unit.','If ImprovementType = ''Dwelling'' and there are no instances of PROPERTY_UNIT',ARRAY['10.002'],'{"phase":7,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-001','fatal','unit','Unit area measurements require at least one data source.','each unit has area data source',ARRAY['10.003','10.009'],'{"phase":7,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-002','fatal','unit','The reported level count must match the saved levels.','level count equals level records',ARRAY['10.017','10.029'],'{"phase":7,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-003','fatal','unit','Level areas must reconcile to the unit area breakdown.','level area totals equal unit area totals',ARRAY['10.003','10.004','10.005','10.006','10.007','10.008','10.032'],'{"phase":7,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-004','fatal','unit','Bedroom and bathroom counts must match room records.','room summary equals room records',ARRAY['10.023','10.024','10.025','10.033'],'{"phase":7,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-005','fatal','unit_room','Each required Unit Interior room requires a verified photo.','required room photo exists',ARRAY['10.033','10.033.1'],'{"phase":7,"source":"UAD 3.6 Photo and Image Requirements v1.0","implementation":"server_asset"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-006','fatal','unit_interior_feature','Flooring and Walls and Ceiling records are required.','required interior feature rows exist',ARRAY['10.044'],'{"phase":7,"source":"Appendix A-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-007','fatal','unit','Accessibility None must be exclusive.','None exclusive in accessibility list',ARRAY['10.050'],'{"phase":7,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-UNIT-008','fatal','unit_interior_defect','Each reported physical interior defect requires a verified photo.','required defect photo exists',ARRAY['10.055','10.056.1'],'{"phase":7,"source":"Appendix F-1 v1.4","implementation":"server_asset"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
