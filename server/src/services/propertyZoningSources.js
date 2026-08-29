// Dallas County's official municipality list is maintained at:
// https://www.dallascounty.org/about-us/cities/
//
// A municipality is only marked "automatic" after its own public website or
// ArcGIS organization exposes a queryable polygon layer. Municipalities that
// publish only a PDF, a private viewer, or a third-party viewer remain visible
// in the registry as manual-review jurisdictions. That is intentional: a
// missing official feed must never be silently replaced with guessed zoning.

export const DALLAS_COUNTY_CITIES = Object.freeze([
  "Addison",
  "Balch Springs",
  "Carrollton",
  "Cedar Hill",
  "Cockrell Hill",
  "Combine",
  "Coppell",
  "Dallas",
  "DeSoto",
  "Duncanville",
  "Farmers Branch",
  "Ferris",
  "Garland",
  "Glenn Heights",
  "Grand Prairie",
  "Grapevine",
  "Highland Park",
  "Hutchins",
  "Irving",
  "Lancaster",
  "Lewisville",
  "Mesquite",
  "Ovilla",
  "Richardson",
  "Rowlett",
  "Sachse",
  "Seagoville",
  "Sunnyvale",
  "University Park",
  "Wilmer",
  "Wylie",
]);

function officialSource({
  city,
  url,
  layer,
  outFields,
  zoningCodeFields,
  descriptionFields = [],
  classificationLabels = {},
  classificationPrefixLabels = {},
  sourceIdFields = [],
  sourceUpdatedFields = [],
  queryUrls,
  referenceUrl,
}) {
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return Object.freeze({
    providerKey: `city_${slug}_official`,
    sourceKey: `zoning_city_${slug}_official`,
    label: `City of ${city} official zoning GIS`,
    jurisdiction: city,
    url,
    layer,
    outFields,
    zoningCodeFields,
    descriptionFields,
    classificationLabels: Object.freeze({ ...classificationLabels }),
    classificationPrefixLabels: Object.freeze({ ...classificationPrefixLabels }),
    sourceIdFields,
    sourceUpdatedFields,
    queryUrls,
    referenceUrl,
  });
}

export function officialZoningClassificationDescription(source, zoningCode) {
  const normalized = String(zoningCode || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!normalized) return null;
  const exact = String(source?.classificationLabels?.[normalized] || "").trim();
  if (exact) return exact;
  for (const [prefix, description] of Object.entries(source?.classificationPrefixLabels || {})) {
    if (normalized.startsWith(prefix)) return String(description || "").trim() || null;
  }
  return null;
}

export const OFFICIAL_ZONING_SOURCES = Object.freeze([
  officialSource({
    city: "Balch Springs",
    url: "https://services5.arcgis.com/HmZrfXtpyBP9VLYQ/arcgis/rest/services/Parcels_Zoning/FeatureServer/0/query",
    layer: 0,
    outFields: "OBJECTID,GlobalID,Zoning,Zoning_Code,SUP",
    zoningCodeFields: ["Zoning_Code", "Zoning"],
    descriptionFields: ["Zoning", "SUP"],
    sourceIdFields: ["GlobalID"],
    referenceUrl: "https://balchsprings.maps.arcgis.com/",
  }),
  officialSource({
    city: "Carrollton",
    url: "https://maps.cityofcarrollton.com/arcserver/rest/services/Webmaps/Zoning/MapServer/132/query",
    layer: 132,
    outFields: "OBJECTID,GlobalID,Zoning,Ordinance,PD_Num,EditDate,last_edited_date,OrdDate1",
    zoningCodeFields: ["Zoning", "PD_Num"],
    descriptionFields: ["Zoning"],
    sourceIdFields: ["GlobalID"],
    sourceUpdatedFields: ["last_edited_date", "EditDate", "OrdDate1"],
    referenceUrl: "https://maps.cityofcarrollton.com/arcserver/rest/services/Webmaps/Zoning/MapServer/132",
  }),
  officialSource({
    city: "Cedar Hill",
    url: "https://services2.arcgis.com/c4jK8v4C9UDiTgJU/arcgis/rest/services/CHZoning/FeatureServer/0/query",
    layer: 0,
    outFields: "OBJECTID,ZONECLASS,ZONEDESC,PD_NUM,CASE_NUM,ORD_NUM,LASTUPDATE",
    zoningCodeFields: ["ZONECLASS", "PD_NUM"],
    descriptionFields: ["ZONEDESC"],
    sourceUpdatedFields: ["LASTUPDATE"],
    referenceUrl: "https://cedarhilltx.com/",
  }),
  officialSource({
    city: "Coppell",
    url: "https://map.coppelltx.gov/gis/rest/services/External/CivilianServices/MapServer/5/query",
    layer: 5,
    outFields: "OBJECTID,ZONETYPE,ZONEBASE,CASE_,ORDINANCE,DATE_,SPECIAL,LaserFiche",
    zoningCodeFields: ["ZONEBASE", "ZONETYPE"],
    descriptionFields: ["SPECIAL"],
    sourceUpdatedFields: ["DATE_"],
    referenceUrl: "https://www.coppelltx.gov/448/Maps",
  }),
  officialSource({
    city: "Dallas",
    url: "https://gis.dallascityhall.com/arcgis/rest/services/sdc_public/Zoning/MapServer/15/query",
    layer: 15,
    outFields: "OBJECTID,GLOBALID,ZONE_DIST,LONG_ZONE_DIST,PD_NUM,CD_NUM,DISTRICTUSE,EFFECTIVEDATE",
    zoningCodeFields: ["LONG_ZONE_DIST", "ZONE_DIST"],
    descriptionFields: ["DISTRICTUSE"],
    sourceIdFields: ["GLOBALID"],
    sourceUpdatedFields: ["EFFECTIVEDATE"],
    referenceUrl: "https://dallascitydata.dallascityhall.com/",
  }),
  officialSource({
    city: "DeSoto",
    url: "https://services8.arcgis.com/QHqdbIhWBJLlMbGN/arcgis/rest/services/Zoning_DeSoto/FeatureServer/0/query",
    layer: 0,
    outFields: "OBJECTID,GlobalID,Unique_ID,Zone_Code,ZONECLASS,ZONEDESC,LASTUPDATE,last_edited_date",
    zoningCodeFields: ["Zone_Code", "ZONECLASS"],
    descriptionFields: ["ZONEDESC"],
    sourceIdFields: ["GlobalID", "Unique_ID"],
    sourceUpdatedFields: ["last_edited_date", "LASTUPDATE"],
    referenceUrl: "https://www.desototexas.gov/",
  }),
  officialSource({
    city: "Duncanville",
    url: "https://services3.arcgis.com/mjqW4t1A3YDrjss0/arcgis/rest/services/Zoning_view/FeatureServer/0/query",
    layer: 0,
    outFields: "FID,NEW_ZONING",
    zoningCodeFields: ["NEW_ZONING"],
    classificationLabels: {
      C: "Commercial District",
      DD: "Downtown Duncanville District",
      GOR: "General Office/Retail District",
      I: "Industrial District",
      LOR: "Local Office/Retail District",
      MF14: "Multi-Family Residential District (MF-14)",
      MF21: "Multi-Family Residential District (MF-21)",
      NOR: "Neighborhood Office/Retail District",
      NP: "Nature Preserve District",
      PD: "Planned Development District",
      RR: "Railroad",
      SF7: "Single-Family Residential District (SF-7)",
      SF10: "Single-Family Residential District (SF-10)",
      SF13: "Single-Family Residential District (SF-13)",
      SF43: "Estate Single-Family Residential District (SF-43)",
      SUP: "Specific Use",
      TF7: "Duplex Residential District (TF-7)",
    },
    classificationPrefixLabels: {
      PD: "Planned Development District",
      SUP: "Specific Use",
    },
    sourceIdFields: ["FID"],
    referenceUrl: "https://duncanville.maps.arcgis.com/apps/instant/basic/index.html?appid=64164a8429db49f2864d9361f30e4720",
  }),
  officialSource({
    city: "Farmers Branch",
    url: "https://services1.arcgis.com/rrMt0tlqg3eYOL0M/arcgis/rest/services/Zoning_public/FeatureServer/0/query",
    layer: 0,
    outFields: "OBJECTID,ZONECLASS,ZONEDESC,CITYPDDIST,LASTUPDATE",
    zoningCodeFields: ["ZONECLASS", "CITYPDDIST"],
    descriptionFields: ["ZONEDESC"],
    sourceUpdatedFields: ["LASTUPDATE"],
    referenceUrl: "https://www.farmersbranchtx.gov/",
  }),
  officialSource({
    city: "Garland",
    url: "https://maps.garlandtx.gov/arcgis/rest/services/CityMap_Other/GDC_Zoning/MapServer/1/query",
    layer: 1,
    outFields: "OBJECTID,PD_NUM,GDC_ZONING,ORD_NO,BASE_ZONE,MISC",
    zoningCodeFields: ["BASE_ZONE", "GDC_ZONING"],
    descriptionFields: ["MISC"],
    referenceUrl: "https://maps.garlandtx.gov/",
  }),
  officialSource({
    city: "Grand Prairie",
    url: "https://gis.gptx.org/srv105/rest/services/Maps/Information/MapServer/55/query",
    layer: 55,
    outFields: "OBJECTID,ZONE_CLASS,ORDINANCE_NO,ZONE_DESC,ZONE_CASE,DOC_LINK",
    zoningCodeFields: ["ZONE_CLASS"],
    descriptionFields: ["ZONE_DESC"],
    referenceUrl: "https://www.gptx.org/Departments/Planning-and-Development",
  }),
  officialSource({
    city: "Grapevine",
    url: "https://services.arcgis.com/xSPs49inzz3yMpnd/arcgis/rest/services/Zoning/FeatureServer/0/query",
    layer: 0,
    outFields: "OBJECTID,ZONECODE,ZONEDESCRIPTION",
    zoningCodeFields: ["ZONECODE"],
    descriptionFields: ["ZONEDESCRIPTION"],
    referenceUrl: "https://grapevinegis.maps.arcgis.com/",
  }),
  officialSource({
    city: "Irving",
    url: "https://services3.arcgis.com/OfsJXUlu8pSkbl7B/arcgis/rest/services/Planning_and_Zoning/FeatureServer/5/query",
    layer: 5,
    outFields: "OBJECTID,GlobalID,FacilityID,CaseNumber,Ordinance,District,Use_,Description,BaseDistrict,last_edited_date",
    zoningCodeFields: ["District", "BaseDistrict"],
    descriptionFields: ["Description", "Use_"],
    sourceIdFields: ["GlobalID", "FacilityID"],
    sourceUpdatedFields: ["last_edited_date"],
    referenceUrl: "https://www.cityofirving.org/",
  }),
  officialSource({
    city: "Lancaster",
    url: "https://services1.arcgis.com/hUry7JDhk1zQOJdo/arcgis/rest/services/Zoning1/FeatureServer/0/query",
    layer: 0,
    outFields: "OBJECTID,CaseNo,Zoning,Descriptio,Ordinance,Zoning2,PD_Num,Acres",
    zoningCodeFields: ["Zoning", "Zoning2", "PD_Num"],
    descriptionFields: ["Descriptio"],
    referenceUrl: "https://www.lancaster-tx.com/295/Zoning",
  }),
  officialSource({
    city: "Lewisville",
    url: "https://services2.arcgis.com/kXGqZY4GIOcEYxoF/arcgis/rest/services/Zoning_Feature_view/FeatureServer/0/query",
    layer: 0,
    outFields: "OBJECTID,GlobalID,ZONING_CLASS,Zoning_Desc,Ordinance_Number",
    zoningCodeFields: ["ZONING_CLASS"],
    descriptionFields: ["Zoning_Desc"],
    sourceIdFields: ["GlobalID"],
    referenceUrl: "https://www.cityoflewisville.com/",
  }),
  officialSource({
    city: "Mesquite",
    url: "https://gisservices.cityofmesquite.com/server/rest/services/onlinemaps/zoning/MapServer/2/query",
    layer: 2,
    outFields: "OBJECTID,GlobalID,DISTRICT,BASE_ZONE,COMMENTS,Overlay,ORDINANCE_NO,PLANNED_DEVELOPMENT,last_edited_date",
    zoningCodeFields: ["BASE_ZONE", "DISTRICT", "PLANNED_DEVELOPMENT"],
    descriptionFields: ["COMMENTS", "Overlay"],
    sourceIdFields: ["GlobalID"],
    sourceUpdatedFields: ["last_edited_date"],
    referenceUrl: "https://www.cityofmesquite.com/512/Online-Interactive-Maps",
  }),
  officialSource({
    city: "Richardson",
    url: "https://maps.cor.gov/arcgis/rest/services/DevelopmentServices/ZoningDistricts/MapServer/1/query",
    layer: 1,
    outFields: "OBJECTID,FACILITYID,ZONECLASS,ZONEDESC,ORD,SPL,CZO,last_edited_date,OrdinanceDate",
    zoningCodeFields: ["ZONECLASS", "CZO"],
    descriptionFields: ["ZONEDESC"],
    sourceIdFields: ["FACILITYID"],
    sourceUpdatedFields: ["last_edited_date", "OrdinanceDate"],
    referenceUrl: "https://www.cor.net/",
  }),
  officialSource({
    city: "Sachse",
    url: "https://services6.arcgis.com/OSORr24S2Mlvyg30/arcgis/rest/services/Zoning/FeatureServer/0/query",
    layer: 0,
    outFields: "FID,ZONING,TYPE,DISTRICT,ORD_NO1,ORD1_DATE",
    zoningCodeFields: ["ZONING", "DISTRICT"],
    descriptionFields: ["TYPE"],
    sourceIdFields: ["FID"],
    sourceUpdatedFields: ["ORD1_DATE"],
    referenceUrl: "https://www.cityofsachse.com/",
  }),
  officialSource({
    city: "Sunnyvale",
    url: "https://services5.arcgis.com/ecWT8iam2AWjfm3E/arcgis/rest/services/Sunnyvale_Base_Map/FeatureServer/16/query",
    layer: 16,
    outFields: "OBJECTID_1,GlobalID,Zone_Class,Zone_Class_Code,Text,LABEL,last_edited_date",
    zoningCodeFields: ["Zone_Class_Code", "Zone_Class", "LABEL"],
    descriptionFields: ["Text"],
    sourceIdFields: ["GlobalID", "OBJECTID_1"],
    sourceUpdatedFields: ["last_edited_date"],
    referenceUrl: "https://townofsunnyvale.org/499/Zoning-Map-and-Regulations",
  }),
  officialSource({
    city: "Wilmer",
    url: "https://services3.arcgis.com/MJMFp00W0CZ2tFbf/arcgis/rest/services/Zoning_Districts/FeatureServer/10/query",
    layer: 10,
    outFields: "OBJECTID,GlobalID,CaseNum,Zoning,Descriptio,Ordinance,Status,F2nd_Zoning,BaseZoning",
    zoningCodeFields: ["Zoning", "BaseZoning", "F2nd_Zoning"],
    descriptionFields: ["Descriptio"],
    sourceIdFields: ["GlobalID"],
    referenceUrl: "https://www.cityofwilmer.net/300/Interactive-Maps",
  }),
  officialSource({
    city: "Wylie",
    url: "https://gisapp.wylietexas.gov/portalserver/rest/services/Planning/ZoningDistricts/FeatureServer/81/query",
    layer: 81,
    outFields: "OBJECTID,GlobalID,ZONECLASS,ZONEDESC,ZONECATE,NOTES,LASTUPDATE,last_edited_date,OrdinanceNumber",
    zoningCodeFields: ["ZONECLASS", "ZONECATE"],
    descriptionFields: ["ZONEDESC", "NOTES"],
    sourceIdFields: ["GlobalID"],
    sourceUpdatedFields: ["last_edited_date", "LASTUPDATE"],
    referenceUrl: "https://gisapp.wylietexas.gov/portalserver/rest/services/Planning/ZoningDistricts/FeatureServer/81",
  }),
]);

const SOURCE_BY_CITY = new Map(OFFICIAL_ZONING_SOURCES.map((source) => [source.jurisdiction, source]));

const MANUAL_REFERENCE_URLS = Object.freeze({
  Addison: "https://www.addisontx.gov/Government/Departments/Information-Technology/GIS-Maps",
  "Cockrell Hill": "https://www.cockrellhilltx.gov/",
  Combine: "https://combinetx.com/",
  Ferris: "https://www.ferristexas.gov/249/Zoning-District-Maps",
  "Glenn Heights": "https://www.glennheightstx.gov/176/Planning-Development-Services",
  "Highland Park": "https://www.hptx.org/237/Zoning",
  Hutchins: "https://www.cityofhutchinstx.gov/",
  Ovilla: "https://www.cityofovilla.org/268/Development-Services",
  Rowlett: "https://emap.rowlett.com/arcgis/rest/services/OnlineServices/ZoningInfo/MapServer/0",
  Seagoville: "https://www.seagoville.us/218/Maps",
  "University Park": "https://uptexas.org/174/Zoning",
});

// Static official maps are cached by scheduled maintenance so the property
// report can still display the last-known evidence when a municipal site is
// unavailable. Interactive-only jurisdictions retain their official link and
// contact path below instead of being treated as if a PDF exists.
const MANUAL_ZONING_DOCUMENTS = Object.freeze({
  "Cockrell Hill": [{
    key: "official_zoning_code",
    title: "Cockrell Hill Official Zoning and Development Code",
    url: "https://cityofcockrellhill.us/DocumentCenter/View/387/ZONING-CODE-ENTIRE-2008-F-Ch-153",
  }],
  Ferris: [{
    key: "official_zoning_map",
    title: "Ferris Official Zoning District Map",
    url: "https://www.ferristexas.gov/DocumentCenter/View/132/zoning_map_-_feb_2021_3-25-21",
  }],
  "Glenn Heights": [{
    key: "official_zoning_map",
    title: "Glenn Heights Zoning Map",
    url: "https://www.glennheightstx.gov/DocumentCenter/View/193/Zoning-Map-PDF",
  }],
  "Highland Park": [{
    key: "official_zoning_map",
    title: "Highland Park Zoning Map with Addresses",
    url: "https://www.hptx.org/DocumentCenter/View/1448",
  }],
  Ovilla: [{
    key: "official_zoning_map",
    title: "Ovilla Zoning Map",
    url: "https://cityofovilla.org/DocumentCenter/View/3542/Ovilla-Zoning-Map",
  }],
  Seagoville: [{
    key: "official_zoning_map",
    title: "Seagoville Zoning Map",
    url: "https://seagoville.us/DocumentCenter/View/5012",
  }],
});

const MANUAL_ZONING_CONTACTS = Object.freeze({
  Addison: {
    department: "Development & Neighborhood Services - Planning and Zoning",
    phone: "972-450-2880",
    email: "developmentservices@addisontx.gov",
    address: "16801 Westgrove Drive, Addison, TX 75001",
    sourceUrl: "https://developmentservices.addisontx.gov/Contact-Us",
  },
  "Cockrell Hill": {
    department: "City Administration / Building Permits",
    phone: "214-330-6333",
    email: "buildingpermits@cockrell-hill.tx.us",
    address: "4125 W Clarendon Drive, Cockrell Hill, TX 75211",
    sourceUrl: "https://cityofcockrellhill.us/2200/Apply-for-City-Permits",
  },
  Combine: {
    department: "City Secretary / Planning and Zoning",
    phone: "972-476-1532",
    email: "city@combinetx.com",
    address: "100 Davis Road, Combine, TX 75159",
    sourceUrl: "https://www.combinetx.com/",
  },
  Ferris: {
    department: "Community Development - Planning",
    phone: "972-544-2110",
    email: "development@ferristexas.gov",
    address: "114 S Central Street, Ferris, TX 75125",
    sourceUrl: "https://www.ferristexas.gov/172/Planning",
  },
  "Glenn Heights": {
    department: "Planning & Development Services",
    phone: "972-223-1690 ext. 451",
    email: null,
    address: "1938-C S Hampton Road, Glenn Heights, TX 75154",
    sourceUrl: "https://www.glennheightstx.gov/176/Planning-Development-Services",
  },
  "Highland Park": {
    department: "Building Inspection / Zoning",
    phone: "214-521-4161",
    email: null,
    address: "4700 Drexel Drive, Highland Park, TX 75205",
    sourceUrl: "https://www.hptx.org/237/Zoning",
  },
  Hutchins: {
    department: "City Hall - Planning and Zoning",
    phone: "972-225-6121",
    email: "klindsey@cityofhutchins.org",
    address: "321 N Main Street, Hutchins, TX 75141",
    sourceUrl: "https://www.cityofhutchinstx.gov/",
  },
  Ovilla: {
    department: "Development Services",
    contactName: "Planning and Development Coordinator",
    phone: "972-617-7262",
    email: null,
    address: "105 Cockrell Hill Road, Ovilla, TX 75154",
    sourceUrl: "https://cityofovilla.org/268/Development-Services",
  },
  Rowlett: {
    department: "Planning and Urban Design",
    phone: "972-412-6138",
    email: "planning@rowlett.com",
    address: "5702 Rowlett Road, Rowlett, TX 75089",
    sourceUrl: "https://www.rowletttx.gov/230/Planning-and-Urban-Design-Department",
  },
  Seagoville: {
    department: "Planning & Zoning",
    contactName: "City Planner",
    phone: "972-287-3918",
    email: "cparks@seagoville.us",
    address: "702 N Highway 175, Seagoville, TX 75159",
    sourceUrl: "https://seagoville.us/71/Planning-Zoning",
  },
  "University Park": {
    department: "Community Development",
    contactName: "City Planner",
    phone: "214-987-5411",
    email: null,
    address: "4420 Worcola Street, Dallas, TX 75206",
    sourceUrl: "https://uptexas.org/163/Community-Development",
  },
});

export const DALLAS_COUNTY_ZONING_JURISDICTIONS = Object.freeze(
  DALLAS_COUNTY_CITIES.map((city) => {
    const source = SOURCE_BY_CITY.get(city) || null;
    const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return Object.freeze({
      city,
      providerKey: source?.providerKey || `city_${slug}_official`,
      providerLabel: source?.label || `City of ${city} official zoning verification`,
      sourceKey: source?.sourceKey || null,
      automationStatus: source ? "automatic" : "manual_review",
      serviceUrl: source?.url || null,
      serviceLayer: source?.layer ?? null,
      referenceUrl: source?.referenceUrl || MANUAL_REFERENCE_URLS[city] || null,
      documents: MANUAL_ZONING_DOCUMENTS[city] || [],
      contact: MANUAL_ZONING_CONTACTS[city] || null,
      configuration: {
        coverage_scope: "Dallas County portion",
        automation_status: source ? "automatic" : "manual_review",
        zoning_code_fields: source?.zoningCodeFields || [],
        description_fields: source?.descriptionFields || [],
        reference_url: source?.referenceUrl || MANUAL_REFERENCE_URLS[city] || null,
        documents: MANUAL_ZONING_DOCUMENTS[city] || [],
        contact: MANUAL_ZONING_CONTACTS[city] || null,
        verification_note: source
          ? "Queryable official municipal polygon service verified."
          : "No verified public municipal polygon service; confirm zoning manually from the linked official city resource.",
      },
    });
  }),
);

export const AUTOMATED_ZONING_SOURCE_KEYS = Object.freeze(
  OFFICIAL_ZONING_SOURCES.map((source) => source.sourceKey),
);

export function selectOfficialZoningSources(jurisdictions = null) {
  const requested = Array.isArray(jurisdictions)
    ? jurisdictions
    : String(jurisdictions || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  if (!requested.length) return [...OFFICIAL_ZONING_SOURCES];
  const requestedByName = new Map(requested.map((city) => [city.toUpperCase(), city]));
  const selected = OFFICIAL_ZONING_SOURCES.filter(
    (source) => requestedByName.has(source.jurisdiction.toUpperCase()),
  );
  const found = new Set(selected.map((source) => source.jurisdiction.toUpperCase()));
  const unknown = requested.filter((city) => !found.has(city.toUpperCase()));
  if (unknown.length) {
    throw new Error(`unknown_zoning_jurisdiction:${unknown.join(",")}`);
  }
  return selected;
}
