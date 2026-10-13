-- Additive history projection; no existing business/notification rows are rewritten.
CREATE INDEX messages_agreement_history ON campus.messages(agreement_id,created_at DESC,id DESC) WHERE agreement_id IS NOT NULL;
CREATE INDEX messages_order_history ON campus.messages(order_id,created_at DESC,id DESC) WHERE order_id IS NOT NULL;

-- Names are current editable labels, never identity verification or historical snapshots.
-- One collaboration only; no arbitrary user-id lookup and no broader users grants.
CREATE FUNCTION campus.conversation_people(scope_kind text,scope_id uuid)
RETURNS TABLE(id uuid,display_name text,role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT p.id,u.display_name,p.role FROM (
  SELECT a.owner_id AS id,'publisher'::text AS role FROM campus.agreements a
   WHERE scope_kind='agreement' AND a.id=scope_id AND campus.in_agreement(a.id)
  UNION ALL
  SELECT m.user_id,CASE WHEN m.user_id=a.captain_id THEN 'captain' ELSE 'participant' END
   FROM campus.agreement_members m JOIN campus.agreements a ON a.id=m.agreement_id
   WHERE scope_kind='agreement' AND a.id=scope_id AND campus.in_agreement(a.id)
  UNION ALL
  SELECT o.buyer_id,'buyer' FROM campus.orders o
   WHERE scope_kind='order' AND o.id=scope_id AND campus.actor() IN(o.buyer_id,o.seller_id)
  UNION ALL
  SELECT o.seller_id,'seller' FROM campus.orders o
   WHERE scope_kind='order' AND o.id=scope_id AND campus.actor() IN(o.buyer_id,o.seller_id)
 ) p JOIN campus.users u ON u.id=p.id
 WHERE EXISTS(SELECT 1 FROM campus.users me WHERE me.id=campus.actor() AND me.account_status<>'locked')
$$;

-- Gate receipts as well as first sends. Hold current authority through key waits.
CREATE FUNCTION campus.authorize_message_scope(scope_kind text,scope_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE status text; membership_ok boolean;
BEGIN
 IF scope_kind='agreement' THEN
  PERFORM id FROM campus.agreements WHERE id=scope_id AND campus.in_agreement(id) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM user_id FROM campus.agreement_members WHERE agreement_id=scope_id AND user_id=campus.actor() FOR SHARE;
 ELSIF scope_kind='order' THEN
  PERFORM id FROM campus.orders WHERE id=scope_id AND campus.actor() IN(buyer_id,seller_id) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 ELSE RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT account_status INTO status FROM campus.users WHERE id=campus.actor() FOR SHARE;
 IF status IS NULL OR status='locked' THEN RAISE EXCEPTION 'account_locked' USING ERRCODE='42501'; END IF;
 -- Lock each source of membership authority, including institution/domain enablement.
 PERFORM f.user_id FROM campus.affiliations f JOIN campus.domains d ON d.domain=f.domain
  AND d.institution_id=f.institution_id JOIN campus.institutions i ON i.id=f.institution_id
  WHERE f.user_id=campus.actor() FOR SHARE OF f,d,i;
 SELECT EXISTS(SELECT 1 FROM campus.affiliations f JOIN campus.domains d ON d.domain=f.domain
  AND d.institution_id=f.institution_id JOIN campus.institutions i ON i.id=f.institution_id
  WHERE f.user_id=campus.actor() AND f.valid_until>clock_timestamp() AND d.enabled AND i.active) INTO membership_ok;
 IF NOT membership_ok THEN RAISE EXCEPTION 'membership_required' USING ERRCODE='42501'; END IF;
 IF status<>'active' THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='42501'; END IF;
 RETURN scope_id;
END $$;

-- Exact event anchors only. No work/feedback/message bodies or copied names/titles.
CREATE TABLE campus.notification_work_context (
 notification_id uuid PRIMARY KEY REFERENCES campus.notifications,
 milestone_id uuid NOT NULL REFERENCES campus.milestones,
 submission_id uuid NOT NULL,
 submission_version integer NOT NULL CHECK(submission_version>0),
 milestone_revision integer NOT NULL CHECK(milestone_revision>0),
 review_id uuid REFERENCES campus.milestone_reviews,
 FOREIGN KEY(submission_id,milestone_id,submission_version) REFERENCES campus.submissions(id,milestone_id,version)
);
ALTER TABLE campus.notification_work_context ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_work_context_read ON campus.notification_work_context FOR SELECT TO campus_app USING(
 EXISTS(SELECT 1 FROM campus.notifications n WHERE n.id=notification_id AND n.recipient_id=campus.actor())
 AND campus.in_milestone(milestone_id));
GRANT SELECT ON campus.notification_work_context TO campus_app;
REVOKE ALL ON campus.notification_work_context FROM PUBLIC,campus_auth,campus_worker;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON campus.notification_work_context FROM campus_app;
CREATE FUNCTION campus.immutable_notification_work_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Notification work context is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_notification_work_context BEFORE UPDATE OR DELETE ON campus.notification_work_context
 FOR EACH ROW EXECUTE FUNCTION campus.immutable_notification_work_context();

-- Existing trigger and recipient/event keys are retained. Only freshly inserted
-- notification ids receive context: an old legacy event can never be enriched.
CREATE OR REPLACE FUNCTION campus.notify_work_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE review_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='milestones' THEN
  IF NEW.revision IS DISTINCT FROM OLD.revision AND NEW.state IN ('submitted','revision_requested','accepted') THEN
   IF NEW.state IN ('revision_requested','accepted') THEN
    SELECT id INTO STRICT review_uuid FROM campus.milestone_reviews WHERE milestone_id=NEW.id
     AND submission_id=NEW.latest_submission_id AND submission_version=NEW.version
     AND milestone_revision=NEW.revision AND decision=NEW.state;
   END IF;
   WITH emitted AS (
    INSERT INTO campus.notifications(recipient_id,event_key,kind,target_type,target_id)
    SELECT DISTINCT u.id,'milestone:'||NEW.id||':'||NEW.revision,'milestone.'||NEW.state,'agreement',NEW.agreement_id
    FROM unnest(campus.notification_agreement_people(NEW.agreement_id)) r(id)
    JOIN campus.users u ON u.id=r.id WHERE u.id IS DISTINCT FROM campus.actor()
    ON CONFLICT(event_key,recipient_id,channel) DO NOTHING RETURNING id
   ) INSERT INTO campus.notification_work_context(notification_id,milestone_id,submission_id,submission_version,milestone_revision,review_id)
    SELECT id,NEW.id,NEW.latest_submission_id,NEW.version,NEW.revision,review_uuid FROM emitted;
  END IF;
 ELSIF NEW.state='completed' AND OLD.state IS DISTINCT FROM NEW.state THEN
  PERFORM campus.emit_notification('agreement:'||NEW.id||':completed','agreement.completed','agreement',NEW.id,
   campus.notification_agreement_people(NEW.id),campus.actor());
 END IF;
 RETURN NEW;
END $$;

-- Invoker projection obeys both recipient and current target RLS, including revoked access.
CREATE FUNCTION campus.notification_work_detail(notification_uuid uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('type','milestone','milestoneId',w.milestone_id,
  'milestoneTitle',m.title,'milestonePosition',m.position,'submissionId',w.submission_id,
  'submissionVersion',w.submission_version,'milestoneRevision',w.milestone_revision,'reviewId',w.review_id)
 FROM campus.notification_work_context w JOIN campus.milestones m ON m.id=w.milestone_id
 JOIN campus.notifications n ON n.id=w.notification_id AND n.target_type='agreement' AND n.target_id=m.agreement_id
 WHERE n.id=notification_uuid AND n.recipient_id=campus.actor() AND campus.in_agreement(m.agreement_id)
$$;
REVOKE ALL ON FUNCTION campus.conversation_people(text,uuid),campus.authorize_message_scope(text,uuid),
 campus.immutable_notification_work_context(),campus.notify_work_transition(),campus.notification_work_detail(uuid)
 FROM PUBLIC,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.conversation_people(text,uuid),campus.authorize_message_scope(text,uuid),
 campus.notification_work_detail(uuid) TO campus_app;

-- The app SQL role must obey the same current send authority as service calls.
-- History reads intentionally remain available to expired/restricted participants.
CREATE FUNCTION campus.guard_message_send() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 PERFORM campus.authorize_message_scope(CASE WHEN NEW.agreement_id IS NOT NULL THEN 'agreement' ELSE 'order' END,
  coalesce(NEW.agreement_id,NEW.order_id));
 RETURN NEW;
END $$;
CREATE TRIGGER guard_message_send BEFORE INSERT ON campus.messages
 FOR EACH ROW EXECUTE FUNCTION campus.guard_message_send();
REVOKE ALL ON FUNCTION campus.guard_message_send() FROM PUBLIC,campus_app,campus_auth,campus_worker;
