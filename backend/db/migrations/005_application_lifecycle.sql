ALTER TABLE campus.applications DROP CONSTRAINT applications_state_check;
ALTER TABLE campus.applications ADD CONSTRAINT applications_state_check
 CHECK(state IN ('applied','invited','accepted','declined','withdrawn','superseded'));
ALTER TABLE campus.applications DROP CONSTRAINT applications_task_id_applicant_id_key;
CREATE UNIQUE INDEX applications_one_live_per_applicant
 ON campus.applications(task_id,applicant_id)
 WHERE state IN ('applied','invited','accepted');

-- Older accepted agreements may have left competing applications open. Preserve
-- their proposal/member history while making the existing outcome explicit.
WITH ended AS (
 UPDATE campus.applications a SET state='superseded'
 WHERE a.state IN ('applied','invited') AND EXISTS (
   SELECT 1 FROM campus.agreements g WHERE g.task_id=a.task_id AND g.application_id<>a.id
 ) RETURNING a.id
), recorded AS (
 INSERT INTO campus.events(kind,object_id)
 SELECT 'application.superseded',id FROM ended RETURNING object_id
)
INSERT INTO campus.audit(actor_id,action,object_id)
 SELECT NULL,'application.superseded',object_id FROM recorded;

CREATE FUNCTION campus.guard_application_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.task_id,NEW.applicant_id,NEW.team_id,NEW.proposal,NEW.created_at)
    IS DISTINCT FROM (OLD.task_id,OLD.applicant_id,OLD.team_id,OLD.proposal,OLD.created_at) THEN
   RAISE EXCEPTION 'Application proposals are immutable; submit a new application' USING ERRCODE='23514';
 END IF;
 IF NEW.state<>OLD.state AND NOT (
   (OLD.state='applied' AND NEW.state IN ('invited','declined','withdrawn','superseded')) OR
   (OLD.state='invited' AND NEW.state IN ('accepted','declined','withdrawn','superseded'))
 ) THEN
   RAISE EXCEPTION 'Invalid application state transition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_application_history BEFORE UPDATE ON campus.applications
 FOR EACH ROW EXECUTE FUNCTION campus.guard_application_history();
REVOKE ALL ON FUNCTION campus.guard_application_history() FROM PUBLIC;

-- The accepting applicant cannot read or update competing applicants under RLS.
-- This narrow function performs only the consequence of an existing accepted
-- agreement, returns no private rows, and never grants broader table access.
CREATE FUNCTION campus.supersede_other_applications(accepted_application uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus AS $$
DECLARE task_uuid uuid; ended uuid; affected integer:=0;
BEGIN
 SELECT g.task_id INTO task_uuid FROM campus.agreements g
 JOIN campus.applications a ON a.id=g.application_id
 JOIN campus.tasks t ON t.id=g.task_id
 WHERE g.application_id=accepted_application AND g.captain_id=campus.actor()
   AND a.state='accepted' AND t.status='contracted';
 IF task_uuid IS NULL THEN
   RAISE EXCEPTION 'An accepted agreement owned by this applicant is required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||task_uuid::text,0));
 FOR ended IN UPDATE campus.applications SET state='superseded'
   WHERE task_id=task_uuid AND id<>accepted_application AND state IN ('applied','invited') RETURNING id
 LOOP
   INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'application.superseded',ended);
   INSERT INTO campus.events(kind,object_id) VALUES('application.superseded',ended);
   affected:=affected+1;
 END LOOP;
 RETURN affected;
END $$;
REVOKE ALL ON FUNCTION campus.supersede_other_applications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.supersede_other_applications(uuid) TO campus_app;
