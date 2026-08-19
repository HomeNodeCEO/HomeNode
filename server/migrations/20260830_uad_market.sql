-- URAR Section 17: Market.
-- This migration is additive. It registers the official market-search metrics,
-- repeatable price-trend sources, graphs/exhibits, and compliance rules without
-- changing HomeNode's existing sales, market-analysis, or appraisal records.

ALTER TABLE appraisal.uad_entities
  DROP CONSTRAINT IF EXISTS uad_entities_entity_type_check;

ALTER TABLE appraisal.uad_entities
  ADD CONSTRAINT uad_entities_entity_type_check
  CHECK (entity_type IN (
    'property', 'dwelling', 'manufactured_home', 'unit', 'adu', 'outbuilding',
    'vehicle_storage', 'amenity', 'sales_comparable', 'rental_comparable',
    'grm_comparable', 'land_comparable', 'analyzed_not_used', 'site_parcel',
    'site_influence', 'site_view', 'site_encumbrance', 'site_feature',
    'site_utility', 'site_defect', 'renewable_energy_component',
    'green_building_certification', 'green_efficiency_rating',
    'dwelling_exterior_feature', 'dwelling_noncontinuous_room',
    'dwelling_exterior_defect', 'manufactured_home_skirting_material',
    'manufactured_home_modification', 'manufactured_home_hud_label',
    'manufactured_home_financing_program', 'unit_area_data_source',
    'unit_adu_data_source', 'unit_level', 'unit_room', 'unit_interior_feature',
    'unit_interior_defect', 'outbuilding_room', 'outbuilding_defect',
    'vehicle_storage_defect', 'amenity_defect', 'market_price_trend_source'
  ));

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"3000.0008","rfid":"17.003","context":"market","name":"MarketBoundariesDescription","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":1250,"format":"1250"},
    {"uid":"3000.0010","rfid":"17.004","context":"market","name":"MarketInventorySearchParameterDescription","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":1250,"format":"1250"},
    {"uid":"3000.0018","rfid":"17.005","context":"market_active_listings","name":"MarketInventoryCount","type":"Numeric","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":"+3.0"},
    {"uid":"3000.0021","rfid":"17.006","context":"market_active_listings","name":"MarketInventoryMedianDaysOnMarketCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"3000.0020","rfid":"17.007","context":"market_active_listings","name":"MarketInventoryLowestPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"3000.0022","rfid":"17.008","context":"market_active_listings","name":"MarketInventoryMedianPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"3000.0019","rfid":"17.009","context":"market_active_listings","name":"MarketInventoryHighestPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"3000.0024","rfid":"17.010","context":"market_pending_sales","name":"MarketInventoryCount","type":"Numeric","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":"+3.0"},
    {"uid":"3000.0009","rfid":"17.011","context":"market","name":"MarketInventoryLookbackMonthsCount","type":"Numeric","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0"},
    {"uid":"3000.0026","rfid":"17.012","context":"market_total_sales","name":"MarketInventoryCount","type":"Numeric","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":"+3.0"},
    {"uid":"3000.0028","rfid":"17.013","context":"market_total_sales","name":"MarketInventoryLowestPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"3000.0029","rfid":"17.014","context":"market_total_sales","name":"MarketInventoryMedianPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"3000.0027","rfid":"17.015","context":"market_total_sales","name":"MarketInventoryHighestPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"3000.0034","rfid":"17.016","context":"market","name":"MarketTrendsForeclosureActivityIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":null},
    {"uid":"1400.0638","rfid":"17.017","context":"market_asset","name":"ImageCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:unbounded","options":["AbsorptionRateGraph","MedianDaysOnMarketGraph","PercentOfDistressedSalesGraph","PriceTrendGraph","YearBuiltOfSalesGraph","MarketAnalysisExhibit"],"maxLength":null,"format":null},
    {"uid":"1400.0640","rfid":"17.017.2","context":"market_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"3000.0051","rfid":"17.018","context":"market_price_trend_source","name":"DataSourceName","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"3000.0040","rfid":"17.019","context":"market_price_trend_commentary","name":"PriceTrendsAnalysisDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":2500,"format":"2500"},
    {"uid":"3000.0033","rfid":"17.021","context":"market","name":"MarketSupplyTrendType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["InBalance","OverSupply","Shortage"],"maxLength":null,"format":null},
    {"uid":"3000.0031","rfid":"17.022","context":"market","name":"MarketingTimeType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["OverSixMonths","ThreeToSixMonths","UnderThreeMonths"],"maxLength":null,"format":null},
    {"uid":"0100.0044","rfid":"17.023","context":"market_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":5000,"format":"5000"}
  ]
  $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 17, 'Market', context, name, type,
  requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 14, 'options', options, 'max_length', "maxLength", 'format', format,
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
  field.release_key, field.uid, field.property_context, option.value,
  CASE option.value WHEN 'OverSupply' THEN 'Oversupply'
    ELSE regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g') END,
  option.ordinality,
  '{"phase":14,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 17
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, location_role, metadata) AS (
  VALUES
    ('3000.0008','market','17.003','primary','{"label":"Market Area Boundary"}'::jsonb),
    ('3000.0010','market','17.004','primary','{"label":"Search Criteria Description"}'::jsonb),
    ('3000.0018','market_active_listings','17.005','primary','{"label":"Active Listings"}'::jsonb),
    ('3000.0021','market_active_listings','17.006','primary','{"label":"Median Days on Market"}'::jsonb),
    ('3000.0020','market_active_listings','17.007','primary','{"label":"Lowest List Price"}'::jsonb),
    ('3000.0022','market_active_listings','17.008','primary','{"label":"Median List Price"}'::jsonb),
    ('3000.0019','market_active_listings','17.009','primary','{"label":"Highest List Price"}'::jsonb),
    ('3000.0024','market_pending_sales','17.010','primary','{"label":"Pending Sales"}'::jsonb),
    ('3000.0009','market','17.011','primary','{"label":"Lookback Months"}'::jsonb),
    ('3000.0026','market_total_sales','17.012','primary','{"label":"Sales in Lookback Period"}'::jsonb),
    ('3000.0028','market_total_sales','17.013','primary','{"label":"Lowest Sale Price"}'::jsonb),
    ('3000.0029','market_total_sales','17.014','primary','{"label":"Median Sale Price"}'::jsonb),
    ('3000.0027','market_total_sales','17.015','primary','{"label":"Highest Sale Price"}'::jsonb),
    ('3000.0034','market','17.016','primary','{"label":"Distressed Market Competition"}'::jsonb),
    ('1400.0638','market_asset','17.017','primary','{"label":"Graph"}'::jsonb),
    ('1400.0638','market_asset','17.017.1','redisplay','{"label":"Market Exhibit Category"}'::jsonb),
    ('1400.0640','market_asset','17.017.2','primary','{"label":"Market Exhibit Caption"}'::jsonb),
    ('3000.0051','market_price_trend_source','17.018','primary','{"label":"Price Trend Source"}'::jsonb),
    ('3000.0040','market_price_trend_commentary','17.019','primary','{"label":"Price Trend Analysis Commentary"}'::jsonb),
    ('3000.0033','market','17.021','primary','{"label":"Demand Supply"}'::jsonb),
    ('3000.0031','market','17.022','primary','{"label":"Marketing Time"}'::jsonb),
    ('0100.0044','market_commentary','17.023','primary','{"label":"Market Commentary"}'::jsonb),
    ('1400.0638','market_asset','17.024.1','redisplay','{"label":"Additional Market Exhibit Category"}'::jsonb),
    ('1400.0640','market_asset','17.024.2','redisplay','{"label":"Additional Market Exhibit Caption"}'::jsonb)
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
  17, 'Market', location_role,
  metadata || '{"phase":14,"source":"Appendix C-1 v1.3 and Appendix F-1 v1.4"}'::jsonb
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1626','fatal','market','Provide the market area boundary.','MarketBoundariesDescription is required.',ARRAY['17.003'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1627','fatal','market','Provide the market inventory lookback months.','MarketInventoryLookbackMonthsCount is required.',ARRAY['17.011'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1629','fatal','market_active_listings','Provide the active listing count.','Active MarketInventoryCount is required.',ARRAY['17.005'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1630','fatal','market_active_listings','Provide the highest list price when active listings exist.','Highest price is required when count is greater than zero.',ARRAY['17.005','17.009'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1631','fatal','market_active_listings','The highest list price must be greater than zero.','Highest price must be greater than zero.',ARRAY['17.009'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1632','fatal','market_active_listings','Provide the lowest list price when active listings exist.','Lowest price is required when count is greater than zero.',ARRAY['17.005','17.007'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1633','fatal','market_active_listings','The lowest list price must be greater than zero.','Lowest price must be greater than zero.',ARRAY['17.007'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1634','fatal','market_active_listings','Provide median days on market when active listings exist.','Median days on market is required when count is greater than zero.',ARRAY['17.005','17.006'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1635','warning','market_active_listings','Provide the median list price when active listings exist.','Median price is required when count is greater than zero.',ARRAY['17.005','17.008'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1636','fatal','market_active_listings','The median list price must be greater than zero.','Median price must be greater than zero.',ARRAY['17.008'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1639','fatal','market_pending_sales','Provide the pending sale count.','Pending MarketInventoryCount is required.',ARRAY['17.010'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1642','fatal','market_total_sales','Provide the total sale count.','Total sales MarketInventoryCount is required.',ARRAY['17.012'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1643','fatal','market_total_sales','Provide the highest sale price when sales exist.','Highest price is required when count is greater than zero.',ARRAY['17.012','17.015'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1644','fatal','market_total_sales','The highest sale price must be greater than zero.','Highest price must be greater than zero.',ARRAY['17.015'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1645','fatal','market_total_sales','Provide the lowest sale price when sales exist.','Lowest price is required when count is greater than zero.',ARRAY['17.012','17.013'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1646','fatal','market_total_sales','The lowest sale price must be greater than zero.','Lowest price must be greater than zero.',ARRAY['17.013'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1647','warning','market_total_sales','Provide the median sale price when sales exist.','Median price is required when count is greater than zero.',ARRAY['17.012','17.014'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1648','fatal','market_total_sales','The median sale price must be greater than zero.','Median price must be greater than zero.',ARRAY['17.014'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1652','fatal','market','Provide the demand and supply trend.','MarketSupplyTrendType is required.',ARRAY['17.021'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1653','fatal','market','Indicate whether distressed sales compete with the subject.','MarketTrendsForeclosureActivityIndicator is required.',ARRAY['17.016'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1656','fatal','market_price_trend_commentary','Provide a price trend graph or analysis commentary.','PriceTrendGraph or PriceTrendsAnalysisDescription is required.',ARRAY['17.017','17.019'],'{"phase":14,"source":"Appendix H-1 v1.5","implementation":"server_asset_or_commentary"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1657','warning','market_price_trend_source','Provide the source for each price trend analysis.','DataSourceName is required for each DATA_SOURCE instance.',ARRAY['17.018'],'{"phase":14,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MARKET-001','fatal','market','Provide the market inventory search criteria.','MarketInventorySearchParameterDescription is required.',ARRAY['17.004'],'{"phase":14,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MARKET-002','fatal','market','Provide the typical marketing time.','MarketingTimeType is required.',ARRAY['17.022'],'{"phase":14,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MARKET-003','fatal','market_active_listings','Active listing prices must be ordered lowest, median, highest.','Lowest <= median <= highest.',ARRAY['17.007','17.008','17.009'],'{"phase":14,"source":"HomeNode cross-field integrity","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MARKET-004','fatal','market_total_sales','Sale prices must be ordered lowest, median, highest.','Lowest <= median <= highest.',ARRAY['17.013','17.014','17.015'],'{"phase":14,"source":"HomeNode cross-field integrity","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MARKET-005','fatal','market_price_trend_source','Add at least one price trend source.','At least one DATA_SOURCE instance is required.',ARRAY['17.018'],'{"phase":14,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_repeatable_entity"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
