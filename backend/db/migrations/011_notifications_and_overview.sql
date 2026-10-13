-- Recipient-scoped durable inbox. No backfill and no generic audit/event consumer.
CREATE TABLE campus.notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient_id uuid NOT NULL REFERENCES campus.users,
 event_key text NOT NULL CHECK(length(event_key)<=200),
 channel text NOT NULL DEFAULT 'in_app' CHECK(channel='in_app'),
 kind text NOT NULL CHECK(kind IN (
  'application.received','application.consent_requested','application.consented',
  'application.invited','application.declined','application.withdrawn','application.superseded','application.accepted',
  'team.invite','team.accept','team.decline','team.revoke','team.leave','team.remove','team.captain','team.context',
  'milestone.submitted','milestone.revision_requested','milestone.accepted','agreement.completed','message.received',
  'order.created','order.cancelled','order.expired','order.shipped','order.ready_for_pickup','order.completed',
  'eligibility.approved','eligibility.rejected')),
 template_version integer NOT NULL DEFAULT 1 CHECK(template_version=1),
 target_type text NOT NULL CHECK(target_type IN ('application','agreement','order','team','eligibility')),
 target_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 UNIQUE(event_key,recipient_id,channel)
);
CREATE INDEX notification_inbox ON campus.notifications(recipient_id,created_at DESC,id DESC);
CREATE INDEX notification_unread ON campus.notifications(recipient_id,created_at DESC,id DESC) WHERE read_at IS NULL;
ALTER TABLE campus.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_read ON campus.notifications FOR SELECT TO campus_app USING(
 recipient_id=campus.actor() AND EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked'));
GRANT SELECT ON campus.notifications TO campus_app;
REVOKE ALL ON campus.notifications FROM PUBLIC,campus_auth,campus_worker;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON campus.notifications FROM campus_app;

CREATE FUNCTION campus.guard_notification_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Notification history is immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.recipient_id,NEW.event_key,NEW.channel,NEW.kind,NEW.template_version,NEW.target_type,NEW.target_id,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.recipient_id,OLD.event_key,OLD.channel,OLD.kind,OLD.template_version,OLD.target_type,OLD.target_id,OLD.created_at)
 OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at)
 THEN RAISE EXCEPTION 'Notification history is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_history_immutable BEFORE UPDATE OR DELETE ON campus.notifications
 FOR EACH ROW EXECUTE FUNCTION campus.guard_notification_history();

-- Only trigger functions owned by the migration role may invoke this helper.
CREATE FUNCTION campus.emit_notification(event text,event_kind text,target_kind text,target uuid,recipients uuid[],actor_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 INSERT INTO campus.notifications(recipient_id,event_key,kind,target_type,target_id)
 SELECT DISTINCT u.id,event,event_kind,target_kind,target FROM unnest(recipients) r(id)
 JOIN campus.users u ON u.id=r.id WHERE u.id IS DISTINCT FROM actor_id
 ON CONFLICT(event_key,recipient_id,channel) DO NOTHING
$$;
CREATE FUNCTION campus.notification_agreement_people(a uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT array_agg(id) FROM (SELECT owner_id AS id FROM campus.agreements WHERE id=a
 UNION SELECT user_id FROM campus.agreement_members WHERE agreement_id=a) participants
$$;

CREATE FUNCTION campus.notify_application_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE recipients uuid[]; owner_uuid uuid; agreement_uuid uuid;
BEGIN
 SELECT owner_id INTO owner_uuid FROM campus.tasks WHERE id=NEW.task_id;
 IF TG_OP='INSERT' THEN
   PERFORM campus.emit_notification('application:'||NEW.id||':received','application.received','application',NEW.id,ARRAY[owner_uuid],campus.actor());
 ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
   IF NEW.state='accepted' THEN
     SELECT id INTO agreement_uuid FROM campus.agreements WHERE application_id=NEW.id;
     IF agreement_uuid IS NOT NULL THEN
       PERFORM campus.emit_notification('application:'||NEW.id||':accepted','application.accepted','agreement',agreement_uuid,
        campus.notification_agreement_people(agreement_uuid),campus.actor());
     END IF;
   ELSE
     SELECT array_agg(user_id) INTO recipients FROM (
       SELECT NEW.applicant_id AS user_id UNION SELECT user_id FROM campus.application_members WHERE application_id=NEW.id AND confirmed
       UNION SELECT owner_uuid WHERE NEW.state='withdrawn') people;
     PERFORM campus.emit_notification('application:'||NEW.id||':'||NEW.state,'application.'||NEW.state,'application',NEW.id,recipients,campus.actor());
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_application AFTER INSERT OR UPDATE ON campus.applications
 FOR EACH ROW EXECUTE FUNCTION campus.notify_application_transition();

CREATE FUNCTION campus.notify_application_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE applicant uuid;
BEGIN
 IF TG_OP='INSERT' THEN
   IF NOT NEW.confirmed THEN
     PERFORM campus.emit_notification('consent:'||NEW.application_id||':'||NEW.user_id||':request','application.consent_requested','application',NEW.application_id,ARRAY[NEW.user_id],campus.actor());
   END IF;
 ELSIF NEW.confirmed AND NOT OLD.confirmed THEN
   SELECT applicant_id INTO applicant FROM campus.applications WHERE id=NEW.application_id;
   PERFORM campus.emit_notification('consent:'||NEW.application_id||':'||NEW.user_id||':confirmed','application.consented','application',NEW.application_id,ARRAY[applicant],campus.actor());
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_consent AFTER INSERT OR UPDATE ON campus.application_members
 FOR EACH ROW EXECUTE FUNCTION campus.notify_application_consent();

CREATE FUNCTION campus.notify_team_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE recipients uuid[]; event_kind text;
BEGIN
 IF NEW.action IN ('backfill','create','archive') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='team_context_events' THEN
   event_kind:='team.context';
   SELECT array_agg(user_id) INTO recipients FROM campus.team_members WHERE team_id=NEW.team_id AND state IN ('accepted','invited');
 ELSIF NEW.action='invite' THEN
   event_kind:='team.invite'; recipients:=ARRAY[NEW.user_id];
 ELSE
   event_kind:='team.'||NEW.action;
   SELECT array_agg(user_id) INTO recipients FROM (SELECT user_id FROM campus.team_members WHERE team_id=NEW.team_id AND state='accepted'
     UNION SELECT NEW.user_id) people;
 END IF;
 PERFORM campus.emit_notification(TG_TABLE_NAME||':'||NEW.id,event_kind,'team',NEW.team_id,recipients,NEW.actor_id);
 RETURN NEW;
END $$;
CREATE TRIGGER notification_team_membership AFTER INSERT ON campus.team_membership_events
 FOR EACH ROW EXECUTE FUNCTION campus.notify_team_event();
CREATE TRIGGER notification_team_context AFTER INSERT ON campus.team_context_events
 FOR EACH ROW EXECUTE FUNCTION campus.notify_team_event();

CREATE FUNCTION campus.notify_work_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='milestones' THEN
   IF NEW.revision IS DISTINCT FROM OLD.revision AND NEW.state IN ('submitted','revision_requested','accepted') THEN
     PERFORM campus.emit_notification('milestone:'||NEW.id||':'||NEW.revision,'milestone.'||NEW.state,'agreement',NEW.agreement_id,
       campus.notification_agreement_people(NEW.agreement_id),campus.actor());
   END IF;
 ELSIF NEW.state='completed' AND OLD.state IS DISTINCT FROM NEW.state THEN
   PERFORM campus.emit_notification('agreement:'||NEW.id||':completed','agreement.completed','agreement',NEW.id,
     campus.notification_agreement_people(NEW.id),campus.actor());
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_milestone AFTER UPDATE ON campus.milestones
 FOR EACH ROW EXECUTE FUNCTION campus.notify_work_transition();
CREATE TRIGGER notification_agreement AFTER UPDATE ON campus.agreements
 FOR EACH ROW EXECUTE FUNCTION campus.notify_work_transition();

CREATE FUNCTION campus.notify_message_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE recipients uuid[]; target_kind text; target uuid;
BEGIN
 IF NEW.agreement_id IS NOT NULL THEN
   target_kind:='agreement'; target:=NEW.agreement_id; recipients:=campus.notification_agreement_people(target);
 ELSE
   target_kind:='order'; target:=NEW.order_id;
   SELECT ARRAY[buyer_id,seller_id] INTO recipients FROM campus.orders WHERE id=target;
 END IF;
 PERFORM campus.emit_notification('message:'||NEW.id,'message.received',target_kind,target,recipients,NEW.sender_id);
 RETURN NEW;
END $$;
CREATE TRIGGER notification_message AFTER INSERT ON campus.messages
 FOR EACH ROW EXECUTE FUNCTION campus.notify_message_insert();

CREATE FUNCTION campus.notify_order_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE suffix text;
BEGIN
 IF TG_OP='INSERT' THEN suffix:='created';
 ELSIF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('cancelled','expired','shipped','ready_for_pickup','completed') THEN suffix:=NEW.state;
 ELSE RETURN NEW; END IF;
 PERFORM campus.emit_notification('order:'||NEW.id||':'||suffix,'order.'||suffix,'order',NEW.id,
  ARRAY[NEW.buyer_id,NEW.seller_id],CASE WHEN suffix='expired' THEN NULL ELSE campus.actor() END);
 RETURN NEW;
END $$;
CREATE TRIGGER notification_order AFTER INSERT OR UPDATE ON campus.orders
 FOR EACH ROW EXECUTE FUNCTION campus.notify_order_transition();

CREATE FUNCTION campus.notify_eligibility_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('approved','rejected') THEN
   PERFORM campus.emit_notification('eligibility:'||NEW.id||':'||NEW.status,'eligibility.'||NEW.status,'eligibility',NEW.id,ARRAY[NEW.user_id],NEW.reviewer_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_eligibility AFTER UPDATE ON campus.eligibility_requests
 FOR EACH ROW EXECUTE FUNCTION campus.notify_eligibility_transition();

-- Invoker query deliberately uses the same current RLS visibility as business reads.
CREATE FUNCTION campus.notification_target(kind text,target uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT CASE kind
 WHEN 'agreement' THEN (SELECT jsonb_build_object('type',kind,'id',id,'contextLabel',left(terms->>'taskTitle',160)) FROM campus.agreements WHERE id=target)
 WHEN 'order' THEN (SELECT jsonb_build_object('type',kind,'id',id,'contextLabel',left(terms->>'title',160)) FROM campus.orders WHERE id=target)
 WHEN 'team' THEN (SELECT jsonb_build_object('type',kind,'id',id,'contextLabel',left(name,160)) FROM campus.teams WHERE id=target)
 WHEN 'eligibility' THEN (SELECT jsonb_build_object('type',kind,'id',id) FROM campus.eligibility_requests WHERE id=target AND user_id=campus.actor())
 WHEN 'application' THEN (SELECT jsonb_build_object('type',kind,'id',id) ||
   CASE WHEN campus.is_member() THEN jsonb_build_object('taskId',task_id,'contextLabel',
     (SELECT left(t.title,160) FROM campus.tasks t WHERE t.id=task_id)) ELSE '{}'::jsonb END FROM campus.applications WHERE id=target)
 ELSE NULL END
 WHERE EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked')
$$;
CREATE FUNCTION campus.mark_notification_read(notification_uuid uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 PERFORM id FROM campus.users WHERE id=campus.actor() AND account_status<>'locked' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account_locked' USING ERRCODE='42501'; END IF;
 -- Ownership must be checked even when the row was already acknowledged.
 PERFORM id FROM campus.notifications WHERE id=notification_uuid AND recipient_id=campus.actor() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 UPDATE campus.notifications SET read_at=clock_timestamp() WHERE id=notification_uuid AND read_at IS NULL;
 RETURN notification_uuid;
END $$;

REVOKE ALL ON FUNCTION campus.guard_notification_history(),campus.emit_notification(text,text,text,uuid,uuid[],uuid),
 campus.notification_agreement_people(uuid),campus.notify_application_transition(),campus.notify_application_consent(),
 campus.notify_team_event(),campus.notify_work_transition(),campus.notify_message_insert(),campus.notify_order_transition(),
 campus.notify_eligibility_transition(),campus.notification_target(text,uuid),campus.mark_notification_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.notification_target(text,uuid),campus.mark_notification_read(uuid) TO campus_app;
