-- Exact duplicate-position probes must not scan every link in a large package
-- once per validation row. This index is DATA-only; no source grant, mutable
-- fallback, default activation or change to immutable published originals.
CREATE INDEX IF NOT EXISTS neighborhood_frozen_link_identity_idx
  ON app.neighborhood_frozen_source_rows
    (generation_id, source_record_id, (payload->>'source_position'), (payload->>'parcel_sequence'), row_key)
  WHERE kind='sale_links';
