-- UNREGISTERED birth-only original-resolution storage. This is not exact18,
-- source progress, economic eligibility or permission to disclose evidence.
-- The real original owner alone derives the candidate after all ending fences.
-- These native guards bind its representation to actual retained17/FIRST; they
-- do not replace original reconciliation. Every durable COMMIT still refuses.
CREATE TABLE app.neighborhood_custom_cohort_source_resolution_v3_rows (
 operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_source_resolution_v3_first(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 organization_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence=1),
 candidate_reference jsonb NOT NULL CHECK(octet_length(candidate_reference::text) BETWEEN 100 AND 256),
 issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0)
);
CREATE TABLE app.neighborhood_custom_cohort_source_resolution_v3_heads (
 operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_source_resolution_v3_rows(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 organization_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence=1),
 candidate_reference jsonb NOT NULL CHECK(octet_length(candidate_reference::text) BETWEEN 100 AND 256),
 issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0)
);

CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_first_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE first_source app.neighborhood_custom_cohort_source_resolution_v3_first%ROWTYPE;
 actual app.neighborhood_custom_cohort_source_resolution_v3_first%ROWTYPE;
 body jsonb; expected jsonb; resolution jsonb; actual_reference jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_source_resolution_v3_row_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO first_source FROM app.neighborhood_custom_cohort_source_resolution_v3_first
  WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
 SELECT * INTO actual FROM app.neighborhood_source_resolution_v3_native_first(NEW.operation_id,NEW.organization_id);
 IF actual.operation_id IS NULL OR first_source.operation_id IS NULL OR to_jsonb(first_source) IS DISTINCT FROM to_jsonb(actual)
  OR NEW.issued_transaction_id<>txid_current() OR NEW.issued_transaction_id<>actual.issued_transaction_id OR NEW.sequence<>1 THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_retained_FIRST_required' USING ERRCODE='55000'; END IF;
 SELECT canonical_utf8::jsonb,jsonb_build_object('content_sha256',content_sha256,'canonical_utf8_bytes',canonical_utf8_bytes::text)
  INTO body,actual_reference FROM app.neighborhood_cohort_evidence_blobs
  WHERE organization_id=NEW.organization_id AND content_sha256=NEW.candidate_reference->>'content_sha256'
   AND canonical_utf8_bytes::text=NEW.candidate_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=12000;
 expected:=jsonb_build_object('format','cohort_first_source_resolution_candidate_v3',
  'command_id',actual.command_id,'generation_id',actual.generation_id,
  'transaction_index_reference',actual.index_reference,'transaction_index_sequence',actual.index_sequence,
  'selected_stock_count',actual.index_sequence-1,
  'selected_source',jsonb_build_object('kind',actual.kind,'native_key',actual.native_key,'first_selected_ordinal',actual.first_selected_ordinal),
  'first_seen_selected_entry',jsonb_build_object('account_id',actual.selected_account_id,'ordinal',actual.first_selected_ordinal,
   'partition_ordinal',actual.partition_ordinal,'entry_reference',actual.entry_reference,
   'metric_row_reference',actual.metric_row_reference,'contribution_row_reference',actual.contribution_row_reference),
  'usage','first_whole_original_source_resolution_candidate_only','durable_source_resolution_issued',false,
  'source_cursor_advanced',false,'complete_selected_union',false,'economic_transaction_eligibility','not_established',
  'quarter_statistics','not_established','authority','not_established','report_update','none');
 resolution:=body->'resolution';
 IF NEW.candidate_reference IS DISTINCT FROM actual_reference
  OR (body-'resolution') IS DISTINCT FROM expected OR jsonb_typeof(resolution) IS DISTINCT FROM 'object'
  OR resolution->'resolution_version' IS DISTINCT FROM '3'::jsonb
  OR resolution->>'kind' IS DISTINCT FROM actual.kind OR resolution->>'native_key' IS DISTINCT FROM actual.native_key
  OR resolution->>'basis' IS DISTINCT FROM 'complete_native_package_original_associations_and_reported_observations_only'
  OR resolution->>'authority' IS DISTINCT FROM 'not_established' OR resolution->>'report_update' IS DISTINCT FROM 'none'
  OR resolution->>'economic_transaction_eligibility' IS DISTINCT FROM 'not_established'
  OR resolution->>'quarter_statistics' IS DISTINCT FROM 'not_established'
  OR resolution->'complete_selected_union' IS DISTINCT FROM 'false'::jsonb
  OR resolution->'cross_source_deduplication' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_original_candidate_binding_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_row_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_source_resolution_v3_rows FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_first_row();

CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_first_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retained app.neighborhood_custom_cohort_source_resolution_v3_rows%ROWTYPE;
 actual app.neighborhood_custom_cohort_source_resolution_v3_first%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_source_resolution_v3_head_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO retained FROM app.neighborhood_custom_cohort_source_resolution_v3_rows
  WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
 SELECT * INTO actual FROM app.neighborhood_source_resolution_v3_native_first(NEW.operation_id,NEW.organization_id);
 IF retained.operation_id IS NULL OR actual.operation_id IS NULL OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(retained)
  OR NEW.issued_transaction_id<>txid_current() OR NEW.issued_transaction_id<>actual.issued_transaction_id THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_original_row_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_head_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_source_resolution_v3_heads FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_first_head();
CREATE TRIGGER neighborhood_source_resolution_v3_row_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_source_resolution_v3_rows FOR EACH STATEMENT
 EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_source_resolution_v3_head_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_source_resolution_v3_heads FOR EACH STATEMENT
 EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_row_commit AFTER INSERT
 ON app.neighborhood_custom_cohort_source_resolution_v3_rows DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app.reject_neighborhood_source_resolution_v3_unintegrated();
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_head_commit AFTER INSERT
 ON app.neighborhood_custom_cohort_source_resolution_v3_heads DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app.reject_neighborhood_source_resolution_v3_unintegrated();
