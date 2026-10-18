-- Additive terms/consent only. No money execution or provider authority.
SET LOCAL lock_timeout='5s';
ALTER TABLE campus.tasks ADD COLUMN release_policy text CHECK(release_policy IN('per_milestone','final_completion'));
CREATE TABLE campus.payment_policy_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id uuid NOT NULL REFERENCES campus.applications,
 listing_version integer NOT NULL, status text NOT NULL CHECK(status IN('pending','approved')),
 provenance text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,application_id,listing_version)
);
-- No default policy and no app/worker approval or fee setter. Scenario policies must be scoped to one application.
CREATE TABLE campus.application_allocation_revisions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL REFERENCES campus.applications,
 revision integer NOT NULL CHECK(revision>0), listing_version integer NOT NULL, task_revision integer NOT NULL,
 proposer_id uuid NOT NULL REFERENCES campus.users,ratios jsonb NOT NULL, plan jsonb NOT NULL, digest text NOT NULL,
 policy_id uuid, policy_snapshot jsonb, previous_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(application_id,revision),UNIQUE(id,application_id),UNIQUE(id,application_id,revision),
 FOREIGN KEY(policy_id,application_id,listing_version) REFERENCES campus.payment_policy_versions(id,application_id,listing_version),
 FOREIGN KEY(previous_id,application_id) REFERENCES campus.application_allocation_revisions(id,application_id)
);
CREATE TABLE campus.application_allocation_confirmations(
 application_id uuid NOT NULL,allocation_id uuid NOT NULL,allocation_revision integer NOT NULL,
 user_id uuid NOT NULL REFERENCES campus.users,digest text NOT NULL,consent_kind text NOT NULL CHECK(consent_kind IN('ratios_only','financial_terms')),
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(allocation_id,user_id),
 FOREIGN KEY(allocation_id,application_id,allocation_revision) REFERENCES campus.application_allocation_revisions(id,application_id,revision)
);
CREATE TABLE campus.agreement_transaction_terms(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agreement_id uuid NOT NULL REFERENCES campus.agreements,
 revision integer NOT NULL DEFAULT 1,application_id uuid NOT NULL, allocation_id uuid NOT NULL,allocation_revision integer NOT NULL,
 listing_version integer NOT NULL,release_policy text NOT NULL CHECK(release_policy IN('per_milestone','final_completion')),
 policy_id uuid NOT NULL,policy_snapshot jsonb,plan jsonb NOT NULL,digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,agreement_id,revision),UNIQUE(agreement_id,revision),
 FOREIGN KEY(allocation_id,application_id,allocation_revision) REFERENCES campus.application_allocation_revisions(id,application_id,revision),
 FOREIGN KEY(policy_id,application_id,listing_version) REFERENCES campus.payment_policy_versions(id,application_id,listing_version)
);
CREATE TABLE campus.agreement_transaction_bindings(
 agreement_id uuid NOT NULL,terms_id uuid NOT NULL,terms_revision integer NOT NULL,
 transaction_terms_id uuid NOT NULL,transaction_terms_revision integer NOT NULL,provenance text NOT NULL,
 PRIMARY KEY(agreement_id,terms_id),
 FOREIGN KEY(terms_id,agreement_id,terms_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision),
 FOREIGN KEY(transaction_terms_id,agreement_id,transaction_terms_revision) REFERENCES campus.agreement_transaction_terms(id,agreement_id,revision)
);
CREATE TABLE campus.payee_allocations(
 component_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),funding_plan_lot_id uuid NOT NULL,source_plan_revision integer NOT NULL CHECK(source_plan_revision>0),
 agreement_id uuid NOT NULL,transaction_terms_id uuid NOT NULL,transaction_terms_revision integer NOT NULL,
 terms_id uuid NOT NULL,milestone_id uuid NOT NULL,member_id uuid NOT NULL REFERENCES campus.users,
 stage_position integer NOT NULL,gross_cents integer NOT NULL CHECK(gross_cents>=0),recipient_fee_cents integer NOT NULL CHECK(recipient_fee_cents>=0),
 net_cents integer NOT NULL CHECK(net_cents>=0 AND net_cents+recipient_fee_cents=gross_cents),
 PRIMARY KEY(transaction_terms_id,funding_plan_lot_id,milestone_id,member_id),
 FOREIGN KEY(transaction_terms_id,agreement_id,transaction_terms_revision) REFERENCES campus.agreement_transaction_terms(id,agreement_id,revision),
 FOREIGN KEY(terms_id,milestone_id) REFERENCES campus.agreement_milestone_terms(terms_id,milestone_id),
 FOREIGN KEY(milestone_id,agreement_id,stage_position) REFERENCES campus.agreement_milestone_identities(id,agreement_id,position),
 FOREIGN KEY(agreement_id,member_id) REFERENCES campus.agreement_members(agreement_id,user_id)
);
CREATE FUNCTION campus.transaction_terms_capabilities() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('transactionTerms',true,'transactionSchemaRequirement',18,'financialExecution',false,'feeEstimate','pending_policy','fullUpfront',true,'platformServiceFeeCents',0)
$$;
CREATE FUNCTION campus.transaction_canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||campus.transaction_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v);
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(campus.transaction_canonical(value),',' ORDER BY ord),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY a(value,ord);
 ELSE result:=v::text; END CASE;
 RETURN result;
END $$;
CREATE FUNCTION campus.transaction_lr(amount bigint,weights bigint[],keys text[]) RETURNS bigint[] LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE total numeric; result bigint[]; remaining bigint; i integer;
BEGIN
 IF amount IS NULL OR amount<0 OR amount>100000000 OR cardinality(weights)<>cardinality(keys) OR EXISTS(SELECT 1 FROM unnest(weights) w WHERE w IS NULL OR w<0 OR w>100000000) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(sum(w),0) INTO total FROM unnest(weights) w;
 IF total=0 THEN IF amount<>0 THEN RAISE EXCEPTION 'fee_exceeds_component' USING ERRCODE='P0001'; END IF; RETURN array_fill(0::bigint,ARRAY[cardinality(weights)]); END IF;
 SELECT array_agg(floor(amount::numeric*w/total)::bigint ORDER BY ord) INTO result FROM unnest(weights) WITH ORDINALITY a(w,ord);
 SELECT amount-sum(v) INTO remaining FROM unnest(result) v;
 FOR i IN SELECT ord::integer FROM unnest(weights) WITH ORDINALITY a(w,ord) WHERE w>0 ORDER BY mod(amount::numeric*w,total) DESC,keys[ord] COLLATE "C" LOOP
  EXIT WHEN remaining=0;result[i]:=result[i]+1;remaining:=remaining-1;
 END LOOP;
 RETURN result;
END $$;
-- Readable policy terms are owner-supplied, immutable, and never inferred from reference IDs.
CREATE FUNCTION campus.transaction_policy_disclosure_valid(payload jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE d jsonb; item jsonb; k text; reference_key text;
BEGIN
 d:=payload->'disclosure';
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->>'format' IS DISTINCT FROM 'transaction_policy_disclosure_v1' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['feeAdjustment','tax','refund'] LOOP
  reference_key:=CASE k WHEN 'feeAdjustment' THEN 'feeAdjustmentPolicyId' WHEN 'tax' THEN 'taxPolicyId' ELSE 'refundPolicyId' END;
  item:=d->k;
  IF jsonb_typeof(item) IS DISTINCT FROM 'object'
   OR jsonb_typeof(item->'policyId') IS DISTINCT FROM 'string' OR length(btrim(item->>'policyId')) NOT BETWEEN 1 AND 200
   OR item->>'policyId' IS DISTINCT FROM payload->>reference_key
   OR jsonb_typeof(item->'version') IS DISTINCT FROM 'string' OR length(btrim(item->>'version')) NOT BETWEEN 1 AND 100
   OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string' OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 200
   OR jsonb_typeof(item->'description') IS DISTINCT FROM 'string' OR length(btrim(item->>'description')) NOT BETWEEN 1 AND 4000
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION campus.transaction_policy_snapshot(policy uuid,aid uuid,version integer) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_policy_versions;
BEGIN
 SELECT * INTO p FROM campus.payment_policy_versions WHERE id=policy AND application_id=aid AND listing_version=version AND status='approved';
 IF p.id IS NULL OR NOT campus.transaction_policy_disclosure_valid(p.payload) THEN RAISE EXCEPTION 'policy_disclosure_pending' USING ERRCODE='P0001'; END IF;
 RETURN jsonb_build_object('policyId',p.id,'provenance',p.provenance,'payload',p.payload);
END $$;
-- SQL recomputes the same algorithm; application-supplied totals never become authority.
CREATE FUNCTION campus.transaction_plan(aid uuid,rs jsonb,lot_id text,policy uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE t campus.tasks; p campus.payment_policy_versions; weights bigint[]; member_keys text[]; stage_keys text[]; positions integer[]; stage_amounts bigint[];
 fee bigint; publisher bigint; recipient bigint; member_fees bigint[]; gross bigint[]; fees bigint[]; allocations bigint[];
 components jsonb:='[]'; plan jsonb; mi integer; si integer; stage_id text;
BEGIN
 SELECT tasks.* INTO t FROM campus.tasks JOIN campus.applications a ON a.task_id=tasks.id WHERE a.id=aid;
 IF policy IS NOT NULL THEN SELECT * INTO p FROM campus.payment_policy_versions WHERE id=policy AND application_id=aid AND listing_version=t.terms_version AND status='approved';
  IF p.id IS NULL OR p.payload->>'kind' IS DISTINCT FROM 'exact_charge_estimate' OR p.payload->>'feeAdjustmentPolicyId' IS NULL OR p.payload->>'taxPolicyId' IS NULL OR p.payload->>'refundPolicyId' IS NULL THEN RAISE EXCEPTION 'fee_policy_pending' USING ERRCODE='P0001'; END IF;
  PERFORM campus.transaction_policy_snapshot(policy,aid,t.terms_version);
  fee:=(p.payload->>'estimatedProcessorFeeCents')::bigint;
  IF fee IS NULL OR fee<0 OR fee>100000000 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
  publisher:=(fee+1)/2;recipient:=fee/2;
  IF (p.payload->>'chargeTotalCents')::bigint IS DISTINCT FROM t.reward_cents+publisher OR t.reward_cents+publisher>100000000 THEN RAISE EXCEPTION 'fee_policy_pending' USING ERRCODE='P0001'; END IF;
 END IF;
 SELECT array_agg((v->>'units')::bigint ORDER BY v->>'memberId'),array_agg(v->>'memberId' ORDER BY v->>'memberId') INTO weights,member_keys FROM jsonb_array_elements(rs) v;
 SELECT array_agg(position ORDER BY position),array_agg(amount_cents::bigint ORDER BY position),array_agg(lpad(position::text,10,'0')||':position:'||position ORDER BY position) INTO positions,stage_amounts,stage_keys FROM campus.task_milestones WHERE task_id=t.id;
 IF recipient IS NOT NULL THEN member_fees:=campus.transaction_lr(recipient,weights,member_keys); END IF;
 FOR mi IN 1..cardinality(member_keys) LOOP
  gross:='{}';
  FOR si IN 1..cardinality(positions) LOOP allocations:=campus.transaction_lr(stage_amounts[si],weights,member_keys);gross:=array_append(gross,allocations[mi]);END LOOP;
  IF recipient IS NOT NULL THEN fees:=campus.transaction_lr(member_fees[mi],gross,stage_keys);END IF;
  FOR si IN 1..cardinality(positions) LOOP
   IF recipient IS NOT NULL AND fees[si]>gross[si] THEN RAISE EXCEPTION 'fee_exceeds_component' USING ERRCODE='P0001'; END IF;
   components:=components||jsonb_build_array(jsonb_build_object('memberId',member_keys[mi],'milestoneId','position:'||positions[si],'stagePosition',positions[si],'grossCents',gross[si],'recipientFeeCents',fees[si],'netCents',gross[si]-fees[si]));
  END LOOP;
 END LOOP;
 plan:=jsonb_build_object('calculationVersion','charge_member_stage_v1','currency','USD','platformServiceFeeCents',0,'roundingRule','largest_remainder_uuid_stage;odd_fee_cent_publisher','members',rs,'lots',jsonb_build_array(jsonb_build_object('fundingPlanLotId',lot_id,'principalCents',t.reward_cents,'estimatedProcessorFeeCents',fee,'publisherProcessorFeeCents',publisher,'recipientProcessorFeeCents',recipient,'chargeTotalCents',t.reward_cents+publisher,'components',components)));
 RETURN plan||jsonb_build_object('digest',encode(sha256(convert_to(campus.transaction_canonical(plan),'UTF8')),'hex'));
END $$;
CREATE FUNCTION campus.propose_application_allocation(aid uuid,body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.applications;t campus.tasks; prior campus.application_allocation_revisions;r campus.application_allocation_revisions;rs jsonb;expected integer; computed jsonb; snapshot jsonb; people uuid[]; proposed uuid[];
BEGIN
 SELECT * INTO a FROM campus.applications WHERE id=aid;
 IF a.id IS NULL OR a.applicant_id IS DISTINCT FROM campus.actor() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||a.task_id,0));
 SELECT * INTO t FROM campus.tasks WHERE id=a.task_id FOR UPDATE;
 PERFORM campus.require_listing_actor(true);
 IF t.release_policy IS NULL THEN RAISE EXCEPTION 'transaction_terms_not_enabled' USING ERRCODE='P0001';END IF;
 IF t.status<>'open' OR t.visibility<>'published' OR a.state NOT IN('applied','invited') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001';END IF;
 IF body-ARRAY['expectedTermsVersion','expectedRevision','expectedAllocationRevision','ratios','policyId','plan']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';END IF;
 IF (body->>'expectedTermsVersion')::integer IS DISTINCT FROM t.terms_version OR (body->>'expectedRevision')::integer IS DISTINCT FROM t.revision THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 rs:=body->'ratios';
 IF jsonb_typeof(rs)<>'array' OR jsonb_array_length(rs) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rs) v WHERE v-ARRAY['memberId','units']<>'{}'::jsonb OR jsonb_typeof(v->'units') IS DISTINCT FROM 'number' OR (v->>'units')::numeric<>trunc((v->>'units')::numeric) OR (v->>'units')::numeric NOT BETWEEN 1 AND 10000) THEN RAISE EXCEPTION 'invalid_ratios' USING ERRCODE='P0001';END IF;
 SELECT array_agg(user_id ORDER BY user_id) INTO people FROM campus.application_members WHERE application_id=aid;
 SELECT array_agg((v->>'memberId')::uuid ORDER BY v->>'memberId'),jsonb_agg(v ORDER BY v->>'memberId') INTO proposed,rs FROM jsonb_array_elements(rs) v;
 IF proposed IS DISTINCT FROM people OR (SELECT sum((v->>'units')::numeric) FROM jsonb_array_elements(rs) v)<>10000 THEN RAISE EXCEPTION 'invalid_ratios' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM unnest(people) u WHERE NOT campus.eligible_student(u)) THEN RAISE EXCEPTION 'student_verification_required' USING ERRCODE='P0001';END IF;
 SELECT * INTO prior FROM campus.application_allocation_revisions WHERE application_id=aid ORDER BY revision DESC LIMIT 1;
 IF (body->>'policyId') IS NOT NULL THEN snapshot:=campus.transaction_policy_snapshot((body->>'policyId')::uuid,aid,t.terms_version);END IF;
 -- A different HTTP key with the same business command recovers, never creates another revision.
 IF prior.id IS NOT NULL AND prior.listing_version=t.terms_version AND prior.task_revision=t.revision AND prior.ratios=rs AND prior.policy_id IS NOT DISTINCT FROM (body->>'policyId')::uuid AND prior.policy_snapshot IS NOT DISTINCT FROM snapshot THEN RETURN jsonb_build_object('id',prior.id,'allocationRevision',prior.revision);END IF;
 IF (body->>'expectedAllocationRevision')::integer IS DISTINCT FROM coalesce(prior.revision,0) THEN RAISE EXCEPTION 'stale_allocation_revision' USING ERRCODE='P0001';END IF;
 IF (body->'plan'->'lots'->0->>'fundingPlanLotId') IS NULL THEN RAISE EXCEPTION 'invalid_component_plan' USING ERRCODE='P0001';END IF;
 PERFORM (body->'plan'->'lots'->0->>'fundingPlanLotId')::uuid;
 computed:=campus.transaction_plan(aid,rs,body->'plan'->'lots'->0->>'fundingPlanLotId',(body->>'policyId')::uuid);
 IF computed IS DISTINCT FROM body->'plan' THEN RAISE EXCEPTION 'invalid_component_plan' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.application_allocation_revisions(application_id,revision,listing_version,task_revision,proposer_id,ratios,plan,digest,policy_id,policy_snapshot,previous_id)
 VALUES(aid,coalesce(prior.revision,0)+1,t.terms_version,t.revision,campus.actor(),rs,computed,encode(sha256(convert_to(campus.transaction_canonical(jsonb_build_object('applicationId',aid,'allocationRevision',coalesce(prior.revision,0)+1,'listingVersion',t.terms_version,'taskRevision',t.revision,'releasePolicy',t.release_policy,'policyId',body->>'policyId','policySnapshot',snapshot,'plan',computed)),'UTF8')),'hex'),(body->>'policyId')::uuid,snapshot,prior.id) RETURNING * INTO r;
 RETURN jsonb_build_object('id',r.id,'allocationRevision',r.revision);
END $$;
CREATE FUNCTION campus.confirm_application_allocation(aid uuid,body jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.applications;t campus.tasks;r campus.application_allocation_revisions;
BEGIN
 SELECT * INTO a FROM campus.applications WHERE id=aid;
 IF a.id IS NULL OR NOT(campus.in_application(aid) OR campus.owns_task(a.task_id)) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('task:'||a.task_id,0));SELECT * INTO t FROM campus.tasks WHERE id=a.task_id FOR UPDATE;
 PERFORM campus.require_listing_actor(t.owner_id<>campus.actor());
 SELECT * INTO r FROM campus.application_allocation_revisions WHERE application_id=aid ORDER BY revision DESC LIMIT 1;
 IF r.id IS NULL OR r.id IS DISTINCT FROM (body->>'allocationId')::uuid OR r.revision IS DISTINCT FROM (body->>'expectedAllocationRevision')::integer OR r.digest IS DISTINCT FROM body->>'digest' THEN RAISE EXCEPTION 'stale_allocation_revision' USING ERRCODE='P0001';END IF;
 IF (body->>'expectedTermsVersion')::integer IS DISTINCT FROM t.terms_version OR (body->>'expectedRevision')::integer IS DISTINCT FROM t.revision OR r.listing_version<>t.terms_version OR r.task_revision<>t.revision OR t.status<>'open' OR a.state NOT IN('applied','invited') THEN RAISE EXCEPTION 'stale_revision' USING ERRCODE='P0001';END IF;
 IF body->>'consentKind' IS DISTINCT FROM (CASE WHEN r.policy_id IS NULL THEN 'ratios_only' ELSE 'financial_terms' END) OR body-ARRAY['allocationId','expectedAllocationRevision','digest','consentKind','expectedRevision','expectedTermsVersion']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';END IF;
 IF r.policy_id IS NOT NULL AND r.policy_snapshot IS DISTINCT FROM campus.transaction_policy_snapshot(r.policy_id,aid,r.listing_version) THEN RAISE EXCEPTION 'policy_disclosure_pending' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.application_allocation_confirmations(application_id,allocation_id,allocation_revision,user_id,digest,consent_kind) VALUES(aid,r.id,r.revision,campus.actor(),r.digest,body->>'consentKind') ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('id',r.id,'allocationRevision',r.revision);
END $$;
CREATE FUNCTION campus.require_transaction_consent(aid uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE t campus.tasks;r campus.application_allocation_revisions;
BEGIN
 SELECT tasks.* INTO t FROM campus.tasks JOIN campus.applications a ON a.task_id=tasks.id WHERE a.id=aid;
 IF t.release_policy IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM campus.application_allocation_revisions WHERE application_id=aid ORDER BY revision DESC LIMIT 1;
 IF r.id IS NULL THEN RAISE EXCEPTION 'allocation_required' USING ERRCODE='P0001';END IF;
 IF r.listing_version<>t.terms_version OR r.task_revision<>t.revision THEN RAISE EXCEPTION 'stale_allocation_revision' USING ERRCODE='P0001';END IF;
 IF r.policy_id IS NULL THEN RAISE EXCEPTION 'fee_policy_pending' USING ERRCODE='P0001';END IF;
 IF r.policy_snapshot IS DISTINCT FROM campus.transaction_policy_snapshot(r.policy_id,aid,r.listing_version) THEN RAISE EXCEPTION 'policy_disclosure_pending' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM (SELECT user_id FROM campus.application_members WHERE application_id=aid UNION SELECT t.owner_id) u WHERE NOT EXISTS(SELECT 1 FROM campus.application_allocation_confirmations c WHERE c.allocation_id=r.id AND c.user_id=u.user_id AND c.digest=r.digest AND c.consent_kind='financial_terms')) THEN RAISE EXCEPTION 'financial_consent_required' USING ERRCODE='P0001';END IF;
 PERFORM campus.require_current_terms(aid,true);
 RETURN r.id;
END $$;
CREATE FUNCTION campus.bind_transaction_terms(gid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.agreements;r campus.application_allocation_revisions; tid uuid; tt uuid;tr integer;
BEGIN
 SELECT * INTO g FROM campus.agreements WHERE id=gid;
 SELECT * INTO r FROM campus.application_allocation_revisions WHERE id=campus.require_transaction_consent(g.application_id);
 IF r.id IS NULL THEN RETURN;END IF;
 SELECT id,revision INTO tid,tr FROM campus.agreement_terms WHERE agreement_id=gid ORDER BY revision DESC LIMIT 1;
 INSERT INTO campus.agreement_transaction_terms(agreement_id,application_id,allocation_id,allocation_revision,listing_version,release_policy,policy_id,policy_snapshot,plan,digest)
 SELECT gid,g.application_id,r.id,r.revision,r.listing_version,release_policy,r.policy_id,r.policy_snapshot,r.plan,r.digest FROM campus.tasks WHERE id=g.task_id RETURNING id INTO tt;
 INSERT INTO campus.agreement_transaction_bindings VALUES(gid,tid,tr,tt,1,'accepted_allocation');
 INSERT INTO campus.payee_allocations(funding_plan_lot_id,source_plan_revision,agreement_id,transaction_terms_id,transaction_terms_revision,terms_id,milestone_id,member_id,stage_position,gross_cents,recipient_fee_cents,net_cents) SELECT (r.plan->'lots'->0->>'fundingPlanLotId')::uuid,r.revision,gid,tt,1,tid,m.id,(v->>'memberId')::uuid,m.position,(v->>'grossCents')::integer,(v->>'recipientFeeCents')::integer,(v->>'netCents')::integer FROM jsonb_array_elements(r.plan->'lots'->0->'components') v JOIN campus.milestones m ON m.agreement_id=gid AND m.position=(v->>'stagePosition')::integer;
 IF (SELECT sum(gross_cents) FROM campus.payee_allocations WHERE transaction_terms_id=tt)<>(g.terms->>'rewardCents')::integer THEN RAISE EXCEPTION 'invalid_component_plan' USING ERRCODE='P0001';END IF;
END $$;
CREATE OR REPLACE FUNCTION campus.listing_terms(k text,l uuid) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT CASE WHEN k='task' THEN
 (SELECT jsonb_build_object('title',t.title,'category',t.category,'description',t.description,'rewardCents',t.reward_cents,
 'releasePolicy',t.release_policy,'fullUpfront',true,'transactionDisclosureVersion','fee_shared_50_50_v1','dueDate',to_char(t.due_date,'YYYY-MM-DD'),'milestones',coalesce((SELECT jsonb_agg(jsonb_build_object('title',m.title,
 'amountCents',m.amount_cents,'deliverable',m.deliverable,'acceptanceCriteria',m.acceptance_criteria) ORDER BY position)
 FROM campus.task_milestones m WHERE m.task_id=t.id),'[]'::jsonb)) FROM campus.tasks t WHERE t.id=l)
 ELSE (SELECT jsonb_build_object('title',p.title,'description',p.description,'priceCents',p.price_cents,
 'stock',p.stock,'deliveryMethods',p.delivery_methods,'shippingCents',p.shipping_cents) FROM campus.products p WHERE p.id=l) END
$$;
CREATE OR REPLACE FUNCTION campus.change_listing(k text,l uuid,op text,expected_revision integer,expected_stock integer,expected_stock_revision integer,body jsonb) RETURNS jsonb
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
   IF (body->>'releasePolicy' IS NOT NULL AND body->>'releasePolicy' NOT IN('per_milestone','final_completion')) OR (t.release_policy IS NOT NULL AND body->>'releasePolicy' IS NULL) OR body-ARRAY['title','category','description','rewardCents','dueDate','milestones','releasePolicy']<>'{}'::jsonb OR
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
    release_policy=body->>'releasePolicy',due_date=(body->>'dueDate')::date,revision=r+1,terms_version=v+1 WHERE id=l;
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
 PERFORM campus.require_transaction_consent(a.id);
 terms_value:=jsonb_build_object('taskTitle',t.title,'description',t.description,'rewardCents',t.reward_cents,
 'dueDate',CASE WHEN t.due_date IS NULL THEN NULL ELSE to_char(t.due_date,'YYYY-MM-DD') END,
 'milestones',milestone_terms,'members',to_jsonb(member_ids),'currency','USD');
 INSERT INTO campus.agreements(task_id,application_id,owner_id,captain_id,team_id,terms)
 VALUES(t.id,a.id,t.owner_id,campus.actor(),a.team_id,terms_value) RETURNING id INTO agreement_uuid;
 INSERT INTO campus.agreement_members(agreement_id,user_id) SELECT agreement_uuid,unnest(member_ids);
 INSERT INTO campus.milestones(agreement_id,position,title,amount_cents,deliverable,acceptance_criteria)
 SELECT agreement_uuid,position,title,amount_cents,deliverable,acceptance_criteria FROM campus.task_milestones WHERE task_id=t.id;
 PERFORM campus.initialize_agreement_terms(agreement_uuid,'accepted_application');
 PERFORM campus.bind_transaction_terms(agreement_uuid);
 UPDATE campus.tasks SET status='contracted',revision=revision+1 WHERE id=t.id;
 UPDATE campus.applications SET state='accepted' WHERE id=a.id;
 PERFORM campus.supersede_other_applications(a.id);
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'application.accept',agreement_uuid);
 INSERT INTO campus.events(kind,object_id) VALUES('application.accept',agreement_uuid);
 RETURN agreement_uuid;
END $$;
-- Nonmonetary amendments inherit only if exact stage amounts/identities and recipients stay unchanged.
CREATE FUNCTION campus.inherit_transaction_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE b campus.agreement_transaction_bindings;
BEGIN
 IF NEW.effective_terms_id IS NOT DISTINCT FROM OLD.effective_terms_id THEN RETURN NEW;END IF;
 SELECT * INTO b FROM campus.agreement_transaction_bindings WHERE agreement_id=NEW.agreement_id AND terms_id=OLD.effective_terms_id;
 IF b.transaction_terms_id IS NULL THEN RETURN NEW;END IF;
 IF EXISTS((SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=OLD.effective_terms_id EXCEPT SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=NEW.effective_terms_id) UNION ALL (SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=NEW.effective_terms_id EXCEPT SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=OLD.effective_terms_id)) THEN RAISE EXCEPTION 'transaction_reassessment_required' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.agreement_transaction_bindings VALUES(NEW.agreement_id,NEW.effective_terms_id,NEW.effective_revision,b.transaction_terms_id,b.transaction_terms_revision,'nonmonetary_inheritance');RETURN NEW;
END $$;
CREATE TRIGGER inherit_transaction_binding AFTER UPDATE ON campus.agreement_terms_state FOR EACH ROW EXECUTE FUNCTION campus.inherit_transaction_binding();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payment_policy_versions','application_allocation_revisions','application_allocation_confirmations'] LOOP
  EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);
  EXECUTE format('GRANT SELECT ON campus.%I TO campus_app',t);
  EXECUTE format('CREATE POLICY allocation_read ON campus.%I FOR SELECT TO campus_app USING(EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status<>''locked'') AND EXISTS(SELECT 1 FROM campus.applications a WHERE a.id=application_id AND (campus.in_application(a.id) OR campus.owns_task(a.task_id))))',t);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.immutable_agreement_history()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agreement_transaction_terms','agreement_transaction_bindings','payee_allocations'] LOOP
  EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);
  EXECUTE format('GRANT SELECT ON campus.%I TO campus_app',t);
  EXECUTE format('CREATE POLICY transaction_read ON campus.%I FOR SELECT TO campus_app USING(campus.in_agreement(agreement_id))',t);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.immutable_agreement_history()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION campus.transaction_policy_disclosure_valid(jsonb),campus.transaction_policy_snapshot(uuid,uuid,integer),campus.transaction_terms_capabilities(),campus.transaction_canonical(jsonb),campus.transaction_lr(bigint,bigint[],text[]),campus.transaction_plan(uuid,jsonb,text,uuid),campus.propose_application_allocation(uuid,jsonb),campus.confirm_application_allocation(uuid,jsonb),campus.require_transaction_consent(uuid),campus.bind_transaction_terms(uuid),campus.inherit_transaction_binding() FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.transaction_policy_disclosure_valid(jsonb),campus.transaction_terms_capabilities(),campus.propose_application_allocation(uuid,jsonb),campus.confirm_application_allocation(uuid,jsonb) TO campus_app;

CREATE FUNCTION campus.require_release_choice() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$ BEGIN IF NEW.release_policy IS NULL THEN RAISE EXCEPTION 'release_policy_required' USING ERRCODE='P0001';END IF;RETURN NEW;END $$;
CREATE TRIGGER require_release_choice BEFORE INSERT ON campus.tasks FOR EACH ROW EXECUTE FUNCTION campus.require_release_choice();
REVOKE ALL ON FUNCTION campus.require_release_choice() FROM PUBLIC,campus_app,campus_auth,campus_worker;
