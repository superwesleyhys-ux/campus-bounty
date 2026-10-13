-- Current membership is a projection; immutable events retain every invitation cycle.
ALTER TABLE campus.teams ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'));
ALTER TABLE campus.teams ADD COLUMN archived_at timestamptz;
ALTER TABLE campus.teams ADD CONSTRAINT team_archive_consistent CHECK((status='active' AND archived_at IS NULL) OR (status='archived' AND archived_at IS NOT NULL));
ALTER TABLE campus.team_members DROP CONSTRAINT team_members_state_check;
ALTER TABLE campus.team_members ADD CONSTRAINT team_members_state_check CHECK(state IN ('invited','accepted','declined','revoked','left','removed'));
ALTER TABLE campus.team_members ADD COLUMN invitation_version integer NOT NULL DEFAULT 1 CHECK(invitation_version>0);
CREATE TABLE campus.team_membership_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES campus.teams,
 user_id uuid NOT NULL REFERENCES campus.users, actor_id uuid REFERENCES campus.users,
 invitation_version integer NOT NULL CHECK(invitation_version>0), revision integer NOT NULL,
 action text NOT NULL CHECK(action IN ('backfill','create','invite','accept','decline','revoke','leave','remove','captain','archive')),
 state text NOT NULL CHECK(state IN ('invited','accepted','declined','revoked','left','removed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX team_membership_history ON campus.team_membership_events(team_id,user_id,created_at,id);
INSERT INTO campus.team_membership_events(team_id,user_id,invitation_version,revision,action,state)
 SELECT m.team_id,m.user_id,m.invitation_version,t.revision,'backfill',m.state FROM campus.team_members m JOIN campus.teams t ON t.id=m.team_id;
ALTER TABLE campus.team_membership_events ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION campus.immutable_team_membership_event() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Team membership events are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_team_membership_event BEFORE UPDATE OR DELETE ON campus.team_membership_events
 FOR EACH ROW EXECUTE FUNCTION campus.immutable_team_membership_event();
REVOKE ALL ON FUNCTION campus.immutable_team_membership_event() FROM PUBLIC;

CREATE FUNCTION campus.team_roster_visible(t uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM campus.users u JOIN campus.team_members m ON m.user_id=u.id
 WHERE u.id=campus.actor() AND u.account_status<>'locked' AND m.team_id=t AND m.state IN ('invited','accepted'))
$$;
CREATE OR REPLACE FUNCTION campus.on_team(t uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT campus.team_roster_visible(t)
$$;
-- Terminal members cannot select an owner's current identity through the base table.
ALTER POLICY teams_read ON campus.teams USING(campus.team_roster_visible(id));
ALTER POLICY members_read ON campus.team_members USING(
 EXISTS(SELECT 1 FROM campus.users u WHERE u.id=campus.actor() AND u.account_status<>'locked')
 AND (user_id=campus.actor() OR campus.team_roster_visible(team_id)));
CREATE POLICY membership_events_read ON campus.team_membership_events FOR SELECT TO campus_app USING(
 EXISTS(SELECT 1 FROM campus.users u WHERE u.id=campus.actor() AND u.account_status<>'locked')
 AND (user_id=campus.actor() OR campus.team_roster_visible(team_id)));
GRANT SELECT ON campus.team_membership_events TO campus_app;
REVOKE INSERT,UPDATE,DELETE ON campus.teams,campus.team_members,campus.team_membership_events FROM campus_app;

CREATE FUNCTION campus.teams_visible() RETURNS TABLE(
 id uuid,name text,owner_id uuid,revision integer,status text,archived_at timestamptz,own_state text,can_view_roster boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT t.id,t.name,CASE WHEN m.state IN ('invited','accepted') THEN t.owner_id ELSE NULL END,
 t.revision,t.status,t.archived_at,m.state,m.state IN ('invited','accepted')
 FROM campus.teams t JOIN campus.team_members m ON m.team_id=t.id AND m.user_id=campus.actor()
 JOIN campus.users u ON u.id=m.user_id WHERE u.account_status<>'locked'
$$;
DROP FUNCTION campus.team_people(uuid);
CREATE FUNCTION campus.team_people(t uuid) RETURNS TABLE(user_id uuid,display_name text,state text,can_captain boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT m.user_id,u.display_name,m.state,
 g.owner_id=campus.actor() AND g.status='active' AND m.user_id<>g.owner_id AND m.state='accepted' AND campus.eligible_student(m.user_id)
 FROM campus.team_members m JOIN campus.users u ON u.id=m.user_id JOIN campus.teams g ON g.id=m.team_id
 WHERE m.team_id=t AND EXISTS(SELECT 1 FROM campus.users me WHERE me.id=campus.actor() AND me.account_status<>'locked')
 AND (m.user_id=campus.actor() OR campus.team_roster_visible(t))
$$;
CREATE OR REPLACE FUNCTION campus.team_candidate(t uuid,u uuid) RETURNS TABLE(user_id uuid,display_name text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT p.id,p.display_name FROM campus.users p JOIN campus.teams g ON g.id=t
 WHERE p.id=u AND g.owner_id=campus.actor() AND g.status='active'
 AND campus.eligible_student(campus.actor()) AND campus.eligible_student(u)
$$;

CREATE FUNCTION campus.create_team(team_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE team_id uuid;
BEGIN
 IF team_name IS NULL OR length(btrim(team_name)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM id FROM campus.users WHERE id=campus.actor() FOR UPDATE;
 PERFORM user_id FROM campus.affiliations WHERE user_id=campus.actor() FOR SHARE;
 IF NOT campus.eligible_student(campus.actor()) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
 INSERT INTO campus.teams(owner_id,name) VALUES(campus.actor(),btrim(team_name)) RETURNING id INTO team_id;
 INSERT INTO campus.team_members(team_id,user_id,state) VALUES(team_id,campus.actor(),'accepted');
 INSERT INTO campus.team_membership_events(team_id,user_id,actor_id,invitation_version,revision,action,state)
 VALUES(team_id,campus.actor(),campus.actor(),1,1,'create','accepted');
 RETURN team_id;
END $$;

CREATE FUNCTION campus.change_team(t uuid,operation text,target uuid,expected_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.teams; m campus.team_members; next_state text; cycle integer; me uuid := campus.actor();
BEGIN
 IF expected_revision IS NULL OR expected_revision<1 OR operation IS NULL OR operation NOT IN ('invite','accept','decline','revoke','leave','remove','captain','archive')
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('team:'||t::text,0));
 SELECT * INTO g FROM campus.teams WHERE id=t FOR UPDATE;
 IF g.id IS NULL OR NOT EXISTS(SELECT 1 FROM campus.team_members WHERE team_id=t AND user_id=me)
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF operation IN ('accept','decline','leave','archive') THEN
   IF target IS DISTINCT FROM me THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 ELSIF target IS NULL THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM id FROM campus.users WHERE id IN (me,target) ORDER BY id FOR UPDATE;
 PERFORM user_id FROM campus.affiliations WHERE user_id IN (me,target) ORDER BY user_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM campus.users WHERE id=me AND account_status<>'locked')
 THEN RAISE EXCEPTION 'account_locked' USING ERRCODE='42501'; END IF;
 IF operation IN ('invite','revoke','remove','captain','archive') AND g.owner_id<>me
 THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='42501'; END IF;
 IF g.revision<>expected_revision THEN RAISE EXCEPTION 'team_revision_changed' USING ERRCODE='P0001'; END IF;
 IF g.status<>'active' THEN RAISE EXCEPTION 'team_archived' USING ERRCODE='P0001'; END IF;
 IF operation IN ('invite','accept') AND NOT campus.eligible_student(me)
 THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO m FROM campus.team_members WHERE team_id=t AND user_id=target;
 cycle:=coalesce(m.invitation_version,1);
 IF operation='invite' THEN
   IF NOT campus.eligible_student(target) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
   IF m.state IN ('invited','accepted') THEN RAISE EXCEPTION 'membership_state_changed' USING ERRCODE='P0001'; END IF;
   next_state:='invited';
   IF m.user_id IS NOT NULL THEN cycle:=cycle+1; END IF;
 ELSIF operation IN ('accept','decline','revoke') THEN
   IF m.state IS DISTINCT FROM 'invited' THEN RAISE EXCEPTION 'membership_state_changed' USING ERRCODE='P0001'; END IF;
   next_state:=CASE operation WHEN 'accept' THEN 'accepted' WHEN 'decline' THEN 'declined' ELSE 'revoked' END;
 ELSIF operation IN ('leave','remove') THEN
   IF target=g.owner_id THEN RAISE EXCEPTION 'captain_transfer_required' USING ERRCODE='P0001'; END IF;
   IF m.state IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'membership_state_changed' USING ERRCODE='P0001'; END IF;
   next_state:=CASE operation WHEN 'leave' THEN 'left' ELSE 'removed' END;
 ELSIF operation='captain' THEN
   IF target=me OR m.state IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'membership_state_changed' USING ERRCODE='P0001'; END IF;
   IF NOT campus.eligible_student(target) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='42501'; END IF;
   UPDATE campus.teams SET owner_id=target WHERE id=t;
   next_state:=m.state;
 ELSE
   IF EXISTS(SELECT 1 FROM campus.team_members WHERE team_id=t AND user_id<>me AND state IN ('accepted','invited'))
   THEN RAISE EXCEPTION 'team_not_empty' USING ERRCODE='P0001'; END IF;
   UPDATE campus.teams SET status='archived',archived_at=clock_timestamp() WHERE id=t;
   next_state:=m.state;
 END IF;
 IF operation NOT IN ('captain','archive') THEN
   INSERT INTO campus.team_members(team_id,user_id,state,invitation_version) VALUES(t,target,next_state,cycle)
   ON CONFLICT(team_id,user_id) DO UPDATE SET state=excluded.state,invitation_version=excluded.invitation_version;
 END IF;
 UPDATE campus.teams SET revision=revision+1 WHERE id=t;
 INSERT INTO campus.team_membership_events(team_id,user_id,actor_id,invitation_version,revision,action,state)
 VALUES(t,target,me,cycle,g.revision+1,operation,next_state);
 RETURN t;
END $$;
REVOKE ALL ON FUNCTION campus.team_roster_visible(uuid),campus.teams_visible(),campus.team_people(uuid),campus.create_team(text),campus.change_team(uuid,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.team_roster_visible(uuid),campus.teams_visible(),campus.team_people(uuid),campus.create_team(text),campus.change_team(uuid,text,uuid,integer) TO campus_app;
