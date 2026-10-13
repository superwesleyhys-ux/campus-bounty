-- Application discussion is a third, independent scope. No history/receipt backfill.
ALTER TABLE campus.messages ADD COLUMN application_id uuid REFERENCES campus.applications;
ALTER TABLE campus.messages DROP CONSTRAINT messages_check;
ALTER TABLE campus.messages ADD CONSTRAINT messages_exactly_one_scope CHECK(num_nonnulls(agreement_id,order_id,application_id)=1);
CREATE INDEX messages_application_history ON campus.messages(application_id,created_at DESC,id DESC) WHERE application_id IS NOT NULL;

-- Frozen application membership (including unconfirmed members), not current team membership.
CREATE FUNCTION campus.can_read_application_conversation(application_uuid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>'locked')
 AND EXISTS(SELECT 1 FROM campus.applications a JOIN campus.tasks t ON t.id=a.task_id
 WHERE a.id=application_uuid AND (campus.actor() IN(a.applicant_id,t.owner_id) OR campus.in_application(a.id)))
$$;
ALTER POLICY messages_read ON campus.messages USING(campus.in_agreement(agreement_id) OR campus.in_order(order_id) OR campus.can_read_application_conversation(application_id));
ALTER POLICY messages_insert ON campus.messages WITH CHECK(sender_id=campus.actor() AND (campus.in_agreement(agreement_id) OR campus.in_order(order_id) OR campus.can_read_application_conversation(application_id)));

CREATE OR REPLACE FUNCTION campus.authorize_message_scope(scope_kind text,scope_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE status text; membership_ok boolean; scope_ok boolean; member_locked boolean; task_uuid uuid;
BEGIN
 IF scope_kind='agreement' THEN
  PERFORM id FROM campus.agreements WHERE id=scope_id AND campus.in_agreement(id) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  PERFORM user_id FROM campus.agreement_members WHERE agreement_id=scope_id AND user_id=campus.actor() FOR SHARE;
  member_locked := FOUND;
  -- The first locking statement can have waited with an older snapshot. A
  -- separate statement inside this VOLATILE helper sees current scope authority.
  -- Owner/captain authority does not require an agreement_members row; an
  -- ordinary signer must still belong. Successfully acquired locks stay held.
  SELECT campus.in_agreement(a.id) AND (campus.actor() IN(a.owner_id,a.captain_id) OR member_locked)
   INTO scope_ok FROM campus.agreements a WHERE a.id=scope_id;
  IF NOT coalesce(scope_ok,false) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 ELSIF scope_kind='order' THEN
  PERFORM id FROM campus.orders WHERE id=scope_id AND campus.actor() IN(buyer_id,seller_id) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 ELSIF scope_kind='application' THEN
  SELECT a.task_id INTO task_uuid FROM campus.applications a
   WHERE a.id=scope_id AND campus.can_read_application_conversation(a.id);
  IF task_uuid IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  -- Same order as change_application_state / accept_task_invitation: task lock,
  -- task row, application row, then participant/account sources. Never user first.
  PERFORM pg_advisory_xact_lock(hashtextextended('task:'||task_uuid::text,0));
  PERFORM id FROM campus.tasks WHERE id=task_uuid FOR SHARE;
  PERFORM id FROM campus.applications WHERE id=scope_id FOR SHARE;
  PERFORM user_id FROM campus.application_members WHERE application_id=scope_id AND user_id=campus.actor() FOR SHARE;
  IF NOT campus.can_read_application_conversation(scope_id) THEN
   RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';
  END IF;
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

REVOKE ALL ON FUNCTION campus.authorize_message_scope(text,uuid) FROM PUBLIC,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.authorize_message_scope(text,uuid) TO campus_app;

CREATE OR REPLACE FUNCTION campus.conversation_people(scope_kind text,scope_id uuid)
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
  UNION ALL
  SELECT t.owner_id,'publisher' FROM campus.applications a JOIN campus.tasks t ON t.id=a.task_id
   WHERE scope_kind='application' AND a.id=scope_id AND campus.can_read_application_conversation(a.id)
  UNION ALL
  SELECT a.applicant_id,'applicant' FROM campus.applications a
   WHERE scope_kind='application' AND a.id=scope_id AND campus.can_read_application_conversation(a.id)
  UNION ALL
  SELECT m.user_id,'proposed_participant' FROM campus.application_members m JOIN campus.applications a ON a.id=m.application_id
   WHERE scope_kind='application' AND a.id=scope_id AND m.user_id<>a.applicant_id
    AND campus.can_read_application_conversation(a.id)
 ) p JOIN campus.users u ON u.id=p.id
 WHERE EXISTS(SELECT 1 FROM campus.users me WHERE me.id=campus.actor() AND me.account_status<>'locked')
$$;

-- Read context deliberately does not call the send gate: expired/restricted
-- participants retain history. No task title is returned by this definer.
CREATE FUNCTION campus.application_conversation_context(application_uuid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 WITH visible AS (
  SELECT a.id,a.state,t.status,
   CASE WHEN u.account_status<>'active' THEN 'account_restricted'
    WHEN NOT EXISTS(SELECT 1 FROM campus.affiliations f JOIN campus.domains d ON d.domain=f.domain
     AND d.institution_id=f.institution_id JOIN campus.institutions i ON i.id=f.institution_id
     WHERE f.user_id=campus.actor() AND f.valid_until>clock_timestamp() AND d.enabled AND i.active) THEN 'membership_required'
    WHEN a.state NOT IN ('applied','invited') THEN 'application_closed'
    WHEN t.status<>'open' THEN 'task_closed' ELSE NULL END AS reason
  FROM campus.applications a JOIN campus.tasks t ON t.id=a.task_id JOIN campus.users u ON u.id=campus.actor()
  WHERE a.id=application_uuid AND campus.can_read_application_conversation(a.id)
 ) SELECT jsonb_build_object('applicationId',v.id,'applicationState',v.state,'taskStatus',v.status,
  'canSend',v.reason IS NULL,'sendUnavailableReason',v.reason,'agreementId',
  (SELECT g.id FROM campus.agreements g WHERE g.application_id=v.id AND campus.in_agreement(g.id))) FROM visible v
$$;

CREATE OR REPLACE FUNCTION campus.guard_message_send() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE application_context jsonb;
BEGIN
 PERFORM campus.authorize_message_scope(CASE WHEN NEW.agreement_id IS NOT NULL THEN 'agreement'
  WHEN NEW.order_id IS NOT NULL THEN 'order' ELSE 'application' END,
  coalesce(NEW.agreement_id,NEW.order_id,NEW.application_id));
 -- Only first execution reaches INSERT; committed identical receipts remain recoverable.
 IF NEW.application_id IS NOT NULL THEN
  SELECT campus.application_conversation_context(NEW.application_id) INTO application_context;
  IF application_context IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
  IF application_context->>'applicationState' NOT IN ('applied','invited') OR application_context->>'taskStatus'<>'open' THEN
   RAISE EXCEPTION 'application_conversation_closed' USING ERRCODE='P0001';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION campus.notify_message_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE recipients uuid[]; target_kind text; target uuid;
BEGIN
 IF NEW.agreement_id IS NOT NULL THEN
   target_kind:='agreement'; target:=NEW.agreement_id; recipients:=campus.notification_agreement_people(target);
 ELSIF NEW.order_id IS NOT NULL THEN
   target_kind:='order'; target:=NEW.order_id;
   SELECT ARRAY[buyer_id,seller_id] INTO recipients FROM campus.orders WHERE id=target;
 ELSE
   target_kind:='application'; target:=NEW.application_id;
   SELECT array_agg(id) INTO recipients FROM (
    SELECT t.owner_id AS id FROM campus.applications a JOIN campus.tasks t ON t.id=a.task_id WHERE a.id=target
    UNION SELECT applicant_id FROM campus.applications WHERE id=target
    UNION SELECT user_id FROM campus.application_members WHERE application_id=target
   ) people;
 END IF;
 PERFORM campus.emit_notification('message:'||NEW.id,'message.received',target_kind,target,recipients,NEW.sender_id);
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION campus.can_read_application_conversation(uuid),campus.application_conversation_context(uuid),
 campus.conversation_people(text,uuid),campus.guard_message_send(),campus.notify_message_insert()
 FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.can_read_application_conversation(uuid),campus.application_conversation_context(uuid),
 campus.conversation_people(text,uuid) TO campus_app;
