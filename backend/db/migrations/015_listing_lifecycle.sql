-- Additive lifecycle metadata. Existing business columns and signed terms are untouched.
ALTER TABLE campus.tasks ADD COLUMN visibility text NOT NULL DEFAULT 'published' CHECK(visibility IN('published','paused'));
ALTER TABLE campus.tasks ADD COLUMN terms_version integer NOT NULL DEFAULT 1 CHECK(terms_version>0);
ALTER TABLE campus.products ADD COLUMN visibility text NOT NULL DEFAULT 'published' CHECK(visibility IN('published','paused'));
ALTER TABLE campus.products ADD COLUMN terms_version integer NOT NULL DEFAULT 1 CHECK(terms_version>0);
ALTER TABLE campus.products ADD COLUMN stock_revision integer NOT NULL DEFAULT 1 CHECK(stock_revision>0);
CREATE TABLE campus.listing_versions(
 kind text NOT NULL CHECK(kind IN('task','product')), listing_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), terms jsonb NOT NULL,
 provenance text NOT NULL CHECK(provenance IN('legacy_observed_current','published','owner_edit')),
 actor_id uuid REFERENCES campus.users, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(kind,listing_id,version)
);
CREATE TABLE campus.application_listing_terms(
 application_id uuid PRIMARY KEY REFERENCES campus.applications, task_id uuid NOT NULL REFERENCES campus.tasks,
 submitted_version integer NOT NULL, provenance text NOT NULL CHECK(provenance IN('legacy_observed_current','unversioned_submission','exact_submission'))
);
CREATE TABLE campus.application_terms_acknowledgements(
 application_id uuid NOT NULL REFERENCES campus.applications, user_id uuid NOT NULL REFERENCES campus.users,
 version integer NOT NULL CHECK(version>0), acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(application_id,user_id,version)
);
CREATE TABLE campus.application_version_invitations(
 application_id uuid NOT NULL REFERENCES campus.applications, version integer NOT NULL CHECK(version>0),
 task_revision integer NOT NULL, publisher_id uuid NOT NULL REFERENCES campus.users,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(application_id,version,task_revision)
);
CREATE FUNCTION campus.listing_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Listing history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER listing_versions_immutable BEFORE UPDATE OR DELETE ON campus.listing_versions FOR EACH ROW EXECUTE FUNCTION campus.listing_immutable();
CREATE TRIGGER application_listing_terms_immutable BEFORE UPDATE OR DELETE ON campus.application_listing_terms FOR EACH ROW EXECUTE FUNCTION campus.listing_immutable();
CREATE TRIGGER terms_ack_immutable BEFORE UPDATE OR DELETE ON campus.application_terms_acknowledgements FOR EACH ROW EXECUTE FUNCTION campus.listing_immutable();
CREATE TRIGGER version_invitation_immutable BEFORE UPDATE OR DELETE ON campus.application_version_invitations FOR EACH ROW EXECUTE FUNCTION campus.listing_immutable();

CREATE FUNCTION campus.listing_terms(k text,l uuid) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT CASE WHEN k='task' THEN
 (SELECT jsonb_build_object('title',t.title,'category',t.category,'description',t.description,'rewardCents',t.reward_cents,
 'dueDate',to_char(t.due_date,'YYYY-MM-DD'),'milestones',coalesce((SELECT jsonb_agg(jsonb_build_object('title',m.title,
 'amountCents',m.amount_cents,'deliverable',m.deliverable,'acceptanceCriteria',m.acceptance_criteria) ORDER BY position)
 FROM campus.task_milestones m WHERE m.task_id=t.id),'[]'::jsonb)) FROM campus.tasks t WHERE t.id=l)
 ELSE (SELECT jsonb_build_object('title',p.title,'description',p.description,'priceCents',p.price_cents,
 'stock',p.stock,'deliveryMethods',p.delivery_methods,'shippingCents',p.shipping_cents) FROM campus.products p WHERE p.id=l) END
$$;
INSERT INTO campus.listing_versions(kind,listing_id,version,terms,provenance)
 SELECT 'task',id,1,campus.listing_terms('task',id),'legacy_observed_current' FROM campus.tasks
 UNION ALL SELECT 'product',id,1,campus.listing_terms('product',id),'legacy_observed_current' FROM campus.products;
INSERT INTO campus.application_listing_terms(application_id,task_id,submitted_version,provenance)
 SELECT id,task_id,1,'legacy_observed_current' FROM campus.applications;

CREATE FUNCTION campus.can_read_listing(k text,l uuid) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked') AND
 CASE WHEN k='task' THEN EXISTS(SELECT 1 FROM campus.tasks t WHERE t.id=l AND
 (t.owner_id=campus.actor() OR (t.visibility='published' AND campus.is_member()) OR
 EXISTS(SELECT 1 FROM campus.applications a WHERE a.task_id=t.id AND (a.applicant_id=campus.actor() OR campus.in_application(a.id))) OR
 EXISTS(SELECT 1 FROM campus.saved s WHERE s.task_id=t.id AND s.user_id=campus.actor())))
 WHEN k='product' THEN EXISTS(SELECT 1 FROM campus.products p WHERE p.id=l AND
 (p.seller_id=campus.actor() OR (p.visibility='published' AND campus.is_member()) OR
 EXISTS(SELECT 1 FROM campus.orders o WHERE o.product_id=p.id AND campus.actor() IN(o.buyer_id,o.seller_id))) ) ELSE false END
$$;
ALTER TABLE campus.listing_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY listing_versions_read ON campus.listing_versions FOR SELECT TO campus_app USING(campus.can_read_listing(kind,listing_id));
ALTER TABLE campus.application_listing_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus.application_terms_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus.application_version_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_listing_terms_read ON campus.application_listing_terms FOR SELECT TO campus_app USING(EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked') AND (campus.in_application(application_id) OR campus.owns_task(task_id)));
CREATE POLICY terms_ack_read ON campus.application_terms_acknowledgements FOR SELECT TO campus_app USING(EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked') AND (campus.in_application(application_id) OR EXISTS(SELECT 1 FROM campus.applications a WHERE a.id=application_id AND campus.owns_task(a.task_id))));
CREATE POLICY version_invitation_read ON campus.application_version_invitations FOR SELECT TO campus_app USING(EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked') AND (campus.in_application(application_id) OR EXISTS(SELECT 1 FROM campus.applications a WHERE a.id=application_id AND campus.owns_task(a.task_id))));
GRANT SELECT ON campus.listing_versions,campus.application_listing_terms,campus.application_terms_acknowledgements,campus.application_version_invitations TO campus_app;
-- No new raw write privileges. Existing owner writes are routed through the bounded function.
REVOKE UPDATE ON campus.tasks,campus.products FROM campus_app;
ALTER POLICY tasks_read ON campus.tasks USING(EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked') AND (owner_id=campus.actor() OR (visibility='published' AND campus.is_member()) OR campus.can_read_listing('task',id)));
ALTER POLICY products_read ON campus.products USING(EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked') AND (seller_id=campus.actor() OR (visibility='published' AND campus.is_member()) OR campus.can_read_listing('product',id)));
ALTER POLICY task_milestones_read ON campus.task_milestones USING(campus.can_read_listing('task',task_id));

CREATE FUNCTION campus.capture_published_listing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE k text;
BEGIN
 k:=CASE WHEN TG_TABLE_NAME='tasks' THEN 'task' ELSE 'product' END;
 INSERT INTO campus.listing_versions(kind,listing_id,version,terms,provenance,actor_id)
 VALUES(k,NEW.id,1,campus.listing_terms(k,NEW.id),'published',campus.actor()) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
-- Task capture waits until its milestone inserts complete in the publication transaction.
CREATE CONSTRAINT TRIGGER capture_task_publication AFTER INSERT ON campus.tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION campus.capture_published_listing();
CREATE TRIGGER capture_product_publication AFTER INSERT ON campus.products FOR EACH ROW EXECUTE FUNCTION campus.capture_published_listing();
CREATE FUNCTION campus.guard_listing_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.terms_version<>1 OR NEW.revision<>1 OR NEW.visibility<>'published' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF TG_TABLE_NAME='products' THEN
  IF NEW.stock_revision<>1 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_task_publication BEFORE INSERT ON campus.tasks FOR EACH ROW EXECUTE FUNCTION campus.guard_listing_insert();
CREATE TRIGGER guard_product_publication BEFORE INSERT ON campus.products FOR EACH ROW EXECUTE FUNCTION campus.guard_listing_insert();
CREATE FUNCTION campus.guard_task_milestone_edit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF current_user='campus_app' AND EXISTS(SELECT 1 FROM campus.listing_versions WHERE kind='task' AND listing_id=NEW.task_id)
 THEN RAISE EXCEPTION 'immutable_listing_version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_task_milestone_edit BEFORE INSERT ON campus.task_milestones FOR EACH ROW EXECUTE FUNCTION campus.guard_task_milestone_edit();
CREATE FUNCTION campus.track_available_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.stock IS DISTINCT FROM OLD.stock THEN NEW.stock_revision:=OLD.stock_revision+1; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER track_available_stock BEFORE UPDATE ON campus.products FOR EACH ROW EXECUTE FUNCTION campus.track_available_stock();

CREATE FUNCTION campus.require_listing_actor(student boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE s text;
BEGIN
 SELECT account_status INTO s FROM campus.users WHERE id=campus.actor() FOR UPDATE;
 PERFORM user_id FROM campus.affiliations WHERE user_id=campus.actor() FOR SHARE;
 IF s IS NULL OR NOT campus.is_member() THEN RAISE EXCEPTION 'membership_required' USING ERRCODE='P0001'; END IF;
 IF s<>'active' THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001'; END IF;
 IF student AND NOT campus.eligible_student(campus.actor()) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='P0001'; END IF;
END $$;

-- Notification kinds gain immutable version metadata, using the existing private inbox/targets.
ALTER TABLE campus.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE campus.notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN (
'application.received','application.consent_requested','application.consented','application.invited','application.declined','application.withdrawn','application.superseded','application.accepted',
'team.invite','team.accept','team.decline','team.revoke','team.leave','team.remove','team.captain','team.context',
'milestone.submitted','milestone.revision_requested','milestone.accepted','agreement.completed','message.received',
'order.created','order.cancelled','order.expired','order.shipped','order.ready_for_pickup','order.completed','eligibility.approved','eligibility.rejected',
'listing.terms_changed','listing.paused','listing.republished','application.terms_acknowledged','application.version_invited'));
CREATE TABLE campus.listing_notification_context(
 notification_id uuid PRIMARY KEY REFERENCES campus.notifications, listing_kind text NOT NULL CHECK(listing_kind IN('task','product')),
 listing_id uuid NOT NULL, terms_version integer NOT NULL, listing_revision integer NOT NULL
);
ALTER TABLE campus.listing_notification_context ENABLE ROW LEVEL SECURITY;
CREATE POLICY listing_notification_read ON campus.listing_notification_context FOR SELECT TO campus_app USING(EXISTS(SELECT 1 FROM campus.notifications n WHERE n.id=notification_id AND n.recipient_id=campus.actor()));
GRANT SELECT ON campus.listing_notification_context TO campus_app;
CREATE TRIGGER listing_notification_immutable BEFORE UPDATE OR DELETE ON campus.listing_notification_context FOR EACH ROW EXECUTE FUNCTION campus.listing_immutable();
CREATE FUNCTION campus.notify_listing(k text,l uuid,v integer,r integer,action text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a record; recipients uuid[]; event text;
BEGIN
 IF k='task' THEN
  FOR a IN SELECT id,applicant_id FROM campus.applications WHERE task_id=l AND state IN('applied','invited') LOOP
   SELECT array_agg(user_id) INTO recipients FROM (SELECT a.applicant_id AS user_id UNION SELECT user_id FROM campus.application_members WHERE application_id=a.id) x;
   event:='listing:task:'||l||':'||r||':'||a.id;
   PERFORM campus.emit_notification(event,'listing.'||action,'application',a.id,recipients,campus.actor());
   INSERT INTO campus.listing_notification_context SELECT id,k,l,v,r FROM campus.notifications WHERE event_key=event ON CONFLICT DO NOTHING;
  END LOOP;
 ELSE
  FOR a IN SELECT id,buyer_id FROM campus.orders WHERE product_id=l AND state NOT IN('cancelled','expired','completed') LOOP
   event:='listing:product:'||l||':'||r||':'||a.id;
   PERFORM campus.emit_notification(event,'listing.'||action,'order',a.id,ARRAY[a.buyer_id],campus.actor());
   INSERT INTO campus.listing_notification_context SELECT id,k,l,v,r FROM campus.notifications WHERE event_key=event ON CONFLICT DO NOTHING;
  END LOOP;
 END IF;
END $$;

CREATE FUNCTION campus.change_listing(k text,l uuid,op text,expected_revision integer,expected_stock integer,expected_stock_revision integer,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE t campus.tasks; p campus.products; v integer; r integer; vis text; m jsonb; pos integer:=0;
BEGIN
 IF k IS NULL OR k NOT IN('task','product') OR op IS NULL OR op NOT IN('edit','pause','republish') OR expected_revision IS NULL OR expected_revision<1
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 IF k='task' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('task:'||l::text,0));
  SELECT * INTO t FROM campus.tasks WHERE id=l FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF t.owner_id IS DISTINCT FROM campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001'; END IF;
  r:=t.revision; v:=t.terms_version; vis:=t.visibility;
 ELSE
  SELECT * INTO p FROM campus.products WHERE id=l FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF p.seller_id IS DISTINCT FROM campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001'; END IF;
  r:=p.revision; v:=p.terms_version; vis:=p.visibility;
 END IF;
 PERFORM campus.require_listing_actor(false);
 IF r<>expected_revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF op='edit' THEN
  IF body IS NULL OR jsonb_typeof(body)<>'object' OR jsonb_typeof(body->'title') IS DISTINCT FROM 'string' OR length(btrim(body->>'title')) NOT BETWEEN 1 AND 160 OR
   jsonb_typeof(body->'description') IS DISTINCT FROM 'string' OR length(btrim(body->>'description')) NOT BETWEEN 1 AND 10000
  THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
  IF k='task' THEN
   IF body-ARRAY['title','category','description','rewardCents','dueDate','milestones']<>'{}'::jsonb OR
    body->>'category' IS NULL OR body->>'category' NOT IN('Research','Design','Engineering','Writing','Campus','Other') OR
    jsonb_typeof(body->'rewardCents') IS DISTINCT FROM 'number' OR (body->>'rewardCents')::numeric<>trunc((body->>'rewardCents')::numeric) OR
    (body->>'rewardCents')::numeric NOT BETWEEN 1 AND 100000000 OR jsonb_typeof(body->'milestones') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
   IF jsonb_array_length(body->'milestones') NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
   IF body->>'dueDate' IS NOT NULL AND (body->>'dueDate' !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' OR to_char((body->>'dueDate')::date,'YYYY-MM-DD')<>body->>'dueDate') THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
   FOR m IN SELECT value FROM jsonb_array_elements(body->'milestones') LOOP
    IF jsonb_typeof(m)<>'object' OR m-ARRAY['title','amountCents','deliverable','acceptanceCriteria']<>'{}'::jsonb OR
     jsonb_typeof(m->'title') IS DISTINCT FROM 'string' OR length(btrim(m->>'title')) NOT BETWEEN 1 AND 160 OR
     jsonb_typeof(m->'deliverable') IS DISTINCT FROM 'string' OR length(btrim(m->>'deliverable')) NOT BETWEEN 1 AND 10000 OR
     jsonb_typeof(m->'amountCents') IS DISTINCT FROM 'number' OR (m->>'amountCents')::numeric<>trunc((m->>'amountCents')::numeric) OR
     (m->>'amountCents')::numeric NOT BETWEEN 1 AND 100000000 OR
     (m->>'acceptanceCriteria' IS NOT NULL AND (jsonb_typeof(m->'acceptanceCriteria')<>'string' OR length(btrim(m->>'acceptanceCriteria')) NOT BETWEEN 1 AND 10000))
    THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
   END LOOP;
   IF (SELECT sum((value->>'amountCents')::numeric) FROM jsonb_array_elements(body->'milestones'))<>(body->>'rewardCents')::numeric
   THEN RAISE EXCEPTION 'invalid_milestone_budget' USING ERRCODE='P0001'; END IF;
   UPDATE campus.tasks SET title=body->>'title',category=body->>'category',description=body->>'description',reward_cents=(body->>'rewardCents')::integer,
    due_date=(body->>'dueDate')::date,revision=r+1,terms_version=v+1 WHERE id=l;
   DELETE FROM campus.task_milestones WHERE task_id=l;
   FOR m IN SELECT value FROM jsonb_array_elements(body->'milestones') LOOP
    pos:=pos+1;
    INSERT INTO campus.task_milestones(task_id,position,title,amount_cents,deliverable,acceptance_criteria)
    VALUES(l,pos,m->>'title',(m->>'amountCents')::integer,m->>'deliverable',m->>'acceptanceCriteria');
   END LOOP;
  ELSE
   IF body-ARRAY['title','description','priceCents','stock','deliveryMethods','shippingCents']<>'{}'::jsonb OR
    jsonb_typeof(body->'priceCents') IS DISTINCT FROM 'number' OR (body->>'priceCents')::numeric<>trunc((body->>'priceCents')::numeric) OR (body->>'priceCents')::numeric NOT BETWEEN 1 AND 100000000 OR
    jsonb_typeof(body->'stock') IS DISTINCT FROM 'number' OR (body->>'stock')::numeric<>trunc((body->>'stock')::numeric) OR (body->>'stock')::numeric NOT BETWEEN 0 AND 100000 OR
    jsonb_typeof(body->'shippingCents') IS DISTINCT FROM 'number' OR (body->>'shippingCents')::numeric<>trunc((body->>'shippingCents')::numeric) OR (body->>'shippingCents')::numeric NOT BETWEEN 0 AND 10000000 OR
    jsonb_typeof(body->'deliveryMethods') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
   IF jsonb_array_length(body->'deliveryMethods') NOT BETWEEN 1 AND 2 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(body->'deliveryMethods') x WHERE x NOT IN('pickup','shipping')) OR
    (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements_text(body->'deliveryMethods') x)
   THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
   IF expected_stock IS NULL OR expected_stock_revision IS NULL OR expected_stock<>p.stock OR expected_stock_revision<>p.stock_revision
   THEN RAISE EXCEPTION 'stock_changed' USING ERRCODE='P0001'; END IF;
   UPDATE campus.products SET title=body->>'title',description=body->>'description',price_cents=(body->>'priceCents')::integer,
    stock=(body->>'stock')::integer,delivery_methods=ARRAY(SELECT jsonb_array_elements_text(body->'deliveryMethods')),
    shipping_cents=(body->>'shippingCents')::integer,revision=r+1,terms_version=v+1 WHERE id=l;
  END IF;
  v:=v+1;
  INSERT INTO campus.listing_versions(kind,listing_id,version,terms,provenance,actor_id) VALUES(k,l,v,campus.listing_terms(k,l),'owner_edit',campus.actor());
 ELSE
  IF op='republish' AND k='task' AND t.status<>'open' THEN RAISE EXCEPTION 'task_contracted' USING ERRCODE='P0001'; END IF;
  IF (op='pause' AND vis='paused') OR (op='republish' AND vis='published') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
  vis:=CASE WHEN op='pause' THEN 'paused' ELSE 'published' END;
  IF k='task' THEN UPDATE campus.tasks SET visibility=vis,revision=r+1 WHERE id=l;
  ELSE UPDATE campus.products SET visibility=vis,revision=r+1 WHERE id=l; END IF;
 END IF;
 PERFORM campus.notify_listing(k,l,v,r+1,CASE op WHEN 'edit' THEN 'terms_changed' WHEN 'pause' THEN 'paused' ELSE 'republished' END);
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'listing.'||k||'.'||op,l);
 INSERT INTO campus.events(kind,object_id) VALUES('listing.'||k||'.'||op,l);
 RETURN jsonb_build_object('id',l,'kind',k,'operation',op,'revision',r+1,'termsVersion',v,'visibility',vis);
END $$;
-- Root enables this only after Task2 routes/UI are installed. No app-role setter.
CREATE TABLE campus.listing_lifecycle_cutover(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), strict_versions boolean NOT NULL DEFAULT false);
INSERT INTO campus.listing_lifecycle_cutover VALUES(true,false);
ALTER TABLE campus.listing_lifecycle_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus.applications ADD COLUMN submitted_terms_version integer;
ALTER TABLE campus.applications ADD COLUMN submitted_listing_revision integer;
CREATE FUNCTION campus.guard_versioned_application() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE t campus.tasks;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||NEW.task_id::text,0));
 SELECT * INTO t FROM campus.tasks WHERE id=NEW.task_id FOR UPDATE;
 PERFORM campus.require_listing_actor(true);
 IF t.owner_id=NEW.applicant_id THEN RAISE EXCEPTION 'self_application' USING ERRCODE='P0001'; END IF;
 IF t.id IS NULL OR t.visibility<>'published' OR t.status<>'open' THEN RAISE EXCEPTION 'listing_unavailable' USING ERRCODE='P0001'; END IF;
 IF NEW.submitted_terms_version IS NULL THEN
  IF t.terms_version>1 OR (SELECT strict_versions FROM campus.listing_lifecycle_cutover) THEN RAISE EXCEPTION 'terms_review_required' USING ERRCODE='P0001'; END IF;
 ELSIF NEW.submitted_terms_version IS DISTINCT FROM t.terms_version OR NEW.submitted_listing_revision IS DISTINCT FROM t.revision THEN
  RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_versioned_application BEFORE INSERT ON campus.applications FOR EACH ROW EXECUTE FUNCTION campus.guard_versioned_application();
CREATE FUNCTION campus.capture_application_terms() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE v integer;
BEGIN
 SELECT terms_version INTO v FROM campus.tasks WHERE id=NEW.task_id;
 INSERT INTO campus.application_listing_terms VALUES(NEW.id,NEW.task_id,v,CASE WHEN NEW.submitted_terms_version IS NULL THEN 'unversioned_submission' ELSE 'exact_submission' END);
 IF NEW.submitted_terms_version IS NOT NULL THEN
  INSERT INTO campus.application_terms_acknowledgements(application_id,user_id,version) VALUES(NEW.id,NEW.applicant_id,v);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_application_terms AFTER INSERT ON campus.applications FOR EACH ROW EXECUTE FUNCTION campus.capture_application_terms();
CREATE FUNCTION campus.version_review_required(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT t.terms_version>1 OR b.provenance='exact_submission' OR (SELECT strict_versions FROM campus.listing_lifecycle_cutover)
 FROM campus.applications x JOIN campus.tasks t ON t.id=x.task_id JOIN campus.application_listing_terms b ON b.application_id=x.id WHERE x.id=a
$$;
CREATE FUNCTION campus.require_current_terms(a uuid,require_invitation boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE t campus.tasks; x campus.applications;
BEGIN
 SELECT * INTO x FROM campus.applications WHERE id=a;
 SELECT * INTO t FROM campus.tasks WHERE id=x.task_id;
 IF t.visibility<>'published' THEN RAISE EXCEPTION 'listing_unavailable' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a) OR
 EXISTS(SELECT 1 FROM (SELECT x.applicant_id AS user_id UNION SELECT user_id FROM campus.application_members WHERE application_id=a) people
 WHERE NOT EXISTS(SELECT 1 FROM campus.application_terms_acknowledgements ack WHERE ack.application_id=a AND ack.user_id=people.user_id AND ack.version=t.terms_version))
 THEN RAISE EXCEPTION 'terms_review_required' USING ERRCODE='P0001'; END IF;
 IF require_invitation AND NOT EXISTS(SELECT 1 FROM campus.application_version_invitations WHERE application_id=a AND version=t.terms_version AND task_revision=t.revision AND publisher_id=t.owner_id)
 THEN RAISE EXCEPTION 'fresh_invitation_required' USING ERRCODE='P0001'; END IF;
END $$;
CREATE FUNCTION campus.guard_invitation_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF NEW.state='invited' THEN
  IF campus.version_review_required(NEW.id) THEN PERFORM campus.require_current_terms(NEW.id,true);
  ELSIF EXISTS(SELECT 1 FROM campus.tasks WHERE id=NEW.task_id AND visibility='paused') THEN RAISE EXCEPTION 'listing_unavailable' USING ERRCODE='P0001'; END IF;
 END IF;
 IF (NEW.submitted_terms_version,NEW.submitted_listing_revision) IS DISTINCT FROM (OLD.submitted_terms_version,OLD.submitted_listing_revision)
 THEN RAISE EXCEPTION 'Application version binding is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_invitation_version BEFORE UPDATE ON campus.applications FOR EACH ROW EXECUTE FUNCTION campus.guard_invitation_version();
CREATE FUNCTION campus.guard_agreement_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF campus.version_review_required(NEW.application_id) THEN PERFORM campus.require_current_terms(NEW.application_id,true);
 ELSIF EXISTS(SELECT 1 FROM campus.tasks WHERE id=NEW.task_id AND visibility='paused') THEN RAISE EXCEPTION 'listing_unavailable' USING ERRCODE='P0001'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER guard_agreement_version BEFORE INSERT ON campus.agreements FOR EACH ROW EXECUTE FUNCTION campus.guard_agreement_version();
CREATE FUNCTION campus.guard_product_purchase() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE v text;
BEGIN
 SELECT visibility INTO v FROM campus.products WHERE id=NEW.product_id FOR SHARE;
 IF v IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'listing_unavailable' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_product_quote BEFORE INSERT ON campus.quotes FOR EACH ROW EXECUTE FUNCTION campus.guard_product_purchase();
CREATE TRIGGER guard_product_order BEFORE INSERT ON campus.orders FOR EACH ROW EXECUTE FUNCTION campus.guard_product_purchase();

CREATE FUNCTION campus.review_application_terms(aid uuid,v integer,expected_revision integer,op text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.applications; t campus.tasks; recipients uuid[]; event text; g uuid; accepting_members uuid[];
BEGIN
 IF v IS NULL OR v<1 OR expected_revision IS NULL OR expected_revision<1 OR op IS NULL OR op NOT IN('acknowledge','invite','accept')
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 SELECT * INTO a FROM campus.applications WHERE id=aid;
 IF a.id IS NULL OR NOT(campus.in_application(a.id) OR campus.owns_task(a.task_id)) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||a.task_id::text,0));
 SELECT * INTO t FROM campus.tasks WHERE id=a.task_id FOR UPDATE;
 SELECT * INTO a FROM campus.applications WHERE id=aid FOR UPDATE;
 IF op='accept' THEN
  IF a.applicant_id<>campus.actor() THEN RAISE EXCEPTION 'not_applicant' USING ERRCODE='P0001'; END IF;
  -- Match accept_task_invitation: acquire the complete frozen user set in UUID
  -- order, then its affiliations, BEFORE require_listing_actor locks the actor.
  -- Include the actor even for a malformed legacy roster; no later actor lock
  -- may introduce a different order. The delegated routine still validates it.
  SELECT array_agg(user_id ORDER BY user_id) INTO accepting_members FROM (
   SELECT user_id FROM campus.application_members WHERE application_id=a.id
   UNION SELECT campus.actor() AS user_id
  ) participants;
  PERFORM id FROM campus.users WHERE id=ANY(accepting_members) ORDER BY id FOR UPDATE;
  PERFORM user_id FROM campus.affiliations WHERE user_id=ANY(accepting_members) ORDER BY user_id FOR SHARE;
 END IF;
 PERFORM campus.require_listing_actor(op<>'invite');
 IF op='accept' AND a.applicant_id=campus.actor() THEN
  SELECT id INTO g FROM campus.agreements WHERE application_id=a.id;
  IF g IS NOT NULL THEN RETURN jsonb_build_object('id',a.id,'agreementId',g,'operation',op,'originalAgreement',true); END IF;
 END IF;
 IF t.revision<>expected_revision OR t.terms_version<>v THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF a.state NOT IN('applied','invited') OR t.status<>'open' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 IF op='acknowledge' THEN
  IF NOT EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a.id AND user_id=campus.actor()) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  INSERT INTO campus.application_terms_acknowledgements(application_id,user_id,version) VALUES(a.id,campus.actor(),v) ON CONFLICT DO NOTHING;
  -- This is an explicit member action; it also fulfills the pre-existing membership consent requirement.
  UPDATE campus.application_members SET confirmed=true WHERE application_id=a.id AND user_id=campus.actor() AND NOT confirmed;
  event:='terms-ack:'||a.id||':'||v||':'||campus.actor();
  PERFORM campus.emit_notification(event,'application.terms_acknowledged','application',a.id,ARRAY[a.applicant_id,t.owner_id],campus.actor());
 ELSIF op='invite' THEN
  IF t.owner_id<>campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001'; END IF;
  PERFORM campus.require_current_terms(a.id,false);
  IF EXISTS(SELECT 1 FROM campus.application_members WHERE application_id=a.id AND NOT campus.eligible_student(user_id)) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='P0001'; END IF;
  INSERT INTO campus.application_version_invitations(application_id,version,task_revision,publisher_id) VALUES(a.id,v,t.revision,campus.actor()) ON CONFLICT DO NOTHING;
  UPDATE campus.applications SET state='invited' WHERE id=a.id;
  SELECT array_agg(user_id) INTO recipients FROM campus.application_members WHERE application_id=a.id;
  event:='version-invite:'||a.id||':'||v||':'||t.revision;
  PERFORM campus.emit_notification(event,'application.version_invited','application',a.id,recipients,campus.actor());
 ELSE
  IF a.applicant_id<>campus.actor() THEN RAISE EXCEPTION 'not_applicant' USING ERRCODE='P0001'; END IF;
  PERFORM campus.require_current_terms(a.id,true);
  g:=campus.accept_task_invitation(a.id);
 END IF;
 IF event IS NOT NULL THEN INSERT INTO campus.listing_notification_context SELECT id,'task',t.id,v,t.revision FROM campus.notifications WHERE event_key=event ON CONFLICT DO NOTHING; END IF;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'application.terms.'||op,a.id);
 INSERT INTO campus.events(kind,object_id) VALUES('application.terms.'||op,a.id);
 RETURN jsonb_build_object('id',a.id,'operation',op,'termsVersion',v,'revision',t.revision,'agreementId',g);
END $$;

-- Narrow grants only. Private snapshot/validation helpers cannot be used as RLS bypasses.
REVOKE ALL ON FUNCTION campus.listing_immutable(),campus.listing_terms(text,uuid),campus.can_read_listing(text,uuid),
 campus.capture_published_listing(),campus.guard_listing_insert(),campus.guard_task_milestone_edit(),campus.track_available_stock(),campus.require_listing_actor(boolean),
 campus.notify_listing(text,uuid,integer,integer,text),campus.change_listing(text,uuid,text,integer,integer,integer,jsonb),
 campus.guard_versioned_application(),campus.capture_application_terms(),campus.version_review_required(uuid),campus.require_current_terms(uuid,boolean),
 campus.guard_invitation_version(),campus.guard_agreement_version(),campus.guard_product_purchase(),campus.review_application_terms(uuid,integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.can_read_listing(text,uuid),campus.change_listing(text,uuid,text,integer,integer,integer,jsonb),campus.review_application_terms(uuid,integer,integer,text) TO campus_app;

-- App roles have no UPDATE privilege, so row locking is itself a narrow authorized capability.
CREATE FUNCTION campus.lock_owned_listing(k text,l uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE t campus.tasks; p campus.products;
BEGIN
 IF k='task' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('task:'||l::text,0));
  SELECT * INTO t FROM campus.tasks WHERE id=l FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF t.owner_id IS DISTINCT FROM campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001'; END IF;
  PERFORM campus.require_listing_actor(false); RETURN to_jsonb(t);
 ELSIF k='product' THEN
  SELECT * INTO p FROM campus.products WHERE id=l FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF p.seller_id IS DISTINCT FROM campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001'; END IF;
  PERFORM campus.require_listing_actor(false); RETURN to_jsonb(p);
 ELSE RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
END $$;
REVOKE ALL ON FUNCTION campus.lock_owned_listing(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.lock_owned_listing(text,uuid) TO campus_app;
