-- Review revision is independent of immutable submitted-work version.
ALTER TABLE campus.milestones ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE campus.milestones ADD COLUMN latest_submission_id uuid;
ALTER TABLE campus.milestones ADD COLUMN accepted_submission_id uuid;
ALTER TABLE campus.milestones DROP CONSTRAINT milestones_state_check;
ALTER TABLE campus.milestones ADD CONSTRAINT milestones_state_check
 CHECK(state IN ('pending','submitted','revision_requested','accepted'));
ALTER TABLE campus.submissions ADD CONSTRAINT submission_exact_identity UNIQUE(id,milestone_id,version);
-- This is only a link to an existing exact version, not an invented review,
-- reviewer, decision time, funding event, or historical completion.
UPDATE campus.milestones m SET latest_submission_id=s.id,
 accepted_submission_id=CASE WHEN m.state='accepted' THEN s.id ELSE NULL END
 FROM campus.submissions s WHERE s.milestone_id=m.id AND s.version=m.version;
ALTER TABLE campus.milestones ADD CONSTRAINT latest_submission_exact
 FOREIGN KEY(latest_submission_id,id,version) REFERENCES campus.submissions(id,milestone_id,version);
ALTER TABLE campus.milestones ADD CONSTRAINT accepted_submission_exact
 FOREIGN KEY(accepted_submission_id,id,version) REFERENCES campus.submissions(id,milestone_id,version);
ALTER TABLE campus.milestones ADD CONSTRAINT accepted_submission_state
 CHECK(accepted_submission_id IS NULL OR (state='accepted' AND accepted_submission_id=latest_submission_id));

CREATE TABLE campus.milestone_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), milestone_id uuid NOT NULL REFERENCES campus.milestones,
 submission_id uuid NOT NULL UNIQUE, submission_version integer NOT NULL CHECK(submission_version>0),
 milestone_revision integer NOT NULL CHECK(milestone_revision>0), reviewer_id uuid NOT NULL REFERENCES campus.users,
 decision text NOT NULL CHECK(decision IN ('revision_requested','accepted')),
 feedback text NOT NULL CHECK(length(feedback)<=10000 AND
   ((decision='revision_requested' AND length(btrim(feedback))>0) OR (decision='accepted' AND feedback=''))),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(milestone_id,milestone_revision),
 FOREIGN KEY(submission_id,milestone_id,submission_version) REFERENCES campus.submissions(id,milestone_id,version)
);
ALTER TABLE campus.milestone_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY milestone_reviews_read ON campus.milestone_reviews FOR SELECT TO campus_app USING(campus.in_milestone(milestone_id));
GRANT SELECT ON campus.milestone_reviews TO campus_app;
CREATE FUNCTION campus.immutable_milestone_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Milestone reviews are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_milestone_review BEFORE UPDATE OR DELETE ON campus.milestone_reviews
 FOR EACH ROW EXECUTE FUNCTION campus.immutable_milestone_review();

-- Preserve read access for expired/restricted parties, but never locked users.
CREATE OR REPLACE FUNCTION campus.in_agreement(a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM campus.users u WHERE u.id=campus.actor() AND u.account_status<>'locked') AND
 (EXISTS(SELECT 1 FROM campus.agreements WHERE id=a AND campus.actor() IN(owner_id,captain_id)) OR
 EXISTS(SELECT 1 FROM campus.agreement_members WHERE agreement_id=a AND user_id=campus.actor()))
$$;
ALTER POLICY agreements_read ON campus.agreements USING(campus.in_agreement(id));
-- Frozen participants and stages can only be created by the accepting function.
-- There is deliberately no app-accessible funding or arbitrary state setter.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON campus.agreements,campus.agreement_members,
 campus.milestones,campus.submissions,campus.milestone_reviews FROM campus_app;
REVOKE ALL ON campus.milestone_reviews FROM PUBLIC,campus_auth,campus_worker;

CREATE FUNCTION campus.accept_task_invitation(application_uuid uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.applications; t campus.tasks; agreement_uuid uuid; terms_value jsonb; milestone_terms jsonb; member_ids uuid[];
BEGIN
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid;
 IF a.id IS NULL OR NOT (a.applicant_id=campus.actor() OR campus.in_application(a.id) OR campus.owns_task(a.task_id))
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||a.task_id::text,0));
 SELECT * INTO t FROM campus.tasks WHERE id=a.task_id FOR UPDATE;
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid FOR UPDATE;
 IF a.applicant_id<>campus.actor() THEN RAISE EXCEPTION 'not_captain' USING ERRCODE='42501'; END IF;
 IF NOT campus.eligible_student(campus.actor()) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
 SELECT id INTO agreement_uuid FROM campus.agreements WHERE application_id=application_uuid;
 IF agreement_uuid IS NOT NULL THEN RETURN agreement_uuid; END IF;
 IF a.state='superseded' OR t.status<>'open' THEN RAISE EXCEPTION 'task_contracted' USING ERRCODE='P0001'; END IF;
 IF a.state<>'invited' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 SELECT array_agg(user_id ORDER BY user_id) INTO member_ids FROM campus.application_members WHERE application_id=a.id;
 IF coalesce(cardinality(member_ids),0)=0 OR NOT campus.actor()=ANY(member_ids) OR EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a.id AND NOT confirmed)
 THEN RAISE EXCEPTION 'team_consent_required' USING ERRCODE='P0001'; END IF;
 IF t.owner_id=ANY(member_ids) THEN RAISE EXCEPTION 'self_application' USING ERRCODE='P0001'; END IF;
 PERFORM id FROM campus.users WHERE id=ANY(member_ids) ORDER BY id FOR UPDATE;
 PERFORM user_id FROM campus.affiliations WHERE user_id=ANY(member_ids) ORDER BY user_id FOR SHARE;
 FOREACH agreement_uuid IN ARRAY member_ids LOOP
   IF NOT campus.eligible_student(agreement_uuid) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('position',position,'title',title,'amount_cents',amount_cents,
   'deliverable',deliverable,'acceptance_criteria',acceptance_criteria) ORDER BY position)
 INTO milestone_terms FROM campus.task_milestones WHERE task_id=t.id;
 IF milestone_terms IS NULL OR (SELECT sum(amount_cents) FROM campus.task_milestones WHERE task_id=t.id)<>t.reward_cents
 THEN RAISE EXCEPTION 'invalid_milestone_budget' USING ERRCODE='22023'; END IF;
 terms_value:=jsonb_build_object('taskTitle',t.title,'description',t.description,'rewardCents',t.reward_cents,
 'dueDate',CASE WHEN t.due_date IS NULL THEN NULL ELSE to_char(t.due_date,'YYYY-MM-DD') END,
 'milestones',milestone_terms,'members',to_jsonb(member_ids),'currency','USD');
 INSERT INTO campus.agreements(task_id,application_id,owner_id,captain_id,team_id,terms)
 VALUES(t.id,a.id,t.owner_id,campus.actor(),a.team_id,terms_value) RETURNING id INTO agreement_uuid;
 INSERT INTO campus.agreement_members(agreement_id,user_id) SELECT agreement_uuid,unnest(member_ids);
 INSERT INTO campus.milestones(agreement_id,position,title,amount_cents,deliverable,acceptance_criteria)
 SELECT agreement_uuid,position,title,amount_cents,deliverable,acceptance_criteria FROM campus.task_milestones WHERE task_id=t.id;
 UPDATE campus.tasks SET status='contracted',revision=revision+1 WHERE id=t.id;
 UPDATE campus.applications SET state='accepted' WHERE id=a.id;
 PERFORM campus.supersede_other_applications(a.id);
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'application.accept',agreement_uuid);
 INSERT INTO campus.events(kind,object_id) VALUES('application.accept',agreement_uuid);
 RETURN agreement_uuid;
END $$;

-- Private helper: all mutation functions enter in agreement -> milestone order.
CREATE FUNCTION campus.lock_work_agreement(agreement_uuid uuid,operation text) RETURNS campus.agreements
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreements; status text;
BEGIN
 IF operation IS NULL OR operation NOT IN ('submit','review','complete') THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agreement:'||agreement_uuid::text,0));
 SELECT * INTO a FROM campus.agreements WHERE id=agreement_uuid FOR UPDATE;
 IF a.id IS NULL OR NOT campus.in_agreement(a.id) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 SELECT account_status INTO status FROM campus.users WHERE id=campus.actor() FOR UPDATE;
 PERFORM user_id FROM campus.affiliations WHERE user_id=campus.actor() FOR SHARE;
 IF status IS NULL OR status='locked' THEN RAISE EXCEPTION 'account_locked' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.affiliations f JOIN campus.domains d ON d.domain=f.domain AND d.institution_id=f.institution_id JOIN campus.institutions i ON i.id=f.institution_id WHERE f.user_id=campus.actor() AND f.valid_until>clock_timestamp() AND d.enabled AND i.active) THEN RAISE EXCEPTION 'membership_required' USING ERRCODE='42501'; END IF;
 IF status<>'active' THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='42501'; END IF;
 IF operation='submit' THEN
   IF a.owner_id=campus.actor() OR NOT EXISTS(SELECT 1 FROM campus.agreement_members WHERE agreement_id=a.id AND user_id=campus.actor())
   THEN RAISE EXCEPTION 'not_assignee' USING ERRCODE='42501'; END IF;
 ELSIF a.owner_id<>campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='42501'; END IF;
 RETURN a;
END $$;

CREATE FUNCTION campus.authorize_work_agreement(agreement_uuid uuid,operation text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreements;
BEGIN a:=campus.lock_work_agreement(agreement_uuid,operation); RETURN a.id; END $$;

CREATE FUNCTION campus.submit_milestone_work(milestone_uuid uuid,expected_version integer,expected_revision integer,content_value text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE m campus.milestones; a campus.agreements; agreement_uuid uuid; submission_uuid uuid; cleaned text;
BEGIN
 cleaned:=regexp_replace(content_value,'^\s+|\s+$','','g');
 IF expected_version IS NULL OR expected_version<0 OR expected_revision IS NULL OR expected_revision<1 OR cleaned IS NULL OR length(cleaned) NOT BETWEEN 1 AND 10000
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT agreement_id INTO agreement_uuid FROM campus.milestones WHERE id=milestone_uuid;
 IF agreement_uuid IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 a:=campus.lock_work_agreement(agreement_uuid,'submit');
 SELECT * INTO m FROM campus.milestones WHERE id=milestone_uuid FOR UPDATE;
 IF m.version<>expected_version OR m.revision<>expected_revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF a.state='awaiting_funding' THEN RAISE EXCEPTION 'funding_required' USING ERRCODE='P0001'; END IF;
 IF a.state<>'active' OR m.state='accepted' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 INSERT INTO campus.submissions(milestone_id,author_id,version,content) VALUES(m.id,campus.actor(),m.version+1,cleaned) RETURNING id INTO submission_uuid;
 UPDATE campus.milestones SET version=version+1,revision=revision+1,state='submitted',latest_submission_id=submission_uuid WHERE id=m.id;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'milestone.submit',submission_uuid);
 INSERT INTO campus.events(kind,object_id) VALUES('milestone.submit',submission_uuid);
 RETURN submission_uuid;
END $$;

CREATE FUNCTION campus.review_milestone_work(milestone_uuid uuid,submission_uuid uuid,expected_version integer,expected_revision integer,decision_value text,feedback_value text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE m campus.milestones; a campus.agreements; agreement_uuid uuid; review_uuid uuid; cleaned text;
BEGIN
 cleaned:=regexp_replace(feedback_value,'^\s+|\s+$','','g');
 IF submission_uuid IS NULL OR expected_version IS NULL OR expected_version<1 OR expected_revision IS NULL OR expected_revision<1 OR
 decision_value IS NULL OR decision_value NOT IN ('revision_requested','accepted') OR cleaned IS NULL OR length(cleaned)>10000 OR
 (decision_value='revision_requested' AND length(cleaned)=0) OR (decision_value='accepted' AND cleaned<>'')
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT agreement_id INTO agreement_uuid FROM campus.milestones WHERE id=milestone_uuid;
 IF agreement_uuid IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 a:=campus.lock_work_agreement(agreement_uuid,'review');
 SELECT * INTO m FROM campus.milestones WHERE id=milestone_uuid FOR UPDATE;
 IF m.version<>expected_version OR m.revision<>expected_revision OR m.latest_submission_id IS DISTINCT FROM submission_uuid
 THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF a.state='awaiting_funding' THEN RAISE EXCEPTION 'funding_required' USING ERRCODE='P0001'; END IF;
 IF a.state<>'active' OR m.state<>'submitted' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 INSERT INTO campus.milestone_reviews(milestone_id,submission_id,submission_version,milestone_revision,reviewer_id,decision,feedback)
 VALUES(m.id,submission_uuid,m.version,m.revision+1,campus.actor(),decision_value,cleaned) RETURNING id INTO review_uuid;
 UPDATE campus.milestones SET revision=revision+1,state=decision_value,
 accepted_submission_id=CASE WHEN decision_value='accepted' THEN submission_uuid ELSE NULL END WHERE id=m.id;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'milestone.'||decision_value,review_uuid);
 INSERT INTO campus.events(kind,object_id) VALUES('milestone.'||decision_value,review_uuid);
 IF decision_value='accepted' AND NOT EXISTS(SELECT 1 FROM campus.milestones WHERE agreement_id=a.id AND state<>'accepted') THEN
   UPDATE campus.agreements SET state='completed' WHERE id=a.id;
   INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'agreement.completed',a.id);
   INSERT INTO campus.events(kind,object_id) VALUES('agreement.completed',a.id);
 END IF;
 RETURN review_uuid;
END $$;

CREATE FUNCTION campus.complete_work_agreement(agreement_uuid uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreements;
BEGIN
 a:=campus.lock_work_agreement(agreement_uuid,'complete');
 IF a.state='awaiting_funding' THEN RAISE EXCEPTION 'funding_required' USING ERRCODE='P0001'; END IF;
 IF a.state<>'active' OR NOT EXISTS(SELECT 1 FROM campus.milestones WHERE agreement_id=a.id) OR
 EXISTS(SELECT 1 FROM campus.milestones WHERE agreement_id=a.id AND state<>'accepted')
 THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 UPDATE campus.agreements SET state='completed' WHERE id=a.id;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'agreement.completed',a.id);
 INSERT INTO campus.events(kind,object_id) VALUES('agreement.completed',a.id);
 RETURN a.id;
END $$;
REVOKE ALL ON FUNCTION campus.immutable_milestone_review(),campus.lock_work_agreement(uuid,text),
 campus.accept_task_invitation(uuid),campus.authorize_work_agreement(uuid,text),campus.submit_milestone_work(uuid,integer,integer,text),
 campus.review_milestone_work(uuid,uuid,integer,integer,text,text),campus.complete_work_agreement(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.accept_task_invitation(uuid),campus.authorize_work_agreement(uuid,text),campus.submit_milestone_work(uuid,integer,integer,text),
 campus.review_milestone_work(uuid,uuid,integer,integer,text,text),campus.complete_work_agreement(uuid) TO campus_app;

-- Initial participant lists come only from an accepted team roster. A captain
-- cannot forge another member's consent or append people after invitation.
REVOKE INSERT,UPDATE,DELETE ON campus.application_members FROM campus_app;
CREATE FUNCTION campus.initialize_application_members(application_uuid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.applications; members uuid[];
BEGIN
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid;
 IF a.id IS NULL OR a.applicant_id<>campus.actor() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||a.task_id::text,0));
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid FOR UPDATE;
 IF a.state<>'applied' OR EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a.id)
 THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 IF a.team_id IS NULL THEN members:=ARRAY[campus.actor()]; ELSE
   PERFORM pg_advisory_xact_lock(hashtextextended('team:'||a.team_id::text,0));
   IF NOT EXISTS(SELECT 1 FROM campus.teams WHERE id=a.team_id AND owner_id=campus.actor() AND status='active')
   THEN RAISE EXCEPTION 'not_captain' USING ERRCODE='42501'; END IF;
   SELECT array_agg(user_id ORDER BY user_id) INTO members FROM campus.team_members WHERE team_id=a.team_id AND state='accepted';
 END IF;
 IF NOT campus.actor()=ANY(members) OR EXISTS(SELECT 1 FROM unnest(members) u WHERE NOT campus.eligible_student(u))
 THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM campus.tasks WHERE id=a.task_id AND owner_id=ANY(members))
 THEN RAISE EXCEPTION 'self_application' USING ERRCODE='P0001'; END IF;
 INSERT INTO campus.application_members(application_id,user_id,confirmed) SELECT a.id,u,u=campus.actor() FROM unnest(members) u;
END $$;
CREATE FUNCTION campus.consent_application_member(application_uuid uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.applications;
BEGIN
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid;
 IF a.id IS NULL OR NOT campus.in_application(a.id) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||a.task_id::text,0));
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid FOR UPDATE;
 IF a.state<>'applied' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 IF NOT campus.eligible_student(campus.actor()) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
 UPDATE campus.application_members SET confirmed=true WHERE application_id=a.id AND user_id=campus.actor();
 RETURN campus.actor();
END $$;
REVOKE ALL ON FUNCTION campus.initialize_application_members(uuid),campus.consent_application_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.initialize_application_members(uuid),campus.consent_application_member(uuid) TO campus_app;

-- Application invitations must originate from the publisher, never from an
-- applicant-created state or direct state update trusted by contract creation.
REVOKE UPDATE,DELETE ON campus.applications FROM campus_app;
ALTER POLICY applications_insert ON campus.applications WITH CHECK(
 applicant_id=campus.actor() AND campus.is_member() AND state='applied');
CREATE FUNCTION campus.change_application_state(application_uuid uuid,next_state text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.applications; t campus.tasks;
BEGIN
 IF next_state IS NULL OR next_state NOT IN ('invited','declined','withdrawn')
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid;
 IF a.id IS NULL OR NOT (a.applicant_id=campus.actor() OR campus.owns_task(a.task_id))
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||a.task_id::text,0));
 SELECT * INTO t FROM campus.tasks WHERE id=a.task_id FOR UPDATE;
 SELECT * INTO a FROM campus.applications WHERE id=application_uuid FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM campus.users u JOIN campus.affiliations f ON f.user_id=u.id
 JOIN campus.domains d ON d.domain=f.domain AND d.institution_id=f.institution_id JOIN campus.institutions i ON i.id=f.institution_id
 WHERE u.id=campus.actor() AND u.account_status='active' AND f.valid_until>clock_timestamp() AND d.enabled AND i.active)
 THEN RAISE EXCEPTION 'membership_required' USING ERRCODE='42501'; END IF;
 IF next_state='withdrawn' THEN
   IF a.applicant_id<>campus.actor() THEN RAISE EXCEPTION 'not_applicant' USING ERRCODE='42501'; END IF;
 ELSIF t.owner_id<>campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='42501'; END IF;
 IF a.state=next_state AND next_state<>'invited' THEN RETURN a.id; END IF;
 IF next_state='invited' THEN
   IF a.state<>'applied' OR t.status<>'open' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
   IF NOT EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a.id) OR
    EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a.id AND NOT confirmed)
   THEN RAISE EXCEPTION 'team_consent_required' USING ERRCODE='P0001'; END IF;
   IF EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a.id AND NOT campus.eligible_student(user_id))
   THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
 ELSIF a.state NOT IN ('applied','invited') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 UPDATE campus.applications SET state=next_state WHERE id=a.id;
 RETURN a.id;
END $$;
REVOKE ALL ON FUNCTION campus.change_application_state(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.change_application_state(uuid,text) TO campus_app;
