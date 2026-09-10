-- Reviews are a separate append-only history. Original source bytes/receipts
-- and shared sales remain untouched; a match review is not analysis admission.
CREATE TABLE app.assignment_sales_import_reviews (
  review_id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES app.assignment_sales_import_batches(batch_id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  operation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  command_json text NOT NULL,
  command_sha256 text NOT NULL,
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL,
  source_interpretation jsonb,
  UNIQUE (batch_id, revision),
  UNIQUE (batch_id, operation_id),
  UNIQUE (batch_id, review_id),
  UNIQUE (batch_id, review_id, revision),
  CHECK (octet_length(convert_to(command_json, 'UTF8')) BETWEEN 1 AND 262144),
  CHECK (octet_length(convert_to(payload_json, 'UTF8')) BETWEEN 1 AND 2097152),
  CHECK (jsonb_typeof(command_json::jsonb) = 'object'),
  CHECK (jsonb_typeof(payload_json::jsonb) = 'object'),
  CHECK (command_sha256 = encode(sha256(convert_to(command_json, 'UTF8')), 'hex')),
  CHECK (payload_sha256 = encode(sha256(convert_to(payload_json, 'UTF8')), 'hex')),
  -- IS NOT DISTINCT FROM rejects missing/null/string values instead of letting
  -- SQL's unknown CHECK result silently admit a missing expected revision.
  CHECK ((command_json::jsonb->'expected_revision') IS NOT DISTINCT FROM to_jsonb(revision - 1)),
  CHECK (source_interpretation IS NOT DISTINCT FROM nullif(command_json::jsonb->'source_interpretation', 'null'::jsonb))
);

CREATE INDEX assignment_sales_import_reviews_source_idx
  ON app.assignment_sales_import_reviews (batch_id, revision DESC)
  WHERE source_interpretation IS NOT NULL;

-- Compact indexed projection for reading the latest decision per visible row.
-- This is derived by the database from the immutable review command, never a
-- separately writable mutable 'current match' record.
CREATE TABLE app.assignment_sales_import_review_rows (
  batch_id uuid NOT NULL,
  review_id uuid NOT NULL,
  revision integer NOT NULL,
  source_row_number integer NOT NULL,
  receipt_id uuid NOT NULL REFERENCES app.assignment_sales_import_rows(receipt_id) ON DELETE RESTRICT,
  decision jsonb NOT NULL,
  PRIMARY KEY (batch_id, source_row_number, revision),
  FOREIGN KEY (batch_id, source_row_number) REFERENCES app.assignment_sales_import_rows(batch_id, source_row_number) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id, review_id, revision)
    REFERENCES app.assignment_sales_import_reviews(batch_id, review_id, revision) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(decision) = 'object' AND octet_length(convert_to(decision::text, 'UTF8')) <= 8192),
  CHECK ((decision->'source_row_number') IS NOT DISTINCT FROM to_jsonb(source_row_number)),
  CHECK ((decision->'receipt_id') IS NOT DISTINCT FROM to_jsonb(receipt_id::text))
);

CREATE FUNCTION app.guard_assignment_sales_review_append()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE last_revision integer; command_value jsonb; payload_value jsonb;
  decisions jsonb; payload_decisions jsonb; decision_value jsonb; payload_decision jsonb;
  stored_record jsonb; item record;
BEGIN
  PERFORM 1 FROM app.assignment_sales_import_batches WHERE batch_id = NEW.batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment_sales_import_invalid_review_projection' USING ERRCODE = '23514';
  END IF;
  SELECT revision INTO last_revision FROM app.assignment_sales_import_reviews
    WHERE batch_id = NEW.batch_id ORDER BY revision DESC LIMIT 1;
  IF last_revision = 2147483647 THEN
    RAISE EXCEPTION 'assignment_sales_import_revision_conflict' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision IS DISTINCT FROM coalesce(last_revision, 0) + 1 THEN
    RAISE EXCEPTION 'assignment_sales_import_revision_conflict' USING ERRCODE = '23514';
  END IF;
  command_value := NEW.command_json::jsonb;
  payload_value := NEW.payload_json::jsonb;
  decisions := command_value->'row_decisions';
  payload_decisions := payload_value->'row_decisions';
  -- Structural envelope alignment only. Source interpretation, reviewer
  -- authority, fresh proposal meaning and analysis admission remain owner work.
  IF jsonb_typeof(command_value) IS DISTINCT FROM 'object'
    OR jsonb_typeof(payload_value) IS DISTINCT FROM 'object'
    OR (command_value->'review_version') IS DISTINCT FROM '1'::jsonb
    OR (command_value->'expected_revision') IS DISTINCT FROM to_jsonb(NEW.revision - 1)
    OR (payload_value->'review_version') IS DISTINCT FROM '1'::jsonb
    OR (jsonb_typeof(command_value->'source_interpretation') IN ('object','null')) IS NOT TRUE
    OR (payload_value->'source_interpretation') IS DISTINCT FROM (command_value->'source_interpretation')
    OR jsonb_typeof(decisions) IS DISTINCT FROM 'array'
    OR jsonb_typeof(payload_decisions) IS DISTINCT FROM 'array'
    OR (payload_value->'matching_status') IS DISTINCT FROM '"reviewed_separately"'::jsonb
    OR (payload_value->'analysis_status') IS DISTINCT FROM '"not_evaluated"'::jsonb THEN
    RAISE EXCEPTION 'assignment_sales_import_invalid_review_projection' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(decisions) > 100
    OR jsonb_array_length(payload_decisions) <> jsonb_array_length(decisions) THEN
    RAISE EXCEPTION 'assignment_sales_import_invalid_review_projection' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT d.value, d.ordinality
      FROM jsonb_array_elements(decisions) WITH ORDINALITY d(value,ordinality)
  LOOP
    decision_value := item.value;
    payload_decision := payload_decisions->(item.ordinality::integer - 1);
    -- Reject malformed identities before the indexed typed receipt lookup.
    IF jsonb_typeof(decision_value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(payload_decision) IS DISTINCT FROM 'object'
      OR jsonb_typeof(decision_value->'source_row_number') IS DISTINCT FROM 'number'
      OR ((decision_value->>'source_row_number') ~ '^[1-9][0-9]{0,4}$') IS NOT TRUE
      OR jsonb_typeof(decision_value->'receipt_id') IS DISTINCT FROM 'string'
      OR ((decision_value->>'receipt_id') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') IS NOT TRUE
      OR (payload_decision - ARRAY['record_data','match_evidence']::text[]) IS DISTINCT FROM decision_value
      OR (jsonb_typeof(payload_decision->'match_evidence') IN ('object','null')) IS NOT TRUE THEN
      RAISE EXCEPTION 'assignment_sales_import_invalid_review_projection' USING ERRCODE = '23514';
    END IF;
    SELECT record_data INTO stored_record FROM app.assignment_sales_import_rows r
      WHERE r.batch_id=NEW.batch_id
        AND r.source_row_number=(decision_value->>'source_row_number')::integer
        AND r.receipt_id=(decision_value->>'receipt_id')::uuid;
    IF NOT FOUND OR stored_record IS DISTINCT FROM (payload_decision->'record_data') THEN
      RAISE EXCEPTION 'assignment_sales_import_invalid_review_projection' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assignment_sales_review_append BEFORE INSERT ON app.assignment_sales_import_reviews
  FOR EACH ROW EXECUTE FUNCTION app.guard_assignment_sales_review_append();

CREATE FUNCTION app.project_assignment_sales_review_rows()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  INSERT INTO app.assignment_sales_import_review_rows
    (batch_id,review_id,revision,source_row_number,receipt_id,decision)
    SELECT NEW.batch_id,NEW.review_id,NEW.revision,(d->>'source_row_number')::integer,(d->>'receipt_id')::uuid,d
      FROM jsonb_array_elements(NEW.command_json::jsonb->'row_decisions') d;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assignment_sales_review_projection AFTER INSERT ON app.assignment_sales_import_reviews
  FOR EACH ROW EXECUTE FUNCTION app.project_assignment_sales_review_rows();

CREATE FUNCTION app.guard_assignment_sales_review_projection()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.assignment_sales_import_rows r
      WHERE r.batch_id=NEW.batch_id AND r.source_row_number=NEW.source_row_number AND r.receipt_id=NEW.receipt_id)
    OR NOT EXISTS (SELECT 1 FROM app.assignment_sales_import_reviews r
      WHERE r.batch_id=NEW.batch_id AND r.review_id=NEW.review_id AND r.revision=NEW.revision
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.command_json::jsonb->'row_decisions') d(value)
          WHERE d.value=NEW.decision
            AND (d.value->'source_row_number') IS NOT DISTINCT FROM to_jsonb(NEW.source_row_number)
            AND (d.value->'receipt_id') IS NOT DISTINCT FROM to_jsonb(NEW.receipt_id::text))) THEN
    RAISE EXCEPTION 'assignment_sales_import_invalid_review_projection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assignment_sales_review_projection_guard BEFORE INSERT ON app.assignment_sales_import_review_rows
  FOR EACH ROW EXECUTE FUNCTION app.guard_assignment_sales_review_projection();
CREATE TRIGGER assignment_sales_import_reviews_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON app.assignment_sales_import_reviews FOR EACH STATEMENT EXECUTE FUNCTION app.reject_assignment_sales_import_mutation();
CREATE TRIGGER assignment_sales_import_review_rows_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON app.assignment_sales_import_review_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_assignment_sales_import_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.assignment_sales_import_reviews FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.assignment_sales_import_review_rows FROM PUBLIC;
