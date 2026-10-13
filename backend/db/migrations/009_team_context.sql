-- Invitation background is current information, never an amendment to a commitment.
-- Keep it separate from teams: terminal members may read their own relationship
-- summary, but neither that summary nor raw SQL may disclose current background.
CREATE TABLE campus.team_contexts (
 team_id uuid PRIMARY KEY REFERENCES campus.teams,
 purpose text NOT NULL DEFAULT '' CHECK(length(purpose)<=1000),
 activities text NOT NULL DEFAULT '' CHECK(length(activities)<=1500),
 time_commitment text NOT NULL DEFAULT '' CHECK(length(time_commitment)<=500),
 project_context text NOT NULL DEFAULT '' CHECK(length(project_context)<=1500)
);
INSERT INTO campus.team_contexts(team_id) SELECT id FROM campus.teams;
ALTER TABLE campus.team_contexts ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_context_read ON campus.team_contexts FOR SELECT TO campus_app
 USING(campus.team_roster_visible(team_id));
GRANT SELECT ON campus.team_contexts TO campus_app;

CREATE TABLE campus.team_context_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES campus.teams,
 actor_id uuid REFERENCES campus.users, revision integer NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN ('backfill','create','update')),
 purpose text NOT NULL, activities text NOT NULL, time_commitment text NOT NULL, project_context text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(team_id,revision)
);
INSERT INTO campus.team_context_events(team_id,revision,action,purpose,activities,time_commitment,project_context)
 SELECT id,revision,'backfill','','','','' FROM campus.teams;
ALTER TABLE campus.team_context_events ENABLE ROW LEVEL SECURITY;
-- No app/auth/worker read grant or policy on history: current membership is not
-- authority to discover private background that predates this invitation.
REVOKE ALL ON campus.team_contexts,campus.team_context_events FROM PUBLIC,campus_auth,campus_worker;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON campus.team_contexts FROM campus_app;
REVOKE ALL ON campus.team_context_events FROM campus_app;
CREATE FUNCTION campus.immutable_team_context_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Team context events are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_team_context_event BEFORE UPDATE OR DELETE ON campus.team_context_events
 FOR EACH ROW EXECUTE FUNCTION campus.immutable_team_context_event();

CREATE FUNCTION campus.normalize_team_context(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE field text; normalized text; result jsonb:='{}'; maximum integer;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(value))<>4 OR
    NOT value ?& ARRAY['purpose','activities','timeCommitment','projectContext']
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 FOREACH field IN ARRAY ARRAY['purpose','activities','timeCommitment','projectContext'] LOOP
   IF jsonb_typeof(value->field) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   normalized:=regexp_replace(value->>field,'^\s+|\s+$','','g');
   maximum:=CASE field WHEN 'purpose' THEN 1000 WHEN 'timeCommitment' THEN 500 ELSE 1500 END;
   IF length(normalized)>maximum OR (field<>'projectContext' AND length(normalized)=0)
   THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
   result:=result||jsonb_build_object(field,normalized);
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION campus.create_team_with_context(team_name text,value jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE t uuid; v jsonb;
BEGIN
 IF value IS NULL THEN v:=jsonb_build_object('purpose','','activities','','timeCommitment','','projectContext','');
 ELSE v:=campus.normalize_team_context(value); END IF;
 t:=campus.create_team(team_name);
 INSERT INTO campus.team_contexts(team_id,purpose,activities,time_commitment,project_context)
 VALUES(t,v->>'purpose',v->>'activities',v->>'timeCommitment',v->>'projectContext');
 INSERT INTO campus.team_context_events(team_id,actor_id,revision,action,purpose,activities,time_commitment,project_context)
 VALUES(t,campus.actor(),1,'create',v->>'purpose',v->>'activities',v->>'timeCommitment',v->>'projectContext');
 RETURN t;
END $$;

CREATE FUNCTION campus.set_team_context(t uuid,expected_revision integer,value jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.teams; prior campus.team_contexts; v jsonb; me uuid:=campus.actor();
BEGIN
 IF expected_revision IS NULL OR expected_revision<1 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('team:'||t::text,0));
 SELECT * INTO g FROM campus.teams WHERE id=t FOR UPDATE;
 IF g.id IS NULL OR NOT EXISTS(SELECT 1 FROM campus.team_members WHERE team_id=t AND user_id=me)
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM id FROM campus.users WHERE id=me FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM campus.users WHERE id=me AND account_status<>'locked')
 THEN RAISE EXCEPTION 'account_locked' USING ERRCODE='42501'; END IF;
 IF g.owner_id<>me THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='42501'; END IF;
 IF g.revision<>expected_revision THEN RAISE EXCEPTION 'team_revision_changed' USING ERRCODE='P0001'; END IF;
 IF g.status<>'active' THEN RAISE EXCEPTION 'team_archived' USING ERRCODE='P0001'; END IF;
 v:=campus.normalize_team_context(value);
 SELECT * INTO prior FROM campus.team_contexts WHERE team_id=t;
 IF prior.team_id IS NOT NULL AND
   (prior.purpose,prior.activities,prior.time_commitment,prior.project_context)=
   (v->>'purpose',v->>'activities',v->>'timeCommitment',v->>'projectContext') THEN RETURN t; END IF;
 INSERT INTO campus.team_contexts(team_id,purpose,activities,time_commitment,project_context)
 VALUES(t,v->>'purpose',v->>'activities',v->>'timeCommitment',v->>'projectContext')
 ON CONFLICT(team_id) DO UPDATE SET purpose=excluded.purpose,activities=excluded.activities,
 time_commitment=excluded.time_commitment,project_context=excluded.project_context;
 UPDATE campus.teams SET revision=revision+1 WHERE id=t;
 INSERT INTO campus.team_context_events(team_id,actor_id,revision,action,purpose,activities,time_commitment,project_context)
 VALUES(t,me,g.revision+1,'update',v->>'purpose',v->>'activities',v->>'timeCommitment',v->>'projectContext');
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(me,'team.context',t);
 INSERT INTO campus.events(kind,object_id) VALUES('team.context',t);
 RETURN t;
END $$;

CREATE FUNCTION campus.require_invitation_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF NEW.state='invited' THEN
   IF TG_OP='INSERT' OR OLD.state IS DISTINCT FROM 'invited' OR OLD.invitation_version IS DISTINCT FROM NEW.invitation_version THEN
     IF NOT EXISTS(SELECT 1 FROM campus.team_contexts WHERE team_id=NEW.team_id
       AND length(btrim(purpose))>0 AND length(btrim(activities))>0 AND length(btrim(time_commitment))>0)
     THEN RAISE EXCEPTION 'team_context_required' USING ERRCODE='P0001'; END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invitation_context_required BEFORE INSERT OR UPDATE ON campus.team_members
 FOR EACH ROW EXECUTE FUNCTION campus.require_invitation_context();
REVOKE ALL ON FUNCTION campus.immutable_team_context_event(),campus.normalize_team_context(jsonb),
 campus.create_team_with_context(text,jsonb),campus.set_team_context(uuid,integer,jsonb),campus.require_invitation_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.create_team_with_context(text,jsonb),campus.set_team_context(uuid,integer,jsonb) TO campus_app;
