CREATE TABLE campus.application_members (
 application_id uuid NOT NULL REFERENCES campus.applications, user_id uuid NOT NULL REFERENCES campus.users,
 confirmed boolean NOT NULL DEFAULT false, PRIMARY KEY(application_id,user_id)
);
CREATE FUNCTION campus.eligible_student(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$
 SELECT EXISTS(SELECT 1 FROM campus.users x JOIN campus.affiliations a ON a.user_id=x.id JOIN campus.domains d ON d.domain=a.domain AND d.institution_id=a.institution_id JOIN campus.institutions i ON i.id=a.institution_id WHERE x.id=u AND x.account_status='active' AND a.can_apply AND a.valid_until>now() AND d.enabled AND i.active)
$$;
CREATE FUNCTION campus.in_application(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a AND user_id=campus.actor()) $$;
CREATE FUNCTION campus.captains_application(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.applications WHERE id=a AND applicant_id=campus.actor()) $$;
ALTER TABLE campus.application_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_members_read ON campus.application_members FOR SELECT TO campus_app USING(campus.in_application(application_id) OR EXISTS(SELECT 1 FROM campus.applications WHERE id=application_id AND campus.owns_task(task_id)));
CREATE POLICY application_members_insert ON campus.application_members FOR INSERT TO campus_app WITH CHECK(campus.captains_application(application_id));
CREATE POLICY application_members_update ON campus.application_members FOR UPDATE TO campus_app USING(user_id=campus.actor());
CREATE POLICY applications_team_read ON campus.applications FOR SELECT TO campus_app USING(campus.in_application(id));
GRANT SELECT,INSERT,UPDATE ON campus.application_members TO campus_app;
REVOKE ALL ON FUNCTION campus.eligible_student(uuid),campus.in_application(uuid),campus.captains_application(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.eligible_student(uuid),campus.in_application(uuid),campus.captains_application(uuid) TO campus_app;

CREATE FUNCTION campus.immutable_submission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Submission versions are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_submission BEFORE UPDATE OR DELETE ON campus.submissions FOR EACH ROW EXECUTE FUNCTION campus.immutable_submission();
CREATE FUNCTION campus.immutable_agreement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.task_id,NEW.application_id,NEW.owner_id,NEW.captain_id,NEW.team_id,NEW.terms) IS DISTINCT FROM (OLD.task_id,OLD.application_id,OLD.owner_id,OLD.captain_id,OLD.team_id,OLD.terms) THEN RAISE EXCEPTION 'Agreement terms are immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER immutable_agreement BEFORE UPDATE ON campus.agreements FOR EACH ROW EXECUTE FUNCTION campus.immutable_agreement();
CREATE FUNCTION campus.immutable_milestone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.agreement_id,NEW.position,NEW.title,NEW.amount_cents,NEW.deliverable) IS DISTINCT FROM (OLD.agreement_id,OLD.position,OLD.title,OLD.amount_cents,OLD.deliverable) THEN RAISE EXCEPTION 'Milestone terms are immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER immutable_milestone BEFORE UPDATE ON campus.milestones FOR EACH ROW EXECUTE FUNCTION campus.immutable_milestone();
CREATE FUNCTION campus.immutable_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.quote_id,NEW.product_id,NEW.buyer_id,NEW.seller_id,NEW.quantity,NEW.total_cents,NEW.delivery_method,NEW.shipping_address,NEW.terms) IS DISTINCT FROM (OLD.quote_id,OLD.product_id,OLD.buyer_id,OLD.seller_id,OLD.quantity,OLD.total_cents,OLD.delivery_method,OLD.shipping_address,OLD.terms) THEN RAISE EXCEPTION 'Order terms are immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER immutable_order BEFORE UPDATE ON campus.orders FOR EACH ROW EXECUTE FUNCTION campus.immutable_order();
CREATE FUNCTION campus.expire_reservations() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus AS $$
 DECLARE r record; affected integer:=0;
 BEGIN
 FOR r IN SELECT id,product_id,quantity FROM campus.orders WHERE state='pending_payment' AND reserved_until<=now() ORDER BY reserved_until FOR UPDATE SKIP LOCKED LIMIT 100 LOOP
  UPDATE campus.products SET stock=stock+r.quantity WHERE id=r.product_id;
  UPDATE campus.orders SET state='expired' WHERE id=r.id;
  INSERT INTO campus.events(kind,object_id) VALUES('order.expired',r.id);
  affected:=affected+1;
 END LOOP;RETURN affected;
 END $$;
REVOKE ALL ON FUNCTION campus.expire_reservations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.expire_reservations() TO campus_worker;
-- INSERT ... RETURNING must authorize the new row directly; STABLE helper queries
-- cannot see rows inserted earlier in the same SQL statement.
ALTER POLICY teams_read ON campus.teams USING(owner_id=campus.actor() OR campus.on_team(id));
ALTER POLICY agreements_read ON campus.agreements USING(owner_id=campus.actor() OR captain_id=campus.actor() OR campus.in_agreement(id));
