-- Run outside a transaction, through prepareNeighborhoodSpatialIndexes.js.
-- Deliberately identical to cachedSpatialMembership's cache-wide rejection gate.
-- Index membership stays current on INSERT/UPDATE/DELETE; this is not a cached
-- validity assertion and does not skip invalid/missing parcels.
CREATE INDEX CONCURRENTLY IF NOT EXISTS dcad_parcels_neighborhood_invalid_idx
  ON gis.dcad_parcels (object_id)
  WHERE geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom)
    OR ST_SRID(geom) <> 4326 OR ST_GeometryType(geom) <> 'ST_MultiPolygon'
    OR NOT (ST_XMin(geom) >= -180 AND ST_XMax(geom) <= 180
      AND ST_YMin(geom) >= -90 AND ST_YMax(geom) <= 90);

-- The existing geometry GiST index cannot serve geom::geography ST_DWithin.
-- Keep the original spheroid predicate, radius and whole-parcel membership.
CREATE INDEX CONCURRENTLY IF NOT EXISTS dcad_parcels_neighborhood_geography_gix
  ON gis.dcad_parcels USING gist ((geom::geography));
