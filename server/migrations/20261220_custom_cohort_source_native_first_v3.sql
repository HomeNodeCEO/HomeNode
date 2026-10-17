-- UNREGISTERED provisional FIRST binding, not source issuance or authority.
-- Only the actual retained17 parent can select a native source and its exact
-- first-seen selected account. Every durable COMMIT still refuses.
CREATE TABLE app.neighborhood_custom_cohort_source_resolution_v3_first (
 operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_source_resolution_v3_parents(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 organization_id uuid NOT NULL,
 generation_id uuid NOT NULL,
 command_id uuid NOT NULL,
 index_reference jsonb NOT NULL CHECK(octet_length(index_reference::text) BETWEEN 100 AND 256),
 index_sequence integer NOT NULL CHECK(index_sequence BETWEEN 2 AND 2000001),
 kind text NOT NULL CHECK(kind IN ('source_record','legacy_sale')),
 native_key text COLLATE "C" NOT NULL CHECK(native_key ~ '^[1-9][0-9]{0,18}$' AND native_key::numeric<=9223372036854775807),
 first_selected_ordinal integer NOT NULL CHECK(first_selected_ordinal BETWEEN 1 AND 2000000 AND first_selected_ordinal<index_sequence),
 selected_account_id text COLLATE "C" NOT NULL CHECK(octet_length(selected_account_id) BETWEEN 1 AND 256),
 partition_ordinal integer NOT NULL CHECK(partition_ordinal BETWEEN 1 AND 2000000),
 entry_reference jsonb NOT NULL CHECK(octet_length(entry_reference::text) BETWEEN 100 AND 256),
 metric_row_reference jsonb NOT NULL CHECK(octet_length(metric_row_reference::text) BETWEEN 100 AND 256),
 contribution_row_reference jsonb NOT NULL CHECK(octet_length(contribution_row_reference::text) BETWEEN 100 AND 256),
 issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0)
);

CREATE FUNCTION app.neighborhood_source_resolution_v3_native_first(op uuid,org uuid)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_first
LANGUAGE sql VOLATILE AS $$
 SELECT p.operation_id,p.organization_id,p.generation_id,p.command_id,p.index_reference,p.index_sequence,
  k.kind,k.native_key,k.first_selected_ordinal,m.account_id,m.partition_ordinal,
  m.entry_reference,m.metric_row_reference,m.contribution_row_reference,p.issued_transaction_id
 FROM app.neighborhood_source_resolution_v3_native_parent(op,org) actual
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_parents p
  ON p.operation_id=actual.operation_id AND to_jsonb(p)=to_jsonb(actual)
 CROSS JOIN LATERAL (
  (SELECT 'source_record'::text AS kind,source_record_id::text AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
   WHERE operation_id=p.operation_id AND organization_id=p.organization_id AND generation_id=p.generation_id
   ORDER BY source_record_id LIMIT 1)
  UNION ALL
  (SELECT 'legacy_sale'::text AS kind,legacy_sale_key AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
   WHERE operation_id=p.operation_id AND organization_id=p.organization_id AND generation_id=p.generation_id
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys existing
     WHERE existing.operation_id=p.operation_id LIMIT 1)
   ORDER BY legacy_sale_key COLLATE "C" LIMIT 1)
 ) k
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_rows m
  ON m.operation_id=p.operation_id AND m.organization_id=p.organization_id AND m.generation_id=p.generation_id
  AND m.ordinal=k.first_selected_ordinal
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_edges edge
  ON edge.operation_id=m.operation_id AND edge.organization_id=m.organization_id AND edge.generation_id=m.generation_id
  AND edge.ordinal=m.ordinal AND edge.account_id=m.account_id AND edge.kind=k.kind AND edge.native_key=k.native_key
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_native_first(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_first() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected app.neighborhood_custom_cohort_source_resolution_v3_first%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_source_resolution_v3_first_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO expected FROM app.neighborhood_source_resolution_v3_native_first(NEW.operation_id,NEW.organization_id);
 IF NOT FOUND OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(expected) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_native_first_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_first_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_source_resolution_v3_first FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_first();
CREATE TRIGGER neighborhood_source_resolution_v3_first_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_source_resolution_v3_first FOR EACH STATEMENT
 EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_first_commit AFTER INSERT
 ON app.neighborhood_custom_cohort_source_resolution_v3_first DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app.reject_neighborhood_source_resolution_v3_unintegrated();
