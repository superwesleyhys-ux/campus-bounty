-- Forward-only amendment origin. No historical signatures or money identities are rewritten.
SET LOCAL lock_timeout='5s';
CREATE TABLE campus.amendment_financial_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agreement_id uuid NOT NULL,amendment_id uuid NOT NULL,revision integer NOT NULL,
 proposal_revision integer NOT NULL,base_terms_id uuid NOT NULL,base_revision integer NOT NULL,terms_id uuid NOT NULL,terms_revision integer NOT NULL,
 base_transaction_id uuid NOT NULL,base_transaction_revision integer NOT NULL,environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 policy_id uuid NOT NULL,policy_origin text NOT NULL DEFAULT 'amendment' CHECK(policy_origin='amendment'),collection_profile_id uuid NOT NULL REFERENCES campus.payment_collection_profiles,
 body jsonb NOT NULL,digest text NOT NULL,baseline jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(amendment_id,revision),UNIQUE(id,agreement_id),UNIQUE(id,environment_id),
 FOREIGN KEY(amendment_id,proposal_revision,agreement_id,terms_id,terms_revision,base_terms_id,base_revision) REFERENCES campus.agreement_amendment_revisions(amendment_id,proposal_revision,agreement_id,terms_id,terms_revision,base_terms_id,base_effective_revision),
 FOREIGN KEY(base_transaction_id,agreement_id,base_transaction_revision) REFERENCES campus.agreement_transaction_terms(id,agreement_id,revision),
 FOREIGN KEY(policy_id,environment_id,policy_origin,amendment_id) REFERENCES campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id)
);
CREATE TABLE campus.amendment_financial_confirmations (
 plan_id uuid NOT NULL REFERENCES campus.amendment_financial_plans,user_id uuid NOT NULL REFERENCES campus.users,digest text NOT NULL,
 confirmed_at timestamptz NOT NULL DEFAULT campus.money_now(),PRIMARY KEY(plan_id,user_id)
);
ALTER TABLE campus.agreement_transaction_terms ADD COLUMN origin text NOT NULL DEFAULT 'application' CHECK(origin IN('application','amendment'));
ALTER TABLE campus.agreement_transaction_terms ADD COLUMN amendment_plan_id uuid;
ALTER TABLE campus.agreement_transaction_terms ALTER COLUMN application_id DROP NOT NULL,ALTER COLUMN allocation_id DROP NOT NULL,ALTER COLUMN allocation_revision DROP NOT NULL,ALTER COLUMN listing_version DROP NOT NULL,ALTER COLUMN policy_id DROP NOT NULL;
ALTER TABLE campus.agreement_transaction_terms ADD CONSTRAINT transaction_exclusive_origin CHECK(
 (origin='application' AND amendment_plan_id IS NULL AND application_id IS NOT NULL AND allocation_id IS NOT NULL AND allocation_revision IS NOT NULL AND listing_version IS NOT NULL AND policy_id IS NOT NULL) OR
 (origin='amendment' AND amendment_plan_id IS NOT NULL AND application_id IS NULL AND allocation_id IS NULL AND allocation_revision IS NULL AND listing_version IS NULL AND policy_id IS NULL));
ALTER TABLE campus.agreement_transaction_terms ADD FOREIGN KEY(amendment_plan_id,agreement_id) REFERENCES campus.amendment_financial_plans(id,agreement_id),ADD UNIQUE(amendment_plan_id);
CREATE TABLE campus.amendment_funding_origins (
 plan_id uuid PRIMARY KEY,agreement_id uuid NOT NULL,obligation_id uuid NOT NULL UNIQUE,environment_id uuid NOT NULL,
 FOREIGN KEY(plan_id,agreement_id) REFERENCES campus.amendment_financial_plans(id,agreement_id),FOREIGN KEY(plan_id,environment_id) REFERENCES campus.amendment_financial_plans(id,environment_id),
 FOREIGN KEY(obligation_id,environment_id) REFERENCES campus.funding_obligations(id,environment_id)
);
CREATE TABLE campus.transaction_component_memberships (
 transaction_terms_id uuid NOT NULL,agreement_id uuid NOT NULL,transaction_terms_revision integer NOT NULL,
 component_id uuid NOT NULL REFERENCES campus.funding_component_plans,PRIMARY KEY(transaction_terms_id,component_id),
 FOREIGN KEY(transaction_terms_id,agreement_id,transaction_terms_revision) REFERENCES campus.agreement_transaction_terms(id,agreement_id,revision)
);
INSERT INTO campus.transaction_component_memberships SELECT o.transaction_terms_id,o.agreement_id,o.transaction_terms_revision,c.id FROM campus.funding_obligations o JOIN campus.funding_lots l ON l.obligation_id=o.id JOIN campus.funding_component_plans c ON c.lot_id=l.id WHERE o.transaction_terms_id IS NOT NULL;
CREATE FUNCTION campus.amend_component_membership() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN INSERT INTO campus.transaction_component_memberships SELECT o.transaction_terms_id,o.agreement_id,o.transaction_terms_revision,NEW.id FROM campus.funding_lots l JOIN campus.funding_obligations o ON o.id=l.obligation_id WHERE l.id=NEW.lot_id AND o.transaction_terms_id IS NOT NULL;RETURN NULL;END $$;
CREATE TRIGGER transaction_membership AFTER INSERT ON campus.funding_component_plans FOR EACH ROW EXECUTE FUNCTION campus.amend_component_membership();
CREATE TABLE campus.amendment_money_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),plan_id uuid NOT NULL REFERENCES campus.amendment_financial_plans,baseline_digest text NOT NULL,
 current_digest text NOT NULL,status text NOT NULL,reason text,allowed_effect_ids uuid[] NOT NULL,environment_effect_ids uuid[] NOT NULL,
 details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now()
);
CREATE TABLE campus.amendment_money_activations (
 plan_id uuid PRIMARY KEY REFERENCES campus.amendment_financial_plans,assessment_id uuid NOT NULL UNIQUE REFERENCES campus.amendment_money_assessments,
 transaction_terms_id uuid NOT NULL UNIQUE REFERENCES campus.agreement_transaction_terms,created_at timestamptz NOT NULL DEFAULT campus.money_now()
);
CREATE TABLE campus.amendment_money_cancellations (
 plan_id uuid PRIMARY KEY REFERENCES campus.amendment_financial_plans,user_id uuid NOT NULL REFERENCES campus.users,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now()
);
CREATE FUNCTION campus.amend_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,campus AS $$ SELECT encode(sha256(convert_to(campus.transaction_canonical(v),'UTF8')),'hex') $$;
CREATE FUNCTION campus.amend_work(gid uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,campus AS $$
 SELECT jsonb_build_object('agreement',(SELECT jsonb_build_object('state',state,'owner',owner_id,'captain',captain_id) FROM campus.agreements WHERE id=gid),
 'members',(SELECT jsonb_agg(user_id ORDER BY user_id) FROM campus.agreement_members WHERE agreement_id=gid),
 'stages',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM campus.milestones m WHERE agreement_id=gid),
 'submissions',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM campus.submissions s JOIN campus.milestones m ON m.id=s.milestone_id WHERE m.agreement_id=gid),
 'reviews',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM campus.milestone_reviews r JOIN campus.milestones m ON m.id=r.milestone_id WHERE m.agreement_id=gid))
$$;
-- Exact immutable histories include content and order; revision alone is not authority.
CREATE FUNCTION campus.amend_history(gid uuid,eid uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,campus AS $$
 SELECT jsonb_build_object('work',campus.amend_work(gid),'history',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY revision),'[]') FROM campus.money_effect_history h WHERE aggregate_type='agreement' AND aggregate_id=gid AND environment_id=eid),
 'environment',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY id),'[]') FROM campus.payment_environment_effect_history h WHERE environment_id=eid),
 'revision',(SELECT revision FROM campus.money_aggregate_revisions WHERE environment_id=eid AND aggregate_type='agreement' AND aggregate_id=gid),
 'components',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM campus.funding_component_plans c JOIN campus.funding_lots l ON l.id=c.lot_id JOIN campus.funding_obligations o ON o.id=l.obligation_id WHERE o.agreement_id=gid),
 'binding',(SELECT to_jsonb(b) FROM campus.agreement_transaction_bindings b JOIN campus.agreement_terms_state s ON s.agreement_id=b.agreement_id AND s.effective_terms_id=b.terms_id WHERE b.agreement_id=gid))
$$;
CREATE FUNCTION campus.amend_plan_current(p campus.amendment_financial_plans) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,campus AS $$
 SELECT p.digest=campus.amend_hash(p.body) AND p.policy_id=(SELECT id FROM campus.payment_execution_policies WHERE environment_id=p.environment_id AND aggregate_type='amendment' AND aggregate_id=p.amendment_id AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1)
 AND p.collection_profile_id=(SELECT id FROM campus.payment_collection_profiles WHERE environment_id=p.environment_id ORDER BY version DESC LIMIT 1)
 AND EXISTS(SELECT 1 FROM campus.payment_environments WHERE id=p.environment_id AND enabled)
 AND EXISTS(SELECT 1 FROM campus.agreement_terms_state WHERE agreement_id=p.agreement_id AND effective_terms_id=p.base_terms_id AND effective_revision=p.base_revision)
 AND EXISTS(SELECT 1 FROM campus.agreement_amendments WHERE id=p.amendment_id AND current_proposal_revision=p.proposal_revision AND status IN('pending','agreed_waiting_funds'))
 AND p.baseline->'work'=campus.amend_work(p.agreement_id)
 AND NOT EXISTS(SELECT 1 FROM campus.amendment_money_cancellations WHERE plan_id=p.id)
$$;
CREATE FUNCTION campus.amend_plan_exact(gid uuid,aid uuid,rev integer,request jsonb) RETURNS campus.amendment_financial_plans LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;r campus.agreement_amendment_revisions;
BEGIN
 PERFORM campus.lock_agreement_amendment(gid);r:=campus.exact_amendment_revision(gid,aid,request);
 SELECT * INTO p FROM campus.amendment_financial_plans WHERE agreement_id=gid AND amendment_id=aid AND revision=rev;
 IF p.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF request->>'digest' IS DISTINCT FROM p.digest OR p.proposal_revision<>r.proposal_revision THEN RAISE EXCEPTION 'financial_plan_changed' USING ERRCODE='P0001';END IF;RETURN p;
END $$;
CREATE FUNCTION campus.amend_unanimous(p campus.amendment_financial_plans) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,campus AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p.body->'participants') person WHERE
 NOT EXISTS(SELECT 1 FROM campus.amendment_financial_confirmations WHERE plan_id=p.id AND user_id=person::uuid AND digest=p.digest) OR
 NOT EXISTS(SELECT 1 FROM campus.agreement_amendment_confirmations WHERE amendment_id=p.amendment_id AND proposal_revision=p.proposal_revision AND user_id=person::uuid))
$$;
CREATE FUNCTION campus.amend_money_propose(gid uuid,aid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.agreements;r campus.agreement_amendment_revisions;b campus.agreement_transaction_bindings;t campus.agreement_transaction_terms;pol campus.payment_execution_policies;profile campus.payment_collection_profiles;p campus.amendment_financial_plans;
 eid uuid;pid uuid:=gen_random_uuid();lid uuid:=gen_random_uuid();weights bigint[];people text[];stagekeys text[];gross bigint[];fees bigint[];memberfees bigint[];targets bigint[];components jsonb:='[]';increments jsonb:='[]';oldids jsonb;body jsonb;stage record;mi integer;si integer;assigned bigint;delta bigint;principal bigint:=0;fee bigint;payable bigint;rs jsonb;baseline jsonb;
BEGIN
 g:=campus.lock_agreement_amendment(gid);PERFORM campus.require_amendment_enabled();
 IF g.owner_id<>campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001';END IF;
 IF g.state<>'active' THEN RAISE EXCEPTION 'agreement_not_funded_or_closed' USING ERRCODE='P0001';END IF;
 r:=campus.exact_amendment_revision(gid,aid,request);PERFORM campus.validate_amendment_effect(aid,r.proposal_revision);
 IF EXISTS(SELECT 1 FROM campus.amendment_funding_origins x JOIN campus.amendment_financial_plans pp ON pp.id=x.plan_id WHERE pp.amendment_id=aid) THEN RAISE EXCEPTION 'candidate_collection_reserved' USING ERRCODE='P0001';END IF;
 IF NOT r.allocation_changed OR cardinality(r.retired_milestone_ids)>0 THEN RAISE EXCEPTION 'compensation_policy_unresolved' USING ERRCODE='P0001';END IF;
 eid:=campus.money_environment();PERFORM campus.money_cash_lock(eid);
 SELECT * INTO b FROM campus.agreement_transaction_bindings WHERE agreement_id=gid AND terms_id=r.base_terms_id;
 SELECT * INTO t FROM campus.agreement_transaction_terms WHERE id=b.transaction_terms_id;
 IF t.id IS NULL OR NOT EXISTS(SELECT 1 FROM campus.transaction_component_memberships WHERE transaction_terms_id=t.id) OR EXISTS(SELECT 1 FROM campus.transaction_component_memberships mm JOIN campus.funding_component_plans c ON c.id=mm.component_id LEFT JOIN campus.funding_allocations f ON f.lot_id=c.lot_id WHERE mm.transaction_terms_id=t.id AND f.fee_state IS DISTINCT FROM 'matched') THEN RAISE EXCEPTION 'legacy_coverage_unknown' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.money_active_holds h JOIN campus.funding_obligations o ON o.id=h.obligation_id WHERE o.agreement_id=gid) THEN RAISE EXCEPTION 'funds_held' USING ERRCODE='P0001';END IF;
 SELECT * INTO pol FROM campus.payment_execution_policies WHERE id=(request->>'policyVersionId')::uuid AND environment_id=eid AND aggregate_type='amendment' AND aggregate_id=aid AND purpose='collection' AND status='approved';
 IF pol.id IS NULL OR pol.digest IS DISTINCT FROM request->>'policyDigest' OR pol.digest<>campus.amend_hash(pol.payload) OR pol.payload->>'feeAdjustment' IS DISTINCT FROM 'hold_on_variance' OR NOT campus.transaction_policy_disclosure_valid(pol.payload) THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';END IF;
 SELECT * INTO profile FROM campus.payment_collection_profiles WHERE environment_id=eid ORDER BY version DESC LIMIT 1;
 IF profile.id IS NULL OR pol.payload->>'collectionProfileId' IS DISTINCT FROM profile.id::text OR pol.payload->>'collectionProfileDigest' IS DISTINCT FROM profile.digest OR profile.platform_account_id IS DISTINCT FROM (SELECT platform_account_id FROM campus.payment_environments WHERE id=eid) THEN RAISE EXCEPTION 'collection_profile_refresh_required' USING ERRCODE='P0001';END IF;
 rs:=t.plan->'members';SELECT array_agg((v->>'units')::bigint ORDER BY v->>'memberId'),array_agg(v->>'memberId' ORDER BY v->>'memberId') INTO weights,people FROM jsonb_array_elements(rs)v;
 IF people IS DISTINCT FROM (SELECT array_agg(user_id::text ORDER BY user_id::text) FROM campus.agreement_members WHERE agreement_id=gid) THEN RAISE EXCEPTION 'frozen_roster_mismatch' USING ERRCODE='P0001';END IF;
 FOR stage IN SELECT * FROM campus.agreement_milestone_terms WHERE terms_id=r.terms_id ORDER BY position LOOP
  targets:=campus.transaction_lr(stage.amount_cents,weights,people);
  FOR mi IN 1..cardinality(people) LOOP
   SELECT coalesce(sum(c.gross_cents),0) INTO assigned FROM campus.transaction_component_memberships mm JOIN campus.money_effective_components c ON c.id=mm.component_id WHERE mm.transaction_terms_id=t.id AND c.milestone_id=stage.milestone_id AND c.member_id=people[mi]::uuid;
   delta:=targets[mi]-assigned;
   IF delta<0 THEN RAISE EXCEPTION 'compensation_policy_unresolved' USING ERRCODE='P0001';END IF;
   IF delta>0 AND EXISTS(SELECT 1 FROM campus.submissions WHERE milestone_id=stage.milestone_id) THEN RAISE EXCEPTION 'protected_milestone' USING ERRCODE='P0001';END IF;
   IF delta>0 THEN increments:=increments||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'memberId',people[mi],'milestoneId',stage.milestone_id,'stagePosition',stage.position,'grossCents',delta));principal:=principal+delta;END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM campus.transaction_component_memberships mm JOIN campus.funding_component_plans c ON c.id=mm.component_id WHERE mm.transaction_terms_id=t.id AND NOT EXISTS(SELECT 1 FROM campus.agreement_milestone_terms WHERE terms_id=r.terms_id AND milestone_id=c.milestone_id)) OR principal<=0 THEN RAISE EXCEPTION 'compensation_policy_unresolved' USING ERRCODE='P0001';END IF;
 fee:=(pol.payload->>'estimatedProcessorFeeCents')::bigint;payable:=principal+(fee+1)/2;
 IF fee IS NULL OR fee<0 OR payable>100000000 OR (pol.payload->>'estimatedForAmountCents')::bigint IS DISTINCT FROM payable OR (pol.payload->>'principalCents')::bigint IS DISTINCT FROM principal THEN RAISE EXCEPTION 'fee_estimate_amount_mismatch' USING ERRCODE='P0001';END IF;
 memberfees:=campus.transaction_lr(fee/2,weights,people);
 FOR mi IN 1..cardinality(people) LOOP
  SELECT array_agg((v->>'grossCents')::bigint ORDER BY (v->>'stagePosition')::int),array_agg(v->>'stagePosition' ORDER BY (v->>'stagePosition')::int) INTO gross,stagekeys FROM jsonb_array_elements(increments)v WHERE v->>'memberId'=people[mi];
  IF gross IS NULL THEN IF memberfees[mi]>0 THEN RAISE EXCEPTION 'fee_exceeds_component' USING ERRCODE='P0001';END IF;CONTINUE;END IF;
  fees:=campus.transaction_lr(memberfees[mi],gross,stagekeys);si:=0;
  FOR stage IN SELECT value v FROM jsonb_array_elements(increments) WHERE value->>'memberId'=people[mi] ORDER BY (value->>'stagePosition')::int LOOP si:=si+1;IF fees[si]>gross[si] THEN RAISE EXCEPTION 'fee_exceeds_component' USING ERRCODE='P0001';END IF;components:=components||jsonb_build_array(stage.v||jsonb_build_object('recipientFeeCents',fees[si],'netCents',gross[si]-fees[si]));END LOOP;
 END LOOP;
 SELECT jsonb_agg(component_id ORDER BY component_id) INTO oldids FROM campus.transaction_component_memberships WHERE transaction_terms_id=t.id;
 baseline:=campus.amend_history(gid,eid);
 body:=jsonb_build_object('format','amendment_financial_plan_v1','planId',pid,'agreementId',gid,'amendmentId',aid,'proposalRevision',r.proposal_revision,'baseTermsId',r.base_terms_id,'baseRevision',r.base_effective_revision,'proposedTermsId',r.terms_id,'proposedTermsRevision',r.terms_revision,'baseTransactionTermsId',t.id,'baseTransactionTermsRevision',t.revision,'environmentId',eid,'policyId',pol.id,'policyDigest',pol.digest,'policyVersion',pol.version,'policy',pol.payload,'collectionProfileId',profile.id,'collectionProfileDigest',profile.digest,'collectionProfile',profile.body,'participants',to_jsonb(campus.notification_agreement_people(gid)),'protectedComponentIds',oldids,'baselineDigest',campus.amend_hash(baseline),'releasePolicy',t.release_policy,'currency','USD','principalCents',principal,'estimatedProcessorFeeCents',fee,'publisherProcessorFeeCents',(fee+1)/2,'recipientProcessorFeeCents',fee/2,'extraFeeCapCents',least(100,(fee+9)/10),'chargeTotalCents',payable,'minimumChargeCents',(profile.body->>'minimumChargeCents')::bigint,'plan',jsonb_build_object('calculationVersion','charge_member_stage_v1','currency','USD','platformServiceFeeCents',0,'roundingRule','largest_remainder_uuid_stage;odd_fee_cent_publisher','members',rs,'lots',jsonb_build_array(jsonb_build_object('fundingPlanLotId',lid,'principalCents',principal,'estimatedProcessorFeeCents',fee,'publisherProcessorFeeCents',(fee+1)/2,'recipientProcessorFeeCents',fee/2,'chargeTotalCents',payable,'components',components))));
 INSERT INTO campus.amendment_financial_plans(id,agreement_id,amendment_id,revision,proposal_revision,base_terms_id,base_revision,terms_id,terms_revision,base_transaction_id,base_transaction_revision,environment_id,policy_id,collection_profile_id,body,digest,baseline)
 VALUES(pid,gid,aid,(SELECT coalesce(max(revision),0)+1 FROM campus.amendment_financial_plans WHERE amendment_id=aid),r.proposal_revision,r.base_terms_id,r.base_effective_revision,r.terms_id,r.terms_revision,t.id,t.revision,eid,pol.id,profile.id,body,campus.amend_hash(body),baseline) RETURNING * INTO p;
 RETURN jsonb_build_object('planId',p.id,'revision',p.revision,'digest',p.digest);
END $$;
CREATE FUNCTION campus.amend_money_confirm(gid uuid,aid uuid,rev integer,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;
BEGIN p:=campus.amend_plan_exact(gid,aid,rev,request);
 IF NOT campus.amend_plan_current(p) THEN RAISE EXCEPTION 'financial_plan_stale' USING ERRCODE='P0001';END IF;
 IF NOT p.body->'participants' @> to_jsonb(ARRAY[campus.actor()::text]) THEN RAISE EXCEPTION 'not_party' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.amendment_financial_confirmations VALUES(p.id,campus.actor(),p.digest,campus.money_now()) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('planId',p.id,'revision',p.revision,'digest',p.digest,'userId',campus.actor());END $$;
CREATE FUNCTION campus.amend_money_quote(gid uuid,aid uuid,rev integer,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;o campus.funding_obligations;tt uuid;tr integer;q campus.payment_quotes;l jsonb;v jsonb;body jsonb;
BEGIN p:=campus.amend_plan_exact(gid,aid,rev,request);
 IF campus.actor()<>(SELECT owner_id FROM campus.agreements WHERE id=gid) THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001';END IF;
 PERFORM campus.money_cash_lock(p.environment_id);
 IF NOT campus.amend_plan_current(p) THEN RAISE EXCEPTION 'financial_plan_stale' USING ERRCODE='P0001';END IF;
 IF NOT campus.amend_unanimous(p) THEN RAISE EXCEPTION 'financial_consent_required' USING ERRCODE='P0001';END IF;
 IF (p.body->>'chargeTotalCents')::bigint<(p.body->>'minimumChargeCents')::bigint THEN RAISE EXCEPTION 'amount_below_provider_minimum' USING ERRCODE='P0001';END IF;
 SELECT x.* INTO o FROM campus.funding_obligations x JOIN campus.amendment_funding_origins ao ON ao.obligation_id=x.id WHERE ao.plan_id=p.id;
 IF o.id IS NULL THEN
  -- No foreign business effects may precede the first collectible quote.
  IF p.baseline->'history' IS DISTINCT FROM campus.amend_history(gid,p.environment_id)->'history' THEN RAISE EXCEPTION 'financial_plan_stale' USING ERRCODE='P0001';END IF;
  SELECT coalesce(max(revision),0)+1 INTO tr FROM campus.agreement_transaction_terms WHERE agreement_id=gid;
  INSERT INTO campus.agreement_transaction_terms(agreement_id,revision,release_policy,policy_snapshot,plan,digest,origin,amendment_plan_id)
  SELECT gid,tr,t.release_policy,jsonb_build_object('policyId',p.policy_id,'payload',p.body->'policy'),jsonb_set(p.body->'plan','{lots}',(t.plan->'lots')||(p.body#>'{plan,lots}')),p.digest,'amendment',p.id FROM campus.agreement_transaction_terms t WHERE id=p.base_transaction_id RETURNING id INTO tt;
  INSERT INTO campus.transaction_component_memberships SELECT tt,gid,tr,component_id FROM campus.transaction_component_memberships WHERE transaction_terms_id=p.base_transaction_id;
  l:=p.body#>'{plan,lots,0}';
  INSERT INTO campus.funding_obligations(environment_id,aggregate_type,aggregate_id,agreement_id,amendment_id,payer_id,terms_id,terms_revision,transaction_terms_id,transaction_terms_revision,source_digest,policy_id,currency,principal_cents,fee_cents,publisher_fee_cents,amount_cents)
  VALUES(p.environment_id,'amendment',aid,gid,aid,campus.actor(),p.terms_id,p.terms_revision,tt,tr,p.digest,p.policy_id,'USD',(l->>'principalCents')::bigint,(l->>'estimatedProcessorFeeCents')::bigint,(l->>'publisherProcessorFeeCents')::bigint,(l->>'chargeTotalCents')::bigint) RETURNING * INTO o;
  INSERT INTO campus.amendment_funding_origins VALUES(p.id,gid,o.id,p.environment_id);
  INSERT INTO campus.funding_lots VALUES((l->>'fundingPlanLotId')::uuid,o.id,p.environment_id,rev,o.principal_cents,o.publisher_fee_cents,o.fee_cents);
  FOR v IN SELECT value FROM jsonb_array_elements(l->'components') LOOP INSERT INTO campus.funding_component_plans(id,lot_id,environment_id,member_id,milestone_id,stage_position,gross_cents,recipient_fee_cents,net_cents) VALUES((v->>'id')::uuid,(l->>'fundingPlanLotId')::uuid,p.environment_id,(v->>'memberId')::uuid,(v->>'milestoneId')::uuid,(v->>'stagePosition')::int,(v->>'grossCents')::bigint,(v->>'recipientFeeCents')::bigint,(v->>'netCents')::bigint);END LOOP;
 END IF;
 SELECT * INTO q FROM campus.payment_quotes WHERE obligation_id=o.id AND expires_at>campus.money_now() ORDER BY created_at DESC LIMIT 1;
 IF q.id IS NULL THEN
 body:=p.body||jsonb_build_object('obligationId',o.id,'sourceDigest',p.digest,'transactionTermsId',o.transaction_terms_id,'transactionTermsRevision',o.transaction_terms_revision);
 INSERT INTO campus.payment_quotes(obligation_id,environment_id,payer_id,digest,body,expires_at) VALUES(o.id,o.environment_id,o.payer_id,campus.amend_hash(body),body,campus.money_now()+interval '10 minutes') RETURNING * INTO q;
 END IF;
 RETURN jsonb_build_object('quoteId',q.id,'quoteDigest',q.digest,'obligationId',o.id,'obligationRevision',o.revision,'expiresAt',q.expires_at,'amountCents',o.amount_cents,'currency','USD');
END $$;
CREATE FUNCTION campus.amend_collectible(oid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;
BEGIN SELECT pp.* INTO p FROM campus.amendment_financial_plans pp JOIN campus.amendment_funding_origins ao ON ao.plan_id=pp.id WHERE ao.obligation_id=oid;
 IF p.id IS NULL THEN RETURN false;END IF;
 RETURN campus.amend_plan_current(p) AND campus.amend_unanimous(p) AND (p.body->>'chargeTotalCents')::bigint>=(p.body->>'minimumChargeCents')::bigint;
END $$;
ALTER FUNCTION campus.money_attempt(uuid,jsonb) RENAME TO money_attempt_before_amendment;
REVOKE ALL ON FUNCTION campus.money_attempt_before_amendment(uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_attempt(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN PERFORM campus.money_lock_aggregate(oid);
 IF EXISTS(SELECT 1 FROM campus.amendment_funding_origins WHERE obligation_id=oid) AND NOT campus.amend_collectible(oid) THEN RAISE EXCEPTION 'financial_plan_stale' USING ERRCODE='P0001';END IF;
 RETURN campus.money_attempt_before_amendment(oid,request);END $$;
GRANT EXECUTE ON FUNCTION campus.money_attempt(uuid,jsonb) TO campus_app;
ALTER FUNCTION campus.money_dispatchable(campus.money_operations) RENAME TO money_dispatchable_before_amendment;
CREATE FUNCTION campus.money_dispatchable(op campus.money_operations) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF op.kind='checkout' AND EXISTS(SELECT 1 FROM campus.amendment_funding_origins WHERE obligation_id=op.obligation_id) AND op.first_dispatched_at IS NULL AND NOT campus.amend_collectible(op.obligation_id) THEN RETURN false;END IF;RETURN campus.money_dispatchable_before_amendment(op);END $$;
-- Freeze the method in the persisted payload before it reaches the existing adapter.
CREATE FUNCTION campus.amend_checkout_method() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF NEW.kind='checkout' AND EXISTS(SELECT 1 FROM campus.amendment_funding_origins WHERE obligation_id=NEW.obligation_id) THEN NEW.payload:=NEW.payload||jsonb_build_object('paymentMethodTypes',jsonb_build_array('card'));NEW.payload_hash:=campus.amend_hash(NEW.payload);END IF;RETURN NEW;END $$;
CREATE TRIGGER amendment_method BEFORE INSERT ON campus.money_operations FOR EACH ROW EXECUTE FUNCTION campus.amend_checkout_method();

CREATE OR REPLACE FUNCTION campus.money_record_receipt_core(aid uuid,fact jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.payment_attempts;o campus.funding_obligations;l campus.funding_lots;e campus.payment_environments;jid uuid;allocation campus.funding_allocations;entry jsonb;actual bigint;feeid text;comp campus.funding_component_plans;effect text;
BEGIN
 SELECT * INTO a FROM campus.payment_attempts WHERE id=aid;IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT * INTO o FROM campus.funding_obligations WHERE id=a.obligation_id;
 IF o.agreement_id IS NOT NULL THEN PERFORM 1 FROM campus.agreements WHERE id=o.agreement_id FOR UPDATE;ELSE PERFORM 1 FROM campus.orders WHERE id=o.order_id FOR UPDATE;END IF;
 PERFORM campus.money_cash_lock(o.environment_id);SELECT * INTO o FROM campus.funding_obligations WHERE id=o.id FOR UPDATE;
 SELECT * INTO a FROM campus.payment_attempts WHERE id=aid FOR UPDATE;SELECT * INTO e FROM campus.payment_environments WHERE id=a.environment_id;
 SELECT * INTO l FROM campus.funding_lots WHERE obligation_id=o.id FOR UPDATE;
 IF fact->>'environmentId' IS DISTINCT FROM e.id::text OR fact->>'platformAccountId' IS DISTINCT FROM e.platform_account_id OR (fact->>'livemode')::boolean IS DISTINCT FROM (e.mode='live') OR fact->>'sessionId' IS DISTINCT FROM a.session_id OR fact->>'sourceDigest' IS DISTINCT FROM o.source_digest OR fact->>'currency' IS DISTINCT FROM 'usd' OR (fact->>'amountCents')::bigint IS DISTINCT FROM o.amount_cents OR fact->>'status' IS DISTINCT FROM 'succeeded' OR coalesce(fact->>'chargeId','')='' OR coalesce(fact->>'intentId','')='' THEN
  PERFORM campus.money_hold(o.id,'provider_fact_mismatch','mismatch:'||aid::text,fact-'url');RETURN jsonb_build_object('coverage','held','reason','provider_fact_mismatch');
 END IF;
 SELECT * INTO allocation FROM campus.funding_allocations WHERE lot_id=l.id;
 IF allocation.charge_id IS NOT NULL AND allocation.charge_id<>fact->>'chargeId' THEN
  jid:=campus.money_journal(e.id,l.id,'extra_receipt:'||(fact->>'chargeId'),jsonb_build_array(jsonb_build_object('account','cash','debit',o.amount_cents),jsonb_build_object('account','suspense','credit',o.amount_cents)));
  INSERT INTO campus.payment_unmatched_receipts(environment_id,obligation_id,charge_id,amount_cents,journal_id) VALUES(e.id,o.id,fact->>'chargeId',o.amount_cents,jid) ON CONFLICT DO NOTHING;
  IF (fact->>'actualFeeCents')::bigint>0 AND NOT EXISTS(SELECT 1 FROM campus.payment_receipt_facts rf WHERE rf.environment_id=e.id AND rf.charge_id=fact->>'chargeId' AND rf.observed_fee_cents IS NOT NULL AND (rf.observed_fee_cents IS DISTINCT FROM (fact->>'actualFeeCents')::bigint OR rf.fee_fact_id IS DISTINCT FROM fact->>'feeFactId')) THEN PERFORM campus.money_journal(e.id,l.id,'extra_fee:'||(fact->>'feeFactId'),jsonb_build_array(jsonb_build_object('account','fee_expense','debit',(fact->>'actualFeeCents')::bigint),jsonb_build_object('account','cash','credit',(fact->>'actualFeeCents')::bigint)));END IF;
  PERFORM campus.money_hold(o.id,'extra_receipt','extra_receipt:'||(fact->>'chargeId'),jsonb_build_object('journalId',jid));RETURN jsonb_build_object('coverage','held');
 END IF;
 IF allocation.lot_id IS NULL AND o.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM campus.orders x JOIN campus.order_payment_state ps ON ps.order_id=x.id WHERE x.id=o.order_id AND (x.state IN('cancelled','expired') OR ps.resolution IN('cancellation_requested','expiry_resolving','compensation_review','terminal'))) THEN
  jid:=campus.money_journal(e.id,l.id,'suspense_receipt:'||(fact->>'chargeId'),jsonb_build_array(jsonb_build_object('account','cash','debit',o.amount_cents),jsonb_build_object('account','suspense','credit',o.amount_cents)));
  INSERT INTO campus.payment_unmatched_receipts(environment_id,obligation_id,charge_id,amount_cents,journal_id) VALUES(e.id,o.id,fact->>'chargeId',o.amount_cents,jid) ON CONFLICT DO NOTHING;
  IF fact->'actualFeeCents' IS NOT NULL AND fact->'actualFeeCents'<>'null'::jsonb AND (fact->>'actualFeeCents')::bigint>0 AND NOT EXISTS(SELECT 1 FROM campus.payment_receipt_facts rf WHERE rf.environment_id=e.id AND rf.charge_id=fact->>'chargeId' AND rf.observed_fee_cents IS NOT NULL AND (rf.observed_fee_cents IS DISTINCT FROM (fact->>'actualFeeCents')::bigint OR rf.fee_fact_id IS DISTINCT FROM fact->>'feeFactId')) THEN PERFORM campus.money_journal(e.id,l.id,'suspense_fee:'||(fact->>'feeFactId'),jsonb_build_array(jsonb_build_object('account','fee_expense','debit',(fact->>'actualFeeCents')::bigint),jsonb_build_object('account','cash','credit',(fact->>'actualFeeCents')::bigint)));END IF;
  UPDATE campus.payment_attempts SET status='succeeded',charge_id=fact->>'chargeId',intent_id=fact->>'intentId',hosted_url=NULL WHERE id=aid;
  PERFORM campus.money_hold(o.id,'late_payment_compensation','late:'||aid::text,'{}');RETURN jsonb_build_object('coverage','held','disposition','suspense');
 END IF;
 IF allocation.lot_id IS NULL THEN
  jid:=campus.money_journal(e.id,l.id,'receipt:'||(fact->>'chargeId'),jsonb_build_array(jsonb_build_object('account','cash','debit',o.amount_cents),jsonb_build_object('account','reward_liability','credit',o.principal_cents),jsonb_build_object('account','publisher_fee_liability','credit',o.publisher_fee_cents)));
  INSERT INTO campus.funding_allocations(lot_id,environment_id,attempt_id,charge_id,receipt_journal_id) VALUES(l.id,e.id,aid,fact->>'chargeId',jid);
  INSERT INTO campus.money_reservations(environment_id,lot_id,kind,amount_cents) VALUES(e.id,l.id,'publisher_fee',o.publisher_fee_cents);
  INSERT INTO campus.money_reservations(environment_id,lot_id,component_id,kind,amount_cents) SELECT e.id,l.id,id,'recipient_fee',recipient_fee_cents FROM campus.funding_component_plans WHERE lot_id=l.id;
  UPDATE campus.payment_attempts SET status='succeeded',charge_id=fact->>'chargeId',intent_id=fact->>'intentId',hosted_url=NULL WHERE id=aid;
  UPDATE campus.funding_obligations SET revision=revision+1 WHERE id=o.id;
  IF o.amendment_id IS NOT NULL THEN
   -- A candidate receipt reserves funds; only explicit assessment/activation advances work.
   IF NOT campus.amend_collectible(o.id) THEN PERFORM campus.money_hold(o.id,'stale_amendment_compensation','stale_amendment:'||aid::text,'{}');END IF;
  ELSIF o.agreement_id IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM campus.agreement_transaction_bindings b JOIN campus.agreement_terms_state s ON s.agreement_id=b.agreement_id AND s.effective_terms_id=b.terms_id WHERE b.agreement_id=o.agreement_id AND b.transaction_terms_id=o.transaction_terms_id) THEN UPDATE campus.agreements SET state='active' WHERE id=o.agreement_id AND state='awaiting_funding';
   ELSE PERFORM campus.money_hold(o.id,'stale_terms_receipt','stale_terms:'||aid::text,'{}');END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM campus.order_payment_state p JOIN campus.orders x ON x.id=p.order_id WHERE x.id=o.order_id AND p.resolution='open' AND x.state='pending_payment') THEN UPDATE campus.orders SET state='paid' WHERE id=o.order_id;UPDATE campus.order_payment_state SET resolution='paid',revision=revision+1 WHERE order_id=o.order_id;
   ELSE UPDATE campus.order_payment_state SET resolution='compensation_review',revision=revision+1 WHERE order_id=o.order_id;PERFORM campus.money_hold(o.id,'late_payment_compensation','late:'||aid::text,'{}');END IF;
  END IF;
 END IF;
 IF fact->'actualFeeCents' IS NOT NULL AND fact->'actualFeeCents'<>'null'::jsonb THEN
  actual:=(fact->>'actualFeeCents')::bigint;feeid:=fact->>'feeFactId';IF actual<0 OR coalesce(feeid,'')='' THEN RAISE EXCEPTION 'invalid_fee_fact' USING ERRCODE='P0001';END IF;
  SELECT * INTO allocation FROM campus.funding_allocations WHERE lot_id=l.id;
  IF allocation.fee_fact_id IS NULL THEN
   IF actual>0 THEN PERFORM campus.money_journal(e.id,l.id,'fee:'||feeid,jsonb_build_array(jsonb_build_object('account','fee_expense','debit',actual),jsonb_build_object('account','cash','credit',actual)));END IF;
   UPDATE campus.funding_allocations SET actual_fee_cents=actual,fee_fact_id=feeid,available_cents=(fact->>'availableCents')::bigint,fee_state=CASE WHEN NOT campus.money_inline_closed(e.id,aid,fact) OR EXISTS(SELECT 1 FROM campus.payment_fee_plan_bindings WHERE obligation_id=o.id) THEN 'fee_actual_pending' WHEN actual=o.fee_cents THEN 'matched' ELSE 'fee_variance_pending' END WHERE lot_id=l.id;
   IF actual=o.fee_cents AND campus.money_inline_closed(e.id,aid,fact) AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_plan_bindings WHERE obligation_id=o.id) THEN
    entry:=jsonb_build_array(jsonb_build_object('account','publisher_fee_liability','debit',o.publisher_fee_cents),jsonb_build_object('account','reward_liability','debit',o.fee_cents-o.publisher_fee_cents),jsonb_build_object('account','fee_recovery','credit',o.fee_cents));
    IF actual>0 THEN jid:=campus.money_journal(e.id,l.id,'fee_recovery:'||l.id::text,entry);ELSE jid:=allocation.receipt_journal_id;END IF;
    INSERT INTO campus.fee_consumptions SELECT r.id,e.id,l.id,feeid,jid FROM campus.money_reservations r WHERE r.lot_id=l.id AND r.kind IN('publisher_fee','recipient_fee') ON CONFLICT DO NOTHING;
    UPDATE campus.money_reservations SET status='consumed' WHERE lot_id=l.id AND kind IN('publisher_fee','recipient_fee');
   ELSIF campus.money_inline_closed(e.id,aid,fact) AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_plan_bindings WHERE obligation_id=o.id) THEN PERFORM campus.money_hold(o.id,'fee_variance_pending','fee_variance:'||l.id::text,jsonb_build_object('estimated',o.fee_cents,'actual',actual,'exposure',actual-o.fee_cents));END IF;
  ELSIF allocation.actual_fee_cents=actual AND allocation.fee_fact_id=feeid THEN UPDATE campus.funding_allocations SET available_cents=(fact->>'availableCents')::bigint WHERE lot_id=l.id;
  ELSE PERFORM campus.money_hold(o.id,'fee_fact_changed','fee_changed:'||feeid,jsonb_build_object('actual',actual));
  END IF;
 END IF;
 RETURN jsonb_build_object('coverage',CASE WHEN EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active) THEN 'held' ELSE 'covered' END);
END $$;

CREATE OR REPLACE FUNCTION campus.money_earn(review_uuid uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.milestone_reviews;b campus.submission_terms;t campus.agreement_transaction_bindings;elig uuid;cp campus.funding_component_plans;l campus.funding_lots;f campus.funding_allocations;pol text;ready boolean;
BEGIN
 SELECT * INTO r FROM campus.milestone_reviews WHERE id=review_uuid AND decision='accepted';IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO b FROM campus.submission_terms WHERE submission_id=r.submission_id;
 PERFORM 1 FROM campus.agreements WHERE id=b.agreement_id FOR UPDATE;
 PERFORM campus.money_cash_lock((SELECT environment_id FROM campus.funding_obligations WHERE agreement_id=b.agreement_id ORDER BY id LIMIT 1));
 SELECT * INTO t FROM campus.agreement_transaction_bindings WHERE agreement_id=b.agreement_id AND terms_id=b.terms_id;
 IF t.transaction_terms_id IS NULL THEN RETURN NULL;END IF;
 SELECT id INTO elig FROM campus.settlement_eligibilities WHERE review_id=r.id;
 IF elig IS NULL THEN
 INSERT INTO campus.settlement_eligibilities(agreement_id,review_id,submission_id,milestone_id,terms_id,terms_revision,transaction_terms_id,transaction_terms_revision,submission_version,milestone_revision)
 VALUES(b.agreement_id,r.id,r.submission_id,r.milestone_id,b.terms_id,b.terms_revision,t.transaction_terms_id,t.transaction_terms_revision,r.submission_version,r.milestone_revision) RETURNING id INTO elig;
 END IF;
 SELECT release_policy INTO pol FROM campus.agreement_transaction_terms WHERE id=t.transaction_terms_id;
 ready:=pol='per_milestone' OR EXISTS(SELECT 1 FROM campus.agreements WHERE id=b.agreement_id AND state='completed');
 FOR cp IN SELECT c.* FROM campus.money_effective_components c JOIN campus.funding_lots x ON x.id=c.lot_id JOIN campus.funding_obligations o ON o.id=x.obligation_id WHERE o.agreement_id=b.agreement_id AND EXISTS(SELECT 1 FROM campus.transaction_component_memberships mm WHERE mm.transaction_terms_id=t.transaction_terms_id AND mm.component_id=c.id) AND c.milestone_id=r.milestone_id ORDER BY c.id LOOP
  SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=cp.lot_id;IF f.fee_state IS DISTINCT FROM 'matched' THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM campus.payables WHERE component_id=cp.id) THEN CONTINUE;END IF;
  IF cp.net_cents>0 THEN PERFORM campus.money_journal(cp.environment_id,cp.lot_id,'earned:'||cp.id::text,jsonb_build_array(jsonb_build_object('account','reward_liability','debit',cp.net_cents,'componentId',cp.id),jsonb_build_object('account','payable','credit',cp.net_cents,'componentId',cp.id,'memberId',cp.member_id)));END IF;
  INSERT INTO campus.payables(environment_id,lot_id,component_id,eligibility_id,release_ready,net_cents,gross_satisfied_cents) VALUES(cp.environment_id,cp.lot_id,cp.id,elig,ready,cp.net_cents,CASE WHEN cp.net_cents=0 THEN cp.gross_cents ELSE 0 END);
 END LOOP;
 IF ready AND pol='final_completion' THEN UPDATE campus.payables p SET release_ready=true FROM campus.settlement_eligibilities el WHERE p.eligibility_id=el.id AND el.agreement_id=b.agreement_id AND EXISTS(SELECT 1 FROM campus.transaction_component_memberships mm WHERE mm.transaction_terms_id=t.transaction_terms_id AND mm.component_id=p.component_id);END IF;
 RETURN elig;
END $$;
-- Canonical exact entries, including explicit omission for zero journals.
CREATE FUNCTION campus.amend_entries(jid uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,campus AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('account',account,'debit',debit,'credit',credit,'memberId',member_id,'componentId',component_id) ORDER BY position),'[]') FROM campus.ledger_lines WHERE journal_id=jid $$;
CREATE FUNCTION campus.amend_expected_entries(entries jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,campus AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('account',v->>'account','debit',coalesce((v->>'debit')::bigint,0),'credit',coalesce((v->>'credit')::bigint,0),'memberId',v->'memberId','componentId',v->'componentId') ORDER BY n),'[]') FROM jsonb_array_elements(entries) WITH ORDINALITY a(v,n) WHERE coalesce((v->>'debit')::bigint,0)+coalesce((v->>'credit')::bigint,0)>0 $$;
CREATE FUNCTION campus.amend_environment_foreign(p campus.amendment_financial_plans,h campus.payment_environment_effect_history) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE rowvalue jsonb:=coalesce(h.after_state,h.before_state);sem text;run text;bid text;
BEGIN
 -- Profile or unresolved evidence changes affect this candidate even when their final value is restored.
 IF h.relation_name IN('payment_billing_profiles','payment_collection_profiles','payment_fee_evidence_conflicts') THEN RETURN true;END IF;
 IF h.relation_name='payment_synthetic_fee_closures' THEN RETURN EXISTS(SELECT 1 FROM campus.funding_obligations WHERE agreement_id=p.agreement_id AND id=(rowvalue->>'obligation_id')::uuid);END IF;
 sem:=rowvalue->>'semantic_id';run:=rowvalue->>'run_id';bid:=rowvalue->>'balance_id';
 -- A report/cash item can be excluded only when all its exact rows resolve to other agreements.
 RETURN NOT EXISTS(SELECT 1 FROM campus.payment_fee_report_rows rr WHERE rr.environment_id=p.environment_id AND
  (rr.semantic_id=sem OR (run IS NOT NULL AND EXISTS(SELECT 1 FROM campus.payment_fee_report_memberships m WHERE m.environment_id=p.environment_id AND m.run_id=run AND m.semantic_id=rr.semantic_id)) OR rr.body->>'balanceTransactionId'=bid))
 OR EXISTS(SELECT 1 FROM campus.payment_fee_report_rows rr WHERE rr.environment_id=p.environment_id AND
  (rr.semantic_id=sem OR (run IS NOT NULL AND EXISTS(SELECT 1 FROM campus.payment_fee_report_memberships m WHERE m.environment_id=p.environment_id AND m.run_id=run AND m.semantic_id=rr.semantic_id)) OR rr.body->>'balanceTransactionId'=bid)
  AND NOT EXISTS(SELECT 1 FROM campus.payment_receipt_facts rf JOIN campus.funding_obligations o ON o.id=rf.obligation_id WHERE rf.environment_id=p.environment_id AND rf.charge_id=rr.body->>'incurredBy' AND o.agreement_id IS DISTINCT FROM p.agreement_id));
END $$;
CREATE FUNCTION campus.amend_assess(p campus.amendment_financial_plans) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;f campus.funding_allocations;a campus.payment_attempts;rf campus.payment_receipt_facts;op campus.money_operations;h campus.money_effect_history;eh campus.payment_environment_effect_history;assessment uuid;reason_value text;allowed uuid[]:='{}';envallowed uuid[]:='{}';current_state jsonb;expected jsonb;v jsonb;cp campus.funding_component_plans;res campus.money_reservations;receipt_ids uuid[];jids uuid[];before_value jsonb;after_value jsonb;mutable text[];rr bigint;
BEGIN
 PERFORM 1 FROM campus.agreements WHERE id=p.agreement_id FOR UPDATE;PERFORM campus.money_cash_lock(p.environment_id);
 SELECT x.* INTO o FROM campus.funding_obligations x JOIN campus.amendment_funding_origins ao ON ao.obligation_id=x.id WHERE ao.plan_id=p.id FOR UPDATE OF x;
 IF o.id IS NOT NULL THEN PERFORM id FROM campus.funding_lots WHERE obligation_id=o.id ORDER BY id FOR UPDATE;END IF;
 current_state:=campus.amend_history(p.agreement_id,p.environment_id);
 IF NOT campus.amend_plan_current(p) THEN reason_value:='financial_plan_stale';
 ELSIF NOT campus.amend_unanimous(p) THEN reason_value:='financial_consent_required';
 ELSIF (p.body->>'chargeTotalCents')::bigint<(p.body->>'minimumChargeCents')::bigint THEN reason_value:='amount_below_provider_minimum';
 ELSIF o.id IS NULL THEN reason_value:='payment_required';END IF;
 -- The full original effect set must still be byte-identical; reject any foreign intermediate mutation.
 IF NOT (current_state->'history') @> (p.baseline->'history') THEN reason_value:='baseline_history_changed';END IF;
 FOR h IN SELECT * FROM campus.money_effect_history WHERE aggregate_type='agreement' AND aggregate_id=p.agreement_id AND environment_id=p.environment_id AND NOT (p.baseline->'history') @> jsonb_build_array(to_jsonb(money_effect_history)) ORDER BY revision LOOP
  IF h.obligation_id IS DISTINCT FROM o.id OR h.mutation='DELETE' THEN reason_value:='foreign_money_effect';EXIT;END IF;
  IF h.relation_name NOT IN('funding_obligations','payment_billing_bindings','payment_quotes','funding_lots','funding_component_plans','money_operations','payment_attempts','payment_outbox','payment_events','ledger_journals','ledger_lines','funding_allocations','money_reservations','fee_consumptions','payment_receipt_facts','payment_receipt_observations') THEN reason_value:='unpermitted_money_effect';EXIT;END IF;
  IF h.mutation='UPDATE' THEN
   mutable:=CASE h.relation_name WHEN 'funding_obligations' THEN ARRAY['revision'] WHEN 'money_operations' THEN ARRAY['status','provider_id','first_dispatched_at','lease_until','fence','result'] WHEN 'payment_attempts' THEN ARRAY['status','session_id','intent_id','charge_id','hosted_url','expires_at'] WHEN 'payment_outbox' THEN ARRAY['attempts','available_at','dead_letter','last_code'] WHEN 'funding_allocations' THEN ARRAY['actual_fee_cents','fee_fact_id','fee_state','available_cents'] WHEN 'money_reservations' THEN ARRAY['status'] ELSE ARRAY[]::text[] END;
   IF mutable='{}' OR (h.before_state-mutable-'privateContentDigest') IS DISTINCT FROM (h.after_state-mutable-'privateContentDigest') THEN reason_value:='unexpected_effect_transition';EXIT;END IF;
   IF h.relation_name='funding_obligations' AND ((h.before_state->>'revision')::int<>1 OR (h.after_state->>'revision')::int<>2) THEN reason_value:='unexpected_obligation_transition';EXIT;END IF;
   IF h.relation_name='money_reservations' AND (h.before_state->>'status'<>'reserved' OR h.after_state->>'status'<>'consumed') THEN reason_value:='unexpected_reservation_transition';EXIT;END IF;
  END IF;
  allowed:=array_append(allowed,h.id);
 END LOOP;
 -- Every environment-history delta is retained and classified, never a blanket ignored revision.
 FOR eh IN SELECT * FROM campus.payment_environment_effect_history WHERE environment_id=p.environment_id AND NOT (p.baseline->'environment') @> jsonb_build_array(to_jsonb(payment_environment_effect_history)) ORDER BY id LOOP
  IF campus.amend_environment_foreign(p,eh) THEN reason_value:='environment_evidence_changed';ELSE envallowed:=array_append(envallowed,eh.id);END IF;
 END LOOP;
 SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=(p.body#>>'{plan,lots,0,fundingPlanLotId}')::uuid;
 SELECT * INTO a FROM campus.payment_attempts WHERE obligation_id=o.id AND status NOT IN('failed','canceled');
 SELECT * INTO op FROM campus.money_operations WHERE id=a.operation_id;
 IF o.id IS NOT NULL AND (a.status IS DISTINCT FROM 'succeeded' OR op.status IS DISTINCT FROM 'succeeded' OR f.fee_state IS DISTINCT FROM 'matched') THEN reason_value:=coalesce(reason_value,'payment_or_fee_pending');END IF;
 IF EXISTS(SELECT 1 FROM campus.money_active_holds hh JOIN campus.funding_obligations oo ON oo.id=hh.obligation_id WHERE oo.agreement_id=p.agreement_id) THEN reason_value:=coalesce(reason_value,'funds_held');END IF;
 IF o.id IS NOT NULL AND (o.source_digest<>p.digest OR o.principal_cents<>(p.body->>'principalCents')::bigint OR o.amount_cents<>(p.body->>'chargeTotalCents')::bigint OR o.fee_cents<>(p.body->>'estimatedProcessorFeeCents')::bigint OR o.terms_id<>p.terms_id) THEN reason_value:='signed_amount_changed';END IF;
 IF f.lot_id IS NOT NULL THEN
  IF f.actual_fee_cents IS DISTINCT FROM o.fee_cents OR f.available_cents IS NULL OR f.available_cents<o.amount_cents-o.fee_cents THEN reason_value:='fee_or_availability_unmatched';END IF;
  SELECT * INTO rf FROM campus.payment_receipt_facts WHERE obligation_id=o.id AND attempt_id=a.id AND charge_id=f.charge_id AND observed_fee_cents=o.fee_cents AND fee_fact_id=f.fee_fact_id AND disposition='allocated' ORDER BY recorded_at DESC LIMIT 1;
  IF rf.id IS NULL OR rf.source_digest<>p.digest OR rf.amount_cents<>o.amount_cents OR rf.operation_id<>op.id OR rf.receipt_journal_id<>f.receipt_journal_id OR op.kind<>'checkout' OR op.payload->>'sourceDigest'<>p.digest OR (op.payload->>'amountCents')::bigint<>o.amount_cents OR op.payload->'paymentMethodTypes'<>'["card"]'::jsonb OR op.payload_hash<>campus.amend_hash(op.payload) THEN reason_value:='receipt_provenance_unmatched';END IF;
  expected:=campus.amend_expected_entries(jsonb_build_array(jsonb_build_object('account','cash','debit',o.amount_cents),jsonb_build_object('account','reward_liability','credit',o.principal_cents),jsonb_build_object('account','publisher_fee_liability','credit',o.publisher_fee_cents)));
  IF campus.amend_entries(rf.receipt_journal_id)<>expected THEN reason_value:='receipt_entries_unmatched';END IF;
  expected:=campus.amend_expected_entries(jsonb_build_array(jsonb_build_object('account','fee_expense','debit',o.fee_cents),jsonb_build_object('account','cash','credit',o.fee_cents)));
  IF campus.amend_entries(rf.fee_journal_id)<>expected OR (o.fee_cents=0) IS DISTINCT FROM rf.fee_zero_omitted THEN reason_value:='fee_entries_unmatched';END IF;
  expected:=campus.amend_expected_entries(jsonb_build_array(jsonb_build_object('account','publisher_fee_liability','debit',o.publisher_fee_cents),jsonb_build_object('account','reward_liability','debit',o.fee_cents-o.publisher_fee_cents),jsonb_build_object('account','fee_recovery','credit',o.fee_cents)));
  IF campus.amend_entries(rf.fee_recovery_journal_id)<>expected OR (o.fee_cents=0) IS DISTINCT FROM rf.recovery_zero_omitted THEN reason_value:='recovery_entries_unmatched';END IF;
  jids:=array_remove(ARRAY[rf.receipt_journal_id,rf.fee_journal_id,rf.fee_recovery_journal_id],NULL);
  IF EXISTS(SELECT 1 FROM campus.ledger_journals WHERE lot_id=f.lot_id AND NOT id=ANY(jids)) OR EXISTS(SELECT 1 FROM campus.payment_receipt_facts WHERE obligation_id=o.id AND (disposition<>'allocated' OR charge_id<>rf.charge_id OR (observed_fee_cents IS NOT NULL AND observed_fee_cents<>o.fee_cents))) THEN reason_value:='extra_or_unmatched_money';END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p.body#>'{plan,lots,0,components}') LOOP
   SELECT * INTO cp FROM campus.funding_component_plans WHERE id=(v->>'id')::uuid AND lot_id=f.lot_id;
   IF cp.id IS NULL OR cp.member_id<>(v->>'memberId')::uuid OR cp.milestone_id<>(v->>'milestoneId')::uuid OR cp.gross_cents<>(v->>'grossCents')::bigint OR cp.recipient_fee_cents<>(v->>'recipientFeeCents')::bigint OR cp.net_cents<>(v->>'netCents')::bigint THEN reason_value:='component_coverage_mismatch';END IF;
  END LOOP;
  IF (SELECT count(*) FROM campus.funding_component_plans WHERE lot_id=f.lot_id)<>jsonb_array_length(p.body#>'{plan,lots,0,components}') OR (SELECT sum(gross_cents) FROM campus.funding_component_plans WHERE lot_id=f.lot_id)<>o.principal_cents THEN reason_value:='component_coverage_mismatch';END IF;
  IF (SELECT count(*) FROM campus.money_reservations WHERE lot_id=f.lot_id)<>1+jsonb_array_length(p.body#>'{plan,lots,0,components}') THEN reason_value:='fee_capacity_mismatch';END IF;
  FOR res IN SELECT * FROM campus.money_reservations WHERE lot_id=f.lot_id LOOP
   IF res.status<>'consumed' OR res.kind NOT IN('publisher_fee','recipient_fee') OR res.operation_id IS NOT NULL OR res.cash_debited_cents<>0 OR res.amount_cents IS DISTINCT FROM CASE WHEN res.kind='publisher_fee' THEN o.publisher_fee_cents ELSE (SELECT recipient_fee_cents FROM campus.funding_component_plans WHERE id=res.component_id AND lot_id=f.lot_id) END OR NOT EXISTS(SELECT 1 FROM campus.fee_consumptions WHERE reservation_id=res.id AND fee_fact_id=rf.fee_fact_id AND journal_id=CASE WHEN o.fee_cents=0 THEN rf.receipt_journal_id ELSE rf.fee_recovery_journal_id END) THEN reason_value:='fee_capacity_mismatch';END IF;
  END LOOP;
 END IF;
 INSERT INTO campus.amendment_money_assessments(plan_id,baseline_digest,current_digest,status,reason,allowed_effect_ids,environment_effect_ids,details) VALUES(p.id,campus.amend_hash(p.baseline),campus.amend_hash(current_state),CASE WHEN reason_value IS NULL THEN 'ready' ELSE 'blocked' END,reason_value,allowed,envallowed,jsonb_build_object('currentRevision',current_state->'revision','originalRevision',p.baseline->'revision','receiptFactId',rf.id,'journalIds',jids,'feeZeroOmitted',rf.fee_zero_omitted,'recoveryZeroOmitted',rf.recovery_zero_omitted,'shortfallCents',CASE WHEN f.lot_id IS NULL THEN (p.body->>'principalCents')::bigint ELSE 0 END,'excessCents',0)) RETURNING id INTO assessment;
 RETURN jsonb_build_object('assessmentId',assessment,'planId',p.id,'revision',p.revision,'digest',p.digest,'status',CASE WHEN reason_value IS NULL THEN 'ready' ELSE 'blocked' END,'reason',reason_value);
END $$;
CREATE FUNCTION campus.amend_money_assess(gid uuid,aid uuid,rev integer,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ BEGIN RETURN campus.amend_assess(campus.amend_plan_exact(gid,aid,rev,request));END $$;
CREATE OR REPLACE FUNCTION campus.inherit_transaction_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE b campus.agreement_transaction_bindings;
BEGIN
 IF NEW.effective_terms_id IS NOT DISTINCT FROM OLD.effective_terms_id THEN RETURN NEW;END IF;
 IF EXISTS(SELECT 1 FROM campus.agreement_transaction_bindings nb JOIN campus.agreement_transaction_terms nt ON nt.id=nb.transaction_terms_id JOIN campus.amendment_money_activations act ON act.transaction_terms_id=nt.id WHERE nb.agreement_id=NEW.agreement_id AND nb.terms_id=NEW.effective_terms_id AND nb.terms_revision=NEW.effective_revision) THEN RETURN NEW;END IF;
 SELECT * INTO b FROM campus.agreement_transaction_bindings WHERE agreement_id=NEW.agreement_id AND terms_id=OLD.effective_terms_id;
 IF b.transaction_terms_id IS NULL THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.agreements WHERE id=NEW.agreement_id AND state='active') OR NOT EXISTS(SELECT 1 FROM campus.transaction_component_memberships WHERE transaction_terms_id=b.transaction_terms_id) OR EXISTS(SELECT 1 FROM campus.transaction_component_memberships mm JOIN campus.funding_component_plans cp ON cp.id=mm.component_id LEFT JOIN campus.funding_allocations ff ON ff.lot_id=cp.lot_id WHERE mm.transaction_terms_id=b.transaction_terms_id AND ff.fee_state IS DISTINCT FROM 'matched') THEN RAISE EXCEPTION 'agreement_not_funded_or_closed' USING ERRCODE='P0001';END IF;
 IF EXISTS((SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=OLD.effective_terms_id EXCEPT SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=NEW.effective_terms_id) UNION ALL (SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=NEW.effective_terms_id EXCEPT SELECT milestone_id,amount_cents FROM campus.agreement_milestone_terms WHERE terms_id=OLD.effective_terms_id)) THEN RAISE EXCEPTION 'transaction_reassessment_required' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.agreement_transaction_bindings VALUES(NEW.agreement_id,NEW.effective_terms_id,NEW.effective_revision,b.transaction_terms_id,b.transaction_terms_revision,'nonmonetary_inheritance');RETURN NEW;
END $$;
CREATE FUNCTION campus.amend_money_activate(gid uuid,aid uuid,rev integer,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;assessment jsonb;tt campus.agreement_transaction_terms;r campus.agreement_amendment_revisions;old campus.amendment_money_activations;
BEGIN p:=campus.amend_plan_exact(gid,aid,rev,request);
 IF campus.actor()<>(SELECT owner_id FROM campus.agreements WHERE id=gid) THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001';END IF;
 SELECT * INTO old FROM campus.amendment_money_activations WHERE plan_id=p.id;
 IF old.plan_id IS NOT NULL THEN RETURN jsonb_build_object('planId',p.id,'revision',p.revision,'digest',p.digest,'status','effective','assessmentId',old.assessment_id,'transactionTermsId',old.transaction_terms_id);END IF;
 assessment:=campus.amend_assess(p);IF assessment->>'status'<>'ready' THEN RETURN assessment;END IF;
 PERFORM campus.validate_amendment_effect(aid,p.proposal_revision);
 SELECT * INTO tt FROM campus.agreement_transaction_terms WHERE amendment_plan_id=p.id;
 SELECT * INTO r FROM campus.agreement_amendment_revisions WHERE amendment_id=aid AND proposal_revision=p.proposal_revision;
 -- All old component identities must survive, and all additions must be the signed lot.
 IF EXISTS(SELECT component_id FROM campus.transaction_component_memberships WHERE transaction_terms_id=p.base_transaction_id EXCEPT SELECT component_id FROM campus.transaction_component_memberships WHERE transaction_terms_id=tt.id) THEN RAISE EXCEPTION 'component_union_incomplete' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.amendment_money_activations VALUES(p.id,(assessment->>'assessmentId')::uuid,tt.id,campus.money_now());
 INSERT INTO campus.agreement_transaction_bindings VALUES(gid,p.terms_id,p.terms_revision,tt.id,tt.revision,'amendment_verified_funding');
 INSERT INTO campus.milestones(id,agreement_id,position,title,amount_cents,deliverable,acceptance_criteria) SELECT mt.milestone_id,gid,mt.position,mt.title,mt.amount_cents,mt.deliverable,mt.acceptance_criteria FROM campus.agreement_milestone_terms mt WHERE mt.terms_id=p.terms_id AND mt.milestone_id=ANY(r.added_milestone_ids);
 UPDATE campus.agreement_terms_state SET effective_terms_id=p.terms_id,effective_revision=p.terms_revision WHERE agreement_id=gid;
 UPDATE campus.agreement_amendments SET status='effective' WHERE id=aid;
 PERFORM campus.record_amendment_event(aid,'effective','agreed_waiting_funds','effective');
 RETURN jsonb_build_object('planId',p.id,'revision',p.revision,'digest',p.digest,'status','effective','assessmentId',assessment->'assessmentId','transactionTermsId',tt.id);
END $$;
CREATE FUNCTION campus.amend_money_cancel(gid uuid,aid uuid,rev integer,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;
BEGIN p:=campus.amend_plan_exact(gid,aid,rev,request);
 IF EXISTS(SELECT 1 FROM campus.amendment_money_activations WHERE plan_id=p.id) THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.amendment_money_cancellations VALUES(p.id,campus.actor(),request->>'reason',campus.money_now()) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('planId',p.id,'revision',p.revision,'digest',p.digest,'status','cancellation_requested');END $$;
CREATE FUNCTION campus.amend_candidate_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF NEW.current_proposal_revision<>OLD.current_proposal_revision AND EXISTS(SELECT 1 FROM campus.amendment_financial_plans p JOIN campus.amendment_funding_origins ao ON ao.plan_id=p.id WHERE p.amendment_id=OLD.id) THEN RAISE EXCEPTION 'candidate_collection_reserved' USING ERRCODE='P0001';END IF;RETURN NEW;END $$;
CREATE TRIGGER money_candidate_frozen BEFORE UPDATE ON campus.agreement_amendments FOR EACH ROW EXECUTE FUNCTION campus.amend_candidate_frozen();
ALTER FUNCTION campus.end_agreement_amendment(uuid,uuid,jsonb,text) RENAME TO end_agreement_amendment_before_money;
CREATE FUNCTION campus.end_agreement_amendment(gid uuid,aid uuid,request jsonb,operation text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;r campus.agreement_amendment_revisions;
BEGIN PERFORM campus.lock_agreement_amendment(gid);r:=campus.exact_amendment_revision(gid,aid,request);
 IF operation='withdraw' AND campus.actor()<>(SELECT proposer_id FROM campus.agreement_amendments WHERE id=aid) THEN RAISE EXCEPTION 'not_proposer' USING ERRCODE='P0001';END IF;
 FOR p IN SELECT pp.* FROM campus.amendment_financial_plans pp JOIN campus.amendment_funding_origins ao ON ao.plan_id=pp.id WHERE pp.amendment_id=aid LOOP
  INSERT INTO campus.amendment_money_cancellations VALUES(p.id,campus.actor(),request->>'reason',campus.money_now()) ON CONFLICT DO NOTHING;
 END LOOP;
 -- Ordinary withdrawal may end the work proposal, while separately retained money stays visible.
 RETURN campus.end_agreement_amendment_before_money(gid,aid,request,operation);END $$;
CREATE FUNCTION campus.amend_money_read(gid uuid,aid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;plans jsonb:='[]';reasons jsonb;actions jsonb;confirmed jsonb;o campus.funding_obligations;funded boolean;effective boolean;current_plan boolean;
BEGIN
 IF NOT campus.in_agreement(gid) OR NOT EXISTS(SELECT 1 FROM campus.agreement_amendments WHERE id=aid AND agreement_id=gid) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 FOR p IN SELECT * FROM campus.amendment_financial_plans WHERE agreement_id=gid AND amendment_id=aid ORDER BY revision LOOP
  reasons:='[]';actions:='["refresh"]';current_plan:=campus.amend_plan_current(p);effective:=EXISTS(SELECT 1 FROM campus.amendment_money_activations WHERE plan_id=p.id);
  SELECT coalesce(jsonb_agg(user_id ORDER BY user_id),'[]') INTO confirmed FROM campus.amendment_financial_confirmations WHERE plan_id=p.id AND digest=p.digest;
  SELECT oo.* INTO o FROM campus.funding_obligations oo JOIN campus.amendment_funding_origins ao ON ao.obligation_id=oo.id WHERE ao.plan_id=p.id;
  funded:=EXISTS(SELECT 1 FROM campus.funding_allocations f JOIN campus.funding_lots l ON l.id=f.lot_id WHERE l.obligation_id=o.id);
  IF NOT current_plan AND NOT effective THEN reasons:=reasons||'"financial_plan_stale"'::jsonb;END IF;
  IF NOT campus.amend_unanimous(p) THEN reasons:=reasons||'"ordinary_and_financial_consent_required"'::jsonb;END IF;
  IF (p.body->>'chargeTotalCents')::bigint<(p.body->>'minimumChargeCents')::bigint THEN reasons:=reasons||'"amount_below_provider_minimum"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM campus.amendment_money_cancellations WHERE plan_id=p.id) THEN reasons:=reasons||'"cancellation_requested"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id) THEN reasons:=reasons||'"funds_held"'::jsonb;END IF;
  IF current_plan AND NOT confirmed ? campus.actor()::text THEN actions:=actions||'"confirm_financial_plan"'::jsonb;END IF;
  IF current_plan AND reasons='[]' AND campus.actor()=(SELECT owner_id FROM campus.agreements WHERE id=gid) THEN actions:=actions||CASE WHEN o.id IS NULL THEN '["request_quote"]'::jsonb WHEN funded THEN '["assess","activate"]'::jsonb ELSE '["request_quote","assess"]'::jsonb END;END IF;
  IF NOT effective THEN actions:=actions||'"request_cancellation"'::jsonb;END IF;
  plans:=plans||jsonb_build_array(jsonb_build_object('planId',p.id,'revision',p.revision,'digest',p.digest,'plan',p.body,'confirmedParticipantIds',confirmed,'obligationId',o.id,'funded',funded,'effective',effective,'blockedReasons',reasons,'allowedActions',actions));
 END LOOP;
 RETURN jsonb_build_object('agreementId',gid,'amendmentId',aid,'plans',plans,'financialPolicyLimits',jsonb_build_array('decrease_reallocation_retirement_require_compensation_policy','supported_usd_card_minimum'));
END $$;
DO $$ DECLARE t text;p record;BEGIN
 FOREACH t IN ARRAY ARRAY['amendment_financial_plans','amendment_financial_confirmations','amendment_funding_origins','transaction_component_memberships','amendment_money_assessments','amendment_money_activations','amendment_money_cancellations'] LOOP
  EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);
 END LOOP;
 FOR p IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='campus'::regnamespace AND (proname LIKE 'amend_%' OR proname IN('money_dispatchable','money_dispatchable_before_amendment','end_agreement_amendment','end_agreement_amendment_before_money')) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.sig);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION campus.amend_money_read(uuid,uuid),campus.amend_money_propose(uuid,uuid,jsonb),campus.amend_money_confirm(uuid,uuid,integer,jsonb),campus.amend_money_quote(uuid,uuid,integer,jsonb),campus.amend_money_assess(uuid,uuid,integer,jsonb),campus.amend_money_activate(uuid,uuid,integer,jsonb),campus.amend_money_cancel(uuid,uuid,integer,jsonb) TO campus_app;
