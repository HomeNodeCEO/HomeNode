-- Shared subject readers retain protection against new material/signature rows:
-- every writer takes the actual assignment parent before changing either set.
CREATE FUNCTION app.custom_cohort_subject_parent_write_fence_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE target bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM id FROM app.assignment_files WHERE id=NEW.assignment_file_id FOR UPDATE NOWAIT;
  ELSE
    FOR target IN SELECT DISTINCT id FROM (VALUES(OLD.assignment_file_id),(NEW.assignment_file_id)) AS targets(id) ORDER BY id LOOP
      PERFORM id FROM app.assignment_files WHERE id=target FOR UPDATE NOWAIT;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custom_cohort_subject_material_parent_fence_v1
BEFORE INSERT OR UPDATE ON app.custom_appraisal_sections
FOR EACH ROW EXECUTE FUNCTION app.custom_cohort_subject_parent_write_fence_v1();

CREATE TRIGGER custom_cohort_subject_signature_parent_fence_v1
BEFORE INSERT ON app.custom_appraisal_signed_snapshots
FOR EACH ROW EXECUTE FUNCTION app.custom_cohort_subject_parent_write_fence_v1();

-- Structural rollout prerequisite only; this establishes no source authority.
CREATE FUNCTION app.custom_cohort_subject_shared_fences_v1_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,app AS $$
  SELECT EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='app.custom_appraisal_sections'::regclass
      AND tgname='custom_cohort_subject_material_parent_fence_v1'
      AND tgfoid='app.custom_cohort_subject_parent_write_fence_v1()'::regprocedure
      AND tgtype=23 AND tgqual IS NULL AND tgattr=''::int2vector AND tgnargs=0
      AND NOT tgisinternal AND NOT tgdeferrable AND tgenabled IN ('O','A'))
    AND EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='app.custom_appraisal_signed_snapshots'::regclass
      AND tgname='custom_cohort_subject_signature_parent_fence_v1'
      AND tgfoid='app.custom_cohort_subject_parent_write_fence_v1()'::regprocedure
      AND tgtype=7 AND tgqual IS NULL AND tgattr=''::int2vector AND tgnargs=0
      AND NOT tgisinternal AND NOT tgdeferrable AND tgenabled IN ('O','A'));
$$;
