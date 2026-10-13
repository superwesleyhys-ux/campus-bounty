-- Display labels are scoped to an existing collaboration; never expose identities/emails.
CREATE FUNCTION campus.team_people(t uuid) RETURNS TABLE(user_id uuid,display_name text,state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$
 SELECT m.user_id,u.display_name,m.state FROM campus.team_members m JOIN campus.users u ON u.id=m.user_id
 WHERE m.team_id=t AND campus.on_team(t)
$$;
CREATE FUNCTION campus.application_people(a uuid) RETURNS TABLE(user_id uuid,display_name text,confirmed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$
 SELECT m.user_id,u.display_name,m.confirmed FROM campus.application_members m JOIN campus.users u ON u.id=m.user_id
 WHERE m.application_id=a AND (campus.in_application(a) OR EXISTS(SELECT 1 FROM campus.applications p WHERE p.id=a AND campus.owns_task(p.task_id)))
$$;
CREATE FUNCTION campus.team_candidate(t uuid,u uuid) RETURNS TABLE(user_id uuid,display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$
 SELECT p.id,p.display_name FROM campus.users p WHERE p.id=u AND campus.owns_team(t)
 AND campus.eligible_student(campus.actor()) AND campus.eligible_student(u)
$$;
REVOKE ALL ON FUNCTION campus.team_people(uuid),campus.application_people(uuid),campus.team_candidate(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.team_people(uuid),campus.application_people(uuid),campus.team_candidate(uuid,uuid) TO campus_app;
