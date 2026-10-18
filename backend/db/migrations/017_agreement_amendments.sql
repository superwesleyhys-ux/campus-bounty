-- Additive immutable agreement terms. Install with the reviewed isolated upgrade
-- gate; migration inventory publication belongs to the same surrounding transaction.
CREATE TABLE campus.agreement_amendment_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), mutations_enabled boolean NOT NULL DEFAULT false,
 strict_binding boolean NOT NULL DEFAULT false CHECK(NOT mutations_enabled OR strict_binding)
);
INSERT INTO campus.agreement_amendment_settings DEFAULT VALUES;
CREATE FUNCTION campus.guard_agreement_binding_latch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF TG_OP='DELETE' OR (OLD.strict_binding AND NOT NEW.strict_binding) THEN RAISE EXCEPTION 'Strict agreement binding cannot be disabled' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER agreement_binding_latch BEFORE UPDATE OR DELETE ON campus.agreement_amendment_settings FOR EACH ROW EXECUTE FUNCTION campus.guard_agreement_binding_latch();
CREATE FUNCTION campus.agreement_amendment_capabilities() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('agreementAmendments',s.mutations_enabled AND EXISTS(SELECT 1 FROM campus.schema_migrations WHERE name='017_agreement_amendments.sql'),'agreementTermsBinding',CASE WHEN s.strict_binding THEN 'explicit' ELSE 'legacy' END,'schemaRequirement',17) FROM campus.agreement_amendment_settings s WHERE singleton
$$;
CREATE TABLE campus.agreement_terms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_id uuid NOT NULL REFERENCES campus.agreements,
 revision integer NOT NULL CHECK(revision>0), terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'),
 origin text NOT NULL CHECK(origin IN('legacy_snapshot','accepted_application','amendment')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), source_application_id uuid REFERENCES campus.applications,
 source_listing_version integer, amendment_id uuid, proposal_revision integer,
 UNIQUE(agreement_id,revision), UNIQUE(id,agreement_id,revision)
);
CREATE TABLE campus.agreement_milestone_identities (
 id uuid PRIMARY KEY, agreement_id uuid NOT NULL REFERENCES campus.agreements, position integer NOT NULL CHECK(position>0),
 provenance text NOT NULL CHECK(provenance IN('legacy_snapshot','accepted_application','amendment_reservation')),
 reserved_by_amendment_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,agreement_id),UNIQUE(agreement_id,position),UNIQUE(id,agreement_id,position)
);
CREATE TABLE campus.agreement_milestone_terms (
 terms_id uuid NOT NULL,milestone_id uuid NOT NULL,agreement_id uuid NOT NULL,terms_revision integer NOT NULL,
 position integer NOT NULL,title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
 amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),deliverable text NOT NULL CHECK(length(btrim(deliverable)) BETWEEN 1 AND 10000),
 acceptance_criteria text CHECK(acceptance_criteria IS NULL OR length(btrim(acceptance_criteria)) BETWEEN 1 AND 10000),
 PRIMARY KEY(terms_id,milestone_id),UNIQUE(terms_id,position),
 FOREIGN KEY(terms_id,agreement_id,terms_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision),
 FOREIGN KEY(milestone_id,agreement_id,position) REFERENCES campus.agreement_milestone_identities(id,agreement_id,position)
);
CREATE TABLE campus.agreement_terms_state (
 agreement_id uuid PRIMARY KEY REFERENCES campus.agreements,original_terms_id uuid NOT NULL,original_revision integer NOT NULL DEFAULT 1 CHECK(original_revision=1),
 effective_terms_id uuid NOT NULL,effective_revision integer NOT NULL,next_terms_revision integer NOT NULL CHECK(next_terms_revision>effective_revision),
 FOREIGN KEY(original_terms_id,agreement_id,original_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision),
 FOREIGN KEY(effective_terms_id,agreement_id,effective_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision)
);
CREATE TABLE campus.agreement_amendments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agreement_id uuid NOT NULL REFERENCES campus.agreements,proposer_id uuid NOT NULL REFERENCES campus.users,
 base_terms_id uuid NOT NULL,base_effective_revision integer NOT NULL,current_proposal_revision integer NOT NULL CHECK(current_proposal_revision>0),
 status text NOT NULL CHECK(status IN('pending','agreed_waiting_funds','effective','rejected','withdrawn','stale_base','stale_work','stale_agreement')),
 created_sequence integer NOT NULL CHECK(created_sequence>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),terminal_reason text,
 UNIQUE(id,agreement_id),UNIQUE(agreement_id,created_sequence),
 FOREIGN KEY(base_terms_id,agreement_id,base_effective_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision)
);
CREATE FUNCTION campus.guard_amendment_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.agreement_id,NEW.proposer_id,NEW.base_terms_id,NEW.base_effective_revision,NEW.created_sequence,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.agreement_id,OLD.proposer_id,OLD.base_terms_id,OLD.base_effective_revision,OLD.created_sequence,OLD.created_at) THEN RAISE EXCEPTION 'Amendment identity is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER amendment_identity_immutable BEFORE UPDATE OR DELETE ON campus.agreement_amendments FOR EACH ROW EXECUTE FUNCTION campus.guard_amendment_identity();
REVOKE ALL ON FUNCTION campus.guard_amendment_identity() FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE UNIQUE INDEX agreement_one_live_amendment ON campus.agreement_amendments(agreement_id) WHERE status IN('pending','agreed_waiting_funds');
ALTER TABLE campus.agreement_milestone_identities ADD FOREIGN KEY(reserved_by_amendment_id,agreement_id) REFERENCES campus.agreement_amendments(id,agreement_id);
CREATE TABLE campus.agreement_amendment_revisions (
 amendment_id uuid NOT NULL,proposal_revision integer NOT NULL CHECK(proposal_revision>0),agreement_id uuid NOT NULL,
 terms_id uuid NOT NULL,terms_revision integer NOT NULL,base_terms_id uuid NOT NULL,base_effective_revision integer NOT NULL,
 proposer_id uuid NOT NULL REFERENCES campus.users,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 10000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_paths jsonb NOT NULL,changed_milestone_ids uuid[] NOT NULL,work_baseline jsonb NOT NULL,added_milestone_ids uuid[] NOT NULL,retired_milestone_ids uuid[] NOT NULL,allocation_changed boolean NOT NULL,
 PRIMARY KEY(amendment_id,proposal_revision),UNIQUE(amendment_id,proposal_revision,agreement_id,terms_id,terms_revision,base_terms_id,base_effective_revision),
 FOREIGN KEY(amendment_id,agreement_id) REFERENCES campus.agreement_amendments(id,agreement_id),
 FOREIGN KEY(terms_id,agreement_id,terms_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision),
 FOREIGN KEY(base_terms_id,agreement_id,base_effective_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision)
);
ALTER TABLE campus.agreement_terms ADD FOREIGN KEY(amendment_id,proposal_revision) REFERENCES campus.agreement_amendment_revisions(amendment_id,proposal_revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE campus.agreement_amendment_confirmations (
 amendment_id uuid NOT NULL,proposal_revision integer NOT NULL,user_id uuid NOT NULL REFERENCES campus.users,agreement_id uuid NOT NULL,
 terms_id uuid NOT NULL,terms_revision integer NOT NULL,base_terms_id uuid NOT NULL,base_effective_revision integer NOT NULL,
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),event_id uuid NOT NULL,
 PRIMARY KEY(amendment_id,proposal_revision,user_id),
 FOREIGN KEY(amendment_id,proposal_revision,agreement_id,terms_id,terms_revision,base_terms_id,base_effective_revision) REFERENCES campus.agreement_amendment_revisions(amendment_id,proposal_revision,agreement_id,terms_id,terms_revision,base_terms_id,base_effective_revision)
);
CREATE TABLE campus.agreement_amendment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agreement_id uuid NOT NULL,sequence integer NOT NULL CHECK(sequence>0),amendment_id uuid NOT NULL,
 proposal_revision integer NOT NULL,actor_id uuid REFERENCES campus.users,operation text NOT NULL CHECK(operation IN('propose','revise','confirm','reject','withdraw','effective','agreed_waiting_funds','stale_base','stale_work','stale_agreement','materialize','retire')),
 old_status text,new_status text NOT NULL,command_identity uuid NOT NULL DEFAULT gen_random_uuid(),reason text,occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(agreement_id,sequence),FOREIGN KEY(amendment_id,agreement_id) REFERENCES campus.agreement_amendments(id,agreement_id),
 FOREIGN KEY(amendment_id,proposal_revision) REFERENCES campus.agreement_amendment_revisions(amendment_id,proposal_revision)
);
ALTER TABLE campus.agreement_amendment_confirmations ADD FOREIGN KEY(event_id) REFERENCES campus.agreement_amendment_events;
ALTER TABLE campus.milestones ADD CONSTRAINT milestone_agreement_identity UNIQUE(id,agreement_id);
CREATE TABLE campus.submission_terms (
 submission_id uuid PRIMARY KEY,agreement_id uuid NOT NULL,milestone_id uuid NOT NULL,submission_version integer NOT NULL,
 terms_id uuid NOT NULL,terms_revision integer NOT NULL,provenance text NOT NULL CHECK(provenance IN('legacy_original_snapshot_binding','legacy_client_original_binding','explicit_terms_binding')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(submission_id,milestone_id,submission_version) REFERENCES campus.submissions(id,milestone_id,version),
 FOREIGN KEY(milestone_id,agreement_id) REFERENCES campus.milestones(id,agreement_id),
 FOREIGN KEY(terms_id,agreement_id,terms_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision),
 FOREIGN KEY(terms_id,milestone_id) REFERENCES campus.agreement_milestone_terms(terms_id,milestone_id)
);
CREATE TABLE campus.agreement_amendment_notification_context (
 notification_id uuid PRIMARY KEY REFERENCES campus.notifications,agreement_id uuid NOT NULL,amendment_id uuid NOT NULL,proposal_revision integer NOT NULL,event_id uuid NOT NULL REFERENCES campus.agreement_amendment_events,
 FOREIGN KEY(amendment_id,agreement_id) REFERENCES campus.agreement_amendments(id,agreement_id),FOREIGN KEY(amendment_id,proposal_revision) REFERENCES campus.agreement_amendment_revisions(amendment_id,proposal_revision)
);
CREATE FUNCTION campus.immutable_agreement_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Agreement history is immutable' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['agreement_terms','agreement_milestone_identities','agreement_milestone_terms','agreement_amendment_revisions','agreement_amendment_confirmations','agreement_amendment_events','submission_terms','agreement_amendment_notification_context'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.immutable_agreement_history()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agreement_terms','agreement_milestone_identities','agreement_milestone_terms','agreement_terms_state','agreement_amendments','agreement_amendment_revisions','agreement_amendment_confirmations','agreement_amendment_events','submission_terms','agreement_amendment_notification_context'] LOOP
  EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY agreement_private_read ON campus.%I FOR SELECT TO campus_app USING(campus.in_agreement(agreement_id))',t);
  EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);
  EXECUTE format('GRANT SELECT ON campus.%I TO campus_app',t);
 END LOOP;
END $$;
REVOKE ALL ON campus.agreement_amendment_settings FROM PUBLIC,campus_app,campus_auth,campus_worker;

-- Pure consistency predicate is also callable only by owner; no contradictory
-- business rows need to be manufactured to test upgrade rejection.
CREATE FUNCTION campus.validate_legacy_agreement_snapshot(t jsonb,stages jsonb,members uuid[],captain uuid,owner_id uuid) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE s jsonb; orig jsonb; total bigint:=0;
BEGIN
 IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(stages) IS DISTINCT FROM 'array'
  OR jsonb_typeof(t->'milestones') IS DISTINCT FROM 'array' OR jsonb_array_length(stages) NOT BETWEEN 1 AND 20
  OR jsonb_array_length(t->'milestones')<>jsonb_array_length(stages) OR coalesce(cardinality(members),0)=0
  OR captain IS NULL OR owner_id IS NULL OR array_position(members,NULL) IS NOT NULL
  OR NOT captain=ANY(members) OR owner_id=ANY(members)
  OR jsonb_typeof(t->'currency') IS DISTINCT FROM 'string' OR t->>'currency' IS DISTINCT FROM 'USD'
  OR length(btrim(t->>'taskTitle')) NOT BETWEEN 1 AND 160
  OR length(btrim(t->>'description')) NOT BETWEEN 1 AND 10000 THEN RETURN false; END IF;
 IF jsonb_typeof(t->'taskTitle') IS DISTINCT FROM 'string' OR jsonb_typeof(t->'description') IS DISTINCT FROM 'string' OR jsonb_typeof(t->'rewardCents') IS DISTINCT FROM 'number' OR (t->>'rewardCents') !~ '^[0-9]+$' OR jsonb_typeof(t->'members') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF t ? 'dueDate' AND t->'dueDate'<>'null'::jsonb THEN
  IF jsonb_typeof(t->'dueDate')<>'string' OR t->>'dueDate' !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' OR to_char((t->>'dueDate')::date,'YYYY-MM-DD')<>t->>'dueDate' THEN RETURN false;END IF;
 END IF;
 IF (SELECT array_agg(x::uuid ORDER BY x::uuid) FROM jsonb_array_elements_text(t->'members') x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(members) x) THEN RETURN false; END IF;
 FOR s IN SELECT * FROM jsonb_array_elements(stages) LOOP
  SELECT x INTO orig FROM jsonb_array_elements(t->'milestones') x WHERE (x->>'position')::integer=(s->>'position')::integer;
  IF jsonb_typeof(s->'position') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'title') IS DISTINCT FROM 'string'
   OR jsonb_typeof(s->'amount_cents') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'deliverable') IS DISTINCT FROM 'string'
   OR jsonb_typeof(orig->'position') IS DISTINCT FROM 'number' OR jsonb_typeof(orig->'title') IS DISTINCT FROM 'string'
   OR jsonb_typeof(orig->'amount_cents') IS DISTINCT FROM 'number' OR jsonb_typeof(orig->'deliverable') IS DISTINCT FROM 'string'
   OR orig IS NULL OR (orig->>'title',orig->>'amount_cents',orig->>'deliverable',orig->>'acceptance_criteria')
    IS DISTINCT FROM (s->>'title',s->>'amount_cents',s->>'deliverable',s->>'acceptance_criteria') THEN RETURN false; END IF;
  total:=total+(s->>'amount_cents')::integer;
 END LOOP;
 RETURN coalesce(total=(t->>'rewardCents')::integer AND total BETWEEN 1 AND 100000000,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- Compare only the shared signed fields: category is not signed, and participant
-- IDs belong to the agreement. Optional legacy nulls normalize for comparison, never in storage.
CREATE FUNCTION campus.agreement_matches_listing(signed_terms jsonb,listing jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT coalesce(jsonb_build_object('title',signed_terms->'taskTitle','description',signed_terms->'description',
  'rewardCents',signed_terms->'rewardCents','dueDate',signed_terms->'dueDate',
  'milestones',(SELECT jsonb_agg(jsonb_build_object('title',m->'title','amountCents',m->'amount_cents',
   'deliverable',m->'deliverable','acceptanceCriteria',m->'acceptance_criteria') ORDER BY (m->>'position')::integer)
   FROM jsonb_array_elements(signed_terms->'milestones') m)) =
 jsonb_build_object('title',listing->'title','description',listing->'description',
  'rewardCents',listing->'rewardCents','dueDate',listing->'dueDate',
  'milestones',(SELECT jsonb_agg(jsonb_build_object('title',m->'title','amountCents',m->'amountCents',
   'deliverable',m->'deliverable','acceptanceCriteria',m->'acceptanceCriteria') ORDER BY ord)
   FROM jsonb_array_elements(listing->'milestones') WITH ORDINALITY x(m,ord))),false)
$$;
CREATE FUNCTION campus.accepted_listing_source(gid uuid) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.agreements; candidate integer; matches integer;
BEGIN
 SELECT * INTO g FROM campus.agreements WHERE id=gid;
 -- Only the fresh, successful version-specific acceptance receipt binds a version.
 -- Replays returning originalAgreement have no termsVersion and cannot relabel it.
 IF EXISTS(SELECT 1 FROM campus.idempotency i WHERE i.actor_id=g.captain_id
  AND i.operation='application.terms.accept:'||g.application_id::text
  AND i.response->>'id'=g.application_id::text AND i.response->>'agreementId'=gid::text
  AND i.response->>'operation'='accept' AND i.response ? 'termsVersion') THEN
  SELECT count(DISTINCT i.response->'termsVersion'),min(l.version) INTO matches,candidate
  FROM campus.idempotency i LEFT JOIN campus.listing_versions l
   ON l.kind='task' AND l.listing_id=g.task_id AND to_jsonb(l.version)=i.response->'termsVersion'
   AND campus.agreement_matches_listing(g.terms,l.terms)
   AND EXISTS(SELECT 1 FROM campus.application_version_invitations v WHERE v.application_id=g.application_id
    AND v.version=l.version AND v.publisher_id=g.owner_id AND to_jsonb(v.task_revision)=i.response->'revision')
   AND NOT EXISTS(SELECT 1 FROM campus.agreement_members m WHERE m.agreement_id=gid AND NOT EXISTS(
    SELECT 1 FROM campus.application_terms_acknowledgements a WHERE a.application_id=g.application_id
     AND a.user_id=m.user_id AND a.version=l.version))
  WHERE i.actor_id=g.captain_id AND i.operation='application.terms.accept:'||g.application_id::text
   AND i.response->>'id'=g.application_id::text AND i.response->>'agreementId'=gid::text
   AND i.response->>'operation'='accept' AND i.response ? 'termsVersion';
  IF matches=1 THEN RETURN candidate; END IF;
  RETURN NULL;
 END IF;
 -- The old ordinary receipt has no version. Require a unique matching immutable
 -- snapshot across ALL versions, plus acceptance linkage and original review facts.
 -- Equal snapshots, observed-only history, or missing evidence remain unknown.
 IF NOT EXISTS(SELECT 1 FROM campus.idempotency WHERE actor_id=g.captain_id
  AND operation='application.accept:'||g.application_id::text AND response->>'id'=gid::text) THEN RETURN NULL;END IF;
 SELECT count(*),min(version) INTO matches,candidate FROM campus.listing_versions
  WHERE kind='task' AND listing_id=g.task_id AND campus.agreement_matches_listing(g.terms,terms);
 IF matches<>1 OR NOT EXISTS(SELECT 1 FROM campus.listing_versions WHERE kind='task' AND listing_id=g.task_id
  AND version=candidate AND provenance IN('published','owner_edit')) THEN RETURN NULL;END IF;
 IF candidate=1 AND EXISTS(SELECT 1 FROM campus.application_listing_terms WHERE application_id=g.application_id
  AND task_id=g.task_id AND submitted_version=1 AND provenance='unversioned_submission') THEN RETURN candidate;END IF;
 IF EXISTS(SELECT 1 FROM campus.application_version_invitations WHERE application_id=g.application_id
  AND version=candidate AND publisher_id=g.owner_id) AND NOT EXISTS(
  SELECT 1 FROM campus.agreement_members m WHERE m.agreement_id=gid AND NOT EXISTS(
   SELECT 1 FROM campus.application_terms_acknowledgements a WHERE a.application_id=g.application_id
    AND a.user_id=m.user_id AND a.version=candidate)) THEN RETURN candidate;END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION campus.initialize_agreement_terms(gid uuid,provenance text) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.agreements; tid uuid; stages jsonb; members uuid[]; source_version integer;
BEGIN
 SELECT original_terms_id INTO tid FROM campus.agreement_terms_state WHERE agreement_id=gid;IF tid IS NOT NULL THEN RETURN tid;END IF;
 SELECT * INTO g FROM campus.agreements WHERE id=gid;
 SELECT jsonb_agg(jsonb_build_object('position',position,'title',title,'amount_cents',amount_cents,'deliverable',deliverable,'acceptance_criteria',acceptance_criteria) ORDER BY position) INTO stages FROM campus.milestones WHERE agreement_id=gid;
 SELECT array_agg(user_id ORDER BY user_id) INTO members FROM campus.agreement_members WHERE agreement_id=gid;
 IF NOT campus.validate_legacy_agreement_snapshot(g.terms,stages,members,g.captain_id,g.owner_id) THEN RAISE EXCEPTION 'inconsistent_legacy_agreement' USING ERRCODE='23514'; END IF;
 IF provenance='accepted_application' THEN
  -- Called by acceptance while its task advisory/row locks still protect the exact
  -- snapshot and current-version invitation/acknowledgement checks.
  SELECT terms_version INTO source_version FROM campus.tasks WHERE id=g.task_id;
  IF NOT campus.agreement_matches_listing(g.terms,campus.listing_terms('task',g.task_id)) THEN
   RAISE EXCEPTION 'inconsistent_accepted_listing' USING ERRCODE='23514';END IF;
 ELSE source_version:=campus.accepted_listing_source(gid);END IF;
 INSERT INTO campus.agreement_terms(agreement_id,revision,terms,origin,source_application_id,source_listing_version) VALUES(gid,1,g.terms,provenance,g.application_id,source_version) RETURNING id INTO tid;
 INSERT INTO campus.agreement_milestone_identities(id,agreement_id,position,provenance) SELECT id,gid,position,provenance FROM campus.milestones WHERE agreement_id=gid;
 INSERT INTO campus.agreement_milestone_terms SELECT tid,id,gid,1,position,title,amount_cents,deliverable,acceptance_criteria FROM campus.milestones WHERE agreement_id=gid;
 INSERT INTO campus.agreement_terms_state VALUES(gid,tid,1,tid,1,2);
 RETURN tid;
END $$;
DO $$ DECLARE g uuid; BEGIN FOR g IN SELECT id FROM campus.agreements ORDER BY id LOOP PERFORM campus.initialize_agreement_terms(g,'legacy_snapshot');END LOOP; END $$;
ALTER TABLE campus.milestones ADD CONSTRAINT physical_milestone_identity FOREIGN KEY(id,agreement_id,position) REFERENCES campus.agreement_milestone_identities(id,agreement_id,position) DEFERRABLE INITIALLY DEFERRED;
INSERT INTO campus.submission_terms(submission_id,agreement_id,milestone_id,submission_version,terms_id,terms_revision,provenance)
SELECT s.id,m.agreement_id,m.id,s.version,t.original_terms_id,1,'legacy_original_snapshot_binding' FROM campus.submissions s JOIN campus.milestones m ON m.id=s.milestone_id JOIN campus.agreement_terms_state t ON t.agreement_id=m.agreement_id;

CREATE FUNCTION campus.lock_agreement_amendment(gid uuid) RETURNS campus.agreements LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.agreements; status text;
BEGIN
 IF NOT campus.in_agreement(gid) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agreement:'||gid::text,0));
 SELECT * INTO g FROM campus.agreements WHERE id=gid FOR UPDATE;
 SELECT account_status INTO status FROM campus.users WHERE id=campus.actor() FOR UPDATE;
 PERFORM user_id FROM campus.affiliations WHERE user_id=campus.actor() FOR SHARE;
 IF status IS NULL OR status='locked' THEN RAISE EXCEPTION 'account_locked' USING ERRCODE='P0001'; END IF;
 IF status<>'active' THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.affiliations f JOIN campus.domains d ON d.domain=f.domain AND d.institution_id=f.institution_id JOIN campus.institutions i ON i.id=f.institution_id WHERE f.user_id=campus.actor() AND f.valid_until>clock_timestamp() AND d.enabled AND i.active) THEN RAISE EXCEPTION 'membership_required' USING ERRCODE='P0001'; END IF;
 IF g.owner_id<>campus.actor() AND NOT EXISTS(SELECT 1 FROM campus.agreement_members WHERE agreement_id=gid AND user_id=campus.actor()) THEN RAISE EXCEPTION 'not_party' USING ERRCODE='P0001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.agreement_members WHERE agreement_id=gid AND user_id=g.captain_id) THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 PERFORM agreement_id FROM campus.agreement_terms_state WHERE agreement_id=gid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing_agreement_terms' USING ERRCODE='23514'; END IF;
 PERFORM id FROM campus.agreement_amendments WHERE agreement_id=gid ORDER BY id FOR UPDATE;
 RETURN g;
END $$;
CREATE FUNCTION campus.authorize_agreement_amendment(gid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ BEGIN PERFORM campus.lock_agreement_amendment(gid);RETURN gid;END $$;
CREATE FUNCTION campus.require_amendment_enabled() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$ BEGIN IF NOT (SELECT mutations_enabled AND strict_binding FROM campus.agreement_amendment_settings WHERE singleton) THEN RAISE EXCEPTION 'agreement_amendments_unavailable' USING ERRCODE='P0001'; END IF; END $$;
-- Fixed event helper, private to sanctioned functions. Every transition has its own immutable event.
CREATE FUNCTION campus.record_amendment_event(aid uuid,op text,old_state text,new_state text,why text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreement_amendments;eid uuid;seq integer;
BEGIN
 SELECT * INTO a FROM campus.agreement_amendments WHERE id=aid;
 SELECT coalesce(max(sequence),0)+1 INTO seq FROM campus.agreement_amendment_events WHERE agreement_id=a.agreement_id;
 INSERT INTO campus.agreement_amendment_events(agreement_id,sequence,amendment_id,proposal_revision,actor_id,operation,old_status,new_status,reason) VALUES(a.agreement_id,seq,aid,a.current_proposal_revision,campus.actor(),op,old_state,new_state,why) RETURNING id INTO eid;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'agreement.amendment.'||op,aid);
 INSERT INTO campus.events(kind,object_id) VALUES('agreement.amendment.'||op,eid);
 PERFORM campus.emit_notification('amendment:'||eid,'agreement.amendment.'||op,'agreement',a.agreement_id,campus.notification_agreement_people(a.agreement_id),campus.actor());
 INSERT INTO campus.agreement_amendment_notification_context SELECT id,a.agreement_id,aid,a.current_proposal_revision,eid FROM campus.notifications WHERE event_key='amendment:'||eid;
 RETURN eid;
END $$;
-- Extend the existing fixed-kind constraint without changing historic notifications.
DO $$ DECLARE expr text; BEGIN SELECT pg_get_constraintdef(oid) INTO expr FROM pg_constraint WHERE conrelid='campus.notifications'::regclass AND conname='notifications_kind_check'; EXECUTE 'ALTER TABLE campus.notifications DROP CONSTRAINT notifications_kind_check'; EXECUTE 'ALTER TABLE campus.notifications ADD CONSTRAINT notifications_kind_check CHECK ('||substring(expr FROM 8 FOR length(expr)-8)||' OR kind IN (''agreement.amendment.propose'',''agreement.amendment.revise'',''agreement.amendment.confirm'',''agreement.amendment.reject'',''agreement.amendment.withdraw'',''agreement.amendment.effective'',''agreement.amendment.agreed_waiting_funds'',''agreement.amendment.stale_work'',''agreement.amendment.stale_base'',''agreement.amendment.stale_agreement'',''agreement.amendment.materialize'',''agreement.amendment.retire''))'; END $$;
-- Normalize and validate the full client snapshot again at the SQL trust boundary.
-- Only this private helper allocates reserved identities; it never creates work.
CREATE FUNCTION campus.build_amendment_revision(gid uuid,aid uuid,pr integer,request jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE st campus.agreement_terms_state; b campus.agreement_terms; t jsonb:=request->'terms'; item jsonb; resolved jsonb:='[]'; mappings jsonb:='[]'; changes jsonb:='[]'; baseline jsonb:='{}';
 ident campus.agreement_milestone_identities; oldstage campus.agreement_milestone_terms; tid uuid:=gen_random_uuid(); mid uuid; pos integer;
 seen uuid[]:='{}'; added uuid[]:='{}'; retired uuid[]:='{}'; omitted uuid[]:='{}'; changed uuid[]:='{}'; refs text[]:='{}'; total bigint:=0; monetary boolean:=false; same boolean:=true; full_terms jsonb;
BEGIN
 SELECT * INTO st FROM campus.agreement_terms_state WHERE agreement_id=gid;
 SELECT * INTO b FROM campus.agreement_terms WHERE id=st.effective_terms_id;
 IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(t) key) IS DISTINCT FROM ARRAY['currency','description','dueDate','milestones','retireMilestoneIds','rewardCents','taskTitle']::text[] OR t->>'currency' IS DISTINCT FROM 'USD' OR jsonb_typeof(t->'taskTitle') IS DISTINCT FROM 'string' OR jsonb_typeof(t->'description') IS DISTINCT FROM 'string' OR length(btrim(t->>'taskTitle')) NOT BETWEEN 1 AND 160 OR length(btrim(t->>'description')) NOT BETWEEN 1 AND 10000 OR jsonb_typeof(t->'rewardCents') IS DISTINCT FROM 'number' OR (t->>'rewardCents') !~ '^[0-9]+$' OR (t->>'rewardCents')::bigint NOT BETWEEN 1 AND 100000000 OR jsonb_typeof(t->'milestones') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'milestones') NOT BETWEEN 1 AND 20 OR jsonb_typeof(t->'retireMilestoneIds') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'retireMilestoneIds')>20 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 IF t->'dueDate'<>'null'::jsonb THEN
  IF jsonb_typeof(t->'dueDate')<>'string' OR t->>'dueDate' !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' OR to_char((t->>'dueDate')::date,'YYYY-MM-DD')<>t->>'dueDate' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 END IF;
 IF jsonb_typeof(request->'reason') IS DISTINCT FROM 'string' OR length(btrim(request->>'reason')) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(array_agg(x::uuid ORDER BY x::uuid),'{}') INTO retired FROM jsonb_array_elements_text(t->'retireMilestoneIds') x;
 IF cardinality(retired)<>(SELECT count(DISTINCT x) FROM unnest(retired) x) THEN RAISE EXCEPTION 'invalid_milestone_set' USING ERRCODE='P0001'; END IF;
 PERFORM id FROM campus.milestones WHERE agreement_id=gid ORDER BY id FOR UPDATE;
 FOR item IN SELECT * FROM jsonb_array_elements(t->'milestones') LOOP
  IF jsonb_typeof(item)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key) IS DISTINCT FROM (CASE WHEN item?'id' THEN ARRAY['acceptanceCriteria','amountCents','deliverable','id','position','title']::text[] ELSE ARRAY['acceptanceCriteria','amountCents','clientReference','deliverable','title']::text[] END) OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string' OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 160 OR jsonb_typeof(item->'deliverable') IS DISTINCT FROM 'string' OR length(btrim(item->>'deliverable')) NOT BETWEEN 1 AND 10000 OR (item->'acceptanceCriteria'<>'null'::jsonb AND (jsonb_typeof(item->'acceptanceCriteria')<>'string' OR length(btrim(item->>'acceptanceCriteria')) NOT BETWEEN 1 AND 10000)) OR jsonb_typeof(item->'amountCents') IS DISTINCT FROM 'number' OR item->>'amountCents' !~ '^[0-9]+$' OR (item->>'amountCents')::bigint NOT BETWEEN 1 AND 100000000 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
  IF item?'id' THEN
   mid:=(item->>'id')::uuid;SELECT * INTO ident FROM campus.agreement_milestone_identities WHERE id=mid AND agreement_id=gid;
   IF ident.id IS NULL OR jsonb_typeof(item->'position') IS DISTINCT FROM 'number' OR (item->>'position')::integer<>ident.position THEN RAISE EXCEPTION 'invalid_milestone_set' USING ERRCODE='P0001'; END IF;
   pos:=ident.position;
   IF NOT EXISTS(SELECT 1 FROM campus.agreement_milestone_terms WHERE terms_id=st.effective_terms_id AND milestone_id=mid) AND (ident.reserved_by_amendment_id IS DISTINCT FROM aid OR EXISTS(SELECT 1 FROM campus.milestones WHERE id=mid)) THEN RAISE EXCEPTION 'invalid_milestone_set' USING ERRCODE='P0001'; END IF;
  ELSE
   IF jsonb_typeof(item->'clientReference') IS DISTINCT FROM 'string' OR item->>'clientReference' !~ '^[A-Za-z0-9_-]{1,64}$' OR item->>'clientReference'=ANY(refs) THEN RAISE EXCEPTION 'invalid_milestone_set' USING ERRCODE='P0001'; END IF;
   refs:=array_append(refs,item->>'clientReference');mid:=gen_random_uuid();SELECT coalesce(max(position),0)+1 INTO pos FROM campus.agreement_milestone_identities WHERE agreement_id=gid;
   INSERT INTO campus.agreement_milestone_identities VALUES(mid,gid,pos,'amendment_reservation',aid,clock_timestamp());
   mappings:=mappings||jsonb_build_array(jsonb_build_object('clientReference',item->>'clientReference','id',mid,'position',pos));
  END IF;
  IF mid=ANY(seen) OR mid=ANY(retired) THEN RAISE EXCEPTION 'invalid_milestone_set' USING ERRCODE='P0001'; END IF;
  seen:=array_append(seen,mid);total:=total+(item->>'amountCents')::integer;
  SELECT * INTO oldstage FROM campus.agreement_milestone_terms WHERE terms_id=st.effective_terms_id AND milestone_id=mid;
  IF oldstage.milestone_id IS NULL THEN added:=array_append(added,mid);monetary:=true;same:=false;changes:=changes||jsonb_build_array('milestones.'||mid::text||'.added');
  ELSE
   IF (oldstage.title,oldstage.amount_cents,oldstage.deliverable,oldstage.acceptance_criteria) IS DISTINCT FROM (btrim(item->>'title'),(item->>'amountCents')::integer,btrim(item->>'deliverable'),btrim(item->>'acceptanceCriteria')) THEN
    IF EXISTS(SELECT 1 FROM campus.submissions WHERE milestone_id=mid) THEN RAISE EXCEPTION 'protected_milestone' USING ERRCODE='P0001'; END IF;
    same:=false;changed:=array_append(changed,mid);changes:=changes||jsonb_build_array('milestones.'||mid::text);
    baseline:=baseline||jsonb_build_object(mid::text,(SELECT jsonb_build_object('version',version,'revision',revision) FROM campus.milestones WHERE id=mid));
   END IF;
   monetary:=monetary OR oldstage.amount_cents<>(item->>'amountCents')::integer;
  END IF;
  resolved:=resolved||jsonb_build_array(jsonb_build_object('id',mid,'position',pos,'title',btrim(item->>'title'),'amountCents',(item->>'amountCents')::integer,'deliverable',btrim(item->>'deliverable'),'acceptanceCriteria',btrim(item->>'acceptanceCriteria')));
 END LOOP;
 SELECT coalesce(array_agg(milestone_id ORDER BY milestone_id),'{}') INTO omitted FROM campus.agreement_milestone_terms WHERE terms_id=st.effective_terms_id AND NOT milestone_id=ANY(seen);
 IF retired IS DISTINCT FROM omitted THEN RAISE EXCEPTION 'invalid_milestone_set' USING ERRCODE='P0001'; END IF;
 FOREACH mid IN ARRAY retired LOOP
  IF EXISTS(SELECT 1 FROM campus.submissions WHERE milestone_id=mid) OR EXISTS(SELECT 1 FROM campus.milestones WHERE id=mid AND state<>'pending') THEN RAISE EXCEPTION 'protected_milestone' USING ERRCODE='P0001'; END IF;
  changed:=array_append(changed,mid);changes:=changes||jsonb_build_array('milestones.'||mid::text||'.retired');baseline:=baseline||jsonb_build_object(mid::text,(SELECT jsonb_build_object('version',version,'revision',revision) FROM campus.milestones WHERE id=mid));
 END LOOP;
 IF cardinality(retired)>0 THEN monetary:=true;same:=false;END IF;
 IF total<>(t->>'rewardCents')::bigint THEN RAISE EXCEPTION 'invalid_milestone_budget' USING ERRCODE='P0001'; END IF;
 IF (b.terms->>'taskTitle',b.terms->>'description',b.terms->>'dueDate') IS DISTINCT FROM (btrim(t->>'taskTitle'),btrim(t->>'description'),t->>'dueDate') THEN same:=false;END IF;
 IF b.terms->>'taskTitle' IS DISTINCT FROM btrim(t->>'taskTitle') THEN changes:=changes||'"taskTitle"'::jsonb;END IF;
 IF b.terms->>'description' IS DISTINCT FROM btrim(t->>'description') THEN changes:=changes||'"description"'::jsonb;END IF;
 IF b.terms->>'dueDate' IS DISTINCT FROM t->>'dueDate' THEN changes:=changes||'"dueDate"'::jsonb;END IF;
 IF (b.terms->>'rewardCents')::integer<>total THEN changes:=changes||'"rewardCents"'::jsonb;monetary:=true;same:=false;END IF;
 IF same THEN RAISE EXCEPTION 'no_change' USING ERRCODE='P0001'; END IF;
 -- Retain server-owned fields from the base raw snapshot. Read models use the
 -- explicit sidecar mapping; original JSON is never normalized in place.
 full_terms:=b.terms||jsonb_build_object('taskTitle',btrim(t->>'taskTitle'),'description',btrim(t->>'description'),'dueDate',t->'dueDate','rewardCents',total,'currency','USD','milestones',resolved);
 INSERT INTO campus.agreement_terms(id,agreement_id,revision,terms,origin,source_application_id,source_listing_version,amendment_id,proposal_revision) VALUES(tid,gid,st.next_terms_revision,full_terms,'amendment',b.source_application_id,b.source_listing_version,aid,pr);
 INSERT INTO campus.agreement_milestone_terms SELECT tid,(x->>'id')::uuid,gid,st.next_terms_revision,(x->>'position')::integer,x->>'title',(x->>'amountCents')::integer,x->>'deliverable',x->>'acceptanceCriteria' FROM jsonb_array_elements(resolved) x;
 INSERT INTO campus.agreement_amendment_revisions VALUES(aid,pr,gid,tid,st.next_terms_revision,st.effective_terms_id,st.effective_revision,campus.actor(),btrim(request->>'reason'),clock_timestamp(),changes,changed,baseline,added,retired,monetary);
 UPDATE campus.agreement_terms_state SET next_terms_revision=next_terms_revision+1 WHERE agreement_id=gid;
 RETURN jsonb_build_object('termsId',tid,'termsRevision',st.next_terms_revision,'newMilestoneIds',mappings);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';
END $$;
CREATE FUNCTION campus.require_amendment_base(gid uuid,request jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE s campus.agreement_terms_state;
BEGIN SELECT * INTO s FROM campus.agreement_terms_state WHERE agreement_id=gid;
 IF request->>'expectedEffectiveTermsId' IS DISTINCT FROM s.effective_terms_id::text OR request->>'expectedEffectiveRevision' IS DISTINCT FROM s.effective_revision::text THEN RAISE EXCEPTION 'stale_effective_revision' USING ERRCODE='P0001';END IF;
 IF (SELECT state FROM campus.agreements WHERE id=gid) NOT IN('active','awaiting_funding') THEN RAISE EXCEPTION 'agreement_closed' USING ERRCODE='P0001';END IF;
END $$;
CREATE FUNCTION campus.propose_agreement_amendment(gid uuid,unused uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE aid uuid:=gen_random_uuid();s campus.agreement_terms_state;r jsonb;eid uuid;seq integer;
BEGIN
 PERFORM campus.lock_agreement_amendment(gid);PERFORM campus.require_amendment_enabled();PERFORM campus.require_amendment_base(gid,request);
 IF unused IS NOT NULL OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(request) key) IS DISTINCT FROM ARRAY['expectedEffectiveRevision','expectedEffectiveTermsId','reason','terms']::text[] THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT 1 FROM campus.agreement_amendments WHERE agreement_id=gid AND status IN('pending','agreed_waiting_funds')) THEN RAISE EXCEPTION 'live_amendment_exists' USING ERRCODE='P0001';END IF;
 SELECT * INTO s FROM campus.agreement_terms_state WHERE agreement_id=gid;SELECT coalesce(max(sequence),0)+1 INTO seq FROM campus.agreement_amendment_events WHERE agreement_id=gid;
 INSERT INTO campus.agreement_amendments(id,agreement_id,proposer_id,base_terms_id,base_effective_revision,current_proposal_revision,status,created_sequence) VALUES(aid,gid,campus.actor(),s.effective_terms_id,s.effective_revision,1,'pending',seq);
 r:=campus.build_amendment_revision(gid,aid,1,request);eid:=campus.record_amendment_event(aid,'propose',NULL,'pending');
 RETURN r||jsonb_build_object('operation','propose','agreementId',gid,'amendmentId',aid,'proposalRevision',1,'eventId',eid,'outcomeAtCommit','pending');
END $$;
CREATE FUNCTION campus.revise_agreement_amendment(gid uuid,aid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreement_amendments;r jsonb;eid uuid;
BEGIN
 PERFORM campus.lock_agreement_amendment(gid);PERFORM campus.require_amendment_enabled();PERFORM campus.require_amendment_base(gid,request);
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(request) key) IS DISTINCT FROM ARRAY['expectedEffectiveRevision','expectedEffectiveTermsId','expectedProposalRevision','reason','terms']::text[] THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 SELECT * INTO a FROM campus.agreement_amendments WHERE id=aid AND agreement_id=gid;
 IF a.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF a.proposer_id<>campus.actor() THEN RAISE EXCEPTION 'not_proposer' USING ERRCODE='P0001';END IF;
 IF request->>'expectedProposalRevision' IS DISTINCT FROM a.current_proposal_revision::text THEN RAISE EXCEPTION 'stale_proposal_revision' USING ERRCODE='P0001';END IF;
 IF a.status NOT IN('pending','agreed_waiting_funds') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001';END IF;
 r:=campus.build_amendment_revision(gid,aid,a.current_proposal_revision+1,request);
 UPDATE campus.agreement_amendments SET current_proposal_revision=current_proposal_revision+1,status='pending' WHERE id=aid;
 eid:=campus.record_amendment_event(aid,'revise',a.status,'pending');
 RETURN r||jsonb_build_object('operation','revise','agreementId',gid,'amendmentId',aid,'proposalRevision',a.current_proposal_revision+1,'eventId',eid,'outcomeAtCommit','pending');
END $$;
-- A structural effect validator is provided for future reviewed funding integration,
-- but no callable funding/effect bypass is granted to an application role.
CREATE FUNCTION campus.validate_amendment_effect(aid uuid,pr integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.agreement_amendment_revisions;s campus.agreement_terms_state;
BEGIN
 SELECT * INTO r FROM campus.agreement_amendment_revisions WHERE amendment_id=aid AND proposal_revision=pr;IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT * INTO s FROM campus.agreement_terms_state WHERE agreement_id=r.agreement_id;
 IF (s.effective_terms_id,s.effective_revision) IS DISTINCT FROM (r.base_terms_id,r.base_effective_revision) THEN RAISE EXCEPTION 'stale_effective_revision' USING ERRCODE='P0001';END IF;
 PERFORM id FROM campus.milestones WHERE agreement_id=r.agreement_id ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM campus.submissions WHERE milestone_id=ANY(r.changed_milestone_ids)) OR EXISTS(SELECT 1 FROM campus.milestones m WHERE m.id=ANY(r.changed_milestone_ids) AND (m.version<>(r.work_baseline->m.id::text->>'version')::integer OR m.revision<>(r.work_baseline->m.id::text->>'revision')::integer)) THEN RAISE EXCEPTION 'stale_work' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.milestones WHERE id=ANY(r.retired_milestone_ids) AND state<>'pending') OR EXISTS(SELECT 1 FROM campus.agreement_milestone_identities i WHERE i.id=ANY(r.added_milestone_ids) AND (i.agreement_id<>r.agreement_id OR i.reserved_by_amendment_id IS DISTINCT FROM aid OR EXISTS(SELECT 1 FROM campus.milestones WHERE id=i.id))) THEN RAISE EXCEPTION 'invalid_milestone_set' USING ERRCODE='P0001';END IF;
END $$;
CREATE FUNCTION campus.exact_amendment_revision(gid uuid,aid uuid,request jsonb) RETURNS campus.agreement_amendment_revisions LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreement_amendments;r campus.agreement_amendment_revisions;
BEGIN
 SELECT * INTO a FROM campus.agreement_amendments WHERE id=aid AND agreement_id=gid;IF a.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF request->>'expectedProposalRevision' IS DISTINCT FROM a.current_proposal_revision::text THEN RAISE EXCEPTION 'stale_proposal_revision' USING ERRCODE='P0001';END IF;
 SELECT * INTO r FROM campus.agreement_amendment_revisions WHERE amendment_id=aid AND proposal_revision=a.current_proposal_revision;
 IF (request->>'proposedTermsId',request->>'proposedTermsRevision',request->>'expectedEffectiveTermsId',request->>'expectedEffectiveRevision') IS DISTINCT FROM (r.terms_id::text,r.terms_revision::text,r.base_terms_id::text,r.base_effective_revision::text) THEN RAISE EXCEPTION 'stale_proposal_revision' USING ERRCODE='P0001';END IF;
 RETURN r;
END $$;
CREATE FUNCTION campus.confirm_agreement_amendment(gid uuid,aid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreement_amendments;r campus.agreement_amendment_revisions;eid uuid;existing campus.agreement_amendment_confirmations;outcome text;
BEGIN
 PERFORM campus.lock_agreement_amendment(gid);PERFORM campus.require_amendment_enabled();
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(request) key) IS DISTINCT FROM ARRAY['expectedEffectiveRevision','expectedEffectiveTermsId','expectedProposalRevision','proposedTermsId','proposedTermsRevision']::text[] THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';END IF;
 r:=campus.exact_amendment_revision(gid,aid,request);SELECT * INTO a FROM campus.agreement_amendments WHERE id=aid;
 SELECT * INTO existing FROM campus.agreement_amendment_confirmations WHERE amendment_id=aid AND proposal_revision=r.proposal_revision AND user_id=campus.actor();
 IF existing.user_id IS NOT NULL THEN
  SELECT new_status INTO outcome FROM campus.agreement_amendment_events WHERE id=existing.event_id;
  RETURN jsonb_build_object('operation','confirm','agreementId',gid,'amendmentId',aid,'proposalRevision',r.proposal_revision,'termsId',r.terms_id,'termsRevision',r.terms_revision,'eventId',existing.event_id,'confirmation',jsonb_build_object('amendmentId',aid,'proposalRevision',r.proposal_revision,'userId',campus.actor()),'outcomeAtCommit',outcome);
 END IF;
 PERFORM campus.require_amendment_base(gid,request);
 IF a.status NOT IN('pending','agreed_waiting_funds') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001';END IF;
 PERFORM campus.validate_amendment_effect(aid,r.proposal_revision);
 -- Determine the transition before appending the confirmation receipt; the
 -- event retains the final outcome even when the final actor retries later.
 outcome:='pending';
 IF NOT EXISTS(SELECT 1 FROM unnest(campus.notification_agreement_people(gid)) p WHERE p<>campus.actor() AND NOT EXISTS(SELECT 1 FROM campus.agreement_amendment_confirmations f WHERE f.amendment_id=aid AND f.proposal_revision=r.proposal_revision AND f.user_id=p)) THEN outcome:=CASE WHEN r.allocation_changed THEN 'agreed_waiting_funds' ELSE 'effective' END;END IF;
 eid:=campus.record_amendment_event(aid,'confirm',a.status,outcome);
 INSERT INTO campus.agreement_amendment_confirmations VALUES(aid,r.proposal_revision,campus.actor(),gid,r.terms_id,r.terms_revision,r.base_terms_id,r.base_effective_revision,clock_timestamp(),eid);
 IF outcome<>'pending' THEN
  UPDATE campus.agreement_amendments SET status=outcome WHERE id=aid;
  IF outcome='effective' THEN
   -- No monetary/structural mutation can reach this branch.
   IF cardinality(r.added_milestone_ids)>0 OR cardinality(r.retired_milestone_ids)>0 OR r.allocation_changed THEN RAISE EXCEPTION 'funding_authority_unavailable' USING ERRCODE='P0001';END IF;
   UPDATE campus.agreement_terms_state SET effective_terms_id=r.terms_id,effective_revision=r.terms_revision WHERE agreement_id=gid;
  END IF;
  PERFORM campus.record_amendment_event(aid,outcome,a.status,outcome);
 END IF;
 RETURN jsonb_build_object('operation','confirm','agreementId',gid,'amendmentId',aid,'proposalRevision',r.proposal_revision,'termsId',r.terms_id,'termsRevision',r.terms_revision,'eventId',eid,'confirmation',jsonb_build_object('amendmentId',aid,'proposalRevision',r.proposal_revision,'userId',campus.actor()),'outcomeAtCommit',outcome);
END $$;
-- Private bounded end transition; only the two purpose-specific wrappers are granted.
CREATE FUNCTION campus.end_agreement_amendment(gid uuid,aid uuid,request jsonb,op text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreement_amendments;r campus.agreement_amendment_revisions;eid uuid;outcome text;
BEGIN
 PERFORM campus.lock_agreement_amendment(gid);PERFORM campus.require_amendment_enabled();PERFORM campus.require_amendment_base(gid,request);
 IF op NOT IN('reject','withdraw') OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(request) key) IS DISTINCT FROM ARRAY['expectedEffectiveRevision','expectedEffectiveTermsId','expectedProposalRevision','proposedTermsId','proposedTermsRevision','reason']::text[] OR jsonb_typeof(request->'reason') IS DISTINCT FROM 'string' OR length(btrim(request->>'reason')) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';END IF;
 r:=campus.exact_amendment_revision(gid,aid,request);SELECT * INTO a FROM campus.agreement_amendments WHERE id=aid;
 IF op='withdraw' AND a.proposer_id<>campus.actor() THEN RAISE EXCEPTION 'not_proposer' USING ERRCODE='P0001';END IF;
 IF a.status NOT IN('pending','agreed_waiting_funds') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001';END IF;
 outcome:=CASE WHEN op='reject' THEN 'rejected' ELSE 'withdrawn' END;
 UPDATE campus.agreement_amendments SET status=outcome,terminal_reason=btrim(request->>'reason') WHERE id=aid;
 eid:=campus.record_amendment_event(aid,op,a.status,outcome,btrim(request->>'reason'));
 RETURN jsonb_build_object('operation',op,'agreementId',gid,'amendmentId',aid,'proposalRevision',r.proposal_revision,'termsId',r.terms_id,'termsRevision',r.terms_revision,'eventId',eid,'outcomeAtCommit',outcome);
END $$;
CREATE FUNCTION campus.reject_agreement_amendment(gid uuid,aid uuid,request jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT campus.end_agreement_amendment(gid,aid,request,'reject') $$;
CREATE FUNCTION campus.withdraw_agreement_amendment(gid uuid,aid uuid,request jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT campus.end_agreement_amendment(gid,aid,request,'withdraw') $$;
CREATE FUNCTION campus.invalidate_work_amendment(gid uuid,mid uuid,completed boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreement_amendments;next_state text;
BEGIN
 SELECT * INTO a FROM campus.agreement_amendments WHERE agreement_id=gid AND status IN('pending','agreed_waiting_funds');IF a.id IS NULL THEN RETURN;END IF;
 IF completed THEN next_state:='stale_agreement';ELSIF EXISTS(SELECT 1 FROM campus.agreement_amendment_revisions WHERE amendment_id=a.id AND proposal_revision=a.current_proposal_revision AND mid=ANY(changed_milestone_ids)) THEN next_state:='stale_work';ELSE RETURN;END IF;
 UPDATE campus.agreement_amendments SET status=next_state WHERE id=a.id;PERFORM campus.record_amendment_event(a.id,next_state,a.status,next_state);
END $$;

-- Replacements preserve original acceptance/listing guards and work contracts.
CREATE OR REPLACE FUNCTION campus.accept_task_invitation(application_uuid uuid) RETURNS uuid
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
 PERFORM campus.initialize_agreement_terms(agreement_uuid,'accepted_application');
 UPDATE campus.tasks SET status='contracted',revision=revision+1 WHERE id=t.id;
 UPDATE campus.applications SET state='accepted' WHERE id=a.id;
 PERFORM campus.supersede_other_applications(a.id);
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'application.accept',agreement_uuid);
 INSERT INTO campus.events(kind,object_id) VALUES('application.accept',agreement_uuid);
 RETURN agreement_uuid;
END $$;
CREATE OR REPLACE FUNCTION campus.lock_work_agreement(agreement_uuid uuid,operation text) RETURNS campus.agreements
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
 PERFORM agreement_id FROM campus.agreement_terms_state WHERE agreement_id=agreement_uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'missing_agreement_terms' USING ERRCODE='23514';END IF;
 PERFORM id FROM campus.agreement_amendments WHERE agreement_id=agreement_uuid ORDER BY id FOR UPDATE;
 RETURN a;
END $$;
CREATE OR REPLACE FUNCTION campus.submit_milestone_work(milestone_uuid uuid,expected_version integer,expected_revision integer,content_value text,expected_terms_id uuid,expected_terms_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE m campus.milestones; a campus.agreements; agreement_uuid uuid; submission_uuid uuid; cleaned text; terms_state campus.agreement_terms_state; binding text;
BEGIN
 cleaned:=regexp_replace(content_value,'^\s+|\s+$','','g');
 IF expected_version IS NULL OR expected_version<0 OR expected_revision IS NULL OR expected_revision<1 OR cleaned IS NULL OR length(cleaned) NOT BETWEEN 1 AND 10000
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT agreement_id INTO agreement_uuid FROM campus.milestones WHERE id=milestone_uuid;
 IF agreement_uuid IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 a:=campus.lock_work_agreement(agreement_uuid,'submit');
 SELECT * INTO terms_state FROM campus.agreement_terms_state WHERE agreement_id=agreement_uuid;
 IF expected_terms_id IS NULL OR expected_terms_revision IS NULL THEN
  IF (SELECT strict_binding FROM campus.agreement_amendment_settings WHERE singleton) OR terms_state.effective_revision<>1 OR EXISTS(SELECT 1 FROM campus.agreement_amendments WHERE agreement_id=agreement_uuid) THEN RAISE EXCEPTION 'terms_refresh_required' USING ERRCODE='P0001';END IF;
  IF expected_terms_id IS NOT NULL OR expected_terms_revision IS NOT NULL THEN RAISE EXCEPTION 'terms_refresh_required' USING ERRCODE='P0001';END IF;
  binding:='legacy_client_original_binding';
 ELSE
  IF (expected_terms_id,expected_terms_revision) IS DISTINCT FROM (terms_state.effective_terms_id,terms_state.effective_revision) THEN RAISE EXCEPTION 'stale_effective_revision' USING ERRCODE='P0001';END IF;
  binding:='explicit_terms_binding';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.agreement_milestone_terms WHERE terms_id=terms_state.effective_terms_id AND milestone_id=milestone_uuid) THEN RAISE EXCEPTION 'milestone_retired' USING ERRCODE='P0001';END IF;
 SELECT * INTO m FROM campus.milestones WHERE id=milestone_uuid FOR UPDATE;
 IF m.version<>expected_version OR m.revision<>expected_revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001'; END IF;
 IF a.state='awaiting_funding' THEN RAISE EXCEPTION 'funding_required' USING ERRCODE='P0001'; END IF;
 IF a.state<>'active' OR m.state='accepted' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 INSERT INTO campus.submissions(milestone_id,author_id,version,content) VALUES(m.id,campus.actor(),m.version+1,cleaned) RETURNING id INTO submission_uuid;
 INSERT INTO campus.submission_terms VALUES(submission_uuid,agreement_uuid,m.id,m.version+1,terms_state.effective_terms_id,terms_state.effective_revision,binding,clock_timestamp());
 PERFORM campus.invalidate_work_amendment(agreement_uuid,m.id,false);
 UPDATE campus.milestones SET version=version+1,revision=revision+1,state='submitted',latest_submission_id=submission_uuid WHERE id=m.id;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'milestone.submit',submission_uuid);
 INSERT INTO campus.events(kind,object_id) VALUES('milestone.submit',submission_uuid);
 RETURN submission_uuid;
END $$;
CREATE OR REPLACE FUNCTION campus.review_milestone_work(milestone_uuid uuid,submission_uuid uuid,expected_version integer,expected_revision integer,decision_value text,feedback_value text,expected_terms_id uuid,expected_terms_revision integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE m campus.milestones; a campus.agreements; agreement_uuid uuid; review_uuid uuid; cleaned text; bound campus.submission_terms;
BEGIN
 cleaned:=regexp_replace(feedback_value,'^\s+|\s+$','','g');
 IF submission_uuid IS NULL OR expected_version IS NULL OR expected_version<1 OR expected_revision IS NULL OR expected_revision<1 OR
 decision_value IS NULL OR decision_value NOT IN ('revision_requested','accepted') OR cleaned IS NULL OR length(cleaned)>10000 OR
 (decision_value='revision_requested' AND length(cleaned)=0) OR (decision_value='accepted' AND cleaned<>'')
 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 SELECT agreement_id INTO agreement_uuid FROM campus.milestones WHERE id=milestone_uuid;
 IF agreement_uuid IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 a:=campus.lock_work_agreement(agreement_uuid,'review');
 SELECT * INTO bound FROM campus.submission_terms WHERE submission_id=submission_uuid AND agreement_id=agreement_uuid AND milestone_id=milestone_uuid;
 IF bound.submission_id IS NULL THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF expected_terms_id IS NULL OR expected_terms_revision IS NULL THEN
  IF (SELECT strict_binding FROM campus.agreement_amendment_settings WHERE singleton) OR (SELECT effective_revision<>1 FROM campus.agreement_terms_state WHERE agreement_id=agreement_uuid) OR EXISTS(SELECT 1 FROM campus.agreement_amendments WHERE agreement_id=agreement_uuid) OR expected_terms_id IS NOT NULL OR expected_terms_revision IS NOT NULL THEN RAISE EXCEPTION 'terms_refresh_required' USING ERRCODE='P0001';END IF;
 ELSIF (expected_terms_id,expected_terms_revision) IS DISTINCT FROM (bound.terms_id,bound.terms_revision) THEN RAISE EXCEPTION 'stale_effective_revision' USING ERRCODE='P0001';END IF;
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
 IF decision_value='accepted' AND NOT EXISTS(SELECT 1 FROM campus.milestones stage JOIN campus.agreement_terms_state ts ON ts.agreement_id=stage.agreement_id JOIN campus.agreement_milestone_terms mt ON mt.terms_id=ts.effective_terms_id AND mt.milestone_id=stage.id WHERE stage.agreement_id=a.id AND stage.state<>'accepted') THEN
   PERFORM campus.invalidate_work_amendment(a.id,NULL,true);
   UPDATE campus.agreements SET state='completed' WHERE id=a.id;
   INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'agreement.completed',a.id);
   INSERT INTO campus.events(kind,object_id) VALUES('agreement.completed',a.id);
 END IF;
 RETURN review_uuid;
END $$;
CREATE OR REPLACE FUNCTION campus.complete_work_agreement(agreement_uuid uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreements;
BEGIN
 a:=campus.lock_work_agreement(agreement_uuid,'complete');
 IF a.state='awaiting_funding' THEN RAISE EXCEPTION 'funding_required' USING ERRCODE='P0001'; END IF;
 IF a.state<>'active' OR NOT EXISTS(SELECT 1 FROM campus.milestones m JOIN campus.agreement_terms_state ts ON ts.agreement_id=m.agreement_id JOIN campus.agreement_milestone_terms mt ON mt.terms_id=ts.effective_terms_id AND mt.milestone_id=m.id WHERE m.agreement_id=a.id) OR
 EXISTS(SELECT 1 FROM campus.milestones stage JOIN campus.agreement_terms_state ts ON ts.agreement_id=stage.agreement_id JOIN campus.agreement_milestone_terms mt ON mt.terms_id=ts.effective_terms_id AND mt.milestone_id=stage.id WHERE stage.agreement_id=a.id AND stage.state<>'accepted')
 THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 PERFORM campus.invalidate_work_amendment(a.id,NULL,true);
 UPDATE campus.agreements SET state='completed' WHERE id=a.id;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'agreement.completed',a.id);
 INSERT INTO campus.events(kind,object_id) VALUES('agreement.completed',a.id);
 RETURN a.id;
END $$;
CREATE OR REPLACE FUNCTION campus.submit_milestone_work(milestone_uuid uuid,expected_version integer,expected_revision integer,content_value text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT campus.submit_milestone_work(milestone_uuid,expected_version,expected_revision,content_value,NULL,NULL) $$;
CREATE OR REPLACE FUNCTION campus.review_milestone_work(milestone_uuid uuid,submission_uuid uuid,expected_version integer,expected_revision integer,decision_value text,feedback_value text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT campus.review_milestone_work(milestone_uuid,submission_uuid,expected_version,expected_revision,decision_value,feedback_value,NULL,NULL) $$;
-- Explicitly revoke the default PUBLIC function execution for every 017 helper.
REVOKE ALL ON FUNCTION campus.guard_agreement_binding_latch() FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.agreement_amendment_capabilities() FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.immutable_agreement_history() FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.validate_legacy_agreement_snapshot(jsonb,jsonb,uuid[],uuid,uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.agreement_matches_listing(jsonb,jsonb),campus.accepted_listing_source(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.initialize_agreement_terms(uuid,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.lock_agreement_amendment(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.authorize_agreement_amendment(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.require_amendment_enabled() FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.record_amendment_event(uuid,text,text,text,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.build_amendment_revision(uuid,uuid,integer,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.require_amendment_base(uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.propose_agreement_amendment(uuid,uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.revise_agreement_amendment(uuid,uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.validate_amendment_effect(uuid,integer) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.exact_amendment_revision(uuid,uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.confirm_agreement_amendment(uuid,uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.end_agreement_amendment(uuid,uuid,jsonb,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.reject_agreement_amendment(uuid,uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.withdraw_agreement_amendment(uuid,uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.invalidate_work_amendment(uuid,uuid,boolean) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.accept_task_invitation(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.lock_work_agreement(uuid,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.submit_milestone_work(uuid,integer,integer,text,uuid,integer) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.review_milestone_work(uuid,uuid,integer,integer,text,text,uuid,integer) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.complete_work_agreement(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.submit_milestone_work(uuid,integer,integer,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
REVOKE ALL ON FUNCTION campus.review_milestone_work(uuid,uuid,integer,integer,text,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.agreement_amendment_capabilities() TO campus_app;
GRANT EXECUTE ON FUNCTION campus.authorize_agreement_amendment(uuid) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.propose_agreement_amendment(uuid,uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.revise_agreement_amendment(uuid,uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.confirm_agreement_amendment(uuid,uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.reject_agreement_amendment(uuid,uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.withdraw_agreement_amendment(uuid,uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.accept_task_invitation(uuid) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.submit_milestone_work(uuid,integer,integer,text) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.submit_milestone_work(uuid,integer,integer,text,uuid,integer) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.review_milestone_work(uuid,uuid,integer,integer,text,text) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.review_milestone_work(uuid,uuid,integer,integer,text,text,uuid,integer) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.complete_work_agreement(uuid) TO campus_app;
