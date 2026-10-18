CREATE VIEW campus.money_active_holds AS SELECT * FROM campus.payment_holds WHERE active;
REVOKE ALL ON campus.money_active_holds FROM PUBLIC,campus_app,campus_auth,campus_worker;
-- Purpose functions are the only money mutation authority. No provider network inside transactions.
CREATE TABLE campus.settlement_eligibilities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agreement_id uuid NOT NULL REFERENCES campus.agreements,review_id uuid NOT NULL UNIQUE REFERENCES campus.milestone_reviews,
 submission_id uuid NOT NULL REFERENCES campus.submissions,milestone_id uuid NOT NULL,terms_id uuid NOT NULL,terms_revision integer NOT NULL,
 transaction_terms_id uuid NOT NULL,transaction_terms_revision integer NOT NULL,submission_version integer NOT NULL,milestone_revision integer NOT NULL,
 FOREIGN KEY(transaction_terms_id,agreement_id,transaction_terms_revision) REFERENCES campus.agreement_transaction_terms(id,agreement_id,revision),
 FOREIGN KEY(terms_id,milestone_id) REFERENCES campus.agreement_milestone_terms(terms_id,milestone_id)
);
CREATE TABLE campus.payables (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL,lot_id uuid NOT NULL,component_id uuid NOT NULL UNIQUE,
 eligibility_id uuid REFERENCES campus.settlement_eligibilities,release_ready boolean NOT NULL DEFAULT false,net_cents bigint NOT NULL CHECK(net_cents>=0),
 operation_id uuid REFERENCES campus.money_operations,transferred_cents bigint NOT NULL DEFAULT 0,gross_satisfied_cents bigint NOT NULL DEFAULT 0,
 FOREIGN KEY(component_id,environment_id,lot_id) REFERENCES campus.funding_component_plans(id,environment_id,lot_id)
);
CREATE TABLE campus.order_payment_state (
 order_id uuid PRIMARY KEY REFERENCES campus.orders,revision integer NOT NULL DEFAULT 1,terms_digest text NOT NULL,
 resolution text NOT NULL DEFAULT 'open' CHECK(resolution IN('open','cancellation_requested','expiry_resolving','paid','compensation_review','terminal')),
 requested_terminal text CHECK(requested_terminal IN('cancelled','expired'))
);
CREATE TABLE campus.inventory_release_events(order_id uuid PRIMARY KEY REFERENCES campus.orders,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now());
CREATE TABLE campus.refund_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,requester_id uuid NOT NULL REFERENCES campus.users,
 charge_id text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),reason text NOT NULL,policy_id uuid NOT NULL REFERENCES campus.payment_execution_policies,
 revision integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'requested',created_at timestamptz NOT NULL DEFAULT campus.money_now()
);
CREATE TABLE campus.dispute_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,origin text NOT NULL CHECK(origin IN('participant','network')),
 source_id text NOT NULL,reason text NOT NULL,revision integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'open',UNIQUE(obligation_id,origin,source_id)
);
CREATE TABLE campus.provider_payout_observations (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,account_id text NOT NULL,payout_id text NOT NULL,status text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT campus.money_now(),PRIMARY KEY(environment_id,account_id,payout_id),
 FOREIGN KEY(environment_id,account_id) REFERENCES campus.connected_payee_accounts(environment_id,provider_account_id)
);
CREATE TABLE campus.amendment_funding_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agreement_id uuid NOT NULL REFERENCES campus.agreements,amendment_id uuid NOT NULL,proposal_revision integer NOT NULL,
 terms_id uuid NOT NULL,base_terms_id uuid NOT NULL,ledger_revision bigint NOT NULL,shortfall_cents bigint,excess_cents bigint,outcome text NOT NULL,detail jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT campus.money_now(),FOREIGN KEY(amendment_id,agreement_id) REFERENCES campus.agreement_amendments(id,agreement_id)
);
CREATE FUNCTION campus.money_lock(oid uuid,writing boolean DEFAULT false) RETURNS campus.funding_obligations LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;
BEGIN
 IF NOT campus.money_visible(oid) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT * INTO o FROM campus.funding_obligations WHERE id=oid;
 IF o.agreement_id IS NOT NULL THEN PERFORM 1 FROM campus.agreements WHERE id=o.agreement_id FOR UPDATE;ELSE PERFORM 1 FROM campus.orders WHERE id=o.order_id FOR UPDATE;END IF;
 SELECT * INTO o FROM campus.funding_obligations WHERE id=oid FOR UPDATE;
 IF writing AND NOT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';END IF;RETURN o;
END $$;
CREATE FUNCTION campus.money_environment() RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE eid uuid;
BEGIN SELECT id INTO eid FROM campus.payment_environments WHERE enabled;IF NOT FOUND OR (SELECT count(*) FROM campus.payment_environments WHERE enabled)<>1 THEN RAISE EXCEPTION 'payments_unavailable' USING ERRCODE='P0001';END IF;RETURN eid;END $$;
CREATE FUNCTION campus.money_capabilities() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('enabled',count(*)=1,'environment',CASE WHEN count(*)=1 THEN min(mode) ELSE 'unavailable' END,'schemaRequirement',20,'policyReadiness','per_resource','providerReadiness',CASE WHEN count(*)=1 THEN 'configured_not_provider_acceptance' ELSE 'unverified' END) FROM campus.payment_environments WHERE enabled
$$;
CREATE FUNCTION campus.money_enqueue(eid uuid,oid uuid,k text,business text,body jsonb) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op uuid:=gen_random_uuid();existing campus.money_operations;hash text;
BEGIN
 hash:=encode(sha256(convert_to(campus.transaction_canonical(body),'UTF8')),'hex');
 SELECT * INTO existing FROM campus.money_operations WHERE environment_id=eid AND kind=k AND business_key=business;
 IF FOUND THEN IF existing.payload_hash<>hash THEN RAISE EXCEPTION 'operation_payload_conflict' USING ERRCODE='P0001';END IF;RETURN existing.id;END IF;
 INSERT INTO campus.money_operations(id,environment_id,obligation_id,kind,business_key,payload,payload_hash,provider_key) VALUES(op,eid,oid,k,business,body,hash,eid::text||':'||op::text||':'||k);
 INSERT INTO campus.payment_outbox(operation_id) VALUES(op);RETURN op;
END $$;
CREATE FUNCTION campus.money_agreement_quote(gid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE g campus.agreements;s campus.agreement_terms_state;t campus.agreement_transaction_terms;p campus.payment_execution_policies;e uuid;o campus.funding_obligations;q campus.payment_quotes;l jsonb;body jsonb;lid uuid;fp jsonb;
BEGIN
 g:=campus.lock_agreement_amendment(gid);IF g.owner_id<>campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001';END IF;
 e:=campus.money_environment();SELECT * INTO s FROM campus.agreement_terms_state WHERE agreement_id=gid;
 SELECT x.* INTO t FROM campus.agreement_transaction_terms x JOIN campus.agreement_transaction_bindings b ON b.transaction_terms_id=x.id WHERE b.agreement_id=gid AND b.terms_id=s.effective_terms_id;
 IF t.id IS NULL THEN RAISE EXCEPTION 'release_policy_not_recorded' USING ERRCODE='P0001';END IF;
 IF (request->>'expectedEffectiveTermsId')::uuid IS DISTINCT FROM s.effective_terms_id OR (request->>'expectedEffectiveRevision')::integer IS DISTINCT FROM s.effective_revision OR (request->>'transactionTermsId')::uuid IS DISTINCT FROM t.id OR (request->>'transactionTermsRevision')::integer IS DISTINCT FROM t.revision THEN RAISE EXCEPTION 'terms_refresh_required' USING ERRCODE='P0001';END IF;
 IF NOT campus.transaction_policy_disclosure_valid(t.policy_snapshot->'payload') THEN RAISE EXCEPTION 'fee_adjustment_policy_unresolved' USING ERRCODE='P0001';END IF;
 SELECT * INTO p FROM campus.payment_execution_policies WHERE environment_id=e AND aggregate_type='agreement' AND aggregate_id=gid AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1;
 IF p.id IS NULL OR p.payload->>'signedPolicyId' IS DISTINCT FROM t.policy_id::text OR coalesce(p.payload->>'feeAdjustment','') NOT IN('hold_on_variance','capped_actual_v1') THEN RAISE EXCEPTION 'fee_adjustment_policy_unresolved' USING ERRCODE='P0001';END IF;
 IF p.digest<>encode(sha256(convert_to(campus.transaction_canonical(p.payload),'UTF8')),'hex') THEN RAISE EXCEPTION 'policy_digest_mismatch' USING ERRCODE='P0001';END IF;
 IF p.payload->>'feeAdjustment'='capped_actual_v1' THEN fp:=to_jsonb(campus.money_confirmed_fee_plan(e,'agreement',gid,p.id,t.digest));END IF;
 l:=coalesce(fp->'body'->'maximumPlan',t.plan)->'lots'->0;lid:=(l->>'fundingPlanLotId')::uuid;
 SELECT * INTO o FROM campus.funding_obligations WHERE environment_id=e AND aggregate_type='agreement' AND aggregate_id=gid AND transaction_terms_id=t.id;
 IF FOUND AND (o.policy_id<>p.id OR o.source_digest<>t.digest) THEN RAISE EXCEPTION 'quote_changed' USING ERRCODE='P0001';END IF;
 IF o.id IS NULL THEN
  IF g.state<>'awaiting_funding' THEN RAISE EXCEPTION 'legacy_coverage_unknown' USING ERRCODE='P0001';END IF;
  INSERT INTO campus.funding_obligations(environment_id,aggregate_type,aggregate_id,agreement_id,payer_id,terms_id,terms_revision,transaction_terms_id,transaction_terms_revision,allocation_revision,source_digest,policy_id,currency,principal_cents,fee_cents,publisher_fee_cents,amount_cents)
  VALUES(e,'agreement',gid,gid,g.owner_id,s.effective_terms_id,s.effective_revision,t.id,t.revision,t.allocation_revision,t.digest,p.id,'USD',(l->>'principalCents')::bigint,(l->>'estimatedProcessorFeeCents')::bigint,(l->>'publisherProcessorFeeCents')::bigint,(l->>'chargeTotalCents')::bigint) RETURNING * INTO o;
  INSERT INTO campus.funding_lots VALUES(lid,o.id,e,1,o.principal_cents,o.publisher_fee_cents,o.fee_cents);
  INSERT INTO campus.funding_component_plans(environment_id,lot_id,allocation_component_id,member_id,milestone_id,stage_position,gross_cents,recipient_fee_cents,net_cents)
   SELECT e,lid,pa.component_id,pa.member_id,pa.milestone_id,pa.stage_position,pa.gross_cents,(v->>'recipientFeeCents')::bigint,(v->>'netCents')::bigint FROM campus.payee_allocations pa JOIN jsonb_array_elements(l->'components')v ON v->>'memberId'=pa.member_id::text AND (v->>'stagePosition')::int=pa.stage_position WHERE pa.transaction_terms_id=t.id AND pa.funding_plan_lot_id=lid;
  IF fp IS NOT NULL THEN INSERT INTO campus.payment_fee_plan_bindings VALUES(o.id,(fp->>'id')::uuid);END IF;
  IF (SELECT sum(gross_cents) FROM campus.funding_component_plans WHERE lot_id=lid) IS DISTINCT FROM o.principal_cents OR (SELECT sum(recipient_fee_cents) FROM campus.funding_component_plans WHERE lot_id=lid) IS DISTINCT FROM o.fee_cents-o.publisher_fee_cents THEN RAISE EXCEPTION 'invalid_component_plan' USING ERRCODE='P0001';END IF;
 END IF;
 SELECT * INTO q FROM campus.payment_quotes WHERE obligation_id=o.id AND expires_at>campus.money_now() ORDER BY created_at DESC LIMIT 1;
 IF NOT FOUND THEN
 body:=jsonb_build_object('obligationId',o.id,'termsId',o.terms_id,'termsRevision',o.terms_revision,'transactionTermsId',t.id,'transactionTermsRevision',t.revision,'allocationRevision',t.allocation_revision,'environmentId',e,'policyId',p.id,'policyDigest',p.digest,'policyVersion',p.version,'policyProvenance',p.provenance,'sourceDigest',t.digest,'plan',coalesce(fp->'body'->'maximumPlan',t.plan),'principalCents',o.principal_cents,'chargeTotalCents',o.amount_cents,'currency','USD');
 IF fp IS NOT NULL THEN body:=body||jsonb_build_object('feePlanId',fp->>'id','feePlanDigest',fp->>'digest','feePlan',fp->'body');END IF;
 INSERT INTO campus.payment_quotes(obligation_id,environment_id,payer_id,digest,body,expires_at) VALUES(o.id,e,o.payer_id,encode(sha256(convert_to(campus.transaction_canonical(body),'UTF8')),'hex'),body,campus.money_now()+interval '10 minutes') RETURNING * INTO q;
 END IF;RETURN jsonb_build_object('quoteId',q.id,'quoteDigest',q.digest,'obligationId',o.id,'obligationRevision',o.revision,'expiresAt',q.expires_at,'quote',q.body);
END $$;
CREATE FUNCTION campus.money_attempt(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;q campus.payment_quotes;a campus.payment_attempts;op uuid;aid uuid:=gen_random_uuid();e campus.payment_environments;body jsonb;
BEGIN
 o:=campus.money_lock(oid,true);IF campus.actor()<>o.payer_id THEN RAISE EXCEPTION 'not_payer' USING ERRCODE='P0001';END IF;
 SELECT * INTO q FROM campus.payment_quotes WHERE id=(request->>'quoteId')::uuid AND obligation_id=oid;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF q.digest IS DISTINCT FROM request->>'quoteDigest' OR (request->>'acceptedAmountCents')::bigint IS DISTINCT FROM o.amount_cents OR request->>'currency' IS DISTINCT FROM 'USD' THEN RAISE EXCEPTION 'quote_changed' USING ERRCODE='P0001';END IF;
 SELECT * INTO a FROM campus.payment_attempts WHERE obligation_id=oid AND status NOT IN('failed','canceled');
 IF FOUND THEN RETURN jsonb_build_object('attemptId',a.id,'operationId',a.operation_id,'obligationId',oid,'quoteId',a.quote_id,'amountCents',o.amount_cents,'currency',o.currency,'environment',(SELECT mode FROM campus.payment_environments WHERE id=o.environment_id));END IF;
 IF o.policy_id IS DISTINCT FROM (SELECT id FROM campus.payment_execution_policies WHERE environment_id=o.environment_id AND aggregate_type=o.aggregate_type AND aggregate_id=o.aggregate_id AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1) THEN RAISE EXCEPTION 'quote_changed' USING ERRCODE='P0001';END IF;
 IF q.expires_at<=campus.money_now() THEN RAISE EXCEPTION 'quote_expired' USING ERRCODE='P0001';END IF;
 IF o.revision IS DISTINCT FROM (request->>'expectedObligationRevision')::integer THEN RAISE EXCEPTION 'stale_payment_revision' USING ERRCODE='P0001';END IF;
 IF o.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM campus.orders x JOIN campus.order_payment_state ps ON ps.order_id=x.id WHERE x.id=o.order_id AND (x.reserved_until<=campus.money_now() OR ps.resolution<>'open' OR x.state<>'pending_payment')) THEN RAISE EXCEPTION 'quote_expired' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=oid AND active) THEN RAISE EXCEPTION 'funds_held' USING ERRCODE='P0001';END IF;
 SELECT * INTO e FROM campus.payment_environments WHERE id=o.environment_id AND enabled;IF NOT FOUND THEN RAISE EXCEPTION 'payments_unavailable' USING ERRCODE='P0001';END IF;
 body:=jsonb_build_object('attemptId',aid,'obligationId',oid,'quoteId',q.id,'quoteDigest',q.digest,'amountCents',o.amount_cents,'currency','usd','sourceDigest',o.source_digest,'platformAccountId',e.platform_account_id,'mode',e.mode,'policyId',o.policy_id,'policyDigest',(SELECT digest FROM campus.payment_execution_policies WHERE id=o.policy_id),'policyVersion',(SELECT version FROM campus.payment_execution_policies WHERE id=o.policy_id),'policyProvenance',(SELECT provenance FROM campus.payment_execution_policies WHERE id=o.policy_id),'returnUrl',e.origin||'/?view=workspace&tab=agreements&resource='||CASE WHEN o.order_id IS NULL THEN 'agreement' ELSE 'order' END||'&id='||coalesce(o.order_id,o.agreement_id)::text,'integrationIdentifier','campus_bounty_'||translate(substr(replace(aid::text,'-',''),1,8),'0123456789','abcdefghij'));
 op:=campus.money_enqueue(o.environment_id,oid,'checkout',aid::text,body);
 INSERT INTO campus.payment_attempts(id,environment_id,obligation_id,quote_id,operation_id) VALUES(aid,o.environment_id,oid,q.id,op);
 RETURN jsonb_build_object('attemptId',aid,'operationId',op,'obligationId',oid,'quoteId',q.id,'amountCents',o.amount_cents,'currency','USD','environment',e.mode);
END $$;
CREATE FUNCTION campus.money_claim(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;
BEGIN
 SELECT m.* INTO op FROM campus.money_operations m JOIN campus.payment_outbox b ON b.operation_id=m.id WHERE m.environment_id=eid AND NOT b.dead_letter AND b.available_at<=campus.money_now() AND m.status IN('queued','unknown','dispatching','held') AND (m.lease_until IS NULL OR m.lease_until<campus.money_now()) ORDER BY m.created_at LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM campus.money_lock_aggregate(op.obligation_id);IF op.obligation_id IS NOT NULL THEN PERFORM campus.money_cash_lock(op.environment_id);END IF;SELECT * INTO op FROM campus.money_operations WHERE id=op.id AND status IN('queued','unknown','dispatching','held') AND (lease_until IS NULL OR lease_until<campus.money_now()) FOR UPDATE SKIP LOCKED;IF NOT FOUND THEN RETURN NULL;END IF;
 IF op.first_dispatched_at<campus.money_now()-interval '23 hours' THEN UPDATE campus.money_operations SET status='held' WHERE id=op.id;UPDATE campus.payment_outbox SET dead_letter=true,last_code='provider_retention_elapsed' WHERE operation_id=op.id;RETURN NULL;END IF;
 IF NOT campus.money_dispatchable(op) THEN UPDATE campus.money_operations SET status='held' WHERE id=op.id;UPDATE campus.payment_outbox SET available_at=campus.money_now()+interval '30 seconds',last_code='dispatch_gate_held' WHERE operation_id=op.id;RETURN NULL;END IF;
 UPDATE campus.money_operations SET status='dispatching',first_dispatched_at=coalesce(first_dispatched_at,campus.money_now()),lease_until=campus.money_now()+interval '30 seconds',fence=fence+1 WHERE id=op.id RETURNING * INTO op;
 UPDATE campus.payment_outbox SET attempts=attempts+1 WHERE operation_id=op.id;
 RETURN to_jsonb(op);
END $$;
CREATE FUNCTION campus.money_operation_result(opid uuid,token bigint,outcome jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;retry_count integer;
BEGIN
 PERFORM campus.money_lock_aggregate((SELECT obligation_id FROM campus.money_operations WHERE id=opid));PERFORM campus.money_cash_lock((SELECT environment_id FROM campus.money_operations WHERE id=opid AND obligation_id IS NOT NULL));SELECT * INTO op FROM campus.money_operations WHERE id=opid FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.payment_events(environment_id,operation_id,kind,detail) VALUES(op.environment_id,opid,'dispatch_observation',outcome-'url');
 IF op.fence<>token OR op.lease_until<campus.money_now() THEN RETURN false;END IF;
 IF op.status='succeeded' THEN RETURN true;END IF;
 IF outcome->>'status'='unknown' THEN
  UPDATE campus.money_operations SET status='unknown',lease_until=NULL WHERE id=opid;
  UPDATE campus.payment_attempts SET status='unknown' WHERE operation_id=opid AND status<>'succeeded';
  SELECT b.attempts INTO retry_count FROM campus.payment_outbox b WHERE operation_id=opid;
  UPDATE campus.payment_outbox SET available_at=campus.money_now()+make_interval(secs=>least(3600,2^least(retry_count,10))::integer),dead_letter=retry_count>=8,last_code='provider_outcome_unknown' WHERE operation_id=opid;RETURN true;
 END IF;
 IF outcome->>'status'<>'succeeded' OR coalesce(outcome->>'id','')='' THEN RAISE EXCEPTION 'invalid_provider_outcome' USING ERRCODE='P0001';END IF;
 UPDATE campus.money_operations SET status='succeeded',provider_id=outcome->>'id',result=CASE WHEN op.kind='onboarding' THEN outcome ELSE outcome-'url' END,lease_until=NULL WHERE id=opid;
 IF op.kind='checkout' THEN
  UPDATE campus.payment_attempts SET session_id=outcome->>'id',hosted_url=outcome->>'url',expires_at=to_timestamp((outcome->>'expiresAt')::double precision),status=CASE WHEN status='succeeded' THEN status ELSE 'requires_action' END WHERE operation_id=opid;
 END IF;RETURN true;
END $$;
CREATE FUNCTION campus.money_hold(oid uuid,reason_value text,effect text,detail_value jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 INSERT INTO campus.payment_holds(obligation_id,reason,source_effect) VALUES(oid,reason_value,effect) ON CONFLICT DO NOTHING;
 INSERT INTO campus.reconciliation_cases(environment_id,obligation_id,source_effect,reason,detail) SELECT environment_id,oid,effect,reason_value,detail_value FROM campus.funding_obligations WHERE id=oid ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION campus.money_record_receipt(aid uuid,fact jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
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
  IF o.agreement_id IS NOT NULL THEN
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
CREATE FUNCTION campus.money_earn(review_uuid uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
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
 FOR cp IN SELECT c.* FROM campus.money_effective_components c JOIN campus.funding_lots x ON x.id=c.lot_id JOIN campus.funding_obligations o ON o.id=x.obligation_id WHERE o.agreement_id=b.agreement_id AND o.transaction_terms_id=t.transaction_terms_id AND c.milestone_id=r.milestone_id ORDER BY c.id LOOP
  SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=cp.lot_id;IF f.fee_state IS DISTINCT FROM 'matched' THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM campus.payables WHERE component_id=cp.id) THEN CONTINUE;END IF;
  IF cp.net_cents>0 THEN PERFORM campus.money_journal(cp.environment_id,cp.lot_id,'earned:'||cp.id::text,jsonb_build_array(jsonb_build_object('account','reward_liability','debit',cp.net_cents,'componentId',cp.id),jsonb_build_object('account','payable','credit',cp.net_cents,'componentId',cp.id,'memberId',cp.member_id)));END IF;
  INSERT INTO campus.payables(environment_id,lot_id,component_id,eligibility_id,release_ready,net_cents,gross_satisfied_cents) VALUES(cp.environment_id,cp.lot_id,cp.id,elig,ready,cp.net_cents,CASE WHEN cp.net_cents=0 THEN cp.gross_cents ELSE 0 END);
 END LOOP;
 IF ready AND pol='final_completion' THEN UPDATE campus.payables p SET release_ready=true FROM campus.settlement_eligibilities el WHERE p.eligibility_id=el.id AND el.agreement_id=b.agreement_id AND el.transaction_terms_id=t.transaction_terms_id;END IF;
 RETURN elig;
END $$;
CREATE FUNCTION campus.money_review_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN PERFORM campus.money_earn(NEW.id);RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER money_review_eligibility AFTER INSERT ON campus.milestone_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION campus.money_review_effect();
CREATE FUNCTION campus.money_prepare_transfers(eid uuid,target_oid uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payables;c campus.funding_component_plans;o campus.funding_obligations;a campus.connected_payee_accounts;f campus.funding_allocations;op uuid;cash bigint;reserved bigint;n integer:=0;r record;
BEGIN
 IF target_oid IS NULL THEN SELECT id INTO target_oid FROM campus.funding_obligations WHERE environment_id=eid ORDER BY id LIMIT 1;END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.funding_obligations WHERE id=target_oid AND environment_id=eid) THEN RETURN 0;END IF;
 PERFORM campus.money_lock_aggregate(target_oid);PERFORM campus.money_cash_lock(eid);
 PERFORM campus.money_earn_order((SELECT order_id FROM campus.funding_obligations WHERE id=target_oid));
 -- Recover accepted facts whose fee became known later. Eligibility never comes from worker input.
 FOR r IN SELECT mr.id FROM campus.milestone_reviews mr JOIN campus.submission_terms st ON st.submission_id=mr.submission_id JOIN campus.funding_obligations fo ON fo.agreement_id=st.agreement_id WHERE fo.id=target_oid AND mr.decision='accepted' ORDER BY mr.id LOOP PERFORM campus.money_earn(r.id);END LOOP;
 FOR p IN SELECT * FROM campus.payables WHERE environment_id=eid AND lot_id IN(SELECT id FROM campus.funding_lots WHERE obligation_id=target_oid) AND release_ready AND operation_id IS NULL AND net_cents>0 ORDER BY id LOOP
  PERFORM campus.money_lock_aggregate((SELECT l.obligation_id FROM campus.funding_lots l WHERE l.id=p.lot_id));SELECT * INTO p FROM campus.payables WHERE id=p.id AND operation_id IS NULL FOR UPDATE SKIP LOCKED;IF NOT FOUND THEN CONTINUE;END IF;
  SELECT * INTO c FROM campus.funding_component_plans WHERE id=p.component_id;
  SELECT x.* INTO o FROM campus.funding_obligations x JOIN campus.funding_lots l ON l.obligation_id=x.id WHERE l.id=p.lot_id FOR UPDATE OF x;
  SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=p.lot_id FOR UPDATE;
  SELECT * INTO a FROM campus.connected_payee_accounts WHERE environment_id=eid AND user_id=c.member_id;
  IF f.fee_state IS DISTINCT FROM 'matched' OR a.transfer_capability IS DISTINCT FROM 'active' OR a.observed_at<campus.money_now()-interval '5 minutes' OR a.observed_at IS NULL THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active AND (member_id IS NULL OR member_id=c.member_id)) OR NOT EXISTS(SELECT 1 FROM campus.users WHERE id=c.member_id AND account_status='active') THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM campus.money_reservations WHERE component_id=c.id AND kind IN('transfer','refund') AND status IN('reserved','consumed')) THEN CONTINUE;END IF;
  SELECT coalesce(sum(ll.debit-ll.credit),0) INTO cash FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.lot_id=p.lot_id AND ll.account='cash';
  SELECT coalesce(sum(amount_cents),0) INTO reserved FROM campus.money_reservations WHERE lot_id=p.lot_id AND status='reserved' AND kind IN('transfer','refund');
  IF f.available_cents IS NULL OR campus.money_cash_headroom(eid,NULL)<p.net_cents OR campus.money_cash_headroom(eid,p.lot_id)<p.net_cents THEN CONTINUE;END IF;
  IF p.net_cents+coalesce((SELECT sum(rr.amount_cents) FROM campus.money_reservations rr JOIN campus.money_operations mm ON mm.id=rr.operation_id WHERE mm.environment_id=eid AND mm.kind='transfer' AND mm.payload->>'sourceCharge'=f.charge_id AND rr.status IN('reserved','consumed')),0)>o.amount_cents THEN CONTINUE;END IF;
  op:=campus.money_enqueue(eid,o.id,'transfer',c.id::text,jsonb_build_object('componentId',c.id,'payableId',p.id,'amountCents',p.net_cents,'currency','usd','destination',a.provider_account_id,'sourceCharge',f.charge_id,'transferGroup',o.id::text,'platformAccountId',(SELECT platform_account_id FROM campus.payment_environments WHERE id=eid),'mode',(SELECT mode FROM campus.payment_environments WHERE id=eid),'policyId',o.policy_id,'policyDigest',(SELECT digest FROM campus.payment_execution_policies WHERE id=o.policy_id),'policyVersion',(SELECT version FROM campus.payment_execution_policies WHERE id=o.policy_id),'policyProvenance',(SELECT provenance FROM campus.payment_execution_policies WHERE id=o.policy_id),'sourceDigest',o.source_digest));
  INSERT INTO campus.money_reservations(environment_id,lot_id,component_id,operation_id,kind,amount_cents) VALUES(eid,p.lot_id,c.id,op,'transfer',p.net_cents);
  UPDATE campus.payables SET operation_id=op WHERE id=p.id;n:=n+1;
 END LOOP;RETURN n;
END $$;
CREATE FUNCTION campus.money_transfer_fact(opid uuid,fact jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;p campus.payables;c campus.funding_component_plans;jid uuid;
BEGIN
 PERFORM campus.money_lock_aggregate((SELECT obligation_id FROM campus.money_operations WHERE id=opid));PERFORM campus.money_cash_lock((SELECT environment_id FROM campus.money_operations WHERE id=opid AND obligation_id IS NOT NULL));SELECT * INTO op FROM campus.money_operations WHERE id=opid AND kind='transfer' FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT * INTO p FROM campus.payables WHERE operation_id=opid FOR UPDATE;SELECT * INTO c FROM campus.funding_component_plans WHERE id=p.component_id;
 IF fact->>'environmentId' IS DISTINCT FROM op.environment_id::text OR fact->>'destination' IS DISTINCT FROM op.payload->>'destination' OR fact->>'sourceCharge' IS DISTINCT FROM op.payload->>'sourceCharge' OR fact->>'currency' IS DISTINCT FROM 'usd' OR (fact->>'amountCents')::bigint IS DISTINCT FROM p.net_cents OR coalesce(fact->>'id','')='' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 IF op.status='succeeded' THEN RETURN true;END IF;
 jid:=campus.money_journal(op.environment_id,p.lot_id,'transfer:'||(fact->>'id'),jsonb_build_array(jsonb_build_object('account','payable','debit',p.net_cents,'componentId',c.id,'memberId',c.member_id),jsonb_build_object('account','cash','credit',p.net_cents)));
 UPDATE campus.payables SET transferred_cents=net_cents,gross_satisfied_cents=c.gross_cents WHERE id=p.id;
 UPDATE campus.money_reservations SET status='consumed' WHERE operation_id=opid AND kind='transfer';
 UPDATE campus.money_operations SET status='succeeded',provider_id=fact->>'id',result=fact,lease_until=NULL WHERE id=opid;
 RETURN true;
END $$;
CREATE FUNCTION campus.money_projection(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;result jsonb;g campus.agreements;x campus.orders;coverage text;
BEGIN
 IF kind='agreement' THEN SELECT * INTO g FROM campus.agreements WHERE id=resource AND campus.actor()=ANY(campus.notification_agreement_people(id));IF NOT FOUND OR NOT campus.is_member() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 ELSIF kind='order' THEN SELECT * INTO x FROM campus.orders WHERE id=resource AND campus.actor() IN(buyer_id,seller_id);IF NOT FOUND OR NOT campus.is_member() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 ELSE RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';END IF;
 SELECT * INTO o FROM campus.funding_obligations WHERE aggregate_type=kind AND aggregate_id=resource ORDER BY created_at DESC LIMIT 1;
 IF o.id IS NULL THEN RETURN jsonb_build_object('coverage','unknown','receivedCents',NULL,'requiredCents',NULL,'blockedReasons',jsonb_build_array('funding_not_established'),'allowedActions',jsonb_build_array());END IF;
 coverage:=CASE WHEN EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active) THEN 'held' WHEN EXISTS(SELECT 1 FROM campus.funding_allocations fa JOIN campus.funding_lots l ON l.id=fa.lot_id WHERE l.obligation_id=o.id) THEN 'covered' ELSE 'insufficient' END;
 SELECT jsonb_build_object('obligationId',o.id,'paymentRevision',o.revision,'environmentId',o.environment_id,'environment',(SELECT mode FROM campus.payment_environments WHERE id=o.environment_id),'currency','USD','termsId',o.terms_id,'termsRevision',o.terms_revision,'transactionTermsId',o.transaction_terms_id,'transactionTermsRevision',o.transaction_terms_revision,'estimatedFeeCents',o.fee_cents::text,'actualFeeCents',(SELECT fa.actual_fee_cents::text FROM campus.funding_allocations fa JOIN campus.funding_lots fl ON fl.id=fa.lot_id WHERE fl.obligation_id=o.id),'feeVarianceCents',(SELECT (fa.actual_fee_cents-o.fee_cents)::text FROM campus.funding_allocations fa JOIN campus.funding_lots fl ON fl.id=fa.lot_id WHERE fl.obligation_id=o.id),'coverage',coverage,'requiredCents',o.amount_cents::text,'receivedCents',(coalesce((SELECT sum(o.amount_cents) FROM campus.funding_allocations fa JOIN campus.funding_lots fl ON fl.id=fa.lot_id WHERE fl.obligation_id=o.id),0)+coalesce((SELECT sum(ur.amount_cents) FROM campus.payment_unmatched_receipts ur WHERE ur.obligation_id=o.id),0))::text,'feeState',(SELECT fa.fee_state FROM campus.funding_allocations fa JOIN campus.funding_lots l ON l.id=fa.lot_id WHERE l.obligation_id=o.id),'activeAttempt',(SELECT jsonb_build_object('id',a.id,'status',a.status,'operationId',a.operation_id) FROM campus.payment_attempts a WHERE a.obligation_id=o.id AND a.status NOT IN('failed','canceled') LIMIT 1),'blockedReasons',coalesce((SELECT jsonb_agg(reason) FROM campus.money_active_holds WHERE obligation_id=o.id AND active),'[]'::jsonb),'payees',coalesce((SELECT jsonb_agg(jsonb_build_object('componentId',cp.id,'allocationComponentId',cp.allocation_component_id,'lotId',cp.lot_id,'memberId',cp.member_id,'milestoneId',cp.milestone_id,'grossCents',cp.gross_cents::text,'feeCents',cp.recipient_fee_cents::text,'netCents',cp.net_cents::text,'transferredCents',coalesce(p.transferred_cents,0)::text,'grossSatisfiedCents',coalesce(p.gross_satisfied_cents,0)::text,'releaseReady',coalesce(p.release_ready,false),'bankPayout','unknown')) FROM campus.funding_component_plans cp JOIN campus.funding_lots l ON l.id=cp.lot_id LEFT JOIN campus.payables p ON p.component_id=cp.id WHERE l.obligation_id=o.id),'[]'::jsonb),'allowedActions',jsonb_build_array('refresh'),'heldCents',NULL,'transferredCents',coalesce((SELECT sum(p.transferred_cents)::text FROM campus.payables p JOIN campus.funding_lots l ON l.id=p.lot_id WHERE l.obligation_id=o.id),'0'),'refundedCents',coalesce((SELECT sum(r.amount_cents)::text FROM campus.money_reservations r JOIN campus.funding_lots l ON l.id=r.lot_id WHERE l.obligation_id=o.id AND r.kind='refund' AND r.status='consumed'),'0'),'refundRequests',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'amountCents',r.amount_cents::text,'status',r.status,'revision',r.revision)) FROM campus.refund_requests r WHERE r.obligation_id=o.id),'[]'::jsonb),'disputes',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'origin',d.origin,'status',d.status,'revision',d.revision)) FROM campus.dispute_cases d WHERE d.obligation_id=o.id),'[]'::jsonb)) INTO result;RETURN result;
END $$;
CREATE FUNCTION campus.money_read_attempt(aid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.payment_attempts;o campus.funding_obligations;
BEGIN SELECT * INTO a FROM campus.payment_attempts WHERE id=aid;IF NOT FOUND OR NOT campus.money_visible(a.obligation_id) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;SELECT * INTO o FROM campus.funding_obligations WHERE id=a.obligation_id;
 RETURN jsonb_build_object('attemptId',a.id,'operationId',a.operation_id,'obligationId',a.obligation_id,'status',a.status,'sessionId',a.session_id,'chargeId',a.charge_id,'hostedUrl',CASE WHEN campus.actor()=o.payer_id AND a.status='requires_action' AND a.expires_at>campus.money_now() AND EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') AND NOT EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active) THEN a.hosted_url END,'expiresAt',a.expires_at);
END $$;
CREATE FUNCTION campus.money_read_operation(opid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;
BEGIN SELECT * INTO op FROM campus.money_operations WHERE id=opid;IF NOT FOUND OR NOT(campus.money_visible(op.obligation_id) OR (campus.is_member() AND op.kind IN('recipient','onboarding') AND op.payload->>'userId'=campus.actor()::text)) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;RETURN jsonb_build_object('operationId',op.id,'kind',op.kind,'status',op.status,'createdAt',op.created_at,'hostedUrl',CASE WHEN op.kind='onboarding' AND (op.result->>'expiresAt')::timestamptz>campus.money_now() THEN op.result->>'url' END,'bankPayout','unknown');END $$;
CREATE FUNCTION campus.money_inbox_insert(eid uuid,origin text,eventid text,eventtype text,hash text,body jsonb,parser_value text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result uuid;e campus.payment_environments;
BEGIN
 SELECT * INTO e FROM campus.payment_environments WHERE id=eid;IF NOT FOUND OR (body->>'livemode')::boolean IS DISTINCT FROM (e.mode='live') OR NOT(origin=e.platform_account_id OR EXISTS(SELECT 1 FROM campus.connected_payee_accounts WHERE environment_id=eid AND provider_account_id=origin)) THEN RAISE EXCEPTION 'provider_scope_mismatch' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.provider_inbox(environment_id,origin_account,event_id,event_type,payload_digest,payload,parser) VALUES(eid,origin,eventid,eventtype,hash,body,parser_value) ON CONFLICT DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN SELECT id INTO result FROM campus.provider_inbox WHERE environment_id=eid AND origin_account=origin AND event_id=eventid AND payload_digest=hash;IF result IS NULL THEN RAISE EXCEPTION 'event_payload_conflict' USING ERRCODE='P0001';END IF;END IF;RETURN result;
END $$;
CREATE FUNCTION campus.money_inbox_claim(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.provider_inbox;
BEGIN SELECT * INTO r FROM campus.provider_inbox WHERE environment_id=eid AND status IN('pending','retry','processing') AND available_at<=campus.money_now() AND (lease_until IS NULL OR lease_until<campus.money_now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1;IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE campus.provider_inbox SET status='processing',fence=fence+1,attempts=attempts+1,lease_until=campus.money_now()+interval '30 seconds' WHERE id=r.id RETURNING * INTO r;RETURN to_jsonb(r);END $$;
CREATE FUNCTION campus.money_inbox_finish(iid uuid,token bigint,code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN UPDATE campus.provider_inbox SET status=CASE WHEN code='processed' THEN 'processed' WHEN attempts>=8 THEN 'dead_letter' ELSE 'retry' END,last_code=code,lease_until=NULL,available_at=campus.money_now()+make_interval(secs=>least(3600,2^least(attempts,10))::integer) WHERE id=iid AND fence=token AND lease_until>=campus.money_now();RETURN FOUND;END $$;
CREATE FUNCTION campus.money_find_attempt(eid uuid,objectid text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('id',a.id,'sessionId',a.session_id,'intentId',a.intent_id,'chargeId',a.charge_id,'environmentId',a.environment_id,'operationId',a.operation_id,'obligationId',o.id,'amountCents',o.amount_cents,'sourceDigest',o.source_digest,'quoteDigest',q.digest,'platformAccountId',e.platform_account_id,'mode',e.mode) FROM campus.payment_attempts a JOIN campus.funding_obligations o ON o.id=a.obligation_id JOIN campus.payment_quotes q ON q.id=a.quote_id JOIN campus.payment_environments e ON e.id=a.environment_id WHERE a.environment_id=eid AND objectid IN(a.session_id,a.intent_id,a.charge_id) LIMIT 1
$$;
-- Amendment financial activation and funded nonmonetary inheritance are deferred to Task2B.2.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['settlement_eligibilities','payables','order_payment_state','inventory_release_events','refund_requests','dispute_cases','provider_payout_observations','amendment_funding_assessments'] LOOP
 EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);END LOOP;
 FOREACH t IN ARRAY ARRAY['settlement_eligibilities','inventory_release_events','amendment_funding_assessments'] LOOP EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);END LOOP;
END $$;
-- Revoke PUBLIC on every new entry point and helper before narrow grants.
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname LIKE 'money_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION campus.money_capabilities(),campus.money_agreement_quote(uuid,jsonb),campus.money_attempt(uuid,jsonb),campus.money_projection(text,uuid),campus.money_read_attempt(uuid),campus.money_read_operation(uuid) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.money_claim(uuid),campus.money_operation_result(uuid,bigint,jsonb),campus.money_record_receipt(uuid,jsonb),campus.money_prepare_transfers(uuid,uuid),campus.money_transfer_fact(uuid,jsonb),campus.money_inbox_insert(uuid,text,text,text,text,jsonb,text),campus.money_inbox_claim(uuid),campus.money_inbox_finish(uuid,bigint,text),campus.money_find_attempt(uuid,text) TO campus_worker;

CREATE FUNCTION campus.money_authorize_payer(oid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;BEGIN o:=campus.money_lock(oid,true);IF o.payer_id<>campus.actor() THEN RAISE EXCEPTION 'not_payer' USING ERRCODE='P0001';END IF;END $$;
REVOKE ALL ON FUNCTION campus.money_authorize_payer(uuid) FROM PUBLIC,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_authorize_payer(uuid) TO campus_app;
CREATE TABLE campus.payment_policy_confirmations (
 policy_id uuid NOT NULL REFERENCES campus.payment_execution_policies,user_id uuid NOT NULL REFERENCES campus.users,resource_digest text NOT NULL,policy_digest text NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT campus.money_now(),PRIMARY KEY(policy_id,user_id)
);
ALTER TABLE campus.payment_policy_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_policy_confirmations FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_policy_confirmations FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE FUNCTION campus.money_order_terms(oid uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT encode(sha256(convert_to(campus.transaction_canonical(jsonb_build_object('orderId',id,'quoteId',quote_id,'productId',product_id,'buyerId',buyer_id,'sellerId',seller_id,'quantity',quantity,'totalCents',total_cents,'terms',terms)),'UTF8')),'hex') FROM campus.orders WHERE id=oid
$$;
CREATE FUNCTION campus.money_order_policy(oid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x campus.orders;p campus.payment_execution_policies;eid uuid;fee bigint;d text;rev integer;
BEGIN
 SELECT * INTO x FROM campus.orders WHERE id=oid AND campus.actor() IN(buyer_id,seller_id);IF NOT FOUND OR NOT campus.is_member() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 d:=campus.money_order_terms(oid);SELECT revision INTO rev FROM campus.order_payment_state WHERE order_id=oid;
 SELECT id INTO eid FROM campus.payment_environments WHERE enabled;
 SELECT * INTO p FROM campus.payment_execution_policies WHERE environment_id=eid AND aggregate_type='order' AND aggregate_id=oid AND purpose='collection' ORDER BY version DESC LIMIT 1;
 RETURN jsonb_build_object('orderTermsDigest',d,'paymentRevision',coalesce(rev,0),'policyVersionId',p.id,'policyDigest',p.digest,'policyStatus',p.status,'policy',p.payload,'provenance',p.provenance,'buyerPayableCents',p.payload->'chargeTotalCents','sellerGrossCents',x.total_cents,'sellerFeeCents',CASE WHEN p.payload?'estimatedProcessorFeeCents' THEN (p.payload->>'estimatedProcessorFeeCents')::bigint/2 END,'sellerNetCents',CASE WHEN p.payload?'estimatedProcessorFeeCents' THEN x.total_cents-(p.payload->>'estimatedProcessorFeeCents')::bigint/2 END,'confirmations',coalesce((SELECT jsonb_agg(user_id) FROM campus.payment_policy_confirmations WHERE policy_id=p.id),'[]'::jsonb));
END $$;
CREATE FUNCTION campus.money_order_confirm(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x campus.orders;p campus.payment_execution_policies;d text;rev integer;eid uuid;fee bigint;
BEGIN
 SELECT * INTO x FROM campus.orders WHERE id=oid AND campus.actor() IN(buyer_id,seller_id) FOR UPDATE;IF NOT FOUND OR NOT campus.is_member() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';END IF;
 eid:=campus.money_environment();d:=campus.money_order_terms(oid);SELECT revision INTO rev FROM campus.order_payment_state WHERE order_id=oid;
 IF request->>'orderTermsDigest' IS DISTINCT FROM d OR (request->>'expectedPaymentRevision')::integer IS DISTINCT FROM coalesce(rev,0) THEN RAISE EXCEPTION 'stale_payment_revision' USING ERRCODE='P0001';END IF;
 SELECT * INTO p FROM campus.payment_execution_policies WHERE id=(request->>'policyVersionId')::uuid AND environment_id=eid AND aggregate_type='order' AND aggregate_id=oid AND purpose='collection' AND status='approved';
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF p.digest IS DISTINCT FROM request->>'policyDigest' OR p.digest<>encode(sha256(convert_to(campus.transaction_canonical(p.payload),'UTF8')),'hex') OR NOT campus.transaction_policy_disclosure_valid(p.payload) OR p.payload->>'orderTermsDigest' IS DISTINCT FROM d OR coalesce(p.payload->>'feeAdjustment','') NOT IN('hold_on_variance','capped_actual_v1') THEN RAISE EXCEPTION 'quote_changed' USING ERRCODE='P0001';END IF;
 fee:=(p.payload->>'estimatedProcessorFeeCents')::bigint;
 IF fee IS NULL OR fee<0 OR fee/2>x.total_cents OR (p.payload->>'chargeTotalCents')::bigint IS DISTINCT FROM x.total_cents+(fee+1)/2 THEN RAISE EXCEPTION 'invalid_component_plan' USING ERRCODE='P0001';END IF;
 IF x.state<>'pending_payment' OR x.reserved_until<=campus.money_now() THEN RAISE EXCEPTION 'quote_expired' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.payment_policy_confirmations VALUES(p.id,campus.actor(),d,p.digest,campus.money_now()) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('orderId',oid,'policyVersionId',p.id,'policyDigest',p.digest,'userId',campus.actor());
END $$;
CREATE FUNCTION campus.money_order_quote(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x campus.orders;p campus.payment_execution_policies;o campus.funding_obligations;q campus.payment_quotes;eid uuid;d text;rev integer;lid uuid;fee bigint;body jsonb;fp jsonb;
BEGIN
 SELECT * INTO x FROM campus.orders WHERE id=oid AND buyer_id=campus.actor() FOR UPDATE;IF NOT FOUND OR NOT campus.is_member() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 eid:=campus.money_environment();d:=campus.money_order_terms(oid);SELECT revision INTO rev FROM campus.order_payment_state WHERE order_id=oid;
 IF request->>'orderTermsDigest' IS DISTINCT FROM d OR (request->>'expectedPaymentRevision')::integer IS DISTINCT FROM coalesce(rev,0) THEN RAISE EXCEPTION 'stale_payment_revision' USING ERRCODE='P0001';END IF;
 SELECT * INTO p FROM campus.payment_execution_policies WHERE environment_id=eid AND aggregate_type='order' AND aggregate_id=oid AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'fee_adjustment_policy_unresolved' USING ERRCODE='P0001';END IF;
 IF (SELECT count(*) FROM campus.payment_policy_confirmations WHERE policy_id=p.id AND user_id IN(x.buyer_id,x.seller_id) AND resource_digest=d AND policy_digest=p.digest)<>2 THEN RAISE EXCEPTION 'financial_consent_required' USING ERRCODE='P0001';END IF;
 IF x.state<>'pending_payment' OR x.reserved_until<=campus.money_now() THEN RAISE EXCEPTION 'quote_expired' USING ERRCODE='P0001';END IF;
 IF p.payload->>'feeAdjustment'='capped_actual_v1' THEN fp:=to_jsonb(campus.money_confirmed_fee_plan(eid,'order',oid,p.id,d));END IF;
 fee:=coalesce((fp->'body'->>'maximumFeeCents')::bigint,(p.payload->>'estimatedProcessorFeeCents')::bigint);
 SELECT * INTO o FROM campus.funding_obligations WHERE order_id=oid AND environment_id=eid;
 IF FOUND AND (o.policy_id<>p.id OR o.source_digest<>d OR o.fee_cents<>fee OR o.amount_cents<>x.total_cents+(fee+1)/2) THEN RAISE EXCEPTION 'quote_changed' USING ERRCODE='P0001';END IF;
 IF o.id IS NULL THEN
 
 INSERT INTO campus.funding_obligations(environment_id,aggregate_type,aggregate_id,order_id,payer_id,source_digest,policy_id,currency,principal_cents,fee_cents,publisher_fee_cents,amount_cents) VALUES(eid,'order',oid,oid,x.buyer_id,d,p.id,'USD',x.total_cents,fee,(fee+1)/2,x.total_cents+(fee+1)/2) RETURNING * INTO o;
 lid:=gen_random_uuid();INSERT INTO campus.funding_lots VALUES(lid,o.id,eid,1,o.principal_cents,o.publisher_fee_cents,fee);
 INSERT INTO campus.funding_component_plans(environment_id,lot_id,member_id,stage_position,gross_cents,recipient_fee_cents,net_cents) VALUES(eid,lid,x.seller_id,1,x.total_cents,fee/2,x.total_cents-fee/2);
 IF fp IS NOT NULL THEN INSERT INTO campus.payment_fee_plan_bindings VALUES(o.id,(fp->>'id')::uuid);END IF;
 INSERT INTO campus.order_payment_state(order_id,terms_digest) VALUES(oid,d);
 END IF;
 body:=jsonb_build_object('obligationId',o.id,'environmentId',eid,'orderId',oid,'orderTermsDigest',d,'policyId',p.id,'policyDigest',p.digest,'policyVersion',p.version,'policyProvenance',p.provenance,'policy',p.payload,'principalCents',o.principal_cents,'chargeTotalCents',o.amount_cents,'currency','USD');
 IF fp IS NOT NULL THEN body:=body||jsonb_build_object('feePlanId',fp->>'id','feePlanDigest',fp->>'digest','feePlan',fp->'body');END IF;
 SELECT * INTO q FROM campus.payment_quotes WHERE obligation_id=o.id AND expires_at>campus.money_now() ORDER BY created_at DESC LIMIT 1;
 IF NOT FOUND THEN INSERT INTO campus.payment_quotes(obligation_id,environment_id,payer_id,digest,body,expires_at) VALUES(o.id,eid,o.payer_id,encode(sha256(convert_to(campus.transaction_canonical(body),'UTF8')),'hex'),body,least(x.reserved_until,campus.money_now()+interval '10 minutes')) RETURNING * INTO q;END IF;
 RETURN jsonb_build_object('quoteId',q.id,'quoteDigest',q.digest,'obligationId',o.id,'obligationRevision',o.revision,'expiresAt',q.expires_at,'quote',q.body);
END $$;
CREATE FUNCTION campus.money_release_inventory(oid uuid,terminal text) RETURNS campus.orders LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x campus.orders;
BEGIN SELECT * INTO x FROM campus.orders WHERE id=oid FOR UPDATE;IF x.state<>'pending_payment' THEN RETURN x;END IF;
 INSERT INTO campus.inventory_release_events VALUES(oid,terminal,campus.money_now()) ON CONFLICT DO NOTHING;
 IF FOUND THEN UPDATE campus.products SET stock=stock+x.quantity WHERE id=x.product_id;UPDATE campus.orders SET state=terminal WHERE id=oid RETURNING * INTO x;UPDATE campus.order_payment_state SET resolution='terminal',revision=revision+1 WHERE order_id=oid;END IF;RETURN x;END $$;
CREATE FUNCTION campus.money_resolve_cancellation(oid uuid,terminal text) RETURNS campus.orders LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x campus.orders;o campus.funding_obligations;a campus.payment_attempts;op uuid;
BEGIN SELECT * INTO x FROM campus.orders WHERE id=oid FOR UPDATE;IF x.state IN('cancelled','expired') THEN RETURN x;END IF;IF x.state<>'pending_payment' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001';END IF;
 SELECT * INTO o FROM campus.funding_obligations WHERE order_id=oid FOR UPDATE;
 SELECT * INTO a FROM campus.payment_attempts WHERE obligation_id=o.id AND status NOT IN('failed','canceled') ORDER BY created_at DESC LIMIT 1;
 IF a.id IS NULL THEN RETURN campus.money_release_inventory(oid,terminal);END IF;
 UPDATE campus.order_payment_state SET resolution=CASE WHEN terminal='cancelled' THEN 'cancellation_requested' ELSE 'expiry_resolving' END,requested_terminal=terminal,revision=revision+1 WHERE order_id=oid AND resolution='open';
 IF a.session_id IS NOT NULL THEN op:=campus.money_enqueue(o.environment_id,o.id,'expire',a.id::text,jsonb_build_object('sessionId',a.session_id,'attemptId',a.id));END IF;
 RETURN x;
END $$;
CREATE OR REPLACE FUNCTION campus.cancel_unpaid_order(oid uuid) RETURNS campus.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x campus.orders;
BEGIN
 SELECT * INTO x FROM campus.orders WHERE id=oid AND buyer_id=campus.actor() FOR UPDATE;IF NOT FOUND OR NOT campus.is_member() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.payment_attempts a JOIN campus.funding_obligations o ON o.id=a.obligation_id WHERE o.order_id=oid) THEN RAISE EXCEPTION 'payment_revision_required' USING ERRCODE='P0001';END IF;RETURN campus.money_resolve_cancellation(oid,'cancelled');END $$;
CREATE FUNCTION campus.money_cancel_order(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x campus.orders;ps campus.order_payment_state;
BEGIN SELECT * INTO x FROM campus.orders WHERE id=oid AND buyer_id=campus.actor() FOR UPDATE;IF NOT FOUND OR NOT campus.is_member() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT * INTO ps FROM campus.order_payment_state WHERE order_id=oid;
 IF ps.terms_digest IS DISTINCT FROM request->>'orderTermsDigest' OR ps.revision IS DISTINCT FROM (request->>'expectedPaymentRevision')::integer THEN RAISE EXCEPTION 'stale_payment_revision' USING ERRCODE='P0001';END IF;
 x:=campus.money_resolve_cancellation(oid,'cancelled');RETURN jsonb_build_object('orderId',oid,'state',x.state,'resolution',(SELECT resolution FROM campus.order_payment_state WHERE order_id=oid));END $$;
CREATE OR REPLACE FUNCTION campus.expire_reservations() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE x record;n integer:=0;
BEGIN FOR x IN SELECT id FROM campus.orders WHERE state='pending_payment' AND reserved_until<=campus.money_now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100 LOOP PERFORM campus.money_resolve_cancellation(x.id,'expired');n:=n+1;END LOOP;RETURN n;END $$;
CREATE FUNCTION campus.money_terminal_unpaid(aid uuid,fact jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.payment_attempts;o campus.funding_obligations;ps campus.order_payment_state;
BEGIN SELECT * INTO a FROM campus.payment_attempts WHERE id=aid;SELECT * INTO o FROM campus.funding_obligations WHERE id=a.obligation_id;
 IF o.order_id IS NOT NULL THEN PERFORM 1 FROM campus.orders WHERE id=o.order_id FOR UPDATE;END IF;PERFORM 1 FROM campus.funding_obligations WHERE id=o.id FOR UPDATE;
 IF a.session_id IS DISTINCT FROM fact->>'sessionId' OR fact->>'status' IS DISTINCT FROM 'terminal_unpaid' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.funding_allocations WHERE attempt_id=aid) THEN RETURN;END IF;
 UPDATE campus.payment_attempts SET status='canceled',hosted_url=NULL WHERE id=aid;
 SELECT * INTO ps FROM campus.order_payment_state WHERE order_id=o.order_id;
 IF ps.resolution IN('cancellation_requested','expiry_resolving') THEN PERFORM campus.money_release_inventory(o.order_id,ps.requested_terminal);END IF;
END $$;
CREATE FUNCTION campus.money_order_funds_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;c campus.funding_component_plans;f campus.funding_allocations;p campus.payment_execution_policies;
BEGIN
 IF NEW.state IS NOT DISTINCT FROM OLD.state OR NEW.state NOT IN('shipped','ready_for_pickup','completed') THEN RETURN NEW;END IF;
 SELECT * INTO o FROM campus.funding_obligations WHERE order_id=NEW.id;
 IF o.id IS NULL OR NOT EXISTS(SELECT 1 FROM campus.funding_allocations fa JOIN campus.funding_lots l ON l.id=fa.lot_id WHERE l.obligation_id=o.id) THEN RAISE EXCEPTION 'funding_required' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active) THEN RAISE EXCEPTION 'funds_held' USING ERRCODE='P0001';END IF;
 IF NEW.state='completed' THEN
  PERFORM campus.money_cash_lock(o.environment_id);
  SELECT * INTO p FROM campus.payment_execution_policies WHERE id=o.policy_id;
  IF p.payload->>'goodsRelease' IS DISTINCT FROM 'buyer_confirmed_receipt' THEN RETURN NEW;END IF;
  SELECT cp.* INTO c FROM campus.money_effective_components cp JOIN campus.funding_lots l ON l.id=cp.lot_id WHERE l.obligation_id=o.id;
  SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=c.lot_id;
  IF f.fee_state='matched' THEN
   IF c.net_cents>0 THEN PERFORM campus.money_journal(o.environment_id,c.lot_id,'goods_earned:'||c.id::text,jsonb_build_array(jsonb_build_object('account','reward_liability','debit',c.net_cents),jsonb_build_object('account','payable','credit',c.net_cents,'componentId',c.id,'memberId',c.member_id)));END IF;
   INSERT INTO campus.payables(environment_id,lot_id,component_id,release_ready,net_cents) VALUES(o.environment_id,c.lot_id,c.id,true,c.net_cents) ON CONFLICT DO NOTHING;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER money_order_funds_guard BEFORE UPDATE ON campus.orders FOR EACH ROW EXECUTE FUNCTION campus.money_order_funds_guard();
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN('money_order_terms','money_order_policy','money_order_confirm','money_order_quote','money_release_inventory','money_resolve_cancellation','money_cancel_order','money_terminal_unpaid','money_order_funds_guard') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION campus.money_order_policy(uuid),campus.money_order_confirm(uuid,jsonb),campus.money_order_quote(uuid,jsonb),campus.money_cancel_order(uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.money_terminal_unpaid(uuid,jsonb) TO campus_worker;
-- Account creation inputs require a separately authorized exact owner-managed configuration.
CREATE TABLE campus.payment_recipient_configurations (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,user_id uuid NOT NULL REFERENCES campus.users,
 version integer NOT NULL CHECK(version>0),payload jsonb NOT NULL,digest text NOT NULL,provenance text NOT NULL,
 PRIMARY KEY(environment_id,user_id,version)
);
ALTER TABLE campus.payment_recipient_configurations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_recipient_configurations FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_recipient_configurations FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE FUNCTION campus.money_account() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.connected_payee_accounts;eid uuid;
BEGIN IF NOT campus.is_member() THEN RAISE EXCEPTION 'membership_required' USING ERRCODE='P0001';END IF;SELECT id INTO eid FROM campus.payment_environments WHERE enabled;
 SELECT * INTO a FROM campus.connected_payee_accounts WHERE environment_id=eid AND user_id=campus.actor();RETURN jsonb_build_object('revision',coalesce(a.revision,0),'transferCapability',coalesce(a.transfer_capability,'unknown'),'payoutCapability',coalesce(a.payout_capability,'unknown'),'observedAt',a.observed_at,'bankPayout','unknown','payoutObservations',coalesce((SELECT jsonb_agg(jsonb_build_object('payoutId',payout_id,'status',status,'observedAt',observed_at)) FROM campus.provider_payout_observations WHERE environment_id=eid AND account_id=a.provider_account_id),'[]'::jsonb));END $$;
CREATE FUNCTION campus.money_onboarding(request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE eid uuid;a campus.connected_payee_accounts;p campus.payment_recipient_configurations;op uuid;e campus.payment_environments;prior campus.money_operations;generation integer;
BEGIN
 IF NOT campus.is_member() OR NOT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';END IF;
 PERFORM 1 FROM campus.users WHERE id=campus.actor() FOR UPDATE;eid:=campus.money_environment();SELECT * INTO e FROM campus.payment_environments WHERE id=eid;
 SELECT * INTO a FROM campus.connected_payee_accounts WHERE environment_id=eid AND user_id=campus.actor();
 IF coalesce(a.revision,0) IS DISTINCT FROM (request->>'expectedAccountRevision')::integer THEN RAISE EXCEPTION 'stale_payment_revision' USING ERRCODE='P0001';END IF;
 IF a.provider_account_id IS NULL THEN
 SELECT * INTO p FROM campus.payment_recipient_configurations WHERE environment_id=eid AND user_id=campus.actor() ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR p.digest<>encode(sha256(convert_to(campus.transaction_canonical(p.payload),'UTF8')),'hex') THEN RAISE EXCEPTION 'recipient_identity_configuration_required' USING ERRCODE='P0001';END IF;
 op:=campus.money_enqueue(eid,NULL,'recipient',campus.actor()::text,jsonb_build_object('userId',campus.actor(),'configurationVersion',p.version,'configurationDigest',p.digest,'account',p.payload));
 ELSE
 SELECT * INTO prior FROM campus.money_operations WHERE environment_id=eid AND kind='onboarding' AND payload->>'userId'=campus.actor()::text ORDER BY created_at DESC,id DESC LIMIT 1;
 IF prior.id IS NOT NULL AND prior.status IN('queued','dispatching','unknown','held') THEN op:=prior.id;
 ELSE generation:=coalesce((prior.payload->>'generation')::integer,0)+1;
 op:=campus.money_enqueue(eid,NULL,'onboarding',campus.actor()::text||':'||generation::text,jsonb_build_object('userId',campus.actor(),'accountId',a.provider_account_id,'generation',generation,'returnUrl',e.origin||'/?view=account','refreshUrl',e.origin||'/?view=account'));
 END IF;
 END IF;RETURN jsonb_build_object('operationId',op,'status','queued');END $$;
CREATE FUNCTION campus.money_recipient_created(opid uuid,token bigint,accountid text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;target record;
BEGIN SELECT * INTO op FROM campus.money_operations WHERE id=opid AND kind='recipient';
 FOR target IN SELECT DISTINCT o.id,coalesce(o.agreement_id,o.order_id) AS resource FROM campus.funding_obligations o JOIN campus.funding_lots l ON l.obligation_id=o.id JOIN campus.funding_component_plans c ON c.lot_id=l.id WHERE o.environment_id=op.environment_id AND c.member_id=(op.payload->>'userId')::uuid ORDER BY resource,o.id LOOP PERFORM campus.money_lock_aggregate(target.id);END LOOP;
 SELECT * INTO op FROM campus.money_operations WHERE id=opid AND kind='recipient' FOR UPDATE;IF NOT FOUND OR accountid NOT LIKE 'acct_%' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 IF op.fence<>token OR op.lease_until<campus.money_now() THEN RETURN false;END IF;
 INSERT INTO campus.connected_payee_accounts(environment_id,user_id,provider_account_id) VALUES(op.environment_id,(op.payload->>'userId')::uuid,accountid) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM campus.connected_payee_accounts WHERE environment_id=op.environment_id AND user_id=(op.payload->>'userId')::uuid AND provider_account_id=accountid) THEN RAISE EXCEPTION 'provider_scope_mismatch' USING ERRCODE='P0001';END IF;
 UPDATE campus.money_operations SET status='succeeded',provider_id=accountid,lease_until=NULL WHERE id=opid;RETURN true;END $$;
CREATE FUNCTION campus.money_account_targets(eid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('userId',user_id,'accountId',provider_account_id)),'[]'::jsonb) FROM campus.connected_payee_accounts WHERE environment_id=eid $$;
CREATE FUNCTION campus.money_observe_account(eid uuid,uid uuid,fact jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE target record;
BEGIN
 FOR target IN SELECT DISTINCT o.id,coalesce(o.agreement_id,o.order_id) AS resource FROM campus.funding_obligations o JOIN campus.funding_lots l ON l.obligation_id=o.id JOIN campus.funding_component_plans c ON c.lot_id=l.id WHERE o.environment_id=eid AND c.member_id=uid ORDER BY resource,o.id LOOP PERFORM campus.money_lock_aggregate(target.id);END LOOP;
 IF NOT EXISTS(SELECT 1 FROM campus.connected_payee_accounts WHERE environment_id=eid AND user_id=uid AND provider_account_id=fact->>'accountId') OR fact->>'transferCapability' NOT IN('active','pending','rejected','restricted','unsupported','unknown') OR fact->>'payoutCapability' NOT IN('active','pending','rejected','restricted','unsupported','unknown') THEN RAISE EXCEPTION 'provider_scope_mismatch' USING ERRCODE='P0001';END IF;
 UPDATE campus.connected_payee_accounts SET transfer_capability=fact->>'transferCapability',payout_capability=fact->>'payoutCapability',observed_at=campus.money_now(),revision=revision+CASE WHEN (transfer_capability,payout_capability) IS DISTINCT FROM (fact->>'transferCapability',fact->>'payoutCapability') THEN 1 ELSE 0 END WHERE environment_id=eid AND user_id=uid;
END $$;
REVOKE ALL ON FUNCTION campus.money_account(),campus.money_onboarding(jsonb),campus.money_recipient_created(uuid,bigint,text),campus.money_account_targets(uuid),campus.money_observe_account(uuid,uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_account(),campus.money_onboarding(jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.money_recipient_created(uuid,bigint,text),campus.money_account_targets(uuid),campus.money_observe_account(uuid,uuid,jsonb) TO campus_worker;
CREATE TABLE campus.payment_compensation_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,
 policy_id uuid NOT NULL REFERENCES campus.payment_execution_policies,request_id uuid REFERENCES campus.refund_requests,case_revision integer NOT NULL,
 component_id uuid NOT NULL REFERENCES campus.funding_component_plans,kind text NOT NULL CHECK(kind IN('refund','reversal')),amount_cents bigint NOT NULL CHECK(amount_cents>0),
 original_operation_id uuid REFERENCES campus.money_operations,provenance text NOT NULL,approved_at timestamptz NOT NULL DEFAULT campus.money_now(),UNIQUE(component_id,kind,request_id)
);
ALTER TABLE campus.payment_compensation_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_compensation_decisions FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_compensation_decisions FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE FUNCTION campus.money_refund_request(kind text,rid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;result uuid;policy campus.payment_execution_policies;
BEGIN
 o:=campus.money_lock((request->>'obligationId')::uuid,true);PERFORM campus.money_cash_lock(o.environment_id);
 IF o.aggregate_type<>kind OR o.aggregate_id<>rid OR o.payer_id<>campus.actor() THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF o.revision IS DISTINCT FROM (request->>'expectedPaymentRevision')::integer THEN RAISE EXCEPTION 'stale_payment_revision' USING ERRCODE='P0001';END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.funding_allocations f JOIN campus.funding_lots l ON l.id=f.lot_id WHERE l.obligation_id=o.id AND f.charge_id=request->>'chargeId') THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT * INTO policy FROM campus.payment_execution_policies WHERE id=(request->>'policyVersionId')::uuid AND environment_id=o.environment_id AND aggregate_type=kind AND aggregate_id=rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF (request->>'amountCents')::bigint NOT BETWEEN 1 AND o.amount_cents OR length(btrim(request->>'reason')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.refund_requests(obligation_id,requester_id,charge_id,amount_cents,reason,policy_id) VALUES(o.id,campus.actor(),request->>'chargeId',(request->>'amountCents')::bigint,request->>'reason',policy.id) RETURNING id INTO result;
 PERFORM campus.money_hold(o.id,'refund_request_review','refund_request:'||result::text,jsonb_build_object('requestId',result));
 RETURN jsonb_build_object('requestId',result,'status','requested','refundStatus','not_executed');
END $$;
CREATE FUNCTION campus.money_open_dispute(kind text,rid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;result uuid;
BEGIN
 SELECT * INTO o FROM campus.funding_obligations WHERE aggregate_type=kind AND aggregate_id=rid ORDER BY created_at DESC LIMIT 1;
 o:=campus.money_lock(o.id,true);PERFORM campus.money_cash_lock(o.environment_id);IF o.revision IS DISTINCT FROM (request->>'expectedPaymentRevision')::integer THEN RAISE EXCEPTION 'stale_payment_revision' USING ERRCODE='P0001';END IF;
 IF request?'relatedMilestoneId' AND NOT EXISTS(SELECT 1 FROM campus.milestones WHERE id=(request->>'relatedMilestoneId')::uuid AND agreement_id=o.agreement_id) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF request?'relatedSubmissionId' AND NOT EXISTS(SELECT 1 FROM campus.submission_terms WHERE submission_id=(request->>'relatedSubmissionId')::uuid AND agreement_id=o.agreement_id AND (NOT request?'relatedMilestoneId' OR milestone_id=(request->>'relatedMilestoneId')::uuid)) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 result:=gen_random_uuid();INSERT INTO campus.dispute_cases(id,obligation_id,origin,source_id,reason) VALUES(result,o.id,'participant',result::text,request->>'reason');
 PERFORM campus.money_hold(o.id,'participant_dispute','dispute:'||result::text,jsonb_build_object('caseId',result));RETURN jsonb_build_object('caseId',result,'status','open','financialDecision','pending');
END $$;
CREATE FUNCTION campus.money_prepare_compensation(eid uuid,target_oid uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE d campus.payment_compensation_decisions;c campus.funding_component_plans;o campus.funding_obligations;f campus.funding_allocations;p campus.payment_execution_policies;op uuid;used bigint;cash bigint;n integer:=0;original campus.money_operations;
BEGIN
 IF target_oid IS NULL THEN SELECT id INTO target_oid FROM campus.funding_obligations WHERE environment_id=eid ORDER BY id LIMIT 1;END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.funding_obligations WHERE id=target_oid AND environment_id=eid) THEN RETURN 0;END IF;
 PERFORM campus.money_lock_aggregate(target_oid);PERFORM campus.money_cash_lock(eid);
 FOR d IN SELECT * FROM campus.payment_compensation_decisions WHERE environment_id=eid AND obligation_id=target_oid ORDER BY id LOOP
 PERFORM campus.money_lock_aggregate(d.obligation_id);SELECT * INTO c FROM campus.money_effective_components WHERE id=d.component_id;
 SELECT fo.* INTO o FROM campus.funding_obligations fo JOIN campus.funding_lots l ON l.obligation_id=fo.id WHERE l.id=c.lot_id FOR UPDATE OF fo;
 IF o.id<>d.obligation_id OR o.environment_id<>eid THEN RAISE EXCEPTION 'compensation_scope_mismatch' USING ERRCODE='P0001';END IF;
 SELECT * INTO p FROM campus.payment_execution_policies WHERE id=d.policy_id AND environment_id=eid AND aggregate_type=o.aggregate_type AND aggregate_id=o.aggregate_id AND purpose=d.kind AND status='approved';
 IF p.id IS NULL OR p.payload->>'decisionId' IS DISTINCT FROM d.id::text OR p.payload->>'componentId' IS DISTINCT FROM c.id::text OR (p.payload->>'amountCents')::bigint IS DISTINCT FROM d.amount_cents THEN CONTINUE;END IF;
 IF d.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM campus.refund_requests WHERE id=d.request_id AND obligation_id=o.id AND revision=d.case_revision) THEN CONTINUE;END IF;
 IF EXISTS(SELECT 1 FROM campus.money_operations WHERE environment_id=eid AND kind=d.kind AND business_key=d.id::text) THEN CONTINUE;END IF;
 SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=c.lot_id FOR UPDATE;
 IF f.fee_state IS DISTINCT FROM 'matched' THEN CONTINUE;END IF;
 IF d.kind='refund' THEN
 IF EXISTS(SELECT 1 FROM campus.money_active_holds h WHERE h.obligation_id=o.id AND h.active AND NOT coalesce(p.payload->'approvedHoldIds','[]'::jsonb)?h.id::text) THEN CONTINUE;END IF;
 SELECT coalesce(sum(amount_cents),0) INTO used FROM campus.money_reservations WHERE component_id=c.id AND kind IN('transfer','refund') AND status IN('reserved','consumed');
 IF c.net_cents-used+coalesce((SELECT sum(amount_cents) FROM campus.principal_restorations WHERE component_id=c.id),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_external_balance_facts WHERE component_id=c.id AND kind='reversal' AND role='original'),0)<d.amount_cents THEN CONTINUE;END IF;
 SELECT coalesce(sum(ll.debit-ll.credit),0) INTO cash FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.lot_id=c.lot_id AND ll.account='cash';
 IF campus.money_cash_headroom(eid,NULL,c.lot_id)<d.amount_cents OR campus.money_cash_headroom(eid,c.lot_id,c.lot_id)<d.amount_cents THEN CONTINUE;END IF;
 ELSE
 SELECT * INTO original FROM campus.money_operations WHERE id=d.original_operation_id AND environment_id=eid AND kind='transfer' AND status='succeeded' AND payload->>'componentId'=c.id::text;
 IF original.id IS NULL OR coalesce((SELECT sum(amount_cents) FROM campus.money_reservations WHERE component_id=c.id AND kind='reversal' AND status IN('reserved','consumed')),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_external_balance_facts WHERE original_operation_id=original.id AND kind='reversal' AND role='original'),0)+d.amount_cents>(original.payload->>'amountCents')::bigint THEN CONTINUE;END IF;
 END IF;
 op:=campus.money_enqueue(eid,o.id,d.kind,d.id::text,jsonb_build_object('decisionId',d.id,'componentId',c.id,'amountCents',d.amount_cents,'currency','usd','sourceCharge',f.charge_id,'transferId',original.provider_id,'originalOperationId',d.original_operation_id,'policyId',p.id,'policyDigest',p.digest,'policyVersion',p.version,'policyProvenance',p.provenance,'sourceDigest',o.source_digest));
 INSERT INTO campus.money_reservations(environment_id,lot_id,component_id,operation_id,kind,amount_cents) VALUES(eid,c.lot_id,c.id,op,d.kind,d.amount_cents);n:=n+1;
 END LOOP;RETURN n;
END $$;
CREATE TABLE campus.payment_balance_facts (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,balance_id text NOT NULL,operation_id uuid NOT NULL REFERENCES campus.money_operations,
 lot_id uuid NOT NULL REFERENCES campus.funding_lots,component_id uuid NOT NULL REFERENCES campus.funding_component_plans,object_id text NOT NULL,role text NOT NULL CHECK(role IN('original','failure')),
 amount_cents bigint NOT NULL,fee_cents bigint NOT NULL,net_cents bigint NOT NULL,available boolean NOT NULL,PRIMARY KEY(environment_id,balance_id),UNIQUE(operation_id,role),CHECK(net_cents=amount_cents-fee_cents)
);
ALTER TABLE campus.payment_balance_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_balance_facts FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_compensation_fact(opid uuid,fact jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;r campus.money_reservations;c campus.funding_component_plans;account_name text;amount bigint;b jsonb;original jsonb;failure jsonb;entries jsonb;fee bigint;net bigint;old campus.payment_balance_facts;
BEGIN
 PERFORM campus.money_lock_aggregate((SELECT obligation_id FROM campus.money_operations WHERE id=opid));PERFORM campus.money_cash_lock((SELECT environment_id FROM campus.money_operations WHERE id=opid));
 SELECT * INTO op FROM campus.money_operations WHERE id=opid AND kind IN('refund','reversal') FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 SELECT * INTO r FROM campus.money_reservations WHERE operation_id=opid FOR UPDATE;SELECT * INTO c FROM campus.funding_component_plans WHERE id=r.component_id;amount:=r.amount_cents;
 IF fact->>'environmentId' IS DISTINCT FROM op.environment_id::text OR (fact->>'amountCents')::bigint IS DISTINCT FROM amount OR fact->>'currency' IS DISTINCT FROM 'usd' OR fact->>'sourceCharge' IS DISTINCT FROM op.payload->>'sourceCharge' OR coalesce(fact->>'id','')='' OR (op.provider_id IS NOT NULL AND op.provider_id<>fact->>'id') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 IF op.kind='reversal' AND fact->>'transferId' IS DISTINCT FROM op.payload->>'transferId' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(coalesce(fact->'balances','[]'::jsonb)) LOOP
  net:=(b->>'netCents')::bigint;fee:=(b->>'feeCents')::bigint;
  IF coalesce(b->>'id','')='' OR b->>'role' NOT IN('original','failure') OR (b->>'amountCents')::bigint IS DISTINCT FROM (CASE WHEN op.kind='reversal' OR b->>'role'='failure' THEN amount ELSE -amount END) OR net<>(b->>'amountCents')::bigint-fee THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  IF EXISTS(SELECT 1 FROM campus.payment_external_balance_facts WHERE environment_id=op.environment_id AND balance_id=b->>'id') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  SELECT * INTO old FROM campus.payment_balance_facts WHERE environment_id=op.environment_id AND balance_id=b->>'id';
  IF FOUND THEN
   IF old.operation_id<>op.id OR old.object_id<>fact->>'id' OR old.role<>b->>'role' OR old.amount_cents<>(b->>'amountCents')::bigint OR old.fee_cents<>fee OR old.net_cents<>net THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
   UPDATE campus.payment_balance_facts SET available=(b->>'available')::boolean WHERE environment_id=op.environment_id AND balance_id=old.balance_id;
  ELSE
   INSERT INTO campus.payment_balance_facts VALUES(op.environment_id,b->>'id',op.id,c.lot_id,c.id,fact->>'id',b->>'role',(b->>'amountCents')::bigint,fee,net,(b->>'available')::boolean);
   entries:='[]'::jsonb;
   IF net<>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','cash','debit',greatest(net,0),'credit',greatest(-net,0)));END IF;
   IF fee<>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','fee_expense','debit',greatest(fee,0),'credit',greatest(-fee,0)));END IF;
   entries:=entries||jsonb_build_array(jsonb_build_object('account','network_exposure','debit',greatest(-(b->>'amountCents')::bigint,0),'credit',greatest((b->>'amountCents')::bigint,0)));
   PERFORM campus.money_journal(op.environment_id,c.lot_id,'compensation_balance:'||(b->>'id'),entries);
  END IF;
  IF b->>'role'='original' THEN original:=b;ELSE failure:=b;END IF;
 END LOOP;
 IF op.kind='refund' AND EXISTS(SELECT 1 FROM campus.payment_balance_facts WHERE operation_id=op.id AND role='original') THEN UPDATE campus.money_reservations SET cash_debited_cents=amount_cents WHERE id=r.id;END IF;
 UPDATE campus.money_operations SET provider_id=fact->>'id',result=fact WHERE id=opid;
 IF (r.status='consumed' AND fact->>'status'<>'succeeded') OR (r.status='released' AND fact->>'status'='succeeded') THEN
  PERFORM campus.money_hold(op.obligation_id,'compensation_terminal_conflict','compensation_terminal_conflict:'||op.id::text,jsonb_build_object('operationId',op.id,'previousStatus',op.status,'observedStatus',fact->>'status','principalCorrection','unresolved'));
  RETURN true;
 END IF;
 IF r.status='consumed' THEN RETURN true;END IF;
 IF fact->>'status' IN('failed','canceled') AND op.kind='refund' THEN
  IF original IS NOT NULL AND failure IS NOT NULL AND (failure->>'available')::boolean AND (original->>'amountCents')::bigint+(failure->>'amountCents')::bigint=0 THEN
   UPDATE campus.money_reservations SET status='released' WHERE id=r.id;UPDATE campus.money_operations SET status='failed',lease_until=NULL WHERE id=opid;RETURN true;
  END IF;RETURN false;
 END IF;
 IF fact->>'status'<>'succeeded' OR original IS NULL THEN RETURN false;END IF;
 IF op.kind='refund' THEN
  account_name:=CASE WHEN EXISTS(SELECT 1 FROM campus.payables WHERE component_id=c.id) THEN 'payable' ELSE 'reward_liability' END;
  PERFORM campus.money_journal(op.environment_id,c.lot_id,'refund:'||(fact->>'id'),jsonb_build_array(jsonb_build_object('account',account_name,'debit',amount,'componentId',c.id,'memberId',c.member_id),jsonb_build_object('account','network_exposure','credit',amount)));
 ELSE
  PERFORM campus.money_journal(op.environment_id,c.lot_id,'reversal:'||(fact->>'id'),jsonb_build_array(jsonb_build_object('account','network_exposure','debit',amount),jsonb_build_object('account','payable','credit',amount,'componentId',c.id,'memberId',c.member_id)));
  INSERT INTO campus.principal_restorations VALUES(op.id,(op.payload->>'originalOperationId')::uuid,c.id,c.lot_id,op.environment_id,amount) ON CONFLICT DO NOTHING;
  UPDATE campus.payables SET transferred_cents=transferred_cents-amount,gross_satisfied_cents=greatest(0,gross_satisfied_cents-amount) WHERE component_id=c.id;
  PERFORM campus.money_hold(op.obligation_id,'reversed_payable_review','reversal:'||(fact->>'id'),jsonb_build_object('componentId',c.id));
 END IF;
 UPDATE campus.money_reservations SET status='consumed' WHERE id=r.id;UPDATE campus.money_operations SET status='succeeded',lease_until=NULL WHERE id=opid;RETURN true;
END $$;
CREATE TABLE campus.payment_network_balance_facts(environment_id uuid NOT NULL REFERENCES campus.payment_environments,balance_id text NOT NULL,lot_id uuid NOT NULL,charge_id text NOT NULL,dispute_id text NOT NULL,kind text NOT NULL CHECK(kind IN('debit','credit')),amount_cents bigint NOT NULL CHECK(amount_cents>0),available boolean NOT NULL,PRIMARY KEY(environment_id,balance_id),FOREIGN KEY(lot_id,environment_id) REFERENCES campus.funding_lots(id,environment_id));
ALTER TABLE campus.payment_network_balance_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_network_balance_facts FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_network_fact(eid uuid,chargeid text,fact jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE f record;o campus.funding_obligations;amount bigint;effect text;old campus.payment_network_balance_facts;
BEGIN SELECT * INTO f FROM campus.money_receipt_source(eid,chargeid);IF NOT FOUND THEN RAISE EXCEPTION 'dependency_not_ready' USING ERRCODE='P0001';END IF;PERFORM campus.money_lock_aggregate((SELECT obligation_id FROM campus.funding_lots WHERE id=f.lot_id));PERFORM campus.money_cash_lock(eid);SELECT fo.* INTO o FROM campus.funding_obligations fo JOIN campus.funding_lots l ON l.obligation_id=fo.id WHERE l.id=f.lot_id FOR UPDATE OF fo;
 IF fact->>'currency' IS DISTINCT FROM 'usd' OR fact->>'chargeId' IS DISTINCT FROM chargeid OR coalesce(fact->>'balanceTransactionId','')='' OR fact->>'kind' NOT IN('debit','credit') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 amount:=(fact->>'amountCents')::bigint;IF amount<=0 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE='P0001';END IF;effect:='network:'||(fact->>'balanceTransactionId');
 SELECT * INTO old FROM campus.payment_network_balance_facts WHERE environment_id=eid AND balance_id=fact->>'balanceTransactionId';
 IF FOUND THEN IF old.charge_id<>chargeid OR old.dispute_id IS DISTINCT FROM fact->>'disputeId' OR old.kind<>fact->>'kind' OR old.amount_cents<>amount THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 UPDATE campus.payment_network_balance_facts SET available=coalesce((fact->>'available')::boolean,false) WHERE environment_id=eid AND balance_id=old.balance_id;
 ELSE INSERT INTO campus.payment_network_balance_facts VALUES(eid,fact->>'balanceTransactionId',f.lot_id,chargeid,fact->>'disputeId',fact->>'kind',amount,coalesce((fact->>'available')::boolean,false),f.receipt_fact_id);END IF;

 IF fact->>'kind'='debit' THEN PERFORM campus.money_journal(eid,f.lot_id,effect,jsonb_build_array(jsonb_build_object('account','network_exposure','debit',amount),jsonb_build_object('account','cash','credit',amount)));
 ELSE PERFORM campus.money_journal(eid,f.lot_id,effect,jsonb_build_array(jsonb_build_object('account','cash','debit',amount),jsonb_build_object('account','network_exposure','credit',amount)));END IF;
 INSERT INTO campus.dispute_cases(obligation_id,origin,source_id,reason) VALUES(o.id,'network',fact->>'disputeId','provider_network_dispute') ON CONFLICT DO NOTHING;
 PERFORM campus.money_hold(o.id,'network_dispute',effect,jsonb_build_object('amountCents',amount));RETURN true;
END $$;
REVOKE ALL ON FUNCTION campus.money_refund_request(text,uuid,jsonb),campus.money_open_dispute(text,uuid,jsonb),campus.money_prepare_compensation(uuid,uuid),campus.money_compensation_fact(uuid,jsonb),campus.money_network_fact(uuid,text,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_refund_request(text,uuid,jsonb),campus.money_open_dispute(text,uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.money_prepare_compensation(uuid,uuid),campus.money_compensation_fact(uuid,jsonb),campus.money_network_fact(uuid,text,jsonb) TO campus_worker;
CREATE FUNCTION campus.money_operation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF TG_OP='DELETE' OR (NEW.id,NEW.environment_id,NEW.obligation_id,NEW.kind,NEW.business_key,NEW.payload,NEW.payload_hash,NEW.provider_key,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.environment_id,OLD.obligation_id,OLD.kind,OLD.business_key,OLD.payload,OLD.payload_hash,OLD.provider_key,OLD.created_at) THEN RAISE EXCEPTION 'Operation identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER immutable_operation BEFORE UPDATE OR DELETE ON campus.money_operations FOR EACH ROW EXECUTE FUNCTION campus.money_operation_guard();
CREATE FUNCTION campus.money_obligation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF TG_OP='DELETE' OR (to_jsonb(NEW)-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'revision') OR NEW.revision<OLD.revision THEN RAISE EXCEPTION 'Obligation identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER immutable_obligation BEFORE UPDATE OR DELETE ON campus.funding_obligations FOR EACH ROW EXECUTE FUNCTION campus.money_obligation_guard();
CREATE FUNCTION campus.money_dispatchable(op campus.money_operations) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE account campus.connected_payee_accounts;p campus.payment_execution_policies;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM campus.payment_environments WHERE id=op.environment_id AND enabled) THEN RETURN false;END IF;
 IF op.kind IN('transfer','checkout','fee_restitution') AND EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=op.obligation_id AND active) THEN RETURN false;END IF;
 IF op.kind='transfer' THEN
  IF coalesce((SELECT sum(rr.amount_cents) FROM campus.money_reservations rr JOIN campus.money_operations mm ON mm.id=rr.operation_id WHERE mm.environment_id=op.environment_id AND mm.kind='transfer' AND mm.payload->>'sourceCharge'=op.payload->>'sourceCharge' AND rr.status IN('reserved','consumed')),0)>(SELECT amount_cents FROM campus.funding_obligations WHERE id=op.obligation_id) THEN RETURN false;END IF;
  SELECT * INTO account FROM campus.connected_payee_accounts WHERE environment_id=op.environment_id AND provider_account_id=op.payload->>'destination';
  IF account.transfer_capability IS DISTINCT FROM 'active' OR account.observed_at IS NULL OR account.observed_at<campus.money_now()-interval '5 minutes' OR NOT EXISTS(SELECT 1 FROM campus.users WHERE id=account.user_id AND account_status='active') THEN RETURN false;END IF;
 END IF;
 IF op.kind IN('transfer','refund','fee_restitution') AND (campus.money_cash_headroom(op.environment_id,NULL,CASE WHEN op.kind='refund' THEN (SELECT lot_id FROM campus.money_reservations WHERE operation_id=op.id LIMIT 1) END)<0 OR campus.money_cash_headroom(op.environment_id,(SELECT lot_id FROM campus.money_reservations WHERE operation_id=op.id LIMIT 1),CASE WHEN op.kind='refund' THEN (SELECT lot_id FROM campus.money_reservations WHERE operation_id=op.id LIMIT 1) END)<0) THEN RETURN false;END IF;
 IF op.kind IN('refund','reversal') THEN
  SELECT * INTO p FROM campus.payment_execution_policies WHERE id=(op.payload->>'policyId')::uuid AND status='approved' AND environment_id=op.environment_id AND purpose=op.kind;
  IF p.id IS NULL OR p.digest IS DISTINCT FROM op.payload->>'policyDigest' OR EXISTS(SELECT 1 FROM campus.money_active_holds h WHERE h.obligation_id=op.obligation_id AND h.active AND NOT coalesce(p.payload->'approvedHoldIds','[]'::jsonb)?h.id::text) THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;
CREATE FUNCTION campus.money_environment_binding(eid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT jsonb_build_object('id',id,'platformAccountId',platform_account_id,'mode',mode,'enabled',enabled,'apiVersion',api_version,'sdkVersion',sdk_version) FROM campus.payment_environments WHERE id=eid $$;
REVOKE ALL ON FUNCTION campus.money_operation_guard(),campus.money_obligation_guard(),campus.money_dispatchable(campus.money_operations),campus.money_environment_binding(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_environment_binding(uuid) TO campus_worker;

CREATE TABLE campus.payment_unmatched_receipts(environment_id uuid NOT NULL REFERENCES campus.payment_environments,obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,charge_id text NOT NULL,amount_cents bigint NOT NULL,journal_id uuid NOT NULL REFERENCES campus.ledger_journals,PRIMARY KEY(environment_id,charge_id));
ALTER TABLE campus.payment_unmatched_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_unmatched_receipts FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_unmatched_receipts FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE FUNCTION campus.money_lock_aggregate(oid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;
BEGIN SELECT * INTO o FROM campus.funding_obligations WHERE id=oid;
 IF o.agreement_id IS NOT NULL THEN PERFORM 1 FROM campus.agreements WHERE id=o.agreement_id FOR UPDATE;ELSIF o.order_id IS NOT NULL THEN PERFORM 1 FROM campus.orders WHERE id=o.order_id FOR UPDATE;END IF;END $$;
REVOKE ALL ON FUNCTION campus.money_lock_aggregate(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
-- Append-only monetary change history. The future amendment comparator must
-- enumerate these typed changes; revision numbers alone are never coverage authority.
CREATE TABLE campus.money_aggregate_revisions (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,aggregate_type text NOT NULL,aggregate_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(environment_id,aggregate_type,aggregate_id)
);
CREATE TABLE campus.money_effect_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 aggregate_type text NOT NULL,aggregate_id uuid NOT NULL,revision bigint NOT NULL,
 relation_name text NOT NULL,mutation text NOT NULL CHECK(mutation IN('INSERT','UPDATE','DELETE')),
 row_identity jsonb NOT NULL,obligation_id uuid REFERENCES campus.funding_obligations,lot_id uuid REFERENCES campus.funding_lots,operation_id uuid REFERENCES campus.money_operations,
 before_digest text,after_digest text,before_state jsonb,after_state jsonb,recorded_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(environment_id,aggregate_type,aggregate_id,revision),
 FOREIGN KEY(environment_id,aggregate_type,aggregate_id) REFERENCES campus.money_aggregate_revisions(environment_id,aggregate_type,aggregate_id)
);
ALTER TABLE campus.money_aggregate_revisions ENABLE ROW LEVEL SECURITY;ALTER TABLE campus.money_effect_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.money_aggregate_revisions,campus.money_effect_history FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.money_effect_history FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE FUNCTION campus.money_effect_safe(row_value jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT (row_value-ARRAY['payload','hosted_url','url','result','detail','reason'])||jsonb_build_object('privateContentDigest',encode(sha256(convert_to(campus.transaction_canonical(row_value),'UTF8')),'hex'))
$$;
CREATE FUNCTION campus.money_capture_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE row_value jsonb;before_value jsonb;after_value jsonb;oid uuid;lid uuid;opid uuid;eid uuid;gid uuid;uid uuid;target record;next_revision bigint;identity jsonb;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='connected_payee_accounts' AND TG_OP='UPDATE' AND (to_jsonb(OLD)-'observed_at')=(to_jsonb(NEW)-'observed_at') THEN RETURN NULL;END IF;
 row_value:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP<>'INSERT' THEN before_value:=campus.money_effect_safe(to_jsonb(OLD));END IF;
 IF TG_OP<>'DELETE' THEN after_value:=campus.money_effect_safe(to_jsonb(NEW));END IF;
 oid:=(row_value->>'obligation_id')::uuid;lid:=(row_value->>'lot_id')::uuid;opid:=(row_value->>'operation_id')::uuid;eid:=(row_value->>'environment_id')::uuid;gid:=(row_value->>'agreement_id')::uuid;
 IF TG_TABLE_NAME='payment_environments' THEN eid:=(row_value->>'id')::uuid;END IF;
 IF TG_TABLE_NAME='payment_execution_policies' THEN gid:=CASE WHEN row_value->>'aggregate_type'='agreement' THEN (row_value->>'aggregate_id')::uuid WHEN row_value->>'aggregate_type'='amendment' THEN (SELECT agreement_id FROM campus.agreement_amendments WHERE id=(row_value->>'aggregate_id')::uuid) END;IF row_value->>'aggregate_type'='order' THEN SELECT id INTO oid FROM campus.funding_obligations WHERE order_id=(row_value->>'aggregate_id')::uuid LIMIT 1;END IF;END IF;
 IF TG_TABLE_NAME='funding_obligations' THEN oid:=(row_value->>'id')::uuid;END IF;
 IF TG_TABLE_NAME='funding_lots' THEN lid:=(row_value->>'id')::uuid;END IF;
 IF TG_TABLE_NAME='money_operations' THEN opid:=(row_value->>'id')::uuid;END IF;
 IF TG_TABLE_NAME='ledger_lines' THEN SELECT lot_id,environment_id INTO lid,eid FROM campus.ledger_journals WHERE id=(row_value->>'journal_id')::uuid;END IF;
 IF TG_TABLE_NAME='fee_consumptions' THEN SELECT lot_id INTO lid FROM campus.money_reservations WHERE id=(row_value->>'reservation_id')::uuid;END IF;
 IF oid IS NULL AND lid IS NOT NULL THEN SELECT obligation_id INTO oid FROM campus.funding_lots WHERE id=lid;END IF;
 IF oid IS NULL AND opid IS NOT NULL THEN SELECT obligation_id INTO oid FROM campus.money_operations WHERE id=opid;END IF;
 IF TG_TABLE_NAME='connected_payee_accounts' THEN uid:=(row_value->>'user_id')::uuid;END IF;
 IF TG_TABLE_NAME='order_payment_state' OR TG_TABLE_NAME='inventory_release_events' THEN SELECT id INTO oid FROM campus.funding_obligations WHERE order_id=(row_value->>'order_id')::uuid ORDER BY created_at DESC LIMIT 1;END IF;
 identity:=jsonb_strip_nulls(jsonb_build_object('id',row_value->'id','inboxId',row_value->'inbox_id','receiptFactId',row_value->'receipt_fact_id','lotId',row_value->'lot_id','operationId',row_value->'operation_id','journalId',row_value->'journal_id','position',row_value->'position','reservationId',row_value->'reservation_id','orderId',row_value->'order_id','userId',row_value->'user_id','chargeId',row_value->'charge_id','environmentId',row_value->'environment_id'));
 FOR target IN
  SELECT DISTINCT o.environment_id,CASE WHEN o.agreement_id IS NULL THEN 'order' ELSE 'agreement' END AS kind,coalesce(o.agreement_id,o.order_id) AS resource
  FROM campus.funding_obligations o WHERE o.id=oid OR (gid IS NOT NULL AND o.agreement_id=gid) OR
  (TG_TABLE_NAME='payment_environments' AND o.environment_id=eid) OR
  (uid IS NOT NULL AND o.environment_id=eid AND EXISTS(SELECT 1 FROM campus.funding_lots fl JOIN campus.funding_component_plans cp ON cp.lot_id=fl.id WHERE fl.obligation_id=o.id AND cp.member_id=uid))
  ORDER BY resource
 LOOP
  -- Callers acquire this lock before monetary row writes. This is also defensive
  -- protection for owner-managed fixture/policy setup, never runtime owner access.
  IF target.kind='agreement' THEN PERFORM 1 FROM campus.agreements WHERE id=target.resource FOR UPDATE;ELSE PERFORM 1 FROM campus.orders WHERE id=target.resource FOR UPDATE;END IF;
  INSERT INTO campus.money_aggregate_revisions VALUES(target.environment_id,target.kind,target.resource,0) ON CONFLICT DO NOTHING;
  UPDATE campus.money_aggregate_revisions SET revision=revision+1 WHERE environment_id=target.environment_id AND aggregate_type=target.kind AND aggregate_id=target.resource RETURNING revision INTO next_revision;
  INSERT INTO campus.money_effect_history(environment_id,aggregate_type,aggregate_id,revision,relation_name,mutation,row_identity,obligation_id,lot_id,operation_id,before_digest,after_digest,before_state,after_state)
  VALUES(target.environment_id,target.kind,target.resource,next_revision,TG_TABLE_NAME,TG_OP,identity,oid,lid,opid,CASE WHEN before_value IS NOT NULL THEN encode(sha256(convert_to(campus.transaction_canonical(before_value),'UTF8')),'hex') END,CASE WHEN after_value IS NOT NULL THEN encode(sha256(convert_to(campus.transaction_canonical(after_value),'UTF8')),'hex') END,before_value,after_value);
 END LOOP;RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['funding_obligations','payment_quotes','funding_lots','funding_component_plans','money_operations','payment_attempts','payment_outbox','payment_events','ledger_journals','ledger_lines','funding_allocations','money_reservations','fee_consumptions','payment_holds','reconciliation_cases','settlement_eligibilities','payables','order_payment_state','inventory_release_events','refund_requests','dispute_cases','payment_compensation_decisions','payment_unmatched_receipts','payment_balance_facts','payment_network_balance_facts','connected_payee_accounts','payment_environments','payment_execution_policies'] LOOP EXECUTE format('CREATE TRIGGER money_effect AFTER INSERT OR UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_capture_effect()',t);END LOOP;END $$;
REVOKE ALL ON FUNCTION campus.money_effect_safe(jsonb),campus.money_capture_effect() FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_find_operation(eid uuid,providerid text,correlation uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT to_jsonb(m) FROM campus.money_operations m WHERE m.environment_id=eid AND (m.provider_id=providerid OR m.id=correlation) LIMIT 1 $$;
CREATE FUNCTION campus.money_network_case(eid uuid,chargeid text,disputeid text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE oid uuid;
BEGIN SELECT obligation_id INTO oid FROM campus.money_receipt_source(eid,chargeid);IF oid IS NULL THEN RAISE EXCEPTION 'dependency_not_ready' USING ERRCODE='P0001';END IF;PERFORM campus.money_lock_aggregate(oid);PERFORM campus.money_cash_lock(eid);
 INSERT INTO campus.dispute_cases(obligation_id,origin,source_id,reason) VALUES(oid,'network',disputeid,'provider_network_dispute') ON CONFLICT DO NOTHING;PERFORM campus.money_hold(oid,'network_dispute','dispute:'||disputeid,'{}');END $$;
CREATE FUNCTION campus.money_payout_observe(eid uuid,accountid text,payoutid text,state text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF state NOT IN('paid','pending','in_transit','canceled','failed') OR NOT EXISTS(SELECT 1 FROM campus.connected_payee_accounts WHERE environment_id=eid AND provider_account_id=accountid) THEN RAISE EXCEPTION 'provider_scope_mismatch' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.provider_payout_observations VALUES(eid,accountid,payoutid,state,campus.money_now()) ON CONFLICT(environment_id,account_id,payout_id) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at;END $$;
REVOKE ALL ON FUNCTION campus.money_find_operation(uuid,text,uuid),campus.money_network_case(uuid,text,text),campus.money_payout_observe(uuid,text,text,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_find_operation(uuid,text,uuid),campus.money_network_case(uuid,text,text),campus.money_payout_observe(uuid,text,text,text) TO campus_worker;
ALTER FUNCTION campus.review_milestone_work(uuid,uuid,integer,integer,text,text,uuid,integer) RENAME TO review_milestone_work_before_money;
REVOKE ALL ON FUNCTION campus.review_milestone_work_before_money(uuid,uuid,integer,integer,text,text,uuid,integer) FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.review_milestone_work(mid uuid,sid uuid,ver integer,rev integer,decision text,feedback text,tid uuid,tr integer,ttid uuid,ttr integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE b campus.agreement_transaction_bindings;gid uuid;
BEGIN
 SELECT agreement_id INTO gid FROM campus.milestones WHERE id=mid;PERFORM campus.lock_work_agreement(gid,'review');
 SELECT ab.* INTO b FROM campus.agreement_transaction_bindings ab JOIN campus.submission_terms st ON st.agreement_id=ab.agreement_id AND st.terms_id=ab.terms_id WHERE st.submission_id=sid AND st.milestone_id=mid;
 IF b.transaction_terms_id IS NOT NULL THEN
 IF b.transaction_terms_id IS DISTINCT FROM ttid OR b.transaction_terms_revision IS DISTINCT FROM ttr THEN RAISE EXCEPTION 'terms_refresh_required' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.money_active_holds h JOIN campus.funding_obligations o ON o.id=h.obligation_id WHERE o.agreement_id=gid AND h.active) THEN RAISE EXCEPTION 'funds_held' USING ERRCODE='P0001';END IF;
 END IF;
 RETURN campus.review_milestone_work_before_money(mid,sid,ver,rev,decision,feedback,tid,tr);
END $$;
CREATE FUNCTION campus.review_milestone_work(mid uuid,sid uuid,ver integer,rev integer,decision text,feedback text,tid uuid,tr integer) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT campus.review_milestone_work(mid,sid,ver,rev,decision,feedback,tid,tr,NULL,NULL) $$;
REVOKE ALL ON FUNCTION campus.review_milestone_work(uuid,uuid,integer,integer,text,text,uuid,integer,uuid,integer),campus.review_milestone_work(uuid,uuid,integer,integer,text,text,uuid,integer) FROM PUBLIC,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.review_milestone_work(uuid,uuid,integer,integer,text,text,uuid,integer,uuid,integer),campus.review_milestone_work(uuid,uuid,integer,integer,text,text,uuid,integer) TO campus_app;
CREATE TABLE campus.principal_restorations (
 reversal_operation_id uuid PRIMARY KEY REFERENCES campus.money_operations,original_operation_id uuid NOT NULL REFERENCES campus.money_operations,
 component_id uuid NOT NULL REFERENCES campus.funding_component_plans,lot_id uuid NOT NULL REFERENCES campus.funding_lots,
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,amount_cents bigint NOT NULL CHECK(amount_cents>0)
);
ALTER TABLE campus.principal_restorations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.principal_restorations FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.principal_restorations FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE TRIGGER money_effect AFTER INSERT ON campus.principal_restorations FOR EACH ROW EXECUTE FUNCTION campus.money_capture_effect();

-- Operational polling cursor is separate from semantic account revisions/effect history.
CREATE TABLE campus.payment_recipient_refresh_schedule (
 environment_id uuid NOT NULL,user_id uuid NOT NULL,last_attempt_at timestamptz,
 PRIMARY KEY(environment_id,user_id),FOREIGN KEY(environment_id,user_id) REFERENCES campus.connected_payee_accounts(environment_id,user_id)
);
ALTER TABLE campus.payment_recipient_refresh_schedule ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_recipient_refresh_schedule FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_account_refresh_targets(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 INSERT INTO campus.payment_recipient_refresh_schedule(environment_id,user_id) SELECT environment_id,user_id FROM campus.connected_payee_accounts WHERE environment_id=eid ON CONFLICT DO NOTHING;
 WITH due AS (SELECT s.environment_id,s.user_id FROM campus.payment_recipient_refresh_schedule s WHERE s.environment_id=eid ORDER BY s.last_attempt_at NULLS FIRST,s.user_id FOR UPDATE SKIP LOCKED LIMIT 16), claimed AS (UPDATE campus.payment_recipient_refresh_schedule s SET last_attempt_at=campus.money_now() FROM due WHERE s.environment_id=due.environment_id AND s.user_id=due.user_id RETURNING s.user_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('userId',a.user_id,'accountId',a.provider_account_id)),'[]'::jsonb) INTO result FROM claimed JOIN campus.connected_payee_accounts a ON a.environment_id=eid AND a.user_id=claimed.user_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION campus.money_account_refresh_targets(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_account_refresh_targets(uuid) TO campus_worker;

-- Every financial caller locks its one agreement/order before this environment mutex.
-- Never call an aggregate-locking function for another resource after this mutex.
CREATE FUNCTION campus.money_cash_lock(eid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF eid IS NOT NULL THEN PERFORM pg_advisory_xact_lock(167301,hashtext(eid::text));END IF;END $$;
CREATE TABLE campus.payment_aggregate_work_schedule(obligation_id uuid PRIMARY KEY REFERENCES campus.funding_obligations,last_attempt_at timestamptz);
ALTER TABLE campus.payment_aggregate_work_schedule ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_aggregate_work_schedule FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_work_targets(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 INSERT INTO campus.payment_aggregate_work_schedule SELECT id,NULL FROM campus.funding_obligations WHERE environment_id=eid ON CONFLICT DO NOTHING;
 WITH due AS (SELECT s.obligation_id FROM campus.payment_aggregate_work_schedule s JOIN campus.funding_obligations o ON o.id=s.obligation_id WHERE o.environment_id=eid ORDER BY s.last_attempt_at NULLS FIRST,s.obligation_id FOR UPDATE OF s SKIP LOCKED LIMIT 16), claimed AS (UPDATE campus.payment_aggregate_work_schedule s SET last_attempt_at=campus.money_now() FROM due WHERE s.obligation_id=due.obligation_id RETURNING s.obligation_id)
 SELECT coalesce(jsonb_agg(obligation_id),'[]'::jsonb) INTO result FROM claimed;RETURN result;
END $$;
REVOKE ALL ON FUNCTION campus.money_work_targets(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_work_targets(uuid) TO campus_worker;

CREATE FUNCTION campus.money_balance_fact_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN IF TG_OP='DELETE' OR (to_jsonb(NEW)-'available') IS DISTINCT FROM (to_jsonb(OLD)-'available') THEN RAISE EXCEPTION 'Balance identity is immutable' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER immutable_network_fact BEFORE UPDATE OR DELETE ON campus.payment_network_balance_facts FOR EACH ROW EXECUTE FUNCTION campus.money_balance_fact_guard();
CREATE TRIGGER immutable_balance_fact BEFORE UPDATE OR DELETE ON campus.payment_balance_facts FOR EACH ROW EXECUTE FUNCTION campus.money_balance_fact_guard();
ALTER TABLE campus.payment_balance_facts ADD FOREIGN KEY(operation_id,environment_id) REFERENCES campus.money_operations(id,environment_id),ADD FOREIGN KEY(component_id,environment_id,lot_id) REFERENCES campus.funding_component_plans(id,environment_id,lot_id);
CREATE FUNCTION campus.money_inbox_cursor(iid uuid,token bigint,next_cursor text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN UPDATE campus.provider_inbox SET reconciliation_cursor=next_cursor WHERE id=iid AND fence=token AND lease_until>=campus.money_now();RETURN FOUND;END $$;
REVOKE ALL ON FUNCTION campus.money_balance_fact_guard(),campus.money_inbox_cursor(uuid,bigint,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_inbox_cursor(uuid,bigint,text) TO campus_worker;

CREATE TABLE campus.payment_external_balance_facts (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,balance_id text NOT NULL,lot_id uuid NOT NULL,component_id uuid,
 original_operation_id uuid REFERENCES campus.money_operations,object_id text NOT NULL,kind text NOT NULL CHECK(kind IN('refund','reversal')),role text NOT NULL CHECK(role IN('original','failure')),
 amount_cents bigint NOT NULL,fee_cents bigint NOT NULL,net_cents bigint NOT NULL,available boolean NOT NULL,
 PRIMARY KEY(environment_id,balance_id),UNIQUE(environment_id,object_id,role),CHECK(net_cents=amount_cents-fee_cents),
 FOREIGN KEY(lot_id,environment_id) REFERENCES campus.funding_lots(id,environment_id),FOREIGN KEY(component_id,environment_id,lot_id) REFERENCES campus.funding_component_plans(id,environment_id,lot_id)
);
ALTER TABLE campus.payment_external_balance_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_external_balance_facts FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_balance_fact BEFORE UPDATE OR DELETE ON campus.payment_external_balance_facts FOR EACH ROW EXECUTE FUNCTION campus.money_balance_fact_guard();
CREATE TRIGGER money_effect AFTER INSERT OR UPDATE ON campus.payment_external_balance_facts FOR EACH ROW EXECUTE FUNCTION campus.money_capture_effect();
CREATE FUNCTION campus.money_external_compensation(eid uuid,chargeid text,fact jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE f record;oid uuid;original campus.money_operations;cp campus.funding_component_plans;old campus.payment_external_balance_facts;b jsonb;entries jsonb;amount bigint;fee bigint;net bigint;v_kind text;
BEGIN
 SELECT * INTO f FROM campus.money_receipt_source(eid,chargeid);IF NOT FOUND THEN RAISE EXCEPTION 'dependency_not_ready' USING ERRCODE='P0001';END IF;
 SELECT obligation_id INTO oid FROM campus.funding_lots WHERE id=f.lot_id;PERFORM campus.money_lock_aggregate(oid);PERFORM campus.money_cash_lock(eid);
 v_kind:=fact->>'kind';amount:=(fact->>'amountCents')::bigint;
 IF fact->>'environmentId' IS DISTINCT FROM eid::text OR fact->>'sourceCharge' IS DISTINCT FROM chargeid OR fact->>'currency' IS DISTINCT FROM 'usd' OR v_kind NOT IN('refund','reversal') OR amount<=0 OR amount>(SELECT amount_cents FROM campus.funding_obligations WHERE id=oid) OR coalesce(fact->>'id','')='' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 IF v_kind='reversal' THEN
  SELECT * INTO original FROM campus.money_operations WHERE id=(fact->>'originalOperationId')::uuid AND environment_id=eid AND obligation_id=oid AND kind='transfer' AND status='succeeded' AND provider_id=fact->>'transferId';
  IF original.id IS NULL OR amount>(original.payload->>'amountCents')::bigint THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  SELECT * INTO cp FROM campus.funding_component_plans WHERE id=(original.payload->>'componentId')::uuid AND lot_id=f.lot_id;
 END IF;
 PERFORM campus.money_hold(oid,'external_compensation_review','external:'||(fact->>'id'),jsonb_build_object('kind',v_kind,'objectId',fact->>'id'));
 FOR b IN SELECT value FROM jsonb_array_elements(coalesce(fact->'balances','[]'::jsonb)) LOOP
  net:=(b->>'netCents')::bigint;fee:=(b->>'feeCents')::bigint;
  IF coalesce(b->>'id','')='' OR b->>'role' NOT IN('original','failure') OR (b->>'amountCents')::bigint IS DISTINCT FROM (CASE WHEN v_kind='reversal' OR b->>'role'='failure' THEN amount ELSE -amount END) OR net<>(b->>'amountCents')::bigint-fee THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  IF EXISTS(SELECT 1 FROM campus.payment_balance_facts WHERE environment_id=eid AND balance_id=b->>'id') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  SELECT * INTO old FROM campus.payment_external_balance_facts WHERE environment_id=eid AND balance_id=b->>'id';
  IF FOUND THEN
   IF old.object_id<>fact->>'id' OR old.kind<>v_kind OR old.role<>b->>'role' OR old.lot_id<>f.lot_id OR old.amount_cents<>(b->>'amountCents')::bigint OR old.fee_cents<>fee OR old.net_cents<>net OR old.original_operation_id IS DISTINCT FROM original.id THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
   UPDATE campus.payment_external_balance_facts SET available=(b->>'available')::boolean WHERE environment_id=eid AND balance_id=old.balance_id;CONTINUE;
  END IF;
  IF v_kind='reversal' AND (SELECT coalesce(sum(amount_cents),0) FROM campus.principal_restorations WHERE original_operation_id=original.id)+(SELECT coalesce(sum(amount_cents),0) FROM campus.payment_external_balance_facts WHERE original_operation_id=original.id AND role='original')+amount>(original.payload->>'amountCents')::bigint THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  INSERT INTO campus.payment_external_balance_facts VALUES(eid,b->>'id',f.lot_id,cp.id,original.id,fact->>'id',v_kind,b->>'role',(b->>'amountCents')::bigint,fee,net,(b->>'available')::boolean,f.receipt_fact_id);
  entries:='[]'::jsonb;
  IF net<>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','cash','debit',greatest(net,0),'credit',greatest(-net,0)));END IF;
  IF fee<>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','fee_expense','debit',greatest(fee,0),'credit',greatest(-fee,0)));END IF;
  IF v_kind='reversal' THEN
   entries:=entries||jsonb_build_array(jsonb_build_object('account','payable','credit',amount,'componentId',cp.id,'memberId',cp.member_id));
   UPDATE campus.payables SET transferred_cents=transferred_cents-amount,gross_satisfied_cents=greatest(0,gross_satisfied_cents-amount) WHERE component_id=cp.id;
  ELSE entries:=entries||jsonb_build_array(jsonb_build_object('account','network_exposure','debit',greatest(-(b->>'amountCents')::bigint,0),'credit',greatest((b->>'amountCents')::bigint,0)));END IF;
  PERFORM campus.money_journal(eid,f.lot_id,'external_compensation_balance:'||(b->>'id'),entries);
 END LOOP;RETURN true;
END $$;
REVOKE ALL ON FUNCTION campus.money_external_compensation(uuid,text,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_external_compensation(uuid,text,jsonb) TO campus_worker;
CREATE FUNCTION campus.money_cash_raw(eid uuid,lid uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 WITH cash AS (SELECT coalesce(sum(ll.debit-ll.credit),0) AS book,coalesce(sum(ll.credit),0) AS debits FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=eid AND (lid IS NULL OR j.lot_id=lid) AND ll.account='cash'), originals AS (SELECT coalesce(sum(coalesce(available_cents,0)),0) AS available,coalesce(sum(coalesce(actual_fee_cents,0)),0) AS original_fees FROM campus.funding_allocations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid)), reserved AS (SELECT coalesce(sum(amount_cents-cash_debited_cents),0) AS amount FROM campus.money_reservations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind IN('transfer','refund') AND status='reserved')
 SELECT least(cash.book,originals.available+coalesce((SELECT sum(net_cents) FROM campus.payment_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)+coalesce((SELECT sum(net_cents) FROM campus.payment_external_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_network_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind='credit' AND available),0)-cash.debits+originals.original_fees)-reserved.amount FROM cash,originals,reserved
$$;
REVOKE ALL ON FUNCTION campus.money_cash_lock(uuid),campus.money_cash_raw(uuid,uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
-- Holds consume only positive remaining unreserved source liquidity, never a second
-- copy of cash already reserved/debited. An exact approved refund can use its lot.
CREATE FUNCTION campus.money_cash_headroom(eid uuid,lid uuid DEFAULT NULL,approved_hold_lot uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT campus.money_cash_raw(eid,lid)-coalesce((SELECT sum(greatest(0,campus.money_cash_raw(eid,l.id))) FROM campus.funding_lots l WHERE l.environment_id=eid AND (lid IS NULL OR l.id=lid) AND l.id IS DISTINCT FROM approved_hold_lot AND EXISTS(SELECT 1 FROM campus.money_active_holds h WHERE h.obligation_id=l.obligation_id AND h.active)),0)
$$;
REVOKE ALL ON FUNCTION campus.money_cash_headroom(uuid,uuid,uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;


CREATE FUNCTION campus.money_earn_order(oid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;c campus.funding_component_plans;f campus.funding_allocations;
BEGIN IF oid IS NULL THEN RETURN;END IF;
 PERFORM 1 FROM campus.orders WHERE id=oid AND state='completed' FOR UPDATE;IF NOT FOUND THEN RETURN;END IF;
 SELECT * INTO o FROM campus.funding_obligations WHERE order_id=oid;IF o.id IS NULL THEN RETURN;END IF;PERFORM campus.money_cash_lock(o.environment_id);
 IF NOT EXISTS(SELECT 1 FROM campus.payment_execution_policies WHERE id=o.policy_id AND status='approved' AND payload->>'goodsRelease'='buyer_confirmed_receipt') OR EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active) THEN RETURN;END IF;
 SELECT cp.* INTO c FROM campus.money_effective_components cp JOIN campus.funding_lots l ON l.id=cp.lot_id WHERE l.obligation_id=o.id;SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=c.lot_id;
 IF f.fee_state IS DISTINCT FROM 'matched' OR EXISTS(SELECT 1 FROM campus.payables WHERE component_id=c.id) THEN RETURN;END IF;
 IF c.net_cents>0 THEN PERFORM campus.money_journal(o.environment_id,c.lot_id,'goods_earned:'||c.id::text,jsonb_build_array(jsonb_build_object('account','reward_liability','debit',c.net_cents),jsonb_build_object('account','payable','credit',c.net_cents,'componentId',c.id,'memberId',c.member_id)));END IF;
 INSERT INTO campus.payables(environment_id,lot_id,component_id,release_ready,net_cents) VALUES(o.environment_id,c.lot_id,c.id,true,c.net_cents) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION campus.money_earn_order(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
-- Read-only capability projection uses the same persisted policy/terms/consent facts.
-- Actions are actor-specific entry points; every command still rechecks its exact version.
ALTER FUNCTION campus.money_projection(text,uuid) RENAME TO money_projection_base;
REVOKE ALL ON FUNCTION campus.money_projection_base(text,uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_projection(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;o campus.funding_obligations;g campus.agreements;x campus.orders;t campus.agreement_transaction_terms;pol campus.payment_execution_policies;a campus.connected_payee_accounts;eid uuid;payer uuid;payee boolean:=false;actor_active boolean;canquote boolean:=true;actions jsonb:='["refresh"]';reasons jsonb:='[]';held bigint;item jsonb;members jsonb:='[]';cp campus.funding_component_plans;p campus.payables;op campus.money_operations;fee_state text;state text;q campus.payment_quotes;attempt campus.payment_attempts;
BEGIN
 result:=campus.money_projection_base(kind,resource);reasons:=result->'blockedReasons';
 SELECT * INTO o FROM campus.funding_obligations WHERE aggregate_type=kind AND aggregate_id=resource ORDER BY created_at DESC LIMIT 1;
 SELECT id INTO eid FROM campus.payment_environments WHERE enabled;IF (SELECT count(*) FROM campus.payment_environments WHERE enabled)<>1 THEN eid:=NULL;END IF;
 actor_active:=EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active');
 IF eid IS NULL THEN canquote:=false;reasons:=reasons||'"payments_unavailable"'::jsonb;END IF;
 IF kind='agreement' THEN
  SELECT * INTO g FROM campus.agreements WHERE id=resource;payer:=g.owner_id;
  SELECT tt.* INTO t FROM campus.agreement_transaction_terms tt JOIN campus.agreement_transaction_bindings b ON b.transaction_terms_id=tt.id JOIN campus.agreement_terms_state st ON st.agreement_id=b.agreement_id AND st.effective_terms_id=b.terms_id WHERE b.agreement_id=resource;
  payee:=EXISTS(SELECT 1 FROM campus.payee_allocations WHERE transaction_terms_id=t.id AND member_id=campus.actor());
  IF t.id IS NULL OR (o.id IS NULL AND g.state<>'awaiting_funding') THEN canquote:=false;reasons:=reasons||'"legacy_coverage_unknown"'::jsonb;END IF;
 ELSE SELECT * INTO x FROM campus.orders WHERE id=resource;payer:=x.buyer_id;payee:=campus.actor()=x.seller_id;
  IF x.state<>'pending_payment' OR x.reserved_until<=campus.money_now() THEN canquote:=false;END IF;
 END IF;
 SELECT * INTO pol FROM campus.payment_execution_policies WHERE environment_id=eid AND aggregate_type=kind AND aggregate_id=resource AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1;
 IF pol.id IS NULL OR pol.digest IS DISTINCT FROM encode(sha256(convert_to(campus.transaction_canonical(pol.payload),'UTF8')),'hex') OR coalesce(pol.payload->>'feeAdjustment','') NOT IN('hold_on_variance','capped_actual_v1') THEN canquote:=false;reasons:=reasons||'"financial_policy_unresolved"'::jsonb;
 ELSIF kind='agreement' THEN
  IF pol.payload->>'signedPolicyId' IS DISTINCT FROM t.policy_id::text OR NOT campus.transaction_policy_disclosure_valid(t.policy_snapshot->'payload') THEN canquote:=false;reasons:=reasons||'"financial_policy_unresolved"'::jsonb;END IF;
 ELSE
  IF pol.payload->>'orderTermsDigest' IS DISTINCT FROM campus.money_order_terms(resource) OR NOT campus.transaction_policy_disclosure_valid(pol.payload) OR (pol.payload->>'estimatedProcessorFeeCents') IS NULL OR (pol.payload->>'estimatedProcessorFeeCents')::bigint<0 OR (pol.payload->>'estimatedProcessorFeeCents')::bigint/2>x.total_cents OR (pol.payload->>'chargeTotalCents')::bigint IS DISTINCT FROM x.total_cents+((pol.payload->>'estimatedProcessorFeeCents')::bigint+1)/2 THEN canquote:=false;reasons:=reasons||'"financial_policy_unresolved"'::jsonb;
  ELSE
   IF actor_active AND x.state='pending_payment' AND x.reserved_until>campus.money_now() AND NOT EXISTS(SELECT 1 FROM campus.payment_policy_confirmations WHERE policy_id=pol.id AND user_id=campus.actor()) THEN actions:=actions||'"confirm_payment_policy"'::jsonb;END IF;
   IF (SELECT count(*) FROM campus.payment_policy_confirmations WHERE policy_id=pol.id AND user_id IN(x.buyer_id,x.seller_id) AND resource_digest=campus.money_order_terms(resource) AND policy_digest=pol.digest)<>2 THEN canquote:=false;reasons:=reasons||'"financial_consent_required"'::jsonb;END IF;
  END IF;
 END IF;
 IF payee THEN
  SELECT * INTO a FROM campus.connected_payee_accounts WHERE environment_id=eid AND user_id=campus.actor();
  IF a.transfer_capability IS DISTINCT FROM 'active' THEN
   IF actor_active AND (a.provider_account_id IS NOT NULL OR EXISTS(SELECT 1 FROM campus.payment_recipient_configurations WHERE environment_id=eid AND user_id=campus.actor())) THEN actions:=actions||'"open_onboarding"'::jsonb;
   ELSE reasons:=reasons||'"recipient_identity_configuration_required"'::jsonb;END IF;
  END IF;
 END IF;
 IF NOT actor_active THEN canquote:=false;reasons:=reasons||'"account_restricted"'::jsonb;END IF;
 IF o.id IS NOT NULL THEN
  IF o.policy_id IS DISTINCT FROM pol.id THEN canquote:=false;reasons:=reasons||'"quote_changed"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active) THEN canquote:=false;END IF;
  SELECT coalesce(sum(greatest(0,campus.money_cash_raw(o.environment_id,l.id))),0) INTO held FROM campus.funding_lots l WHERE l.obligation_id=o.id AND EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active);
  SELECT fa.fee_state INTO fee_state FROM campus.funding_allocations fa JOIN campus.funding_lots l ON l.id=fa.lot_id WHERE l.obligation_id=o.id;
  IF fee_state IS NOT NULL THEN canquote:=false;IF actor_active AND campus.actor()=payer THEN actions:=actions||'"request_refund_review"'::jsonb;END IF;END IF;
  IF actor_active THEN actions:=actions||'"open_dispute"'::jsonb;END IF;
  SELECT * INTO attempt FROM campus.payment_attempts WHERE obligation_id=o.id AND status NOT IN('failed','canceled') LIMIT 1;
  IF attempt.id IS NOT NULL THEN
   canquote:=false;actions:=actions||'"refresh_attempt"'::jsonb;
   IF actor_active AND campus.actor()=payer AND attempt.status='requires_action' AND attempt.expires_at>campus.money_now() AND NOT EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active) THEN actions:=actions||'"open_checkout"'::jsonb;END IF;
  ELSIF canquote AND campus.actor()=payer THEN
   SELECT * INTO q FROM campus.payment_quotes WHERE obligation_id=o.id AND expires_at>campus.money_now() ORDER BY created_at DESC LIMIT 1;
   IF q.id IS NOT NULL THEN actions:=actions||'"create_payment_attempt"'::jsonb;END IF;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(result->'payees') LOOP
   SELECT * INTO cp FROM campus.funding_component_plans WHERE id=(item->>'componentId')::uuid;SELECT * INTO p FROM campus.payables WHERE component_id=cp.id;SELECT * INTO op FROM campus.money_operations WHERE id=p.operation_id;SELECT * INTO a FROM campus.connected_payee_accounts WHERE environment_id=o.environment_id AND user_id=cp.member_id;
   state:=CASE WHEN p.id IS NOT NULL AND p.transferred_cents=p.net_cents AND p.gross_satisfied_cents=cp.gross_cents THEN 'transferred' WHEN EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND active AND (member_id IS NULL OR member_id=cp.member_id)) THEN 'held' WHEN fee_state IS NULL THEN 'awaiting_funding' WHEN fee_state<>'matched' THEN fee_state WHEN p.id IS NULL THEN 'awaiting_acceptance' WHEN NOT p.release_ready THEN 'waiting_final_group' WHEN op.status='unknown' OR op.status='dispatching' THEN 'reconciling' WHEN op.status='queued' THEN 'queued' WHEN op.status='held' THEN 'held' WHEN NOT EXISTS(SELECT 1 FROM campus.users WHERE id=cp.member_id AND account_status='active') THEN 'recipient_restricted' WHEN a.transfer_capability IS DISTINCT FROM 'active' THEN 'recipient_action_required' WHEN a.observed_at IS NULL OR a.observed_at<campus.money_now()-interval '5 minutes' THEN 'capability_refresh_required' WHEN campus.money_cash_headroom(o.environment_id,NULL)<p.net_cents OR campus.money_cash_headroom(o.environment_id,cp.lot_id)<p.net_cents THEN 'waiting_available_cash' ELSE 'ready' END;
   members:=members||jsonb_build_array(item||jsonb_build_object('releaseState',state,'transferStatus',coalesce(op.status,'not_created'),'transferCapability',CASE WHEN campus.actor()=cp.member_id THEN coalesce(a.transfer_capability,'unknown') END));
  END LOOP;
  result:=result||jsonb_build_object('payees',members);
 END IF;
 IF canquote AND campus.actor()=payer THEN actions:=actions||'"request_quote"'::jsonb;reasons:=reasons-'funding_not_established';END IF;
 RETURN result||jsonb_build_object('allowedActions',actions,'blockedReasons',(SELECT coalesce(jsonb_agg(DISTINCT v),'[]'::jsonb) FROM jsonb_array_elements(reasons) v),'heldCents',held::text,'heldCentsMeaning','verified_available_cash_under_active_holds_excluding_outbound_reservations');
END $$;
REVOKE ALL ON FUNCTION campus.money_projection(text,uuid) FROM PUBLIC,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_projection(text,uuid) TO campus_app;

-- Verified original collection observations have explicit typed origins and J1/J2/J3
-- links. A changed provider snapshot remains a separate immutable observation; it
-- cannot authorize a new fee delta or replace an earlier journal.
ALTER TABLE campus.payment_attempts ADD CONSTRAINT attempt_origin_key UNIQUE(id,environment_id,obligation_id,operation_id);
ALTER TABLE campus.funding_lots ADD CONSTRAINT lot_origin_key UNIQUE(id,environment_id,obligation_id);
ALTER TABLE campus.ledger_journals ADD CONSTRAINT journal_lot_key UNIQUE(id,environment_id,lot_id);
CREATE TABLE campus.payment_receipt_facts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL,obligation_id uuid NOT NULL,lot_id uuid NOT NULL,
 attempt_id uuid NOT NULL,operation_id uuid NOT NULL,session_id text NOT NULL,intent_id text NOT NULL,charge_id text NOT NULL,
 fact_digest text NOT NULL,source_digest text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),
 observed_fee_cents bigint CHECK(observed_fee_cents>=0),fee_fact_id text,available_cents bigint,
 disposition text NOT NULL CHECK(disposition IN('allocated','fee_conflict','suspense','extra_receipt')),
 receipt_journal_id uuid NOT NULL,fee_journal_id uuid,fee_recovery_journal_id uuid,
 fee_zero_omitted boolean NOT NULL,recovery_zero_omitted boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT campus.money_now(),UNIQUE(attempt_id,fact_digest),
 CHECK(NOT fee_zero_omitted OR (observed_fee_cents=0 AND fee_journal_id IS NULL)),
 CHECK(NOT recovery_zero_omitted OR (observed_fee_cents=0 AND fee_recovery_journal_id IS NULL AND disposition='allocated')),
 FOREIGN KEY(attempt_id,environment_id,obligation_id,operation_id) REFERENCES campus.payment_attempts(id,environment_id,obligation_id,operation_id),
 FOREIGN KEY(lot_id,environment_id,obligation_id) REFERENCES campus.funding_lots(id,environment_id,obligation_id),
 FOREIGN KEY(receipt_journal_id,environment_id,lot_id) REFERENCES campus.ledger_journals(id,environment_id,lot_id),
 FOREIGN KEY(fee_journal_id,environment_id,lot_id) REFERENCES campus.ledger_journals(id,environment_id,lot_id),
 FOREIGN KEY(fee_recovery_journal_id,environment_id,lot_id) REFERENCES campus.ledger_journals(id,environment_id,lot_id)
);
ALTER TABLE campus.payment_receipt_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_receipt_facts FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_receipt_facts FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE TRIGGER money_effect AFTER INSERT ON campus.payment_receipt_facts FOR EACH ROW EXECUTE FUNCTION campus.money_capture_effect();
ALTER FUNCTION campus.money_record_receipt(uuid,jsonb) RENAME TO money_record_receipt_core;
REVOKE ALL ON FUNCTION campus.money_record_receipt_core(uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_record_receipt(aid uuid,fact jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;a campus.payment_attempts;o campus.funding_obligations;l campus.funding_lots;f campus.funding_allocations;
 disposition_value text;receipt uuid;fee uuid;recovery uuid;actual bigint;fee_effect text;fingerprint text;prior campus.payment_receipt_facts;
BEGIN
 result:=campus.money_record_receipt_core(aid,fact);
 IF result->>'reason'='provider_fact_mismatch' THEN RETURN result;END IF;
 SELECT * INTO a FROM campus.payment_attempts WHERE id=aid;SELECT * INTO o FROM campus.funding_obligations WHERE id=a.obligation_id;
 SELECT * INTO l FROM campus.funding_lots WHERE obligation_id=o.id;SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=l.id;
 actual:=(fact->>'actualFeeCents')::bigint;
 fingerprint:=encode(sha256(convert_to(campus.transaction_canonical(fact),'UTF8')),'hex');
 IF EXISTS(SELECT 1 FROM campus.payment_receipt_facts WHERE attempt_id=aid AND fact_digest=fingerprint) THEN RETURN result;END IF;
 IF f.charge_id=fact->>'chargeId' THEN
  receipt:=f.receipt_journal_id;disposition_value:=CASE WHEN actual IS NOT NULL AND (actual IS DISTINCT FROM f.actual_fee_cents OR fact->>'feeFactId' IS DISTINCT FROM f.fee_fact_id) THEN 'fee_conflict' ELSE 'allocated' END;
  IF disposition_value='allocated' THEN
   fee_effect:='fee:'||(fact->>'feeFactId');
   SELECT id INTO recovery FROM campus.ledger_journals WHERE environment_id=o.environment_id AND lot_id=l.id AND source_effect='fee_recovery:'||l.id::text;
  END IF;
 ELSE
  SELECT journal_id INTO receipt FROM campus.payment_unmatched_receipts WHERE environment_id=o.environment_id AND charge_id=fact->>'chargeId';
  disposition_value:=CASE WHEN f.charge_id IS NULL THEN 'suspense' ELSE 'extra_receipt' END;
  fee_effect:=CASE WHEN f.charge_id IS NULL THEN 'suspense_fee:' ELSE 'extra_fee:' END||(fact->>'feeFactId');
 END IF;
 SELECT id INTO fee FROM campus.ledger_journals WHERE environment_id=o.environment_id AND lot_id=l.id AND source_effect=fee_effect;
 SELECT * INTO prior FROM campus.payment_receipt_facts WHERE environment_id=o.environment_id AND charge_id=fact->>'chargeId' AND observed_fee_cents IS NOT NULL ORDER BY recorded_at LIMIT 1;
 IF prior.id IS NOT NULL AND actual IS NOT NULL AND (actual IS DISTINCT FROM prior.observed_fee_cents OR fact->>'feeFactId' IS DISTINCT FROM prior.fee_fact_id) THEN
  disposition_value:='fee_conflict';fee:=NULL;recovery:=NULL;PERFORM campus.money_hold(o.id,'fee_fact_changed','fee_changed:'||(fact->>'feeFactId'),jsonb_build_object('actual',actual));
 END IF;
 INSERT INTO campus.payment_receipt_facts(environment_id,obligation_id,lot_id,attempt_id,operation_id,session_id,intent_id,charge_id,fact_digest,source_digest,amount_cents,observed_fee_cents,fee_fact_id,available_cents,disposition,receipt_journal_id,fee_journal_id,fee_recovery_journal_id,fee_zero_omitted,recovery_zero_omitted)
 VALUES(o.environment_id,o.id,l.id,aid,a.operation_id,fact->>'sessionId',fact->>'intentId',fact->>'chargeId',fingerprint,o.source_digest,o.amount_cents,actual,fact->>'feeFactId',(fact->>'availableCents')::bigint,disposition_value,receipt,fee,recovery,coalesce(actual=0 AND disposition_value<>'fee_conflict',false),coalesce(actual=0 AND disposition_value='allocated' AND f.fee_state='matched',false));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION campus.money_record_receipt(uuid,jsonb) FROM PUBLIC,campus_app,campus_auth;
GRANT EXECUTE ON FUNCTION campus.money_record_receipt(uuid,jsonb) TO campus_worker;
-- Durable authenticated ingress linkage is separate from the semantic receipt fact,
-- so repeated notifications do not create additional money effects.
ALTER TABLE campus.provider_inbox ADD CONSTRAINT inbox_environment_key UNIQUE(id,environment_id);
ALTER TABLE campus.payment_receipt_facts ADD CONSTRAINT receipt_observation_key UNIQUE(id,environment_id,attempt_id,operation_id);
CREATE TABLE campus.payment_receipt_observations (
 inbox_id uuid NOT NULL,receipt_fact_id uuid NOT NULL,environment_id uuid NOT NULL,attempt_id uuid NOT NULL,operation_id uuid NOT NULL,
 PRIMARY KEY(inbox_id,receipt_fact_id),
 FOREIGN KEY(inbox_id,environment_id) REFERENCES campus.provider_inbox(id,environment_id),
 FOREIGN KEY(receipt_fact_id,environment_id,attempt_id,operation_id) REFERENCES campus.payment_receipt_facts(id,environment_id,attempt_id,operation_id)
);
ALTER TABLE campus.payment_receipt_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_receipt_observations FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_receipt_observations FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE TRIGGER money_effect AFTER INSERT ON campus.payment_receipt_observations FOR EACH ROW EXECUTE FUNCTION campus.money_capture_effect();
CREATE FUNCTION campus.money_record_inbox_receipt(aid uuid,fact jsonb,inbox_uuid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;i campus.provider_inbox;a campus.payment_attempts;
BEGIN
 SELECT * INTO a FROM campus.payment_attempts WHERE id=aid;SELECT * INTO i FROM campus.provider_inbox WHERE id=inbox_uuid;
 IF i.environment_id IS DISTINCT FROM a.environment_id OR i.parser IS DISTINCT FROM 'snapshot' OR i.origin_account IS DISTINCT FROM (SELECT platform_account_id FROM campus.payment_environments WHERE id=a.environment_id) OR NOT coalesce(((i.event_type LIKE 'checkout.session.%' AND i.payload#>>'{data,object,id}'=fact->>'sessionId') OR (i.event_type LIKE 'payment_intent.%' AND i.payload#>>'{data,object,id}'=fact->>'intentId') OR (i.event_type='charge.updated' AND i.payload#>>'{data,object,id}'=fact->>'chargeId')),false) THEN RAISE EXCEPTION 'provider_scope_mismatch' USING ERRCODE='P0001';END IF;
 result:=campus.money_record_receipt(aid,fact);
 INSERT INTO campus.payment_receipt_observations SELECT inbox_uuid,r.id,r.environment_id,r.attempt_id,r.operation_id FROM campus.payment_receipt_facts r WHERE r.attempt_id=aid AND r.fact_digest=encode(sha256(convert_to(campus.transaction_canonical(fact),'UTF8')),'hex') ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION campus.money_record_inbox_receipt(uuid,jsonb,uuid) FROM PUBLIC,campus_app,campus_auth;
GRANT EXECUTE ON FUNCTION campus.money_record_inbox_receipt(uuid,jsonb,uuid) TO campus_worker;

-- Fix1 I7: shared work authority, additive to immutable017. A pending amendment
-- alone is not a hold. Legacy unknown coverage retains its established behavior.
ALTER FUNCTION campus.lock_work_agreement(uuid,text) RENAME TO lock_work_agreement_before_money;
CREATE FUNCTION campus.lock_work_agreement(agreement_uuid uuid,operation text) RETURNS campus.agreements
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.agreements;
BEGIN
 a:=campus.lock_work_agreement_before_money(agreement_uuid,operation);
 IF EXISTS(SELECT 1 FROM campus.funding_obligations o JOIN campus.funding_lots l ON l.obligation_id=o.id JOIN campus.funding_allocations f ON f.lot_id=l.id JOIN campus.money_active_holds h ON h.obligation_id=o.id AND h.active WHERE o.agreement_id=agreement_uuid) THEN RAISE EXCEPTION 'funds_held' USING ERRCODE='P0001';END IF;
 RETURN a;
END $$;
REVOKE ALL ON FUNCTION campus.lock_work_agreement(uuid,text),campus.lock_work_agreement_before_money(uuid,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;

-- Fix1 I8: receipt identity does not imply a funding allocation or entitlement.
ALTER TABLE campus.payment_receipt_facts ADD CONSTRAINT receipt_lot_key UNIQUE(id,environment_id,lot_id);
ALTER TABLE campus.payment_network_balance_facts ADD COLUMN receipt_fact_id uuid NOT NULL;
ALTER TABLE campus.payment_network_balance_facts ADD FOREIGN KEY(receipt_fact_id,environment_id,lot_id) REFERENCES campus.payment_receipt_facts(id,environment_id,lot_id);
ALTER TABLE campus.payment_external_balance_facts ADD COLUMN receipt_fact_id uuid NOT NULL;
ALTER TABLE campus.payment_external_balance_facts ADD FOREIGN KEY(receipt_fact_id,environment_id,lot_id) REFERENCES campus.payment_receipt_facts(id,environment_id,lot_id);
CREATE FUNCTION campus.money_receipt_source(eid uuid,chargeid text) RETURNS TABLE(receipt_fact_id uuid,lot_id uuid,obligation_id uuid,attempt_id uuid,charge_id text,amount_cents bigint,intent_id text,session_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT r.id,r.lot_id,r.obligation_id,r.attempt_id,r.charge_id,r.amount_cents,r.intent_id,r.session_id FROM campus.payment_receipt_facts r WHERE r.environment_id=eid AND r.charge_id=chargeid ORDER BY r.recorded_at,r.id LIMIT 1
$$;
CREATE FUNCTION campus.money_find_receipt(eid uuid,chargeid text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT to_jsonb(r)||jsonb_build_object('environmentId',eid,'chargeId',r.charge_id,'amountCents',r.amount_cents,'intentId',r.intent_id,'mode',e.mode) FROM campus.money_receipt_source(eid,chargeid) r JOIN campus.payment_environments e ON e.id=eid
$$;
REVOKE ALL ON FUNCTION campus.money_receipt_source(uuid,text),campus.money_find_receipt(uuid,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_find_receipt(uuid,text) TO campus_worker;

-- Fix1: durable read-only reconciliation. Claims never acquire financial locks;
-- each factual callback obtains its one aggregate before the environment mutex.
CREATE TABLE campus.payment_reconciliation_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 kind text NOT NULL CHECK(kind IN('attempt','compensation','external_refund','external_reversal','dispute')),
 resource_key text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','leased','done','dead_letter')),
 available_at timestamptz NOT NULL DEFAULT campus.money_now(),lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,
 observations integer NOT NULL DEFAULT 0,failures integer NOT NULL DEFAULT 0,last_code text,created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(environment_id,kind,resource_key)
);
ALTER TABLE campus.payment_reconciliation_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_reconciliation_jobs FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_reconcile_schedule(eid uuid,k text,resource text,body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE old campus.payment_reconciliation_jobs;
BEGIN
 IF k='attempt' AND NOT EXISTS(SELECT 1 FROM campus.payment_attempts WHERE environment_id=eid AND session_id=resource) THEN RAISE EXCEPTION 'dependency_not_ready' USING ERRCODE='P0001';END IF;
 IF k='compensation' AND NOT EXISTS(SELECT 1 FROM campus.money_operations WHERE environment_id=eid AND id::text=resource AND kind IN('refund','reversal','fee_restitution') AND provider_id IS NOT NULL) THEN RAISE EXCEPTION 'dependency_not_ready' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.payment_reconciliation_jobs(environment_id,kind,resource_key,payload) VALUES(eid,k,resource,body) ON CONFLICT DO NOTHING;
 SELECT * INTO old FROM campus.payment_reconciliation_jobs WHERE environment_id=eid AND kind=k AND resource_key=resource FOR UPDATE;
 IF old.payload IS DISTINCT FROM body THEN RAISE EXCEPTION 'reconciliation_identity_conflict' USING ERRCODE='P0001';END IF;
 -- A new authenticated notification can reopen a completed observation. It cannot
 -- erase a retry budget or restart an already leased/dead-letter task.
 UPDATE campus.payment_reconciliation_jobs SET status='pending',available_at=campus.money_now() WHERE id=old.id AND status='done';
END $$;
CREATE FUNCTION campus.money_reconcile_claim(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE j campus.payment_reconciliation_jobs;
BEGIN
 SELECT * INTO j FROM campus.payment_reconciliation_jobs WHERE environment_id=eid AND status IN('pending','leased') AND available_at<=campus.money_now() AND (lease_until IS NULL OR lease_until<campus.money_now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE campus.payment_reconciliation_jobs SET status='leased',fence=fence+1,lease_until=campus.money_now()+interval '30 seconds',observations=observations+1 WHERE id=j.id RETURNING * INTO j;
 RETURN to_jsonb(j);
END $$;
CREATE FUNCTION campus.money_reconcile_finish(jid uuid,token bigint,code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 UPDATE campus.payment_reconciliation_jobs SET failures=failures+CASE WHEN code IN('done','pending') THEN 0 ELSE 1 END,
 status=CASE WHEN code='done' THEN 'done' WHEN (code<>'pending' AND failures>=7) OR observations>=1024 OR created_at<campus.money_now()-interval '14 days' THEN 'dead_letter' ELSE 'pending' END,
 last_code=code,lease_until=NULL,available_at=campus.money_now()+make_interval(secs=>CASE WHEN code='pending' THEN least(3600,30*greatest(observations,1)) ELSE least(3600,2^least(failures+1,10))::integer END)
 WHERE id=jid AND fence=token AND lease_until>=campus.money_now();RETURN FOUND;
END $$;
CREATE FUNCTION campus.money_attempt_observe(aid uuid,observed text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.payment_attempts;
BEGIN
 SELECT * INTO a FROM campus.payment_attempts WHERE id=aid;PERFORM campus.money_lock_aggregate(a.obligation_id);
 IF observed NOT IN('requires_action','processing') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 UPDATE campus.payment_attempts SET status=observed WHERE id=aid AND status NOT IN('succeeded','canceled','failed') AND (status<>'processing' OR observed='processing');
 PERFORM campus.money_reconcile_schedule(a.environment_id,'attempt',a.session_id,'{}'::jsonb);
END $$;
ALTER FUNCTION campus.money_operation_result(uuid,bigint,jsonb) RENAME TO money_operation_result_before_recovery;
CREATE FUNCTION campus.money_operation_result(opid uuid,token bigint,outcome jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result boolean;op campus.money_operations;a campus.payment_attempts;o campus.funding_obligations;
BEGIN
 IF outcome->>'status'='failed_no_effect' THEN
  SELECT * INTO op FROM campus.money_operations WHERE id=opid;
  PERFORM campus.money_lock_aggregate(op.obligation_id);PERFORM campus.money_cash_lock(op.environment_id);
  SELECT * INTO op FROM campus.money_operations WHERE id=opid FOR UPDATE;
  IF op.kind<>'checkout' OR op.status<>'dispatching' OR op.fence<>token OR token<>1 OR op.provider_id IS NOT NULL OR op.lease_until<campus.money_now() OR (SELECT attempts FROM campus.payment_outbox WHERE operation_id=opid)<>1 THEN RETURN false;END IF;
  UPDATE campus.money_operations SET status='failed',lease_until=NULL,result=outcome WHERE id=opid;
  UPDATE campus.payment_attempts SET status='failed',hosted_url=NULL WHERE operation_id=opid AND session_id IS NULL;
  UPDATE campus.payment_outbox SET dead_letter=true,last_code='definitive_no_effect' WHERE operation_id=opid;
  INSERT INTO campus.payment_events(environment_id,operation_id,kind,detail) VALUES(op.environment_id,opid,'dispatch_observation',outcome);
  SELECT * INTO o FROM campus.funding_obligations WHERE id=op.obligation_id;
  IF EXISTS(SELECT 1 FROM campus.order_payment_state WHERE order_id=o.order_id AND resolution IN('cancellation_requested','expiry_resolving')) THEN
   PERFORM campus.money_resolve_cancellation(o.order_id,(SELECT requested_terminal FROM campus.order_payment_state WHERE order_id=o.order_id));
  END IF;RETURN true;
 END IF;
 result:=campus.money_operation_result_before_recovery(opid,token,outcome);
 SELECT * INTO op FROM campus.money_operations WHERE id=opid;
 IF result AND op.kind='checkout' AND op.status='succeeded' THEN
  PERFORM campus.money_reconcile_schedule(op.environment_id,'attempt',op.provider_id,'{}'::jsonb);
  SELECT * INTO o FROM campus.funding_obligations WHERE id=op.obligation_id;
  IF EXISTS(SELECT 1 FROM campus.order_payment_state WHERE order_id=o.order_id AND resolution IN('cancellation_requested','expiry_resolving')) THEN
   SELECT * INTO a FROM campus.payment_attempts WHERE operation_id=op.id;
   PERFORM campus.money_enqueue(op.environment_id,op.obligation_id,'expire',a.id::text,jsonb_build_object('sessionId',a.session_id,'attemptId',a.id));
  END IF;
 END IF;RETURN result;
END $$;
CREATE FUNCTION campus.money_expiry_targets(eid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM (SELECT x.id FROM campus.orders x JOIN campus.funding_obligations o ON o.order_id=x.id WHERE o.environment_id=eid AND x.state='pending_payment' AND x.reserved_until<=campus.money_now() ORDER BY x.reserved_until,x.id LIMIT 16) s
$$;
CREATE FUNCTION campus.money_expire_order(eid uuid,oid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 PERFORM 1 FROM campus.orders x JOIN campus.funding_obligations o ON o.order_id=x.id WHERE x.id=oid AND o.environment_id=eid AND x.state='pending_payment' AND x.reserved_until<=campus.money_now() FOR UPDATE OF x;
 IF FOUND THEN PERFORM campus.money_resolve_cancellation(oid,'expired');END IF;
END $$;
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN('money_reconcile_schedule','money_reconcile_claim','money_reconcile_finish','money_attempt_observe','money_operation_result','money_operation_result_before_recovery','money_expiry_targets','money_expire_order') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);END LOOP;END $$;
GRANT EXECUTE ON FUNCTION campus.money_reconcile_schedule(uuid,text,text,jsonb),campus.money_reconcile_claim(uuid),campus.money_reconcile_finish(uuid,bigint,text),campus.money_attempt_observe(uuid,text),campus.money_operation_result(uuid,bigint,jsonb),campus.money_expiry_targets(uuid),campus.money_expire_order(uuid,uuid) TO campus_worker;

-- Fix1 fee authority: immutable prepayment sidecar. No changes to signed018.
CREATE TABLE campus.payment_fee_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 aggregate_type text NOT NULL CHECK(aggregate_type IN('agreement','order')),aggregate_id uuid NOT NULL,
 policy_id uuid NOT NULL,source_digest text NOT NULL,body jsonb NOT NULL,digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(id,environment_id),UNIQUE(environment_id,aggregate_type,aggregate_id,policy_id,source_digest),
 FOREIGN KEY(policy_id,environment_id,aggregate_type,aggregate_id) REFERENCES campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id)
);
CREATE TABLE campus.payment_fee_confirmations (
 plan_id uuid NOT NULL REFERENCES campus.payment_fee_plans,user_id uuid NOT NULL REFERENCES campus.users,digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT campus.money_now(),PRIMARY KEY(plan_id,user_id)
);
CREATE TABLE campus.payment_fee_plan_bindings (
 obligation_id uuid PRIMARY KEY REFERENCES campus.funding_obligations,plan_id uuid NOT NULL REFERENCES campus.payment_fee_plans
);
CREATE TABLE campus.payment_billing_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 version integer NOT NULL CHECK(version>0),platform_account_id text NOT NULL,billing_mode text NOT NULL CHECK(billing_mode IN('unknown','inline','standalone')),
 contract jsonb NOT NULL,provenance text NOT NULL,UNIQUE(environment_id,version),
 FOREIGN KEY(environment_id,platform_account_id) REFERENCES campus.payment_environments(id,platform_account_id)
);
CREATE FUNCTION campus.money_billing_profile_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF NEW.contract->>'kind'='stripe_standard_inline_charge_balance_v1' AND (NEW.billing_mode<>'inline' OR NEW.contract->>'pricingModel' IS DISTINCT FROM 'standard_non_ic_plus' OR NEW.contract->>'source' IS DISTINCT FROM 'https://docs.stripe.com/expand/use-cases' OR coalesce(NEW.contract->>'accountEvidenceDigest','')!~'^[a-f0-9]{64}$' OR coalesce(NEW.contract->>'accountEvidenceRef','')='' OR NEW.provenance LIKE 'Synthetic:%') THEN RAISE EXCEPTION 'billing_profile_evidence_required' USING ERRCODE='P0001';END IF;
 IF NEW.contract->>'kind' LIKE 'synthetic_%' AND ((SELECT mode FROM campus.payment_environments WHERE id=NEW.environment_id)<>'sandbox' OR NEW.provenance NOT LIKE 'Synthetic:%') THEN RAISE EXCEPTION 'synthetic_profile_scope_mismatch' USING ERRCODE='P0001';END IF;RETURN NEW;
END $$;
CREATE TRIGGER billing_profile_scope BEFORE INSERT ON campus.payment_billing_profiles FOR EACH ROW EXECUTE FUNCTION campus.money_billing_profile_guard();
CREATE FUNCTION campus.money_inline_closed(eid uuid,aid uuid,fact jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT coalesce((SELECT p.billing_mode='inline' AND ((p.contract->>'kind'='synthetic_original_charge_balance_v1' AND e.mode='sandbox' AND p.provenance LIKE 'Synthetic:%') OR (p.contract->>'kind'='stripe_standard_inline_charge_balance_v1' AND p.contract->>'pricingModel'='standard_non_ic_plus' AND p.contract->>'source'='https://docs.stripe.com/expand/use-cases' AND p.provenance NOT LIKE 'Synthetic:%' AND p.contract->>'accountEvidenceDigest' ~ '^[a-f0-9]{64}$' AND coalesce(p.contract->>'accountEvidenceRef','')<>'')) AND fact->>'processingFeeSource'='succeeded_captured_original_charge_balance_v1' AND p.platform_account_id=fact->>'platformAccountId' AND (fact->>'environmentId')::uuid=eid AND EXISTS(SELECT 1 FROM campus.payment_attempts WHERE id=aid AND environment_id=eid) AND coalesce(fact->>'feeFactId','')<>'' FROM campus.payment_billing_profiles p JOIN campus.payment_environments e ON e.id=p.environment_id WHERE p.environment_id=eid ORDER BY p.version DESC LIMIT 1),false)
$$;
-- Same confirmed member weights, same exact gross/stage identities; only fee amount changes.
CREATE FUNCTION campus.money_reprice_plan(original jsonb,fee bigint) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb:=original;lot jsonb:=original->'lots'->0;members jsonb:=original->'members';weights bigint[];keys text[];memberfees bigint[];gross bigint[];stagekeys text[];fees bigint[];components jsonb:='[]';rows jsonb;mi integer;si integer;item jsonb;
BEGIN
 IF jsonb_array_length(original->'lots')<>1 OR fee<0 OR fee>100000000 THEN RAISE EXCEPTION 'invalid_fee_plan' USING ERRCODE='P0001';END IF;
 SELECT array_agg((v->>'units')::bigint ORDER BY v->>'memberId'),array_agg(v->>'memberId' ORDER BY v->>'memberId') INTO weights,keys FROM jsonb_array_elements(members) v;
 memberfees:=campus.transaction_lr(fee/2,weights,keys);
 FOR mi IN 1..cardinality(keys) LOOP
  SELECT jsonb_agg(v ORDER BY (v->>'stagePosition')::int,v->>'milestoneId'),array_agg((v->>'grossCents')::bigint ORDER BY (v->>'stagePosition')::int,v->>'milestoneId'),array_agg(lpad(v->>'stagePosition',10,'0')||':'||(v->>'milestoneId') ORDER BY (v->>'stagePosition')::int,v->>'milestoneId') INTO rows,gross,stagekeys FROM jsonb_array_elements(lot->'components') v WHERE v->>'memberId'=keys[mi];
  fees:=campus.transaction_lr(memberfees[mi],gross,stagekeys);
  FOR si IN 1..cardinality(gross) LOOP
   IF fees[si]>gross[si] THEN RAISE EXCEPTION 'fee_exceeds_component' USING ERRCODE='P0001';END IF;
   item:=rows->(si-1);components:=components||jsonb_build_array(item||jsonb_build_object('recipientFeeCents',fees[si],'netCents',gross[si]-fees[si]));
  END LOOP;
 END LOOP;
 lot:=lot||jsonb_build_object('estimatedProcessorFeeCents',fee,'publisherProcessorFeeCents',(fee+1)/2,'recipientProcessorFeeCents',fee/2,'chargeTotalCents',(lot->>'principalCents')::bigint+(fee+1)/2,'components',components);
 result:=(result-'digest')||jsonb_build_object('lots',jsonb_build_array(lot));RETURN result||jsonb_build_object('digest',encode(sha256(convert_to(campus.transaction_canonical(result),'UTF8')),'hex'));
END $$;
CREATE FUNCTION campus.money_fee_context(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_execution_policies;t campus.agreement_transaction_terms;g campus.agreements;x campus.orders;eid uuid;source text;plan jsonb;people jsonb;payer uuid;fee bigint;
BEGIN
 PERFORM campus.money_projection(kind,resource);eid:=campus.money_environment();
 SELECT * INTO p FROM campus.payment_execution_policies WHERE environment_id=eid AND aggregate_type=kind AND aggregate_id=resource AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1;
 IF p.id IS NULL OR p.payload->>'feeAdjustment' IS DISTINCT FROM 'capped_actual_v1' OR p.digest IS DISTINCT FROM encode(sha256(convert_to(campus.transaction_canonical(p.payload),'UTF8')),'hex') THEN RAISE EXCEPTION 'fee_cap_policy_unavailable' USING ERRCODE='P0001';END IF;
 IF kind='agreement' THEN
  SELECT * INTO g FROM campus.agreements WHERE id=resource;payer:=g.owner_id;
  SELECT tt.* INTO t FROM campus.agreement_transaction_terms tt JOIN campus.agreement_transaction_bindings b ON b.transaction_terms_id=tt.id JOIN campus.agreement_terms_state st ON st.agreement_id=b.agreement_id AND st.effective_terms_id=b.terms_id WHERE b.agreement_id=resource;
  IF t.id IS NULL OR p.payload->>'signedPolicyId' IS DISTINCT FROM t.policy_id::text OR NOT campus.transaction_policy_disclosure_valid(t.policy_snapshot->'payload') THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';END IF;
  source:=t.digest;plan:=t.plan;
  SELECT jsonb_agg(id ORDER BY id) INTO people FROM (SELECT payer AS id UNION SELECT (v->>'memberId')::uuid FROM jsonb_array_elements(plan->'members')v) u;
 ELSE
  SELECT * INTO x FROM campus.orders WHERE id=resource;payer:=x.buyer_id;source:=campus.money_order_terms(resource);
  IF p.payload->>'orderTermsDigest' IS DISTINCT FROM source OR NOT campus.transaction_policy_disclosure_valid(p.payload) THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';END IF;
  fee:=(p.payload->>'estimatedProcessorFeeCents')::bigint;
  IF fee IS NULL OR fee<0 THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';END IF;
  plan:=jsonb_build_object('calculationVersion','charge_member_stage_v1','currency','USD','platformServiceFeeCents',0,'roundingRule','largest_remainder_uuid_stage;odd_fee_cent_publisher','members',jsonb_build_array(jsonb_build_object('memberId',x.seller_id,'units',10000)),'lots',jsonb_build_array(jsonb_build_object('fundingPlanLotId',resource,'principalCents',x.total_cents,'components',jsonb_build_array(jsonb_build_object('memberId',x.seller_id,'milestoneId','goods','stagePosition',1,'grossCents',x.total_cents)))));
  plan:=campus.money_reprice_plan(plan,fee);people:=jsonb_build_array(x.buyer_id,x.seller_id);
 END IF;
 RETURN jsonb_build_object('environmentId',eid,'aggregateType',kind,'aggregateId',resource,'policyId',p.id,'policyDigest',p.digest,'policyVersion',p.version,'policyProvenance',p.provenance,'sourceDigest',source,'payerId',payer,'participants',people,'originalPlan',plan);
END $$;
CREATE FUNCTION campus.money_fee_plan_propose(kind text,resource uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE context jsonb;body jsonb;plan campus.payment_fee_plans;fee bigint;maximum bigint;
BEGIN
 IF kind='agreement' THEN PERFORM 1 FROM campus.agreements WHERE id=resource FOR UPDATE;ELSE PERFORM 1 FROM campus.orders WHERE id=resource FOR UPDATE;END IF;
 context:=campus.money_fee_context(kind,resource);
 IF campus.actor()::text IS DISTINCT FROM context->>'payerId' THEN RAISE EXCEPTION 'not_payer' USING ERRCODE='P0001';END IF;
 IF request->>'policyVersionId' IS DISTINCT FROM context->>'policyId' OR request->>'policyDigest' IS DISTINCT FROM context->>'policyDigest' OR request->>'sourceDigest' IS DISTINCT FROM context->>'sourceDigest' THEN RAISE EXCEPTION 'terms_refresh_required' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.funding_obligations WHERE aggregate_type=kind AND aggregate_id=resource) THEN RAISE EXCEPTION 'fee_plan_payment_already_started' USING ERRCODE='P0001';END IF;
 fee:=(context->'originalPlan'->'lots'->0->>'estimatedProcessorFeeCents')::bigint;maximum:=fee+least(100,(fee+9)/10);
 body:=context||jsonb_build_object('format','capped_actual_fee_plan_v1','currency','USD','estimatedFeeCents',fee,'additionalFeeCapCents',maximum-fee,'maximumFeeCents',maximum,'estimatedPayerFeeCents',(fee+1)/2,'maximumPayerFeeCents',(maximum+1)/2,'estimatedRecipientFeeCents',fee/2,'maximumRecipientFeeCents',maximum/2,'maximumPlan',campus.money_reprice_plan(context->'originalPlan',maximum),'restoration','Unused payer fee reserve is owed back to this original charge through a separately tracked refund; unused recipient reserve remains in that exact recipient gross. Actual total fees split 50/50, odd cent to payer. Above the cap, release pauses and new exact fee terms require personal confirmation. No general refund or tax authority is added.','platformServiceFeeCents',0);
 INSERT INTO campus.payment_fee_plans(environment_id,aggregate_type,aggregate_id,policy_id,source_digest,body,digest) VALUES((context->>'environmentId')::uuid,kind,resource,(context->>'policyId')::uuid,context->>'sourceDigest',body,encode(sha256(convert_to(campus.transaction_canonical(body),'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 SELECT * INTO plan FROM campus.payment_fee_plans WHERE environment_id=(context->>'environmentId')::uuid AND aggregate_type=kind AND aggregate_id=resource AND policy_id=(context->>'policyId')::uuid AND source_digest=context->>'sourceDigest';
 RETURN jsonb_build_object('planId',plan.id,'digest',plan.digest);
END $$;
CREATE FUNCTION campus.money_fee_plan_read(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE context jsonb;plan campus.payment_fee_plans;confirmed jsonb;
BEGIN
 context:=campus.money_fee_context(kind,resource);
 SELECT * INTO plan FROM campus.payment_fee_plans WHERE environment_id=(context->>'environmentId')::uuid AND aggregate_type=kind AND aggregate_id=resource AND policy_id=(context->>'policyId')::uuid AND source_digest=context->>'sourceDigest';
 SELECT coalesce(jsonb_agg(user_id ORDER BY user_id),'[]'::jsonb) INTO confirmed FROM campus.payment_fee_confirmations WHERE plan_id=plan.id AND digest=plan.digest;
 RETURN jsonb_build_object('context',context,'planId',plan.id,'digest',plan.digest,'plan',plan.body,'confirmedParticipantIds',confirmed,'allowedActions',CASE WHEN plan.id IS NULL AND context->>'payerId'=campus.actor()::text AND NOT EXISTS(SELECT 1 FROM campus.funding_obligations WHERE aggregate_type=kind AND aggregate_id=resource) THEN jsonb_build_array('propose_fee_plan') WHEN plan.id IS NOT NULL AND NOT confirmed ? campus.actor()::text AND context->'participants' ? campus.actor()::text THEN jsonb_build_array('confirm_fee_plan') WHEN plan.id IS NOT NULL AND (SELECT count(*) FROM jsonb_array_elements(confirmed))=jsonb_array_length(context->'participants') AND context->>'payerId'=campus.actor()::text THEN jsonb_build_array('request_quote') ELSE '[]'::jsonb END);
END $$;
CREATE FUNCTION campus.money_fee_plan_confirm(pid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE plan campus.payment_fee_plans;context jsonb;
BEGIN
 SELECT * INTO plan FROM campus.payment_fee_plans WHERE id=pid;IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF plan.aggregate_type='agreement' THEN PERFORM 1 FROM campus.agreements WHERE id=plan.aggregate_id FOR UPDATE;ELSE PERFORM 1 FROM campus.orders WHERE id=plan.aggregate_id FOR UPDATE;END IF;
 context:=campus.money_fee_context(plan.aggregate_type,plan.aggregate_id);
 IF NOT plan.body->'participants' ? campus.actor()::text THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF request->>'digest' IS DISTINCT FROM plan.digest OR context->>'policyId' IS DISTINCT FROM plan.policy_id::text OR context->>'sourceDigest' IS DISTINCT FROM plan.source_digest OR context->'participants' IS DISTINCT FROM plan.body->'participants' THEN RAISE EXCEPTION 'terms_refresh_required' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM campus.funding_obligations WHERE aggregate_type=plan.aggregate_type AND aggregate_id=plan.aggregate_id) THEN RAISE EXCEPTION 'fee_plan_payment_already_started' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.payment_fee_confirmations(plan_id,user_id,digest) VALUES(pid,campus.actor(),plan.digest) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('planId',pid,'digest',plan.digest,'userId',campus.actor());
END $$;
CREATE FUNCTION campus.money_confirmed_fee_plan(eid uuid,kind text,resource uuid,policy uuid,source text) RETURNS campus.payment_fee_plans LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_fee_plans;
BEGIN
 SELECT * INTO p FROM campus.payment_fee_plans WHERE environment_id=eid AND aggregate_type=kind AND aggregate_id=resource AND policy_id=policy AND source_digest=source;
 IF p.id IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p.body->'participants') who WHERE NOT EXISTS(SELECT 1 FROM campus.payment_fee_confirmations c WHERE c.plan_id=p.id AND c.user_id=who::uuid AND c.digest=p.digest)) THEN RAISE EXCEPTION 'fee_plan_confirmation_required' USING ERRCODE='P0001';END IF;RETURN p;
END $$;
DO $$ DECLARE t text; p record;BEGIN
 FOREACH t IN ARRAY ARRAY['payment_fee_plans','payment_fee_confirmations','payment_fee_plan_bindings','payment_billing_profiles'] LOOP EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);END LOOP;
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN('money_billing_profile_guard','money_inline_closed','money_reprice_plan','money_fee_context','money_fee_plan_propose','money_fee_plan_read','money_fee_plan_confirm','money_confirmed_fee_plan') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION campus.money_fee_plan_propose(text,uuid,jsonb),campus.money_fee_plan_read(text,uuid),campus.money_fee_plan_confirm(uuid,jsonb) TO campus_app;
CREATE FUNCTION campus.money_fee_plan_current(pid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_fee_plans;
BEGIN SELECT * INTO p FROM campus.payment_fee_plans WHERE id=pid;IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;RETURN campus.money_fee_plan_read(p.aggregate_type,p.aggregate_id);END $$;
REVOKE ALL ON FUNCTION campus.money_fee_plan_current(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_fee_plan_current(uuid) TO campus_app;

CREATE TABLE campus.payment_fee_settlements (
 obligation_id uuid PRIMARY KEY REFERENCES campus.funding_obligations,plan_id uuid NOT NULL REFERENCES campus.payment_fee_plans,
 lot_id uuid NOT NULL REFERENCES campus.funding_lots,environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 charge_id text NOT NULL,actual_fee_cents bigint NOT NULL CHECK(actual_fee_cents>=0),payer_fee_cents bigint NOT NULL,recipient_fee_cents bigint NOT NULL,
 restitution_cents bigint NOT NULL CHECK(restitution_cents>=0),closure jsonb NOT NULL,actual_plan jsonb NOT NULL,journal_id uuid REFERENCES campus.ledger_journals,
 created_at timestamptz NOT NULL DEFAULT campus.money_now(),CHECK(payer_fee_cents=(actual_fee_cents+1)/2 AND recipient_fee_cents=actual_fee_cents/2)
);
CREATE TABLE campus.payment_fee_settlement_components (
 component_id uuid PRIMARY KEY REFERENCES campus.funding_component_plans,obligation_id uuid NOT NULL REFERENCES campus.payment_fee_settlements,
 recipient_fee_cents bigint NOT NULL CHECK(recipient_fee_cents>=0),net_cents bigint NOT NULL CHECK(net_cents>=0)
);
CREATE VIEW campus.money_effective_components AS
 SELECT c.id,c.lot_id,c.environment_id,c.allocation_component_id,c.member_id,c.milestone_id,c.stage_position,c.gross_cents,coalesce(s.recipient_fee_cents,c.recipient_fee_cents) AS recipient_fee_cents,coalesce(s.net_cents,c.net_cents) AS net_cents FROM campus.funding_component_plans c LEFT JOIN campus.payment_fee_settlement_components s ON s.component_id=c.id;
REVOKE ALL ON campus.money_effective_components FROM PUBLIC,campus_app,campus_auth,campus_worker;
ALTER TABLE campus.money_operations DROP CONSTRAINT money_operations_kind_check;
ALTER TABLE campus.money_operations ADD CHECK(kind IN('checkout','transfer','refund','reversal','expire','onboarding','recipient','fee_restitution'));
ALTER TABLE campus.money_reservations DROP CONSTRAINT money_reservations_kind_check;
ALTER TABLE campus.money_reservations ADD CHECK(kind IN('publisher_fee','recipient_fee','transfer','refund','reversal','fee_restitution'));
CREATE TABLE campus.payment_restitution_balance_facts (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,balance_id text NOT NULL,operation_id uuid NOT NULL REFERENCES campus.money_operations,lot_id uuid NOT NULL REFERENCES campus.funding_lots,
 object_id text NOT NULL,role text NOT NULL CHECK(role IN('original','failure')),amount_cents bigint NOT NULL,fee_cents bigint NOT NULL,net_cents bigint NOT NULL,available boolean NOT NULL,
 PRIMARY KEY(environment_id,balance_id),UNIQUE(operation_id,role),CHECK(net_cents=amount_cents-fee_cents)
);
CREATE FUNCTION campus.money_fee_settle(oid uuid,actual bigint,closure_value jsonb) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;f campus.funding_allocations;plan campus.payment_fee_plans;old campus.payment_fee_settlements;computed jsonb;entries jsonb:='[]';jid uuid;lid uuid;item jsonb;c campus.funding_component_plans;
BEGIN
 PERFORM campus.money_lock_aggregate(oid);SELECT * INTO o FROM campus.funding_obligations WHERE id=oid;PERFORM campus.money_cash_lock(o.environment_id);
 SELECT p.* INTO plan FROM campus.payment_fee_plans p JOIN campus.payment_fee_plan_bindings b ON b.plan_id=p.id WHERE b.obligation_id=oid;
 IF plan.id IS NULL THEN RETURN false;END IF;
 SELECT fa.* INTO f FROM campus.funding_allocations fa JOIN campus.funding_lots l ON l.id=fa.lot_id WHERE l.obligation_id=oid;
 IF f.lot_id IS NULL OR actual IS NULL THEN RETURN false;END IF;lid:=f.lot_id;
 IF EXISTS(SELECT 1 FROM campus.payment_fee_revision_settlements rs WHERE rs.obligation_id=oid AND rs.evidence=campus.money_fee_evidence(oid)) THEN UPDATE campus.funding_allocations SET fee_state='matched' WHERE lot_id=lid;RETURN true;END IF;
 SELECT * INTO old FROM campus.payment_fee_settlements WHERE obligation_id=oid;
 IF FOUND THEN
  IF old.actual_fee_cents<>actual OR old.closure IS DISTINCT FROM closure_value THEN PERFORM campus.money_hold(oid,'later_fee_correction','later_fee_correction:'||oid::text||':'||encode(sha256(convert_to(campus.transaction_canonical(closure_value),'UTF8')),'hex'),jsonb_build_object('previous',old.actual_fee_cents,'observed',actual,'history','unchanged'));END IF;
  RETURN true;
 END IF;
 IF actual>(plan.body->>'maximumFeeCents')::bigint THEN PERFORM campus.money_hold(oid,'fee_cap_reconfirmation_required','fee_cap:'||oid::text,jsonb_build_object('actual',actual,'maximum',plan.body->'maximumFeeCents'));UPDATE campus.funding_allocations SET fee_state='fee_variance_pending' WHERE lot_id=lid;RETURN false;END IF;
 computed:=campus.money_reprice_plan(plan.body->'originalPlan',actual);
 IF (actual+1)/2>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','publisher_fee_liability','debit',(actual+1)/2));END IF;
 IF actual/2>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','reward_liability','debit',actual/2));END IF;
 IF actual>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','fee_recovery','credit',actual));jid:=campus.money_journal(o.environment_id,lid,'capped_fee_recovery:'||oid::text,entries);END IF;
 INSERT INTO campus.payment_fee_settlements(obligation_id,plan_id,lot_id,environment_id,charge_id,actual_fee_cents,payer_fee_cents,recipient_fee_cents,restitution_cents,closure,actual_plan,journal_id) VALUES(oid,plan.id,lid,o.environment_id,f.charge_id,actual,(actual+1)/2,actual/2,o.publisher_fee_cents-(actual+1)/2,closure_value,computed,jid);
 FOR item IN SELECT value FROM jsonb_array_elements(computed->'lots'->0->'components') LOOP
  SELECT * INTO c FROM campus.funding_component_plans WHERE lot_id=lid AND member_id=(item->>'memberId')::uuid AND stage_position=(item->>'stagePosition')::int;
  IF c.id IS NULL OR c.gross_cents<>(item->>'grossCents')::bigint THEN RAISE EXCEPTION 'invalid_component_plan' USING ERRCODE='P0001';END IF;
  INSERT INTO campus.payment_fee_settlement_components VALUES(c.id,oid,(item->>'recipientFeeCents')::bigint,(item->>'netCents')::bigint);
 END LOOP;
 INSERT INTO campus.fee_consumptions SELECT r.id,o.environment_id,lid,'capped_settlement:'||oid::text,coalesce(jid,f.receipt_journal_id) FROM campus.money_reservations r WHERE r.lot_id=lid AND r.kind IN('publisher_fee','recipient_fee') ON CONFLICT DO NOTHING;
 UPDATE campus.money_reservations SET status='consumed' WHERE lot_id=lid AND kind IN('publisher_fee','recipient_fee');
 UPDATE campus.funding_allocations SET fee_state='matched' WHERE lot_id=lid;
 RETURN true;
END $$;
CREATE FUNCTION campus.money_fee_inline_settle(aid uuid,fact jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.payment_attempts;p campus.payment_billing_profiles;
BEGIN
 SELECT * INTO a FROM campus.payment_attempts WHERE id=aid;
 IF campus.money_inline_closed(a.environment_id,aid,fact) AND EXISTS(SELECT 1 FROM campus.funding_allocations WHERE attempt_id=aid AND actual_fee_cents=(fact->>'actualFeeCents')::bigint AND fee_fact_id=fact->>'feeFactId') THEN
  SELECT * INTO p FROM campus.payment_billing_profiles WHERE id=(SELECT profile_id FROM campus.payment_billing_bindings WHERE obligation_id=a.obligation_id);
  PERFORM campus.money_fee_settle(a.obligation_id,(fact->>'actualFeeCents')::bigint,jsonb_build_object('kind',p.contract->>'kind','profileId',p.id,'environmentId',a.environment_id,'platformAccountId',p.platform_account_id,'chargeId',fact->>'chargeId','originalBalanceTransactionId',fact->>'feeFactId','currentObservationOnly',true));
 END IF;
END $$;
ALTER FUNCTION campus.money_record_receipt(uuid,jsonb) RENAME TO money_record_receipt_before_capped;
CREATE FUNCTION campus.money_record_receipt(aid uuid,fact jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;
BEGIN result:=campus.money_record_receipt_before_capped(aid,fact);PERFORM campus.money_fee_inline_settle(aid,fact);RETURN result;END $$;
CREATE FUNCTION campus.money_prepare_restitution(eid uuid,oid uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE s campus.payment_fee_settlements;o campus.funding_obligations;op campus.money_operations;newid uuid;generation integer;
BEGIN
 PERFORM campus.money_lock_aggregate(oid);SELECT * INTO o FROM campus.funding_obligations WHERE id=oid AND environment_id=eid;IF NOT FOUND THEN RETURN 0;END IF;PERFORM campus.money_cash_lock(eid);
 SELECT * INTO s FROM campus.payment_fee_settlements WHERE obligation_id=oid AND restitution_cents>0;IF NOT FOUND THEN RETURN 0;END IF;
 SELECT * INTO op FROM campus.money_operations WHERE obligation_id=oid AND kind='fee_restitution' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF op.id IS NOT NULL AND (op.status<>'failed' OR NOT EXISTS(SELECT 1 FROM campus.money_reservations WHERE operation_id=op.id AND status='released')) THEN RETURN 0;END IF;
 IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=oid AND active) OR campus.money_cash_headroom(eid,NULL)<0 OR campus.money_cash_headroom(eid,s.lot_id)<0 THEN RETURN 0;END IF;
 generation:=coalesce((op.payload->>'generation')::int,0)+1;
 newid:=campus.money_enqueue(eid,oid,'fee_restitution',oid::text||':'||generation,jsonb_build_object('generation',generation,'feePlanId',s.plan_id,'feePlanDigest',(SELECT digest FROM campus.payment_fee_plans WHERE id=s.plan_id),'amountCents',s.restitution_cents,'currency','usd','sourceCharge',s.charge_id,'purpose','unused_preconsented_payer_fee_reserve','sourceDigest',o.source_digest));
 INSERT INTO campus.money_reservations(environment_id,lot_id,operation_id,kind,amount_cents) VALUES(eid,s.lot_id,newid,'fee_restitution',s.restitution_cents);RETURN 1;
END $$;
CREATE FUNCTION campus.money_restitution_fact(opid uuid,fact jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;r campus.money_reservations;s campus.payment_fee_settlements;b jsonb;old campus.payment_restitution_balance_facts;entries jsonb;original jsonb;failure jsonb;
BEGIN
 SELECT * INTO op FROM campus.money_operations WHERE id=opid AND kind='fee_restitution';IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM campus.money_lock_aggregate(op.obligation_id);PERFORM campus.money_cash_lock(op.environment_id);SELECT * INTO op FROM campus.money_operations WHERE id=opid FOR UPDATE;
 SELECT * INTO s FROM campus.payment_fee_settlements WHERE obligation_id=op.obligation_id;SELECT * INTO r FROM campus.money_reservations WHERE operation_id=opid FOR UPDATE;
 IF op.payload ? 'restitutionId' THEN SELECT rr.obligation_id,rr.charge_id,rr.amount_cents,l.id INTO s.obligation_id,s.charge_id,s.restitution_cents,s.lot_id FROM campus.payment_fee_revision_restitutions rr JOIN campus.funding_lots l ON l.obligation_id=rr.obligation_id WHERE rr.id=(op.payload->>'restitutionId')::uuid AND rr.obligation_id=op.obligation_id AND rr.environment_id=op.environment_id;IF s.obligation_id IS NULL THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;END IF;
 IF fact->>'environmentId' IS DISTINCT FROM op.environment_id::text OR fact->>'sourceCharge' IS DISTINCT FROM s.charge_id OR (fact->>'amountCents')::bigint IS DISTINCT FROM s.restitution_cents OR fact->>'currency' IS DISTINCT FROM 'usd' OR coalesce(fact->>'id','')='' OR (op.provider_id IS NOT NULL AND op.provider_id<>fact->>'id') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(fact->'balances') LOOP
  IF b->>'role' NOT IN('original','failure') OR (b->>'amountCents')::bigint IS DISTINCT FROM (CASE WHEN b->>'role'='original' THEN -s.restitution_cents ELSE s.restitution_cents END) OR (b->>'netCents')::bigint<>(b->>'amountCents')::bigint-(b->>'feeCents')::bigint THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  SELECT * INTO old FROM campus.payment_restitution_balance_facts WHERE environment_id=op.environment_id AND balance_id=b->>'id';
  IF FOUND THEN
   IF old.operation_id<>opid OR old.role<>b->>'role' OR old.object_id<>fact->>'id' OR old.amount_cents<>(b->>'amountCents')::bigint OR old.fee_cents<>(b->>'feeCents')::bigint OR old.net_cents<>(b->>'netCents')::bigint THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
   UPDATE campus.payment_restitution_balance_facts SET available=(b->>'available')::boolean WHERE environment_id=op.environment_id AND balance_id=old.balance_id;
  ELSE
   INSERT INTO campus.payment_restitution_balance_facts VALUES(op.environment_id,b->>'id',opid,s.lot_id,fact->>'id',b->>'role',(b->>'amountCents')::bigint,(b->>'feeCents')::bigint,(b->>'netCents')::bigint,(b->>'available')::boolean);
   entries:=jsonb_build_array(jsonb_build_object('account','network_exposure','debit',greatest(-(b->>'amountCents')::bigint,0),'credit',greatest((b->>'amountCents')::bigint,0)));
   IF (b->>'netCents')::bigint<>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','cash','debit',greatest((b->>'netCents')::bigint,0),'credit',greatest(-(b->>'netCents')::bigint,0)));END IF;
   IF (b->>'feeCents')::bigint<>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','fee_expense','debit',greatest((b->>'feeCents')::bigint,0),'credit',greatest(-(b->>'feeCents')::bigint,0)));PERFORM campus.money_hold(op.obligation_id,'restitution_fee_correction','restitution_fee:'||(b->>'id'),'{}');END IF;
   PERFORM campus.money_journal(op.environment_id,s.lot_id,'restitution_balance:'||(b->>'id'),entries);
  END IF;
  IF b->>'role'='original' THEN original:=b;ELSE failure:=b;END IF;
 END LOOP;
 UPDATE campus.money_operations SET provider_id=fact->>'id',result=fact WHERE id=opid;
 IF original IS NOT NULL THEN UPDATE campus.money_reservations SET cash_debited_cents=amount_cents WHERE id=r.id;END IF;
 IF r.status='released' THEN IF fact->>'status' NOT IN('failed','canceled') THEN PERFORM campus.money_hold(op.obligation_id,'restitution_terminal_conflict','restitution_terminal:'||opid::text,'{}');END IF;RETURN true;END IF;
 IF r.status='consumed' THEN IF fact->>'status'<>'succeeded' THEN PERFORM campus.money_hold(op.obligation_id,'restitution_terminal_conflict','restitution_terminal:'||opid::text,'{}');END IF;RETURN true;END IF;
 IF fact->>'status' IN('failed','canceled') AND original IS NOT NULL AND failure IS NOT NULL AND (failure->>'available')::boolean THEN UPDATE campus.money_reservations SET status='released' WHERE id=r.id;UPDATE campus.money_operations SET status='failed',lease_until=NULL WHERE id=opid;RETURN true;END IF;
 IF fact->>'status'<>'succeeded' OR original IS NULL THEN RETURN false;END IF;
 PERFORM campus.money_journal(op.environment_id,s.lot_id,'fee_restitution:'||coalesce(op.payload->>'restitutionId',op.obligation_id::text),jsonb_build_array(jsonb_build_object('account','publisher_fee_liability','debit',s.restitution_cents),jsonb_build_object('account','network_exposure','credit',s.restitution_cents)));
 UPDATE campus.money_reservations SET status='consumed' WHERE id=r.id;UPDATE campus.money_operations SET status='succeeded',lease_until=NULL WHERE id=opid;RETURN true;
END $$;
DO $$ DECLARE t text;p record;BEGIN
 FOREACH t IN ARRAY ARRAY['payment_fee_settlements','payment_fee_settlement_components','payment_restitution_balance_facts'] LOOP EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);IF t<>'payment_restitution_balance_facts' THEN EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);END IF;END LOOP;
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN('money_fee_settle','money_fee_inline_settle','money_record_receipt','money_record_receipt_before_capped','money_prepare_restitution','money_restitution_fact') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION campus.money_record_receipt(uuid,jsonb),campus.money_prepare_restitution(uuid,uuid),campus.money_restitution_fact(uuid,jsonb) TO campus_worker;
-- Available cash includes restitution failure credits only after verified availability.
-- Fee reserve and restitution liability reservations are disjoint from cash already debited.
CREATE OR REPLACE FUNCTION campus.money_cash_raw(eid uuid,lid uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 WITH cash AS (
  SELECT coalesce(sum(ll.debit-ll.credit),0) AS book,coalesce(sum(ll.credit),0) AS debits FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=eid AND (lid IS NULL OR j.lot_id=lid) AND ll.account='cash'
 ), originals AS (
  SELECT coalesce(sum(coalesce(available_cents,0)),0) AS available,coalesce(sum(coalesce(actual_fee_cents,0)),0) AS original_fees FROM campus.funding_allocations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid)
 ), reserved AS (
  SELECT coalesce(sum(amount_cents-cash_debited_cents),0) AS amount FROM campus.money_reservations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind IN('transfer','refund','fee_restitution') AND status='reserved'
 ), unresolved_fees AS (
  SELECT coalesce(sum(greatest(0,(SELECT coalesce(sum(amount_cents),0) FROM campus.money_reservations r WHERE r.lot_id=f.lot_id AND kind IN('publisher_fee','recipient_fee') AND status='reserved')-coalesce(f.actual_fee_cents,0))),0) AS amount FROM campus.funding_allocations f WHERE f.environment_id=eid AND (lid IS NULL OR f.lot_id=lid)
 ), restitution_due AS (
  SELECT coalesce(sum(greatest(0,s.restitution_cents-coalesce((SELECT sum(r.amount_cents) FROM campus.money_reservations r WHERE r.lot_id=s.lot_id AND r.kind='fee_restitution' AND r.status IN('reserved','consumed')),0))),0) AS amount FROM campus.payment_fee_settlements s WHERE s.environment_id=eid AND (lid IS NULL OR s.lot_id=lid)
 )
 SELECT least(cash.book,originals.available
  +coalesce((SELECT sum(net_cents) FROM campus.payment_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_external_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_restitution_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(amount_cents) FROM campus.payment_network_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind='credit' AND available),0)
  -cash.debits+originals.original_fees)-reserved.amount-unresolved_fees.amount-restitution_due.amount FROM cash,originals,reserved,unresolved_fees,restitution_due
$$;

-- Distinct provider fee cash and report attribution have independent semantic keys.
CREATE TABLE campus.payment_fee_cash_facts (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,balance_id text NOT NULL,amount_cents bigint NOT NULL,fee_cents bigint NOT NULL,net_cents bigint NOT NULL CHECK(net_cents<0),provider_type text NOT NULL CHECK(provider_type='stripe_fee'),journal_id uuid NOT NULL REFERENCES campus.ledger_journals,PRIMARY KEY(environment_id,balance_id),CHECK(net_cents=amount_cents-fee_cents)
);
CREATE TABLE campus.payment_fee_report_artifacts (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,run_id text NOT NULL,file_id text NOT NULL,content_digest text NOT NULL,report_type text NOT NULL,
 interval_start bigint NOT NULL,interval_end bigint NOT NULL,PRIMARY KEY(environment_id,run_id),CHECK(interval_end>interval_start)
);
CREATE TABLE campus.payment_fee_report_rows (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,semantic_id text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(environment_id,semantic_id)
);
CREATE TABLE campus.payment_fee_report_memberships (
 environment_id uuid NOT NULL,run_id text NOT NULL,semantic_id text NOT NULL,
 PRIMARY KEY(environment_id,run_id,semantic_id),FOREIGN KEY(environment_id,run_id) REFERENCES campus.payment_fee_report_artifacts,FOREIGN KEY(environment_id,semantic_id) REFERENCES campus.payment_fee_report_rows
);
CREATE TABLE campus.payment_fee_attributions (
 environment_id uuid NOT NULL,semantic_id text NOT NULL,balance_id text NOT NULL,receipt_fact_id uuid NOT NULL,
 lot_id uuid NOT NULL REFERENCES campus.funding_lots,obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,charge_id text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>=0),profile_id uuid NOT NULL REFERENCES campus.payment_billing_profiles,
 PRIMARY KEY(environment_id,semantic_id),FOREIGN KEY(environment_id,semantic_id) REFERENCES campus.payment_fee_report_rows,
 FOREIGN KEY(environment_id,balance_id) REFERENCES campus.payment_fee_cash_facts,FOREIGN KEY(receipt_fact_id,environment_id,lot_id) REFERENCES campus.payment_receipt_facts(id,environment_id,lot_id)
);
CREATE TABLE campus.payment_fee_evidence_conflicts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,identity text NOT NULL,observation jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now(),UNIQUE(environment_id,identity,observation)
);
CREATE TABLE campus.payment_fee_scan_state (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,kind text NOT NULL CHECK(kind IN('balances','reports')),cursor text,lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,last_code text,next_at timestamptz NOT NULL DEFAULT campus.money_now(),PRIMARY KEY(environment_id,kind)
);
CREATE TABLE campus.payment_fee_report_jobs (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,run_id text NOT NULL,status text NOT NULL DEFAULT 'pending',next_at timestamptz NOT NULL DEFAULT campus.money_now(),lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,failures integer NOT NULL DEFAULT 0,last_code text,PRIMARY KEY(environment_id,run_id)
);
CREATE FUNCTION campus.money_fee_cash(eid uuid,fact jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE old campus.payment_fee_cash_facts;jid uuid;net bigint;
BEGIN
 -- Environment-only fact: never obtains an aggregate lock afterwards.
 PERFORM campus.money_cash_lock(eid);net:=(fact->>'net')::bigint;
 IF fact->>'type' IS DISTINCT FROM 'stripe_fee' OR fact->>'currency' IS DISTINCT FROM 'usd' OR net>=0 OR net IS DISTINCT FROM (fact->>'amount')::bigint-(fact->>'fee')::bigint OR coalesce(fact->>'id','')='' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 SELECT * INTO old FROM campus.payment_fee_cash_facts WHERE environment_id=eid AND balance_id=fact->>'id';
 IF FOUND THEN
  IF old.amount_cents<>(fact->>'amount')::bigint OR old.fee_cents<>(fact->>'fee')::bigint OR old.net_cents<>net THEN INSERT INTO campus.payment_fee_evidence_conflicts(environment_id,identity,observation) VALUES(eid,'balance:'||(fact->>'id'),fact) ON CONFLICT DO NOTHING;RETURN false;END IF;RETURN true;
 END IF;
 IF EXISTS(SELECT 1 FROM campus.payment_receipt_facts WHERE environment_id=eid AND fee_fact_id=fact->>'id') OR EXISTS(SELECT 1 FROM campus.payment_balance_facts WHERE environment_id=eid AND balance_id=fact->>'id') OR EXISTS(SELECT 1 FROM campus.payment_external_balance_facts WHERE environment_id=eid AND balance_id=fact->>'id') OR EXISTS(SELECT 1 FROM campus.payment_network_balance_facts WHERE environment_id=eid AND balance_id=fact->>'id') OR EXISTS(SELECT 1 FROM campus.payment_restitution_balance_facts WHERE environment_id=eid AND balance_id=fact->>'id') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 jid:=campus.money_journal(eid,NULL,'later_fee_cash:'||(fact->>'id'),jsonb_build_array(jsonb_build_object('account','cash','credit',-net),jsonb_build_object('account','fee_expense','debit',-net)));
 INSERT INTO campus.payment_fee_cash_facts VALUES(eid,fact->>'id',(fact->>'amount')::bigint,(fact->>'fee')::bigint,net,'stripe_fee',jid);RETURN true;
END $$;
CREATE FUNCTION campus.money_fee_report(eid uuid,artifact jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE old campus.payment_fee_report_artifacts;r jsonb;prior jsonb;
BEGIN
 IF artifact->>'reportType' IS DISTINCT FROM 'all_fees.balance_transaction_created.itemized.2' OR coalesce(artifact->>'contentDigest','')!~'^[a-f0-9]{64}$' OR jsonb_array_length(artifact->'rows')>10000 THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 SELECT * INTO old FROM campus.payment_fee_report_artifacts WHERE environment_id=eid AND run_id=artifact->>'runId';
 IF FOUND AND (old.content_digest<>artifact->>'contentDigest' OR old.file_id<>artifact->>'fileId' OR old.interval_start<>(artifact->>'intervalStart')::bigint OR old.interval_end<>(artifact->>'intervalEnd')::bigint) THEN INSERT INTO campus.payment_fee_evidence_conflicts(environment_id,identity,observation) VALUES(eid,'report:'||(artifact->>'runId'),artifact-'rows') ON CONFLICT DO NOTHING;RETURN false;END IF;
 INSERT INTO campus.payment_fee_report_artifacts VALUES(eid,artifact->>'runId',artifact->>'fileId',artifact->>'contentDigest',artifact->>'reportType',(artifact->>'intervalStart')::bigint,(artifact->>'intervalEnd')::bigint) ON CONFLICT DO NOTHING;
 FOR r IN SELECT value FROM jsonb_array_elements(artifact->'rows') LOOP
  SELECT body INTO prior FROM campus.payment_fee_report_rows WHERE environment_id=eid AND semantic_id=r->>'semanticId';
  IF FOUND AND prior IS DISTINCT FROM r THEN INSERT INTO campus.payment_fee_evidence_conflicts(environment_id,identity,observation) VALUES(eid,'row:'||(r->>'semanticId'),r) ON CONFLICT DO NOTHING;ELSE
   INSERT INTO campus.payment_fee_report_rows VALUES(eid,r->>'semanticId',r) ON CONFLICT DO NOTHING;
   INSERT INTO campus.payment_fee_report_memberships VALUES(eid,artifact->>'runId',r->>'semanticId') ON CONFLICT DO NOTHING;
  END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION campus.money_fee_attribute(eid uuid,semantic text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE rowvalue jsonb;receipt record;p campus.payment_billing_profiles;amount bigint;cash campus.payment_fee_cash_facts;
BEGIN
 SELECT body INTO rowvalue FROM campus.payment_fee_report_rows WHERE environment_id=eid AND semantic_id=semantic;
 IF rowvalue IS NULL OR rowvalue->>'incurredByType'<>'charge' OR rowvalue->>'settledVia'<>'balance' THEN RETURN false;END IF;
 SELECT * INTO receipt FROM campus.money_receipt_source(eid,rowvalue->>'incurredBy');IF NOT FOUND THEN RETURN false;END IF;
 PERFORM campus.money_lock_aggregate(receipt.obligation_id);PERFORM campus.money_cash_lock(eid);
 IF EXISTS(SELECT 1 FROM campus.payment_fee_attributions WHERE environment_id=eid AND semantic_id=semantic) THEN RETURN true;END IF;
 SELECT * INTO p FROM campus.payment_billing_profiles WHERE id=(SELECT profile_id FROM campus.payment_billing_bindings WHERE obligation_id=receipt.obligation_id);
 IF p.id IS NULL OR NOT coalesce(p.contract->'processingFeatures','[]'::jsonb) @> jsonb_build_array(jsonb_build_object('product',rowvalue->>'product','feature',rowvalue->>'feature')) OR (p.contract->>'kind' LIKE 'synthetic_%' AND (SELECT mode FROM campus.payment_environments WHERE id=eid)<>'sandbox') THEN RETURN false;END IF;
 amount:=(rowvalue->>'amountCents')::bigint;
 IF (rowvalue->>'taxCents')::bigint<>0 OR amount<0 THEN PERFORM campus.money_hold(receipt.obligation_id,'fee_tax_authority_unresolved','fee_tax:'||semantic,rowvalue);RETURN false;END IF;
 SELECT * INTO cash FROM campus.payment_fee_cash_facts WHERE environment_id=eid AND balance_id=rowvalue->>'balanceId';IF NOT FOUND THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=eid AND identity IN('row:'||semantic,'balance:'||cash.balance_id)) OR coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_attributions WHERE environment_id=eid AND balance_id=cash.balance_id),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_supplement_attributions WHERE environment_id=eid AND balance_id=cash.balance_id),0)+amount>-cash.net_cents THEN PERFORM campus.money_hold(receipt.obligation_id,'fee_attribution_conflict','fee_attribution:'||semantic,rowvalue);RETURN false;END IF;
 INSERT INTO campus.payment_fee_attributions VALUES(eid,semantic,cash.balance_id,receipt.receipt_fact_id,receipt.lot_id,receipt.obligation_id,receipt.charge_id,amount,p.id);
 -- Move already posted expense attribution between global and source dimensions;
 -- neither entry changes cash, and no customer liability is consumed here.
 IF amount>0 THEN
  PERFORM campus.money_journal(eid,NULL,'fee_attribution_global:'||semantic,jsonb_build_array(jsonb_build_object('account','fee_expense','credit',amount),jsonb_build_object('account','network_exposure','debit',amount)));
  PERFORM campus.money_journal(eid,receipt.lot_id,'fee_attribution_lot:'||semantic,jsonb_build_array(jsonb_build_object('account','fee_expense','debit',amount),jsonb_build_object('account','network_exposure','credit',amount)));
 END IF;
 IF EXISTS(SELECT 1 FROM campus.payment_fee_settlements WHERE obligation_id=receipt.obligation_id) OR EXISTS(SELECT 1 FROM campus.funding_allocations WHERE lot_id=receipt.lot_id AND fee_state='matched') THEN PERFORM campus.money_hold(receipt.obligation_id,'later_fee_correction','later_fee:'||semantic,jsonb_build_object('semanticId',semantic,'amountCents',amount));END IF;
 RETURN true;
END $$;
CREATE FUNCTION campus.money_fee_report_close(eid uuid,oid uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_billing_profiles;c jsonb;artifact campus.payment_fee_report_artifacts;f campus.funding_allocations;amount bigint;observed jsonb;
BEGIN
 PERFORM campus.money_lock_aggregate(oid);PERFORM campus.money_cash_lock(eid);
 SELECT * INTO p FROM campus.payment_billing_profiles WHERE id=(SELECT profile_id FROM campus.payment_billing_bindings WHERE obligation_id=oid AND environment_id=eid);
 IF p.contract->>'kind' IS DISTINCT FROM 'synthetic_report_artifact_v1' OR (SELECT mode FROM campus.payment_environments WHERE id=eid)<>'sandbox' OR p.provenance NOT LIKE 'Synthetic:%' THEN RETURN false;END IF;
 SELECT fa.* INTO f FROM campus.funding_allocations fa JOIN campus.funding_lots l ON l.id=fa.lot_id WHERE l.obligation_id=oid AND fa.environment_id=eid;IF NOT FOUND THEN RETURN false;END IF;
 SELECT evidence INTO c FROM campus.payment_synthetic_fee_closures WHERE profile_id=p.id AND environment_id=eid AND charge_id=f.charge_id;
 SELECT * INTO artifact FROM campus.payment_fee_report_artifacts WHERE environment_id=eid AND run_id=c->>'runId';
 IF artifact.run_id IS NULL OR artifact.file_id IS DISTINCT FROM c->>'fileId' OR artifact.content_digest IS DISTINCT FROM c->>'contentDigest' OR artifact.interval_start IS DISTINCT FROM (c->>'intervalStart')::bigint OR artifact.interval_end IS DISTINCT FROM (c->>'intervalEnd')::bigint THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(a.semantic_id ORDER BY a.semantic_id),'[]'::jsonb),coalesce(sum(a.amount_cents),0) INTO observed,amount FROM campus.payment_fee_attributions a JOIN campus.payment_fee_report_memberships m USING(environment_id,semantic_id) WHERE a.environment_id=eid AND a.obligation_id=oid AND m.run_id=artifact.run_id;
 IF f.actual_fee_cents IS NULL OR f.fee_fact_id IS NULL OR EXISTS(SELECT 1 FROM campus.payment_fee_report_rows rr JOIN campus.payment_fee_report_memberships mm USING(environment_id,semantic_id) WHERE rr.environment_id=eid AND mm.run_id=artifact.run_id AND rr.body->>'incurredBy'=f.charge_id AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_attributions aa WHERE aa.environment_id=eid AND aa.semantic_id=rr.semantic_id AND aa.obligation_id=oid)) THEN RETURN false;END IF;
 IF observed IS DISTINCT FROM c->'semanticIds' OR EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=eid AND (identity='report:'||artifact.run_id OR identity IN(SELECT 'row:'||jsonb_array_elements_text(observed)))) THEN RETURN false;END IF;
 RETURN campus.money_fee_settle(oid,f.actual_fee_cents+amount,jsonb_build_object('kind',p.contract->>'kind','profileId',p.id,'environmentId',eid,'platformAccountId',p.platform_account_id,'chargeId',f.charge_id,'artifact',to_jsonb(artifact),'semanticIds',observed,'currentObservationOnly',true));
END $$;
DO $$ DECLARE t text;p record;BEGIN
 FOREACH t IN ARRAY ARRAY['payment_fee_cash_facts','payment_fee_report_artifacts','payment_fee_report_rows','payment_fee_report_memberships','payment_fee_attributions','payment_fee_evidence_conflicts','payment_fee_scan_state','payment_fee_report_jobs'] LOOP EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);IF t NOT IN('payment_fee_scan_state','payment_fee_report_jobs') THEN EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);END IF;END LOOP;
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN('money_fee_cash','money_fee_report','money_fee_attribute','money_fee_report_close') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION campus.money_fee_cash(uuid,jsonb),campus.money_fee_report(uuid,jsonb),campus.money_fee_attribute(uuid,text),campus.money_fee_report_close(uuid,uuid) TO campus_worker;
CREATE TABLE campus.payment_fee_attribution_attempts (
 environment_id uuid NOT NULL,semantic_id text NOT NULL,last_attempt_at timestamptz NOT NULL,
 PRIMARY KEY(environment_id,semantic_id),FOREIGN KEY(environment_id,semantic_id) REFERENCES campus.payment_fee_report_rows
);
ALTER TABLE campus.payment_fee_attribution_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_fee_attribution_attempts FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE FUNCTION campus.money_fee_scan_claim(eid uuid,k text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.payment_fee_scan_state;
BEGIN
 INSERT INTO campus.payment_fee_scan_state(environment_id,kind) VALUES(eid,k) ON CONFLICT DO NOTHING;
 UPDATE campus.payment_fee_scan_state SET fence=fence+1,lease_until=campus.money_now()+interval '30 seconds' WHERE environment_id=eid AND kind=k AND next_at<=campus.money_now() AND (lease_until IS NULL OR lease_until<campus.money_now()) RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL;END IF;RETURN to_jsonb(r);
END $$;
CREATE FUNCTION campus.money_fee_scan_finish(eid uuid,k text,token bigint,nextcursor text,code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN UPDATE campus.payment_fee_scan_state SET cursor=CASE WHEN code='processed' THEN nextcursor ELSE cursor END,last_code=code,lease_until=NULL,next_at=campus.money_now()+CASE WHEN code='processed' AND nextcursor IS NOT NULL THEN interval '0 seconds' ELSE interval '30 seconds' END WHERE environment_id=eid AND kind=k AND fence=token AND lease_until>=campus.money_now();RETURN FOUND;END $$;
CREATE FUNCTION campus.money_fee_report_schedule(eid uuid,runid text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ INSERT INTO campus.payment_fee_report_jobs(environment_id,run_id) VALUES(eid,runid) ON CONFLICT DO NOTHING $$;
CREATE FUNCTION campus.money_fee_report_claim(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.payment_fee_report_jobs;
BEGIN SELECT * INTO r FROM campus.payment_fee_report_jobs WHERE environment_id=eid AND status IN('pending','leased') AND next_at<=campus.money_now() AND (lease_until IS NULL OR lease_until<campus.money_now()) ORDER BY next_at,run_id FOR UPDATE SKIP LOCKED LIMIT 1;IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE campus.payment_fee_report_jobs SET status='leased',fence=fence+1,lease_until=campus.money_now()+interval '30 seconds' WHERE environment_id=eid AND run_id=r.run_id RETURNING * INTO r;RETURN to_jsonb(r);END $$;
CREATE FUNCTION campus.money_fee_report_finish(eid uuid,runid text,token bigint,code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN UPDATE campus.payment_fee_report_jobs SET failures=failures+CASE WHEN code IN('pending','processed') THEN 0 ELSE 1 END,status=CASE WHEN code='processed' THEN 'done' WHEN code='failed' OR (code<>'pending' AND failures>=7) THEN 'dead_letter' ELSE 'pending' END,last_code=code,lease_until=NULL,next_at=campus.money_now()+interval '1 minute' WHERE environment_id=eid AND run_id=runid AND fence=token AND lease_until>=campus.money_now();RETURN FOUND;END $$;
CREATE FUNCTION campus.money_fee_attribution_targets(eid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE ids text[];
BEGIN
 SELECT array_agg(semantic_id) INTO ids FROM (SELECT r.semantic_id FROM campus.payment_fee_report_rows r LEFT JOIN campus.payment_fee_attribution_attempts a USING(environment_id,semantic_id) WHERE r.environment_id=eid AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_attributions f WHERE f.environment_id=eid AND f.semantic_id=r.semantic_id) AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_supplement_attributions f WHERE f.environment_id=eid AND f.semantic_id=r.semantic_id) ORDER BY a.last_attempt_at NULLS FIRST,r.semantic_id LIMIT 16) s;
 INSERT INTO campus.payment_fee_attribution_attempts SELECT eid,id,campus.money_now() FROM unnest(ids) id ON CONFLICT(environment_id,semantic_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at;RETURN coalesce(to_jsonb(ids),'[]');
END $$;
CREATE FUNCTION campus.money_attempt_reconciled(aid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT coalesce((SELECT fee_state='matched' AND available_cents IS NOT NULL FROM campus.funding_allocations WHERE attempt_id=aid),false)
$$;
DO $$ DECLARE p record;BEGIN FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN('money_fee_scan_claim','money_fee_scan_finish','money_fee_report_schedule','money_fee_report_claim','money_fee_report_finish','money_fee_attribution_targets','money_attempt_reconciled') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO campus_worker',p.signature);END LOOP;END $$;

-- Exact I1 capacity proposal; scope and authority retained in task-2b-fix1-cash-authorization-context.md.
CREATE OR REPLACE FUNCTION campus.money_cash_raw(eid uuid,lid uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 WITH cash AS (
  SELECT coalesce(sum(ll.debit-ll.credit),0) AS book,coalesce(sum(ll.credit),0) AS debits FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=eid AND (lid IS NULL OR j.lot_id=lid) AND ll.account='cash'
 ), originals AS (
  SELECT coalesce(sum(coalesce(available_cents,0)),0) AS available,coalesce(sum(coalesce(actual_fee_cents,0)),0) AS original_fees FROM campus.funding_allocations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid)
 ), reserved AS (
  SELECT coalesce(sum(amount_cents-cash_debited_cents),0) AS amount FROM campus.money_reservations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind IN('transfer','refund','fee_restitution') AND status='reserved'
 ), unresolved_fees AS (
  SELECT coalesce(sum(greatest(0,(SELECT coalesce(sum(amount_cents),0) FROM campus.money_reservations r WHERE r.lot_id=f.lot_id AND kind IN('publisher_fee','recipient_fee') AND status='reserved')-coalesce(f.actual_fee_cents,0)-coalesce((SELECT sum(a.amount_cents) FROM campus.payment_fee_attributions a WHERE a.lot_id=f.lot_id),0))),0) AS amount FROM campus.funding_allocations f WHERE f.environment_id=eid AND (lid IS NULL OR f.lot_id=lid)
 ), restitution_due AS (
  SELECT coalesce(sum(greatest(0,s.restitution_cents-coalesce((SELECT sum(r.amount_cents) FROM campus.money_reservations r WHERE r.lot_id=s.lot_id AND r.kind='fee_restitution' AND r.status IN('reserved','consumed')),0))),0) AS amount FROM campus.payment_fee_settlements s WHERE s.environment_id=eid AND (lid IS NULL OR s.lot_id=lid)
 )
 SELECT least(cash.book,originals.available
  +coalesce((SELECT sum(net_cents) FROM campus.payment_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_external_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_restitution_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(amount_cents) FROM campus.payment_network_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind='credit' AND available),0)
  -cash.debits+originals.original_fees)-reserved.amount-unresolved_fees.amount-restitution_due.amount-CASE WHEN lid IS NULL THEN 0 ELSE coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_attributions WHERE environment_id=eid AND lot_id=lid),0) END FROM cash,originals,reserved,unresolved_fees,restitution_due
$$;

CREATE OR REPLACE FUNCTION campus.money_cash_headroom(eid uuid,lid uuid DEFAULT NULL,approved_hold_lot uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=eid) THEN least(0,campus.money_cash_raw(eid,lid)) ELSE campus.money_cash_raw(eid,lid)-coalesce((SELECT sum(greatest(0,campus.money_cash_raw(eid,l.id))) FROM campus.funding_lots l WHERE l.environment_id=eid AND (lid IS NULL OR l.id=lid) AND l.id IS DISTINCT FROM approved_hold_lot AND EXISTS(SELECT 1 FROM campus.money_active_holds h WHERE h.obligation_id=l.obligation_id AND h.active)),0) END
$$;

CREATE OR REPLACE FUNCTION campus.money_dispatchable(op campus.money_operations) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE account campus.connected_payee_accounts;p campus.payment_execution_policies;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM campus.payment_environments WHERE id=op.environment_id AND enabled) THEN RETURN false;END IF;
 IF op.kind IN('checkout','transfer','refund','reversal','fee_restitution') AND EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=op.environment_id) THEN RETURN false;END IF;
 IF op.kind IN('transfer','checkout','fee_restitution') AND EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=op.obligation_id AND active) THEN RETURN false;END IF;
 IF op.kind='transfer' THEN
  IF coalesce((SELECT sum(rr.amount_cents) FROM campus.money_reservations rr JOIN campus.money_operations mm ON mm.id=rr.operation_id WHERE mm.environment_id=op.environment_id AND mm.kind='transfer' AND mm.payload->>'sourceCharge'=op.payload->>'sourceCharge' AND rr.status IN('reserved','consumed')),0)>(SELECT amount_cents FROM campus.funding_obligations WHERE id=op.obligation_id) THEN RETURN false;END IF;
  SELECT * INTO account FROM campus.connected_payee_accounts WHERE environment_id=op.environment_id AND provider_account_id=op.payload->>'destination';
  IF account.transfer_capability IS DISTINCT FROM 'active' OR account.observed_at IS NULL OR account.observed_at<campus.money_now()-interval '5 minutes' OR NOT EXISTS(SELECT 1 FROM campus.users WHERE id=account.user_id AND account_status='active') THEN RETURN false;END IF;
 END IF;
 IF op.kind IN('transfer','refund','fee_restitution') AND (campus.money_cash_headroom(op.environment_id,NULL,CASE WHEN op.kind='refund' THEN (SELECT lot_id FROM campus.money_reservations WHERE operation_id=op.id LIMIT 1) END)<0 OR campus.money_cash_headroom(op.environment_id,(SELECT lot_id FROM campus.money_reservations WHERE operation_id=op.id LIMIT 1),CASE WHEN op.kind='refund' THEN (SELECT lot_id FROM campus.money_reservations WHERE operation_id=op.id LIMIT 1) END)<0) THEN RETURN false;END IF;
 IF op.kind IN('refund','reversal') THEN
  SELECT * INTO p FROM campus.payment_execution_policies WHERE id=(op.payload->>'policyId')::uuid AND status='approved' AND environment_id=op.environment_id AND purpose=op.kind;
  IF p.id IS NULL OR p.digest IS DISTINCT FROM op.payload->>'policyDigest' OR EXISTS(SELECT 1 FROM campus.money_active_holds h WHERE h.obligation_id=op.obligation_id AND h.active AND NOT coalesce(p.payload->'approvedHoldIds','[]'::jsonb)?h.id::text) THEN RETURN false;END IF;
 END IF;RETURN true;
END $$;

CREATE OR REPLACE FUNCTION campus.money_prepare_compensation(eid uuid,target_oid uuid DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE d campus.payment_compensation_decisions;c campus.funding_component_plans;o campus.funding_obligations;f campus.funding_allocations;p campus.payment_execution_policies;op uuid;used bigint;cash bigint;n integer:=0;original campus.money_operations;
BEGIN
 IF EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=eid) THEN RETURN 0;END IF;
 IF target_oid IS NULL THEN SELECT id INTO target_oid FROM campus.funding_obligations WHERE environment_id=eid ORDER BY id LIMIT 1;END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.funding_obligations WHERE id=target_oid AND environment_id=eid) THEN RETURN 0;END IF;
 PERFORM campus.money_lock_aggregate(target_oid);PERFORM campus.money_cash_lock(eid);
 FOR d IN SELECT * FROM campus.payment_compensation_decisions WHERE environment_id=eid AND obligation_id=target_oid ORDER BY id LOOP
 PERFORM campus.money_lock_aggregate(d.obligation_id);SELECT * INTO c FROM campus.money_effective_components WHERE id=d.component_id;
 SELECT fo.* INTO o FROM campus.funding_obligations fo JOIN campus.funding_lots l ON l.obligation_id=fo.id WHERE l.id=c.lot_id FOR UPDATE OF fo;
 IF o.id<>d.obligation_id OR o.environment_id<>eid THEN RAISE EXCEPTION 'compensation_scope_mismatch' USING ERRCODE='P0001';END IF;
 SELECT * INTO p FROM campus.payment_execution_policies WHERE id=d.policy_id AND environment_id=eid AND aggregate_type=o.aggregate_type AND aggregate_id=o.aggregate_id AND purpose=d.kind AND status='approved';
 IF p.id IS NULL OR p.payload->>'decisionId' IS DISTINCT FROM d.id::text OR p.payload->>'componentId' IS DISTINCT FROM c.id::text OR (p.payload->>'amountCents')::bigint IS DISTINCT FROM d.amount_cents THEN CONTINUE;END IF;
 IF d.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM campus.refund_requests WHERE id=d.request_id AND obligation_id=o.id AND revision=d.case_revision) THEN CONTINUE;END IF;
 IF EXISTS(SELECT 1 FROM campus.money_operations WHERE environment_id=eid AND kind=d.kind AND business_key=d.id::text) THEN CONTINUE;END IF;
 SELECT * INTO f FROM campus.funding_allocations WHERE lot_id=c.lot_id FOR UPDATE;
 IF f.fee_state IS DISTINCT FROM 'matched' THEN CONTINUE;END IF;
 IF d.kind='refund' THEN
 IF EXISTS(SELECT 1 FROM campus.money_active_holds h WHERE h.obligation_id=o.id AND h.active AND NOT coalesce(p.payload->'approvedHoldIds','[]'::jsonb)?h.id::text) THEN CONTINUE;END IF;
 SELECT coalesce(sum(amount_cents),0) INTO used FROM campus.money_reservations WHERE component_id=c.id AND kind IN('transfer','refund') AND status IN('reserved','consumed');
 IF c.net_cents-used+coalesce((SELECT sum(amount_cents) FROM campus.principal_restorations WHERE component_id=c.id),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_external_balance_facts WHERE component_id=c.id AND kind='reversal' AND role='original'),0)<d.amount_cents THEN CONTINUE;END IF;
 SELECT coalesce(sum(ll.debit-ll.credit),0) INTO cash FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.lot_id=c.lot_id AND ll.account='cash';
 IF campus.money_cash_headroom(eid,NULL,c.lot_id)<d.amount_cents OR campus.money_cash_headroom(eid,c.lot_id,c.lot_id)<d.amount_cents THEN CONTINUE;END IF;
 ELSE
 SELECT * INTO original FROM campus.money_operations WHERE id=d.original_operation_id AND environment_id=eid AND kind='transfer' AND status='succeeded' AND payload->>'componentId'=c.id::text;
 IF original.id IS NULL OR coalesce((SELECT sum(amount_cents) FROM campus.money_reservations WHERE component_id=c.id AND kind='reversal' AND status IN('reserved','consumed')),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_external_balance_facts WHERE original_operation_id=original.id AND kind='reversal' AND role='original'),0)+d.amount_cents>(original.payload->>'amountCents')::bigint THEN CONTINUE;END IF;
 END IF;
 op:=campus.money_enqueue(eid,o.id,d.kind,d.id::text,jsonb_build_object('decisionId',d.id,'componentId',c.id,'amountCents',d.amount_cents,'currency','usd','sourceCharge',f.charge_id,'transferId',original.provider_id,'originalOperationId',d.original_operation_id,'policyId',p.id,'policyDigest',p.digest,'policyVersion',p.version,'policyProvenance',p.provenance,'sourceDigest',o.source_digest));
 INSERT INTO campus.money_reservations(environment_id,lot_id,component_id,operation_id,kind,amount_cents) VALUES(eid,c.lot_id,c.id,op,d.kind,d.amount_cents);n:=n+1;
 END LOOP;RETURN n;
END $$;

CREATE OR REPLACE FUNCTION campus.money_prepare_restitution(eid uuid,oid uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE s campus.payment_fee_settlements;o campus.funding_obligations;op campus.money_operations;newid uuid;generation integer;
BEGIN
 IF EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=eid) THEN RETURN 0;END IF;
 PERFORM campus.money_lock_aggregate(oid);SELECT * INTO o FROM campus.funding_obligations WHERE id=oid AND environment_id=eid;IF NOT FOUND THEN RETURN 0;END IF;PERFORM campus.money_cash_lock(eid);
 SELECT * INTO s FROM campus.payment_fee_settlements WHERE obligation_id=oid AND restitution_cents>0;IF NOT FOUND THEN RETURN 0;END IF;
 SELECT * INTO op FROM campus.money_operations WHERE obligation_id=oid AND kind='fee_restitution' ORDER BY created_at DESC,id DESC LIMIT 1;
 IF op.id IS NOT NULL AND (op.status<>'failed' OR NOT EXISTS(SELECT 1 FROM campus.money_reservations WHERE operation_id=op.id AND status='released')) THEN RETURN 0;END IF;
 IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=oid AND active) OR campus.money_cash_headroom(eid,NULL)<0 OR campus.money_cash_headroom(eid,s.lot_id)<0 THEN RETURN 0;END IF;
 generation:=coalesce((op.payload->>'generation')::int,0)+1;
 newid:=campus.money_enqueue(eid,oid,'fee_restitution',oid::text||':'||generation,jsonb_build_object('generation',generation,'feePlanId',s.plan_id,'feePlanDigest',(SELECT digest FROM campus.payment_fee_plans WHERE id=s.plan_id),'amountCents',s.restitution_cents,'currency','usd','sourceCharge',s.charge_id,'purpose','unused_preconsented_payer_fee_reserve','sourceDigest',o.source_digest));
 INSERT INTO campus.money_reservations(environment_id,lot_id,operation_id,kind,amount_cents) VALUES(eid,s.lot_id,newid,'fee_restitution',s.restitution_cents);RETURN 1;
END $$;
-- Billing authority is bound once per obligation. Later environment profiles
-- cannot silently change the billing premise of an existing charge.
ALTER TABLE campus.payment_billing_profiles ADD UNIQUE(id,environment_id);
CREATE TABLE campus.payment_billing_bindings (
 obligation_id uuid PRIMARY KEY REFERENCES campus.funding_obligations,environment_id uuid NOT NULL REFERENCES campus.payment_environments,profile_id uuid,
 FOREIGN KEY(profile_id,environment_id) REFERENCES campus.payment_billing_profiles(id,environment_id)
);
CREATE FUNCTION campus.money_bind_billing() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN INSERT INTO campus.payment_billing_bindings SELECT NEW.id,NEW.environment_id,(SELECT id FROM campus.payment_billing_profiles WHERE environment_id=NEW.environment_id ORDER BY version DESC LIMIT 1);RETURN NEW;END $$;
CREATE TRIGGER bind_billing AFTER INSERT ON campus.funding_obligations FOR EACH ROW EXECUTE FUNCTION campus.money_bind_billing();
CREATE TABLE campus.payment_synthetic_fee_closures (
 profile_id uuid NOT NULL,environment_id uuid NOT NULL,charge_id text NOT NULL,evidence jsonb NOT NULL,provenance text NOT NULL,
 PRIMARY KEY(environment_id,charge_id),FOREIGN KEY(profile_id,environment_id) REFERENCES campus.payment_billing_profiles(id,environment_id)
);
CREATE FUNCTION campus.money_synthetic_closure_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF (SELECT mode FROM campus.payment_environments WHERE id=NEW.environment_id) IS DISTINCT FROM 'sandbox' OR NEW.provenance NOT LIKE 'Synthetic:%' OR NOT EXISTS(SELECT 1 FROM campus.payment_billing_profiles WHERE id=NEW.profile_id AND environment_id=NEW.environment_id AND contract->>'kind'='synthetic_report_artifact_v1') OR NEW.evidence->>'chargeId' IS DISTINCT FROM NEW.charge_id THEN RAISE EXCEPTION 'synthetic_profile_scope_mismatch' USING ERRCODE='P0001';END IF;RETURN NEW;
END $$;
CREATE TRIGGER synthetic_closure_scope BEFORE INSERT ON campus.payment_synthetic_fee_closures FOR EACH ROW EXECUTE FUNCTION campus.money_synthetic_closure_guard();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payment_billing_bindings','payment_synthetic_fee_closures'] LOOP EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);END LOOP;END $$;
REVOKE ALL ON FUNCTION campus.money_bind_billing(),campus.money_synthetic_closure_guard() FROM PUBLIC,campus_app,campus_auth,campus_worker;

CREATE OR REPLACE FUNCTION campus.money_inline_closed(eid uuid,aid uuid,fact jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT coalesce((SELECT p.billing_mode='inline' AND ((p.contract->>'kind'='synthetic_original_charge_balance_v1' AND e.mode='sandbox' AND p.provenance LIKE 'Synthetic:%') OR (p.contract->>'kind'='stripe_standard_inline_charge_balance_v1' AND p.contract->>'pricingModel'='standard_non_ic_plus' AND p.contract->>'source'='https://docs.stripe.com/expand/use-cases' AND p.provenance NOT LIKE 'Synthetic:%' AND p.contract->>'accountEvidenceDigest' ~ '^[a-f0-9]{64}$' AND coalesce(p.contract->>'accountEvidenceRef','')<>'')) AND fact->>'processingFeeSource'='succeeded_captured_original_charge_balance_v1' AND p.platform_account_id=fact->>'platformAccountId' AND (fact->>'environmentId')::uuid=eid AND EXISTS(SELECT 1 FROM campus.payment_attempts WHERE id=aid AND environment_id=eid) AND coalesce(fact->>'feeFactId','')<>'' FROM campus.payment_billing_profiles p JOIN campus.payment_environments e ON e.id=p.environment_id WHERE p.id=(SELECT bb.profile_id FROM campus.payment_billing_bindings bb JOIN campus.payment_attempts pa ON pa.obligation_id=bb.obligation_id WHERE pa.id=aid AND bb.environment_id=eid)),false)
$$;
-- UI consumes these server-derived cap actions and amounts, never reconstructs authority.
ALTER FUNCTION campus.money_projection(text,uuid) RENAME TO money_projection_before_fee_plan;
CREATE FUNCTION campus.money_projection(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;policy campus.payment_execution_policies;plan campus.payment_fee_plans;o campus.funding_obligations;settlement campus.payment_fee_settlements;payer uuid;source text;actions jsonb;summary jsonb;item jsonb;payees jsonb:='[]';effective campus.funding_component_plans;confirmed boolean;quote_allowed boolean;
BEGIN
 result:=campus.money_projection_before_fee_plan(kind,resource);quote_allowed:=result->'allowedActions' ? 'request_quote';
 SELECT * INTO o FROM campus.funding_obligations WHERE aggregate_type=kind AND aggregate_id=resource ORDER BY created_at DESC LIMIT 1;
 IF kind='agreement' THEN SELECT owner_id INTO payer FROM campus.agreements WHERE id=resource;SELECT t.digest INTO source FROM campus.agreement_transaction_terms t JOIN campus.agreement_transaction_bindings b ON b.transaction_terms_id=t.id JOIN campus.agreement_terms_state st ON st.agreement_id=b.agreement_id AND st.effective_terms_id=b.terms_id WHERE b.agreement_id=resource;
 ELSE SELECT buyer_id INTO payer FROM campus.orders WHERE id=resource;source:=campus.money_order_terms(resource);END IF;
 SELECT * INTO policy FROM campus.payment_execution_policies WHERE aggregate_type=kind AND aggregate_id=resource AND environment_id=coalesce(o.environment_id,(SELECT id FROM campus.payment_environments WHERE enabled LIMIT 1)) AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1;
 IF o.id IS NOT NULL THEN SELECT * INTO policy FROM campus.payment_execution_policies WHERE id=o.policy_id;END IF;
 IF policy.payload->>'feeAdjustment'='capped_actual_v1' THEN
  SELECT p.* INTO plan FROM campus.payment_fee_plans p WHERE p.policy_id=policy.id AND p.source_digest=source;
  IF o.id IS NOT NULL THEN SELECT pp.* INTO plan FROM campus.payment_fee_plans pp JOIN campus.payment_fee_plan_bindings bb ON bb.plan_id=pp.id WHERE bb.obligation_id=o.id;END IF;
  actions:=(result->'allowedActions')-'request_quote';
  IF o.id IS NULL AND EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN
   IF plan.id IS NULL AND campus.actor()=payer THEN actions:=actions||'"propose_fee_plan"'::jsonb;
   ELSIF plan.id IS NOT NULL THEN
    confirmed:=NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(plan.body->'participants')who WHERE NOT EXISTS(SELECT 1 FROM campus.payment_fee_confirmations c WHERE c.plan_id=plan.id AND c.user_id=who::uuid AND c.digest=plan.digest));
    IF plan.body->'participants' ? campus.actor()::text AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_confirmations WHERE plan_id=plan.id AND user_id=campus.actor() AND digest=plan.digest) THEN actions:=actions||'"confirm_fee_plan"'::jsonb;END IF;
    IF confirmed AND campus.actor()=payer AND quote_allowed THEN actions:=actions||'"request_quote"'::jsonb;END IF;
   END IF;
  END IF;
  IF plan.id IS NOT NULL THEN
   SELECT * INTO settlement FROM campus.payment_fee_settlements WHERE obligation_id=o.id;
   summary:=jsonb_build_object('id',plan.id,'digest',plan.digest,'estimatedFeeCents',plan.body->>'estimatedFeeCents','maximumFeeCents',plan.body->>'maximumFeeCents','maximumPayerFeeCents',plan.body->>'maximumPayerFeeCents','maximumRecipientFeeCents',plan.body->>'maximumRecipientFeeCents','upfrontCents',plan.body->'maximumPlan'->'lots'->0->>'chargeTotalCents','actualFeeCents',settlement.actual_fee_cents::text,'payerRestitutionCents',settlement.restitution_cents::text,'restitutionStatus',CASE WHEN settlement.obligation_id IS NULL THEN 'not_determined' WHEN settlement.restitution_cents=0 THEN 'not_required' ELSE coalesce((SELECT mo.status FROM campus.money_operations mo WHERE mo.obligation_id=o.id AND mo.kind='fee_restitution' ORDER BY mo.created_at DESC,mo.id DESC LIMIT 1),'owed') END,'restoration',plan.body->>'restoration');
   IF o.id IS NOT NULL THEN result:=result||jsonb_build_object('estimatedFeeCents',plan.body->>'estimatedFeeCents','actualFeeCents',settlement.actual_fee_cents::text,'feeVarianceCents',(settlement.actual_fee_cents-(plan.body->>'estimatedFeeCents')::bigint)::text);END IF;
  END IF;
  result:=result||jsonb_build_object('allowedActions',actions,'feePlan',summary);
 END IF;
 IF o.id IS NOT NULL THEN
  FOR item IN SELECT value FROM jsonb_array_elements(result->'payees') LOOP
   SELECT * INTO effective FROM campus.money_effective_components WHERE id=(item->>'componentId')::uuid;
   payees:=payees||jsonb_build_array(item||jsonb_build_object('feeCents',effective.recipient_fee_cents::text,'netCents',effective.net_cents::text));
  END LOOP;result:=result||jsonb_build_object('payees',payees);
 END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION campus.money_projection_before_fee_plan(text,uuid),campus.money_projection(text,uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_projection(text,uuid) TO campus_app;

-- Exact over-cap reconfirmation is fee-only authority, never another principal lot.
CREATE TABLE campus.payment_fee_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,revision integer NOT NULL,policy_id uuid NOT NULL REFERENCES campus.payment_execution_policies,
 base_evidence jsonb NOT NULL,base_digest text NOT NULL,body jsonb NOT NULL,digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT campus.money_now(),UNIQUE(obligation_id,revision),UNIQUE(id,obligation_id,environment_id)
);
CREATE TABLE campus.payment_fee_revision_confirmations (
 revision_id uuid NOT NULL REFERENCES campus.payment_fee_revisions,user_id uuid NOT NULL REFERENCES campus.users,digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT campus.money_now(),PRIMARY KEY(revision_id,user_id)
);
CREATE TABLE campus.payment_fee_supplement_obligations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),revision_id uuid NOT NULL UNIQUE,obligation_id uuid NOT NULL,environment_id uuid NOT NULL,
 payer_id uuid NOT NULL REFERENCES campus.users,amount_cents bigint NOT NULL CHECK(amount_cents>0),source_digest text NOT NULL,
 FOREIGN KEY(revision_id,obligation_id,environment_id) REFERENCES campus.payment_fee_revisions(id,obligation_id,environment_id),UNIQUE(id,environment_id)
);
CREATE TABLE campus.payment_fee_supplement_attempts (
 id uuid PRIMARY KEY,fee_obligation_id uuid NOT NULL UNIQUE REFERENCES campus.payment_fee_supplement_obligations,operation_id uuid NOT NULL UNIQUE REFERENCES campus.money_operations,
 status text NOT NULL DEFAULT 'creating' CHECK(status IN('creating','requires_action','processing','succeeded','unknown','failed','canceled')),
 session_id text,charge_id text,intent_id text,hosted_url text,expires_at timestamptz
);
CREATE TABLE campus.payment_fee_supplement_receipts (
 attempt_id uuid PRIMARY KEY REFERENCES campus.payment_fee_supplement_attempts,environment_id uuid NOT NULL,obligation_id uuid NOT NULL,
 revision_id uuid NOT NULL,charge_id text NOT NULL,amount_cents bigint NOT NULL,fee_cents bigint,fee_fact_id text,available_cents bigint,
 fact jsonb NOT NULL,receipt_journal_id uuid NOT NULL REFERENCES campus.ledger_journals,
 UNIQUE(environment_id,charge_id),FOREIGN KEY(revision_id,obligation_id,environment_id) REFERENCES campus.payment_fee_revisions(id,obligation_id,environment_id)
);
CREATE TABLE campus.payment_fee_revision_settlements (
 revision_id uuid PRIMARY KEY REFERENCES campus.payment_fee_revisions,obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,
 actual_fee_cents bigint NOT NULL,payer_fee_cents bigint NOT NULL,recipient_fee_cents bigint NOT NULL,actual_plan jsonb NOT NULL,
 evidence jsonb NOT NULL,evidence_digest text NOT NULL,journal_id uuid REFERENCES campus.ledger_journals,created_at timestamptz NOT NULL DEFAULT campus.money_now()
);
CREATE TABLE campus.payment_fee_hold_resolutions (
 hold_id uuid NOT NULL REFERENCES campus.payment_holds,revision_id uuid NOT NULL REFERENCES campus.payment_fee_revision_settlements,
 evidence_digest text NOT NULL,PRIMARY KEY(hold_id,revision_id)
);
CREATE TABLE campus.payment_fee_revision_restitutions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),revision_id uuid NOT NULL REFERENCES campus.payment_fee_revision_settlements,
 obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,environment_id uuid NOT NULL,charge_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),UNIQUE(revision_id,charge_id)
);
ALTER TABLE campus.money_operations DROP CONSTRAINT money_operations_kind_check;
ALTER TABLE campus.money_operations ADD CONSTRAINT money_operations_kind_check CHECK(kind IN('checkout','transfer','refund','reversal','expire','onboarding','recipient','fee_restitution','fee_supplement_checkout'));
ALTER TABLE campus.payment_reconciliation_jobs DROP CONSTRAINT payment_reconciliation_jobs_kind_check;
ALTER TABLE campus.payment_reconciliation_jobs ADD CONSTRAINT payment_reconciliation_jobs_kind_check CHECK(kind IN('attempt','compensation','external_refund','external_reversal','dispute','fee_supplement'));
CREATE FUNCTION campus.money_fee_evidence(oid uuid,exclude_revision uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('facts',coalesce(jsonb_agg(v ORDER BY v->>'identity'),'[]'::jsonb),'totalCents',coalesce(sum((v->>'feeCents')::bigint),0),'complete',coalesce(bool_and((v->>'verified')::boolean),false)) FROM (
 SELECT jsonb_build_object('identity','original:'||f.charge_id,'chargeId',f.charge_id,'balanceId',f.fee_fact_id,'feeCents',f.actual_fee_cents,'verified',f.actual_fee_cents IS NOT NULL AND f.fee_fact_id IS NOT NULL) v FROM campus.funding_allocations f JOIN campus.funding_lots l ON l.id=f.lot_id WHERE l.obligation_id=oid
 UNION ALL SELECT jsonb_build_object('identity','report:'||a.semantic_id,'chargeId',a.charge_id,'balanceId',a.balance_id,'feeCents',a.amount_cents,'verified',true) FROM campus.payment_fee_attributions a WHERE a.obligation_id=oid
 UNION ALL SELECT jsonb_build_object('identity','supplement:'||r.charge_id,'chargeId',r.charge_id,'balanceId',r.fee_fact_id,'feeCents',r.fee_cents,'verified',r.fee_cents IS NOT NULL AND r.fee_fact_id IS NOT NULL) FROM campus.payment_fee_supplement_receipts r WHERE r.obligation_id=oid AND r.revision_id IS DISTINCT FROM exclude_revision
 ) facts
$$;
CREATE FUNCTION campus.money_fee_retained_payer(oid uuid) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT o.publisher_fee_cents+coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_supplement_receipts WHERE obligation_id=oid),0)-coalesce((SELECT sum(r.amount_cents) FROM campus.money_reservations r JOIN campus.money_operations m ON m.id=r.operation_id WHERE m.obligation_id=oid AND r.kind='fee_restitution' AND r.status='consumed'),0) FROM campus.funding_obligations o WHERE o.id=oid
$$;
CREATE FUNCTION campus.money_fee_revision_propose(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;p campus.payment_execution_policies;plan campus.payment_fee_plans;ev jsonb;bodyvalue jsonb;rid uuid;rev integer;estimate bigint;maximum bigint;shortfall bigint;computed jsonb;item jsonb;cp campus.funding_component_plans;used bigint;
BEGIN
 PERFORM campus.money_lock_aggregate(oid);SELECT * INTO o FROM campus.funding_obligations WHERE id=oid;PERFORM campus.money_projection(o.aggregate_type,o.aggregate_id);
 IF o.payer_id IS DISTINCT FROM campus.actor() THEN RAISE EXCEPTION 'not_payer' USING ERRCODE='P0001';END IF;
 PERFORM campus.money_environment();
 IF EXISTS(SELECT 1 FROM campus.payment_fee_supplement_attempts a JOIN campus.payment_fee_supplement_obligations fo ON fo.id=a.fee_obligation_id WHERE fo.obligation_id=oid AND a.status NOT IN('succeeded','failed','canceled')) OR EXISTS(SELECT 1 FROM campus.money_operations WHERE obligation_id=oid AND kind='fee_restitution' AND status IN('queued','dispatching','unknown','held')) THEN RAISE EXCEPTION 'fee_reconciliation_in_progress' USING ERRCODE='P0001';END IF;
 SELECT pp.* INTO p FROM campus.payment_execution_policies pp WHERE pp.id=(request->>'policyVersionId')::uuid AND pp.environment_id=o.environment_id AND pp.aggregate_type=o.aggregate_type AND pp.aggregate_id=o.aggregate_id AND pp.purpose='collection' AND pp.status='approved';
 IF p.id IS NULL OR p.digest IS DISTINCT FROM request->>'policyDigest' OR p.payload->>'feeAdjustment' IS DISTINCT FROM 'capped_actual_v1' OR p.payload->>'originalObligationId' IS DISTINCT FROM oid::text OR p.payload->>'originalSourceDigest' IS DISTINCT FROM o.source_digest OR p.digest IS DISTINCT FROM encode(sha256(convert_to(campus.transaction_canonical(p.payload),'UTF8')),'hex') THEN RAISE EXCEPTION 'fee_revision_policy_unavailable' USING ERRCODE='P0001';END IF;
 estimate:=(p.payload->>'supplementalEstimatedFeeCents')::bigint;IF estimate IS NULL OR estimate<0 OR estimate>100000000 THEN RAISE EXCEPTION 'supplemental_fee_estimate_required' USING ERRCODE='P0001';END IF;
 SELECT pp.* INTO plan FROM campus.payment_fee_plans pp JOIN campus.payment_fee_plan_bindings b ON b.plan_id=pp.id WHERE b.obligation_id=oid;IF plan.id IS NULL THEN RAISE EXCEPTION 'fee_cap_consent_required' USING ERRCODE='P0001';END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.payment_billing_bindings WHERE obligation_id=oid AND profile_id IS NOT NULL) THEN RAISE EXCEPTION 'billing_contract_unavailable' USING ERRCODE='P0001';END IF;
 ev:=campus.money_fee_evidence(oid);IF NOT (ev->>'complete')::boolean OR request->>'evidenceDigest' IS DISTINCT FROM encode(sha256(convert_to(campus.transaction_canonical(ev),'UTF8')),'hex') THEN RAISE EXCEPTION 'fee_evidence_refresh_required' USING ERRCODE='P0001';END IF;
 maximum:=(ev->>'totalCents')::bigint+estimate+least(100,(estimate+9)/10);shortfall:=greatest(0,(maximum+1)/2-campus.money_fee_retained_payer(oid));computed:=campus.money_reprice_plan(plan.body->'originalPlan',maximum);
 FOR item IN SELECT value FROM jsonb_array_elements(computed->'lots'->0->'components') LOOP
  SELECT c.* INTO cp FROM campus.funding_component_plans c JOIN campus.funding_lots l ON l.id=c.lot_id WHERE l.obligation_id=oid AND c.member_id=(item->>'memberId')::uuid AND c.stage_position=(item->>'stagePosition')::int;
  SELECT coalesce(sum(amount_cents),0) INTO used FROM campus.money_reservations WHERE component_id=cp.id AND kind IN('transfer','refund') AND status IN('reserved','consumed');
  IF used>(item->>'netCents')::bigint THEN RAISE EXCEPTION 'recipient_fee_recovery_policy_required' USING ERRCODE='P0001';END IF;
 END LOOP;
 SELECT coalesce(max(revision),0)+1 INTO rev FROM campus.payment_fee_revisions WHERE obligation_id=oid;
 bodyvalue:=jsonb_build_object('format','fee_reconfirmation_v1','obligationId',oid,'originalSourceDigest',o.source_digest,'originalChargeId',(SELECT charge_id FROM campus.funding_allocations WHERE lot_id=(SELECT id FROM campus.funding_lots WHERE obligation_id=oid)),'environmentId',o.environment_id,'policyId',p.id,'policyDigest',p.digest,'policyProvenance',p.provenance,'revision',rev,'participants',plan.body->'participants','payerId',o.payer_id,'originalPlan',plan.body->'originalPlan','evidence',ev,'supplementalEstimatedFeeCents',estimate,'maximumTotalFeeCents',maximum,'maximumPayerFeeCents',(maximum+1)/2,'maximumRecipientFeeCents',maximum/2,'supplementalAmountCents',shortfall,'maximumPlan',computed,'restoration','One separately started fee-only payment. All actual fees remain 50/50. Unused payer reserve is owed to the charge that supplied it. No automatic recursive collection. Changed base fee evidence, foreign operations, or combined cost above this cap require a new exact personally confirmed revision. Expected authenticated fees of this one supplementary operation may settle within this signed cap. Principal, stages and roster are unchanged.');
 INSERT INTO campus.payment_fee_revisions(obligation_id,environment_id,revision,policy_id,base_evidence,base_digest,body,digest) VALUES(oid,o.environment_id,rev,p.id,ev,encode(sha256(convert_to(campus.transaction_canonical(ev),'UTF8')),'hex'),bodyvalue,encode(sha256(convert_to(campus.transaction_canonical(bodyvalue),'UTF8')),'hex')) RETURNING id INTO rid;
 RETURN jsonb_build_object('revisionId',rid,'revision',rev,'digest',encode(sha256(convert_to(campus.transaction_canonical(bodyvalue),'UTF8')),'hex'));
END $$;
CREATE FUNCTION campus.money_fee_revision_confirm(rid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.payment_fee_revisions;o campus.funding_obligations;
BEGIN
 SELECT * INTO r FROM campus.payment_fee_revisions WHERE id=rid;PERFORM campus.money_lock_aggregate(r.obligation_id);SELECT * INTO o FROM campus.funding_obligations WHERE id=r.obligation_id;PERFORM campus.money_projection(o.aggregate_type,o.aggregate_id);
 IF NOT coalesce(r.body->'participants' ? campus.actor()::text,false) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 IF r.digest IS DISTINCT FROM request->>'digest' OR r.base_evidence IS DISTINCT FROM campus.money_fee_evidence(r.obligation_id,r.id) OR r.revision<>(SELECT max(revision) FROM campus.payment_fee_revisions WHERE obligation_id=r.obligation_id) OR EXISTS(SELECT 1 FROM campus.payment_fee_supplement_obligations WHERE revision_id=rid) THEN RAISE EXCEPTION 'fee_evidence_refresh_required' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.payment_fee_revision_confirmations VALUES(rid,campus.actor(),r.digest,campus.money_now()) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('revisionId',rid,'participantId',campus.actor(),'digest',r.digest,'confirmed',true);
END $$;
CREATE FUNCTION campus.money_fee_revision_start(rid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.payment_fee_revisions;o campus.funding_obligations;e campus.payment_environments;fo campus.payment_fee_supplement_obligations;a campus.payment_fee_supplement_attempts;aid uuid:=gen_random_uuid();op uuid;bodyvalue jsonb;
BEGIN
 SELECT * INTO r FROM campus.payment_fee_revisions WHERE id=rid;PERFORM campus.money_lock_aggregate(r.obligation_id);SELECT * INTO o FROM campus.funding_obligations WHERE id=r.obligation_id;PERFORM campus.money_projection(o.aggregate_type,o.aggregate_id);
 IF o.payer_id IS DISTINCT FROM campus.actor() THEN RAISE EXCEPTION 'not_payer' USING ERRCODE='P0001';END IF;
 SELECT * INTO e FROM campus.payment_environments WHERE id=r.environment_id AND enabled;IF e.id IS NULL THEN RAISE EXCEPTION 'payments_unavailable' USING ERRCODE='P0001';END IF;
 IF request->>'digest' IS DISTINCT FROM r.digest OR (request->>'acceptedAmountCents')::bigint IS DISTINCT FROM (r.body->>'supplementalAmountCents')::bigint OR r.base_evidence IS DISTINCT FROM campus.money_fee_evidence(r.obligation_id,r.id) OR r.revision<>(SELECT max(revision) FROM campus.payment_fee_revisions WHERE obligation_id=r.obligation_id) THEN RAISE EXCEPTION 'fee_evidence_refresh_required' USING ERRCODE='P0001';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.body->'participants') who WHERE NOT EXISTS(SELECT 1 FROM campus.payment_fee_revision_confirmations c WHERE c.revision_id=rid AND c.user_id=who::uuid AND c.digest=r.digest)) THEN RAISE EXCEPTION 'fee_revision_confirmation_required' USING ERRCODE='P0001';END IF;
 SELECT * INTO fo FROM campus.payment_fee_supplement_obligations WHERE revision_id=rid;
 IF fo.id IS NOT NULL THEN SELECT * INTO a FROM campus.payment_fee_supplement_attempts WHERE fee_obligation_id=fo.id;RETURN jsonb_build_object('revisionId',rid,'feeObligationId',fo.id,'attemptId',a.id,'operationId',a.operation_id,'amountCents',fo.amount_cents);END IF;
 IF (r.body->>'supplementalAmountCents')::bigint=0 THEN RAISE EXCEPTION 'supplemental_payment_not_required' USING ERRCODE='P0001';END IF;
 INSERT INTO campus.payment_fee_supplement_obligations(revision_id,obligation_id,environment_id,payer_id,amount_cents,source_digest) VALUES(rid,o.id,o.environment_id,o.payer_id,(r.body->>'supplementalAmountCents')::bigint,r.digest) RETURNING * INTO fo;
 bodyvalue:=jsonb_build_object('attemptId',aid,'obligationId',o.id,'feeObligationId',fo.id,'feeRevisionId',rid,'quoteDigest',r.digest,'amountCents',fo.amount_cents,'currency','usd','sourceDigest',r.digest,'platformAccountId',e.platform_account_id,'mode',e.mode,'returnUrl',e.origin||'/?view=workspace&tab=agreements&resource='||o.aggregate_type||'&id='||o.aggregate_id,'purpose','supplemental_processing_fee_reserve');
 op:=campus.money_enqueue(e.id,o.id,'fee_supplement_checkout',rid::text,bodyvalue);INSERT INTO campus.payment_fee_supplement_attempts(id,fee_obligation_id,operation_id) VALUES(aid,fo.id,op);
 RETURN jsonb_build_object('revisionId',rid,'feeObligationId',fo.id,'attemptId',aid,'operationId',op,'amountCents',fo.amount_cents);
END $$;
CREATE FUNCTION campus.money_fee_profile_closed(oid uuid,fact jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT coalesce((SELECT p.billing_mode='inline' AND ((p.contract->>'kind'='synthetic_original_charge_balance_v1' AND e.mode='sandbox' AND p.provenance LIKE 'Synthetic:%') OR (p.contract->>'kind'='stripe_standard_inline_charge_balance_v1' AND p.contract->>'pricingModel'='standard_non_ic_plus' AND p.contract->>'source'='https://docs.stripe.com/expand/use-cases' AND p.provenance NOT LIKE 'Synthetic:%' AND p.contract->>'accountEvidenceDigest' ~ '^[a-f0-9]{64}$' AND coalesce(p.contract->>'accountEvidenceRef','')<>'')) AND fact->>'processingFeeSource'='succeeded_captured_original_charge_balance_v1' AND p.platform_account_id=fact->>'platformAccountId' AND fact->>'environmentId'=e.id::text AND coalesce(fact->>'feeFactId','')<>'' FROM campus.payment_billing_bindings b JOIN campus.payment_billing_profiles p ON p.id=b.profile_id JOIN campus.payment_environments e ON e.id=b.environment_id WHERE b.obligation_id=oid),false)
$$;
CREATE FUNCTION campus.money_fee_supplement_expected(eid uuid,objectid text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('id',a.id,'sessionId',a.session_id,'intentId',a.intent_id,'chargeId',a.charge_id,'environmentId',fo.environment_id,'operationId',a.operation_id,'obligationId',fo.obligation_id,'amountCents',fo.amount_cents,'sourceDigest',fo.source_digest,'quoteDigest',r.digest,'platformAccountId',e.platform_account_id,'mode',e.mode,'feeRevisionId',r.id) FROM campus.payment_fee_supplement_attempts a JOIN campus.payment_fee_supplement_obligations fo ON fo.id=a.fee_obligation_id JOIN campus.payment_fee_revisions r ON r.id=fo.revision_id JOIN campus.payment_environments e ON e.id=fo.environment_id WHERE fo.environment_id=eid AND objectid IN(a.id::text,a.session_id,a.intent_id,a.charge_id)
$$;
CREATE FUNCTION campus.money_fee_supplement_fact(aid uuid,incoming jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE a campus.payment_fee_supplement_attempts;fo campus.payment_fee_supplement_obligations;prior campus.payment_fee_supplement_receipts;lid uuid;jid uuid;actual bigint;
BEGIN
 SELECT * INTO a FROM campus.payment_fee_supplement_attempts WHERE id=aid;SELECT * INTO fo FROM campus.payment_fee_supplement_obligations WHERE id=a.fee_obligation_id;
 IF fo.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;
 PERFORM campus.money_lock_aggregate(fo.obligation_id);PERFORM campus.money_cash_lock(fo.environment_id);
 IF incoming->>'status' IN('requires_action','processing','terminal_unpaid') THEN UPDATE campus.payment_fee_supplement_attempts SET status=CASE WHEN incoming->>'status'='terminal_unpaid' THEN 'canceled' ELSE incoming->>'status' END WHERE id=aid AND status<>'succeeded';RETURN incoming->>'status'='terminal_unpaid';END IF;
 IF incoming->>'status' IS DISTINCT FROM 'succeeded' OR incoming->>'environmentId' IS DISTINCT FROM fo.environment_id::text OR incoming->>'sessionId' IS DISTINCT FROM a.session_id OR incoming->>'sourceDigest' IS DISTINCT FROM fo.source_digest OR (incoming->>'amountCents')::bigint IS DISTINCT FROM fo.amount_cents OR incoming->>'currency' IS DISTINCT FROM 'usd' OR coalesce(incoming->>'chargeId','')='' OR coalesce(incoming->>'intentId','')='' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
 SELECT id INTO lid FROM campus.funding_lots WHERE obligation_id=fo.obligation_id;actual:=(incoming->>'actualFeeCents')::bigint;
 SELECT * INTO prior FROM campus.payment_fee_supplement_receipts WHERE attempt_id=aid FOR UPDATE;
 IF prior.attempt_id IS NOT NULL AND (prior.charge_id IS DISTINCT FROM incoming->>'chargeId' OR (prior.fee_cents IS NOT NULL AND actual IS NOT NULL AND (prior.fee_cents<>actual OR prior.fee_fact_id IS DISTINCT FROM incoming->>'feeFactId'))) THEN
  INSERT INTO campus.payment_fee_evidence_conflicts(environment_id,identity,observation) VALUES(fo.environment_id,'supplement:'||aid::text,jsonb_build_object('observed',incoming)) ON CONFLICT DO NOTHING;PERFORM campus.money_hold(fo.obligation_id,'fee_fact_changed','supplement_fee_changed:'||aid::text,incoming);RETURN false;
 END IF;
 IF prior.attempt_id IS NULL THEN
  jid:=campus.money_journal(fo.environment_id,lid,'fee_supplement_receipt:'||(incoming->>'chargeId'),jsonb_build_array(jsonb_build_object('account','cash','debit',fo.amount_cents),jsonb_build_object('account','publisher_fee_liability','credit',fo.amount_cents)));
  INSERT INTO campus.payment_fee_supplement_receipts(attempt_id,environment_id,obligation_id,revision_id,charge_id,amount_cents,fact,receipt_journal_id) VALUES(aid,fo.environment_id,fo.obligation_id,fo.revision_id,incoming->>'chargeId',fo.amount_cents,incoming,jid);
 END IF;
 IF actual IS NOT NULL AND prior.fee_cents IS NULL THEN
  IF actual<0 OR coalesce(incoming->>'feeFactId','')='' THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  IF EXISTS(SELECT 1 FROM campus.payment_fee_supplement_receipts WHERE environment_id=fo.environment_id AND fee_fact_id=incoming->>'feeFactId' AND attempt_id<>aid) OR EXISTS(SELECT 1 FROM campus.payment_receipt_facts WHERE environment_id=fo.environment_id AND fee_fact_id=incoming->>'feeFactId') OR EXISTS(SELECT 1 FROM campus.payment_fee_cash_facts WHERE environment_id=fo.environment_id AND balance_id=incoming->>'feeFactId') THEN RAISE EXCEPTION 'provider_fact_mismatch' USING ERRCODE='P0001';END IF;
  IF actual>0 THEN PERFORM campus.money_journal(fo.environment_id,lid,'fee_supplement_fee:'||(incoming->>'feeFactId'),jsonb_build_array(jsonb_build_object('account','fee_expense','debit',actual),jsonb_build_object('account','cash','credit',actual)));END IF;
  UPDATE campus.payment_fee_supplement_receipts SET fee_cents=actual,fee_fact_id=incoming->>'feeFactId' WHERE attempt_id=aid;
 END IF;
 UPDATE campus.payment_fee_supplement_receipts SET available_cents=(incoming->>'availableCents')::bigint,fact=incoming WHERE attempt_id=aid;
 UPDATE campus.payment_fee_supplement_attempts SET status='succeeded',charge_id=incoming->>'chargeId',intent_id=incoming->>'intentId',hosted_url=NULL WHERE id=aid;
 RETURN actual IS NOT NULL AND incoming->>'availableCents' IS NOT NULL AND campus.money_fee_charge_closed(fo.obligation_id,incoming->>'chargeId',incoming);
END $$;
ALTER FUNCTION campus.money_operation_result(uuid,bigint,jsonb) RENAME TO money_operation_result_before_supplement;
CREATE FUNCTION campus.money_operation_result(opid uuid,token bigint,outcome jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE op campus.money_operations;done boolean;
BEGIN
 SELECT * INTO op FROM campus.money_operations WHERE id=opid;
 IF op.kind='fee_supplement_checkout' AND outcome->>'status'='failed_no_effect' THEN
  PERFORM campus.money_lock_aggregate(op.obligation_id);PERFORM campus.money_cash_lock(op.environment_id);SELECT * INTO op FROM campus.money_operations WHERE id=opid FOR UPDATE;
  IF op.status<>'dispatching' OR op.fence<>token OR token<>1 OR op.provider_id IS NOT NULL OR op.lease_until<campus.money_now() OR (SELECT attempts FROM campus.payment_outbox WHERE operation_id=opid)<>1 THEN RETURN false;END IF;
  UPDATE campus.money_operations SET status='failed',lease_until=NULL,result=outcome WHERE id=opid;UPDATE campus.payment_fee_supplement_attempts SET status='failed' WHERE operation_id=opid;UPDATE campus.payment_outbox SET dead_letter=true,last_code='definitive_no_effect' WHERE operation_id=opid;RETURN true;
 END IF;
 done:=campus.money_operation_result_before_supplement(opid,token,outcome);
 IF done AND op.kind='fee_supplement_checkout' THEN
  IF outcome->>'status'='succeeded' THEN
   UPDATE campus.payment_fee_supplement_attempts SET session_id=outcome->>'id',hosted_url=outcome->>'url',expires_at=to_timestamp((outcome->>'expiresAt')::double precision),status=CASE WHEN status='succeeded' THEN status ELSE 'requires_action' END WHERE operation_id=opid;
   PERFORM campus.money_reconcile_schedule(op.environment_id,'fee_supplement',outcome->>'id','{}');
  ELSIF outcome->>'status'='unknown' THEN UPDATE campus.payment_fee_supplement_attempts SET status='unknown' WHERE operation_id=opid AND status<>'succeeded';END IF;
 END IF;RETURN done;
END $$;
ALTER FUNCTION campus.money_dispatchable(campus.money_operations) RENAME TO money_dispatchable_before_supplement;
CREATE FUNCTION campus.money_dispatchable(op campus.money_operations) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.payment_fee_revisions;
BEGIN
 IF op.kind<>'fee_supplement_checkout' THEN RETURN campus.money_dispatchable_before_supplement(op);END IF;
 SELECT * INTO r FROM campus.payment_fee_revisions WHERE id=(op.payload->>'feeRevisionId')::uuid AND obligation_id=op.obligation_id AND environment_id=op.environment_id;
 RETURN r.id IS NOT NULL AND EXISTS(SELECT 1 FROM campus.payment_environments WHERE id=op.environment_id AND enabled) AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=op.environment_id) AND r.base_evidence=campus.money_fee_evidence(r.obligation_id,r.id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.body->'participants')who WHERE NOT EXISTS(SELECT 1 FROM campus.payment_fee_revision_confirmations c WHERE c.revision_id=r.id AND c.user_id=who::uuid AND c.digest=r.digest)) AND EXISTS(SELECT 1 FROM campus.users WHERE id=(r.body->>'payerId')::uuid AND account_status='active');
END $$;
-- Only the exact fee evidence resolved by this revision is excluded. A later fact
-- makes the historical resolution inapplicable without altering either row.
CREATE OR REPLACE VIEW campus.money_active_holds AS SELECT h.* FROM campus.payment_holds h WHERE h.active AND NOT EXISTS(
 SELECT 1 FROM campus.payment_fee_hold_resolutions rr JOIN campus.payment_fee_revision_settlements ss ON ss.revision_id=rr.revision_id WHERE rr.hold_id=h.id AND rr.evidence_digest=encode(sha256(convert_to(campus.transaction_canonical(campus.money_fee_evidence(h.obligation_id)),'UTF8')),'hex') AND ss.obligation_id=h.obligation_id
);
CREATE FUNCTION campus.money_fee_revision_settle(rid uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.payment_fee_revisions;o campus.funding_obligations;plan campus.payment_fee_plans;f campus.funding_allocations;ev jsonb;computed jsonb;actual bigint;prior_payer bigint;prior_recipient bigint;delta bigint;entries jsonb:='[]';jid uuid;item jsonb;c campus.funding_component_plans;oldfee bigint;used bigint;pay campus.payables;retained bigint;restitution bigint;source record;refundused bigint;piece bigint;fingerprint text;
BEGIN
 SELECT * INTO r FROM campus.payment_fee_revisions WHERE id=rid;IF r.id IS NULL THEN RETURN false;END IF;
 PERFORM campus.money_lock_aggregate(r.obligation_id);SELECT * INTO o FROM campus.funding_obligations WHERE id=r.obligation_id;PERFORM campus.money_cash_lock(o.environment_id);
 IF EXISTS(SELECT 1 FROM campus.payment_fee_revision_settlements WHERE revision_id=rid) THEN RETURN true;END IF;
 IF r.revision<>(SELECT max(revision) FROM campus.payment_fee_revisions WHERE obligation_id=o.id) OR r.base_evidence IS DISTINCT FROM campus.money_fee_evidence(o.id,rid) OR EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=o.environment_id) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.body->'participants')who WHERE NOT EXISTS(SELECT 1 FROM campus.payment_fee_revision_confirmations cc WHERE cc.revision_id=rid AND cc.user_id=who::uuid AND cc.digest=r.digest)) THEN RETURN false;END IF;
 SELECT pp.* INTO plan FROM campus.payment_fee_plans pp JOIN campus.payment_fee_plan_bindings b ON b.plan_id=pp.id WHERE b.obligation_id=o.id;
 SELECT ff.* INTO f FROM campus.funding_allocations ff JOIN campus.funding_lots l ON l.id=ff.lot_id WHERE l.obligation_id=o.id;
 IF f.available_cents IS NULL OR NOT campus.money_fee_charge_closed(o.id,f.charge_id,jsonb_build_object('environmentId',o.environment_id,'platformAccountId',(SELECT platform_account_id FROM campus.payment_environments WHERE id=o.environment_id),'processingFeeSource','succeeded_captured_original_charge_balance_v1','feeFactId',f.fee_fact_id)) THEN RETURN false;END IF;
 IF (r.body->>'supplementalAmountCents')::bigint>0 AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_supplement_receipts sr WHERE sr.revision_id=rid AND sr.available_cents IS NOT NULL AND sr.fee_cents IS NOT NULL AND campus.money_fee_charge_closed(o.id,sr.charge_id,sr.fact)) THEN RETURN false;END IF;
 ev:=campus.money_fee_evidence(o.id);IF NOT (ev->>'complete')::boolean THEN RETURN false;END IF;actual:=(ev->>'totalCents')::bigint;
 IF actual>(r.body->>'maximumTotalFeeCents')::bigint THEN PERFORM campus.money_hold(o.id,'fee_cap_reconfirmation_required','fee_cap_revision:'||rid::text,ev);RETURN false;END IF;
 retained:=campus.money_fee_retained_payer(o.id);IF retained<(actual+1)/2 THEN RETURN false;END IF;
 SELECT ss.payer_fee_cents,ss.recipient_fee_cents INTO prior_payer,prior_recipient FROM campus.payment_fee_revision_settlements ss JOIN campus.payment_fee_revisions rr ON rr.id=ss.revision_id WHERE ss.obligation_id=o.id ORDER BY rr.revision DESC LIMIT 1;
 IF prior_payer IS NULL THEN SELECT payer_fee_cents,recipient_fee_cents INTO prior_payer,prior_recipient FROM campus.payment_fee_settlements WHERE obligation_id=o.id;END IF;
 prior_payer:=coalesce(prior_payer,0);prior_recipient:=coalesce(prior_recipient,0);
 IF (actual+1)/2<prior_payer OR actual/2<prior_recipient THEN PERFORM campus.money_hold(o.id,'fee_correction_policy_required','fee_correction:'||rid::text,ev);RETURN false;END IF;
 computed:=campus.money_reprice_plan(plan.body->'originalPlan',actual);
 -- Recheck every exact component before any liability posting, under the shared aggregate lock.
 FOR item IN SELECT value FROM jsonb_array_elements(computed->'lots'->0->'components') LOOP
  SELECT cc.* INTO c FROM campus.funding_component_plans cc WHERE cc.lot_id=f.lot_id AND cc.member_id=(item->>'memberId')::uuid AND cc.stage_position=(item->>'stagePosition')::int;
  SELECT coalesce(sum(amount_cents),0) INTO used FROM campus.money_reservations WHERE component_id=c.id AND kind IN('transfer','refund') AND status IN('reserved','consumed');
  IF used>(item->>'netCents')::bigint THEN PERFORM campus.money_hold(o.id,'recipient_fee_recovery_policy_required','fee_recovery_policy:'||rid::text,jsonb_build_object('componentId',c.id));RETURN false;END IF;
 END LOOP;
 IF (actual+1)/2>prior_payer THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','publisher_fee_liability','debit',(actual+1)/2-prior_payer));END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(computed->'lots'->0->'components') LOOP
  SELECT cc.* INTO c FROM campus.funding_component_plans cc WHERE cc.lot_id=f.lot_id AND cc.member_id=(item->>'memberId')::uuid AND cc.stage_position=(item->>'stagePosition')::int;
  IF prior_payer=0 AND prior_recipient=0 THEN oldfee:=0;ELSE SELECT recipient_fee_cents INTO oldfee FROM campus.money_effective_components WHERE id=c.id;END IF;
  delta:=(item->>'recipientFeeCents')::bigint-oldfee;IF delta<0 THEN RAISE EXCEPTION 'fee_correction_policy_required' USING ERRCODE='P0001';END IF;
  SELECT * INTO pay FROM campus.payables WHERE component_id=c.id FOR UPDATE;
  IF delta>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account',CASE WHEN pay.id IS NULL THEN 'reward_liability' ELSE 'payable' END,'debit',delta,'memberId',c.member_id,'componentId',c.id));END IF;
  IF pay.id IS NOT NULL THEN UPDATE campus.payables SET net_cents=(item->>'netCents')::bigint WHERE id=pay.id;END IF;
 END LOOP;
 delta:=actual-prior_payer-prior_recipient;IF delta>0 THEN entries:=entries||jsonb_build_array(jsonb_build_object('account','fee_recovery','credit',delta));jid:=campus.money_journal(o.environment_id,f.lot_id,'fee_revision_recovery:'||rid::text,entries);END IF;
 fingerprint:=encode(sha256(convert_to(campus.transaction_canonical(ev),'UTF8')),'hex');
 INSERT INTO campus.payment_fee_revision_settlements VALUES(rid,o.id,actual,(actual+1)/2,actual/2,computed,ev,fingerprint,jid,campus.money_now());
 UPDATE campus.money_reservations SET status='consumed' WHERE lot_id=f.lot_id AND kind IN('publisher_fee','recipient_fee') AND status='reserved';
 INSERT INTO campus.fee_consumptions SELECT rr.id,o.environment_id,f.lot_id,'fee_revision:'||rid::text,coalesce(jid,f.receipt_journal_id) FROM campus.money_reservations rr WHERE rr.lot_id=f.lot_id AND rr.kind IN('publisher_fee','recipient_fee') ON CONFLICT DO NOTHING;
 UPDATE campus.funding_allocations SET fee_state='matched' WHERE lot_id=f.lot_id;
 INSERT INTO campus.payment_fee_hold_resolutions SELECT h.id,rid,fingerprint FROM campus.payment_holds h WHERE h.obligation_id=o.id AND h.reason='fee_cap_reconfirmation_required' AND h.active ON CONFLICT DO NOTHING;
 restitution:=retained-(actual+1)/2;
 -- Refund newest reserve first, then original reserve; never exceed a charge's retained contribution.
 FOR source IN SELECT charge_id,amount_cents,rank FROM (SELECT sr.charge_id,sr.amount_cents,rr.revision AS rank FROM campus.payment_fee_supplement_receipts sr JOIN campus.payment_fee_revisions rr ON rr.id=sr.revision_id WHERE sr.obligation_id=o.id UNION ALL SELECT f.charge_id,o.publisher_fee_cents,0) sources ORDER BY rank DESC LOOP
  EXIT WHEN restitution=0;
  SELECT coalesce(sum(mr.amount_cents),0) INTO refundused FROM campus.money_reservations mr JOIN campus.money_operations mo ON mo.id=mr.operation_id WHERE mo.obligation_id=o.id AND mr.kind='fee_restitution' AND mr.status IN('reserved','consumed') AND mo.payload->>'sourceCharge'=source.charge_id;
  piece:=least(restitution,greatest(0,source.amount_cents-refundused));IF piece>0 THEN INSERT INTO campus.payment_fee_revision_restitutions(revision_id,obligation_id,environment_id,charge_id,amount_cents) VALUES(rid,o.id,o.environment_id,source.charge_id,piece);restitution:=restitution-piece;END IF;
 END LOOP;
 IF restitution<>0 THEN RAISE EXCEPTION 'restitution_source_mismatch' USING ERRCODE='P0001';END IF;RETURN true;
END $$;
CREATE OR REPLACE VIEW campus.money_effective_components AS
 SELECT c.id,c.lot_id,c.environment_id,c.allocation_component_id,c.member_id,c.milestone_id,c.stage_position,c.gross_cents,
 coalesce((newest.item->>'recipientFeeCents')::bigint,s.recipient_fee_cents,c.recipient_fee_cents) AS recipient_fee_cents,
 coalesce((newest.item->>'netCents')::bigint,s.net_cents,c.net_cents) AS net_cents
 FROM campus.funding_component_plans c LEFT JOIN campus.payment_fee_settlement_components s ON s.component_id=c.id
 LEFT JOIN LATERAL(SELECT i AS item FROM campus.payment_fee_revision_settlements ss JOIN campus.payment_fee_revisions rr ON rr.id=ss.revision_id JOIN campus.funding_lots l ON l.obligation_id=ss.obligation_id CROSS JOIN LATERAL jsonb_array_elements(ss.actual_plan->'lots'->0->'components')i WHERE l.id=c.lot_id AND i->>'memberId'=c.member_id::text AND (i->>'stagePosition')::int=c.stage_position ORDER BY rr.revision DESC LIMIT 1)newest ON true;
ALTER FUNCTION campus.money_prepare_restitution(uuid,uuid) RENAME TO money_prepare_restitution_before_revision;
CREATE FUNCTION campus.money_prepare_restitution(eid uuid,oid uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE rr campus.payment_fee_revision_restitutions;op campus.money_operations;newid uuid;lid uuid;n integer:=0;generation integer;
BEGIN
 PERFORM campus.money_lock_aggregate(oid);PERFORM campus.money_cash_lock(eid);
 IF NOT EXISTS(SELECT 1 FROM campus.payment_fee_revision_settlements WHERE obligation_id=oid) THEN RETURN campus.money_prepare_restitution_before_revision(eid,oid);END IF;
 IF EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=eid) OR EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=oid) OR campus.money_cash_headroom(eid,NULL)<0 OR campus.money_cash_headroom(eid,(SELECT id FROM campus.funding_lots WHERE obligation_id=oid))<0 THEN RETURN 0;END IF;
 SELECT id INTO lid FROM campus.funding_lots WHERE obligation_id=oid AND environment_id=eid;
 FOR rr IN SELECT * FROM campus.payment_fee_revision_restitutions WHERE obligation_id=oid AND environment_id=eid ORDER BY id LOOP
  SELECT * INTO op FROM campus.money_operations WHERE obligation_id=oid AND kind='fee_restitution' AND payload->>'restitutionId'=rr.id::text ORDER BY created_at DESC,id DESC LIMIT 1;
  IF op.id IS NOT NULL AND (op.status<>'failed' OR NOT EXISTS(SELECT 1 FROM campus.money_reservations WHERE operation_id=op.id AND status='released')) THEN CONTINUE;END IF;
  generation:=coalesce((op.payload->>'generation')::int,0)+1;
  newid:=campus.money_enqueue(eid,oid,'fee_restitution','revision:'||rr.id::text||':'||generation,jsonb_build_object('restitutionId',rr.id,'feeRevisionId',rr.revision_id,'generation',generation,'amountCents',rr.amount_cents,'currency','usd','sourceCharge',rr.charge_id,'purpose','unused_preconsented_payer_fee_reserve','sourceDigest',(SELECT digest FROM campus.payment_fee_revisions WHERE id=rr.revision_id)));
  INSERT INTO campus.money_reservations(environment_id,lot_id,operation_id,kind,amount_cents) VALUES(eid,lid,newid,'fee_restitution',rr.amount_cents);n:=n+1;
 END LOOP;RETURN n;
END $$;
CREATE FUNCTION campus.money_fee_revision_targets(eid uuid,oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT coalesce(jsonb_agg(id),'[]') FROM (SELECT r.id FROM campus.payment_fee_revisions r WHERE r.environment_id=eid AND r.obligation_id=oid ORDER BY r.revision DESC LIMIT 1) q
$$;
DO $$ DECLARE t text;p record;BEGIN
 FOREACH t IN ARRAY ARRAY['payment_fee_revisions','payment_fee_revision_confirmations','payment_fee_supplement_obligations','payment_fee_supplement_attempts','payment_fee_supplement_receipts','payment_fee_revision_settlements','payment_fee_hold_resolutions','payment_fee_revision_restitutions'] LOOP
  EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);
  IF t NOT IN('payment_fee_supplement_attempts','payment_fee_supplement_receipts') THEN EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);END IF;
  EXECUTE format('CREATE TRIGGER money_effect AFTER INSERT OR UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_capture_effect()',t);
 END LOOP;
 FOR p IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='campus'::regnamespace AND proname IN('money_fee_evidence','money_fee_retained_payer','money_fee_revision_propose','money_fee_revision_confirm','money_fee_revision_start','money_fee_profile_closed','money_fee_supplement_expected','money_fee_supplement_fact','money_operation_result','money_operation_result_before_supplement','money_dispatchable','money_dispatchable_before_supplement','money_fee_revision_settle','money_prepare_restitution','money_prepare_restitution_before_revision','money_fee_revision_targets') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.signature);END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION campus.money_fee_revision_propose(uuid,jsonb),campus.money_fee_revision_confirm(uuid,jsonb),campus.money_fee_revision_start(uuid,jsonb) TO campus_app;
GRANT EXECUTE ON FUNCTION campus.money_fee_supplement_expected(uuid,text),campus.money_fee_supplement_fact(uuid,jsonb),campus.money_operation_result(uuid,bigint,jsonb),campus.money_fee_revision_settle(uuid),campus.money_prepare_restitution(uuid,uuid),campus.money_fee_revision_targets(uuid,uuid) TO campus_worker;

-- Supplemental receipts add only verified available net; their original fee is offset exactly once.
CREATE OR REPLACE FUNCTION campus.money_cash_raw(eid uuid,lid uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 WITH cash AS (
  SELECT coalesce(sum(ll.debit-ll.credit),0) AS book,coalesce(sum(ll.credit),0) AS debits FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=eid AND (lid IS NULL OR j.lot_id=lid) AND ll.account='cash'
 ), originals AS (
  SELECT coalesce(sum(available),0) AS available,coalesce(sum(fee),0) AS original_fees FROM (SELECT coalesce(available_cents,0) available,coalesce(actual_fee_cents,0) fee FROM campus.funding_allocations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) UNION ALL SELECT coalesce(sr.available_cents,0),coalesce(sr.fee_cents,0) FROM campus.payment_fee_supplement_receipts sr JOIN campus.funding_lots l ON l.obligation_id=sr.obligation_id WHERE sr.environment_id=eid AND (lid IS NULL OR l.id=lid)) verified_receipts
 ), reserved AS (
  SELECT coalesce(sum(amount_cents-cash_debited_cents),0) AS amount FROM campus.money_reservations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind IN('transfer','refund','fee_restitution') AND status='reserved'
 ), unresolved_fees AS (
  SELECT coalesce(sum(greatest(0,(SELECT coalesce(sum(amount_cents),0) FROM campus.money_reservations r WHERE r.lot_id=f.lot_id AND kind IN('publisher_fee','recipient_fee') AND status='reserved')-coalesce(f.actual_fee_cents,0)-coalesce((SELECT sum(a.amount_cents) FROM campus.payment_fee_attributions a WHERE a.lot_id=f.lot_id),0))),0) AS amount FROM campus.funding_allocations f WHERE f.environment_id=eid AND (lid IS NULL OR f.lot_id=lid)
 ), restitution_due AS (
  SELECT coalesce(sum(amount),0) AS amount FROM (
 SELECT greatest(0,s.restitution_cents-coalesce((SELECT sum(r.amount_cents) FROM campus.money_reservations r WHERE r.lot_id=s.lot_id AND r.kind='fee_restitution' AND r.status IN('reserved','consumed')),0)) AS amount FROM campus.payment_fee_settlements s WHERE s.environment_id=eid AND (lid IS NULL OR s.lot_id=lid) AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_revision_settlements rs WHERE rs.obligation_id=s.obligation_id)
 UNION ALL SELECT greatest(0,rr.amount_cents-coalesce((SELECT sum(r.amount_cents) FROM campus.money_reservations r JOIN campus.money_operations m ON m.id=r.operation_id WHERE m.payload->>'restitutionId'=rr.id::text AND r.kind='fee_restitution' AND r.status IN('reserved','consumed')),0)) FROM campus.payment_fee_revision_restitutions rr JOIN campus.funding_lots l ON l.obligation_id=rr.obligation_id WHERE rr.environment_id=eid AND (lid IS NULL OR l.id=lid)
 ) owed
 )
 SELECT least(cash.book,originals.available
  +coalesce((SELECT sum(net_cents) FROM campus.payment_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_external_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_restitution_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(amount_cents) FROM campus.payment_network_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind='credit' AND available),0)
  -cash.debits+originals.original_fees)-reserved.amount-unresolved_fees.amount-restitution_due.amount-CASE WHEN lid IS NULL THEN 0 ELSE coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_attributions WHERE environment_id=eid AND lot_id=lid),0) END FROM cash,originals,reserved,unresolved_fees,restitution_due
$$;
CREATE FUNCTION campus.money_fee_revision_read(oid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;r campus.payment_fee_revisions;p campus.payment_execution_policies;ev jsonb;confirmed jsonb;actions jsonb:='["refresh"]';state text:='not_proposed';a campus.payment_fee_supplement_attempts;ss campus.payment_fee_revision_settlements;
BEGIN
 SELECT * INTO o FROM campus.funding_obligations WHERE id=oid;IF o.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';END IF;PERFORM campus.money_projection(o.aggregate_type,o.aggregate_id);
 ev:=campus.money_fee_evidence(oid);SELECT * INTO r FROM campus.payment_fee_revisions WHERE obligation_id=oid ORDER BY revision DESC LIMIT 1;
 SELECT * INTO p FROM campus.payment_execution_policies WHERE environment_id=o.environment_id AND aggregate_type=o.aggregate_type AND aggregate_id=o.aggregate_id AND purpose='collection' AND status='approved' AND payload->>'originalObligationId'=oid::text AND payload->>'originalSourceDigest'=o.source_digest AND payload ? 'supplementalEstimatedFeeCents' ORDER BY version DESC LIMIT 1;
 IF r.id IS NOT NULL THEN
  SELECT coalesce(jsonb_agg(user_id ORDER BY user_id),'[]') INTO confirmed FROM campus.payment_fee_revision_confirmations WHERE revision_id=r.id;
  SELECT aa.* INTO a FROM campus.payment_fee_supplement_attempts aa JOIN campus.payment_fee_supplement_obligations fo ON fo.id=aa.fee_obligation_id WHERE fo.revision_id=r.id;
  SELECT * INTO ss FROM campus.payment_fee_revision_settlements WHERE revision_id=r.id;
  state:=CASE WHEN ss.revision_id IS NOT NULL AND ss.evidence IS DISTINCT FROM ev THEN 'evidence_changed' WHEN ss.revision_id IS NOT NULL THEN 'settled' WHEN (ev->>'complete')::boolean AND (ev->>'totalCents')::bigint>(r.body->>'maximumTotalFeeCents')::bigint THEN 'fee_reconfirmation_required' WHEN r.base_evidence IS DISTINCT FROM campus.money_fee_evidence(oid,r.id) THEN 'evidence_changed' WHEN a.status IN('failed','canceled') THEN 'unpaid_terminal' WHEN a.id IS NOT NULL THEN 'awaiting_fee_facts' WHEN jsonb_array_length(confirmed)<jsonb_array_length(r.body->'participants') THEN 'awaiting_confirmations' WHEN (r.body->>'supplementalAmountCents')::bigint=0 THEN 'awaiting_settlement' ELSE 'ready_to_collect' END;
  IF state='awaiting_confirmations' AND r.body->'participants' ? campus.actor()::text AND NOT confirmed ? campus.actor()::text THEN actions:=actions||'"confirm_fee_revision"'::jsonb;END IF;
  IF state='ready_to_collect' AND campus.actor()=o.payer_id THEN actions:=actions||'"start_fee_supplement"'::jsonb;END IF;
  IF a.status='requires_action' AND a.expires_at>campus.money_now() AND campus.actor()=o.payer_id THEN actions:=actions||'"open_fee_checkout"'::jsonb;END IF;
 END IF;
 IF campus.actor()=o.payer_id AND p.id IS NOT NULL AND (ev->>'complete')::boolean AND (r.id IS NULL OR state IN('settled','evidence_changed','unpaid_terminal','fee_reconfirmation_required') OR (state='awaiting_fee_facts' AND a.status='succeeded' AND (ev->>'totalCents')::bigint>(r.body->>'maximumTotalFeeCents')::bigint)) THEN actions:=actions||'"propose_fee_revision"'::jsonb;END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.payment_environments WHERE id=o.environment_id AND enabled) OR NOT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN actions:='["refresh"]';END IF;
 RETURN jsonb_build_object('obligationId',oid,'environmentId',o.environment_id,'policyVersionId',p.id,'policyDigest',p.digest,'evidence',ev,'evidenceDigest',encode(sha256(convert_to(campus.transaction_canonical(ev),'UTF8')),'hex'),'revisionId',r.id,'revision',r.revision,'digest',r.digest,'plan',r.body,'confirmedParticipantIds',coalesce(confirmed,'[]'),'state',state,'allowedActions',actions,'attempt',CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('id',a.id,'operationId',a.operation_id,'status',a.status,'hostedUrl',CASE WHEN campus.actor()=o.payer_id AND a.status='requires_action' AND a.expires_at>campus.money_now() THEN a.hosted_url END,'expiresAt',a.expires_at) END,'settledActualFeeCents',ss.actual_fee_cents::text,'blockedReasons',CASE WHEN state='fee_reconfirmation_required' THEN '["fee_cap_reconfirmation_required"]'::jsonb WHEN state='evidence_changed' THEN '["fee_evidence_refresh_required"]'::jsonb WHEN p.id IS NULL THEN '["supplemental_fee_estimate_or_policy_required"]'::jsonb WHEN NOT (ev->>'complete')::boolean THEN '["fee_evidence_pending"]'::jsonb ELSE '[]'::jsonb END);
END $$;
CREATE FUNCTION campus.money_fee_revision_current(rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT campus.money_fee_revision_read(obligation_id) FROM campus.payment_fee_revisions WHERE id=rid $$;
REVOKE ALL ON FUNCTION campus.money_fee_revision_read(uuid),campus.money_fee_revision_current(uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_fee_revision_read(uuid),campus.money_fee_revision_current(uuid) TO campus_app;
ALTER FUNCTION campus.money_find_attempt(uuid,text) RENAME TO money_find_attempt_before_supplement;
CREATE FUNCTION campus.money_find_attempt(eid uuid,objectid text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$ SELECT coalesce(campus.money_find_attempt_before_supplement(eid,objectid),campus.money_fee_supplement_expected(eid,objectid)) $$;
REVOKE ALL ON FUNCTION campus.money_find_attempt_before_supplement(uuid,text),campus.money_find_attempt(uuid,text) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_find_attempt(uuid,text) TO campus_worker;
-- A report may identify a supplemental charge without granting principal authority.
CREATE TABLE campus.payment_fee_supplement_attributions (
 environment_id uuid NOT NULL,semantic_id text NOT NULL,balance_id text NOT NULL,attempt_id uuid NOT NULL REFERENCES campus.payment_fee_supplement_receipts,
 lot_id uuid NOT NULL REFERENCES campus.funding_lots,obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,charge_id text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>=0),profile_id uuid NOT NULL REFERENCES campus.payment_billing_profiles,
 PRIMARY KEY(environment_id,semantic_id),FOREIGN KEY(environment_id,semantic_id) REFERENCES campus.payment_fee_report_rows,FOREIGN KEY(environment_id,balance_id) REFERENCES campus.payment_fee_cash_facts
);
ALTER TABLE campus.payment_fee_supplement_attributions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_fee_supplement_attributions FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_fee_supplement_attributions FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE TRIGGER money_effect AFTER INSERT ON campus.payment_fee_supplement_attributions FOR EACH ROW EXECUTE FUNCTION campus.money_capture_effect();
ALTER FUNCTION campus.money_fee_attribute(uuid,text) RENAME TO money_fee_attribute_original;
CREATE FUNCTION campus.money_fee_attribute(eid uuid,semantic text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE rowvalue jsonb;receipt campus.payment_fee_supplement_receipts;p campus.payment_billing_profiles;amount bigint;cash campus.payment_fee_cash_facts;lid uuid;
BEGIN
 IF campus.money_fee_attribute_original(eid,semantic) THEN RETURN true;END IF;
 SELECT body INTO rowvalue FROM campus.payment_fee_report_rows WHERE environment_id=eid AND semantic_id=semantic;
 IF rowvalue IS NULL OR rowvalue->>'incurredByType'<>'charge' OR rowvalue->>'settledVia'<>'balance' THEN RETURN false;END IF;
 SELECT * INTO receipt FROM campus.payment_fee_supplement_receipts WHERE environment_id=eid AND charge_id=rowvalue->>'incurredBy';IF NOT FOUND THEN RETURN false;END IF;
 PERFORM campus.money_lock_aggregate(receipt.obligation_id);PERFORM campus.money_cash_lock(eid);
 IF EXISTS(SELECT 1 FROM campus.payment_fee_supplement_attributions WHERE environment_id=eid AND semantic_id=semantic) THEN RETURN true;END IF;
 SELECT id INTO lid FROM campus.funding_lots WHERE obligation_id=receipt.obligation_id;
 SELECT * INTO p FROM campus.payment_billing_profiles WHERE id=(SELECT profile_id FROM campus.payment_billing_bindings WHERE obligation_id=receipt.obligation_id);
 IF p.id IS NULL OR NOT coalesce(p.contract->'processingFeatures','[]') @> jsonb_build_array(jsonb_build_object('product',rowvalue->>'product','feature',rowvalue->>'feature')) OR (p.contract->>'kind' LIKE 'synthetic_%' AND (SELECT mode FROM campus.payment_environments WHERE id=eid)<>'sandbox') THEN RETURN false;END IF;
 amount:=(rowvalue->>'amountCents')::bigint;
 IF (rowvalue->>'taxCents')::bigint<>0 OR amount<0 THEN PERFORM campus.money_hold(receipt.obligation_id,'fee_tax_authority_unresolved','fee_tax:'||semantic,rowvalue);RETURN false;END IF;
 SELECT * INTO cash FROM campus.payment_fee_cash_facts WHERE environment_id=eid AND balance_id=rowvalue->>'balanceId';IF NOT FOUND THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=eid AND identity IN('row:'||semantic,'balance:'||cash.balance_id)) OR coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_attributions WHERE environment_id=eid AND balance_id=cash.balance_id),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_supplement_attributions WHERE environment_id=eid AND balance_id=cash.balance_id),0)+amount>-cash.net_cents THEN PERFORM campus.money_hold(receipt.obligation_id,'fee_attribution_conflict','fee_attribution:'||semantic,rowvalue);RETURN false;END IF;
 INSERT INTO campus.payment_fee_supplement_attributions VALUES(eid,semantic,cash.balance_id,receipt.attempt_id,lid,receipt.obligation_id,receipt.charge_id,amount,p.id);
 IF amount>0 THEN
  PERFORM campus.money_journal(eid,NULL,'fee_attribution_global:'||semantic,jsonb_build_array(jsonb_build_object('account','fee_expense','credit',amount),jsonb_build_object('account','network_exposure','debit',amount)));
  PERFORM campus.money_journal(eid,lid,'fee_attribution_lot:'||semantic,jsonb_build_array(jsonb_build_object('account','fee_expense','debit',amount),jsonb_build_object('account','network_exposure','credit',amount)));
 END IF;
 IF EXISTS(SELECT 1 FROM campus.payment_fee_revision_settlements WHERE obligation_id=receipt.obligation_id) THEN PERFORM campus.money_hold(receipt.obligation_id,'later_fee_correction','later_fee:'||semantic,rowvalue);END IF;RETURN true;
END $$;
CREATE FUNCTION campus.money_fee_charge_closed(oid uuid,chargeid text,fact jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_billing_profiles;closure jsonb;artifact campus.payment_fee_report_artifacts;observed jsonb;attributed jsonb;
BEGIN
 IF campus.money_fee_profile_closed(oid,fact) THEN RETURN true;END IF;
 SELECT pp.* INTO p FROM campus.payment_billing_profiles pp JOIN campus.payment_billing_bindings b ON b.profile_id=pp.id WHERE b.obligation_id=oid;
 IF p.contract->>'kind' IS DISTINCT FROM 'synthetic_report_artifact_v1' OR (SELECT mode FROM campus.payment_environments WHERE id=p.environment_id)<>'sandbox' OR p.provenance NOT LIKE 'Synthetic:%' OR coalesce(fact->>'feeFactId','')='' THEN RETURN false;END IF;
 SELECT evidence INTO closure FROM campus.payment_synthetic_fee_closures WHERE profile_id=p.id AND environment_id=p.environment_id AND charge_id=chargeid;
 SELECT * INTO artifact FROM campus.payment_fee_report_artifacts WHERE environment_id=p.environment_id AND run_id=closure->>'runId';
 IF artifact.run_id IS NULL OR artifact.file_id IS DISTINCT FROM closure->>'fileId' OR artifact.content_digest IS DISTINCT FROM closure->>'contentDigest' OR artifact.interval_start IS DISTINCT FROM (closure->>'intervalStart')::bigint OR artifact.interval_end IS DISTINCT FROM (closure->>'intervalEnd')::bigint THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(r.semantic_id ORDER BY r.semantic_id),'[]') INTO observed FROM campus.payment_fee_report_rows r JOIN campus.payment_fee_report_memberships m USING(environment_id,semantic_id) WHERE r.environment_id=p.environment_id AND m.run_id=artifact.run_id AND r.body->>'incurredBy'=chargeid;
 SELECT coalesce(jsonb_agg(a.semantic_id ORDER BY a.semantic_id),'[]') INTO attributed FROM (SELECT semantic_id FROM campus.payment_fee_attributions WHERE environment_id=p.environment_id AND charge_id=chargeid UNION SELECT semantic_id FROM campus.payment_fee_supplement_attributions WHERE environment_id=p.environment_id AND charge_id=chargeid)a JOIN campus.payment_fee_report_memberships m ON m.environment_id=p.environment_id AND m.semantic_id=a.semantic_id AND m.run_id=artifact.run_id;
 RETURN observed=closure->'semanticIds' AND attributed=observed AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts WHERE environment_id=p.environment_id);
END $$;
REVOKE ALL ON FUNCTION campus.money_fee_attribute_original(uuid,text),campus.money_fee_attribute(uuid,text),campus.money_fee_charge_closed(uuid,text,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_fee_attribute(uuid,text) TO campus_worker;

CREATE OR REPLACE FUNCTION campus.money_fee_evidence(oid uuid,exclude_revision uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT jsonb_build_object('facts',coalesce(jsonb_agg(v ORDER BY v->>'identity'),'[]'::jsonb),'totalCents',coalesce(sum((v->>'feeCents')::bigint),0),'complete',coalesce(bool_and((v->>'verified')::boolean),false)) FROM (
 SELECT jsonb_build_object('identity','original:'||f.charge_id,'chargeId',f.charge_id,'balanceId',f.fee_fact_id,'feeCents',f.actual_fee_cents,'verified',f.actual_fee_cents IS NOT NULL AND f.fee_fact_id IS NOT NULL) v FROM campus.funding_allocations f JOIN campus.funding_lots l ON l.id=f.lot_id WHERE l.obligation_id=oid
 UNION ALL SELECT jsonb_build_object('identity','report:'||a.semantic_id,'chargeId',a.charge_id,'balanceId',a.balance_id,'feeCents',a.amount_cents,'verified',true) FROM campus.payment_fee_attributions a WHERE a.obligation_id=oid
 UNION ALL SELECT jsonb_build_object('identity','supplement:'||r.charge_id,'chargeId',r.charge_id,'balanceId',r.fee_fact_id,'feeCents',r.fee_cents,'verified',r.fee_cents IS NOT NULL AND r.fee_fact_id IS NOT NULL) FROM campus.payment_fee_supplement_receipts r WHERE r.obligation_id=oid AND r.revision_id IS DISTINCT FROM exclude_revision
 UNION ALL SELECT jsonb_build_object('identity','report:'||a.semantic_id,'chargeId',a.charge_id,'balanceId',a.balance_id,'feeCents',a.amount_cents,'verified',true) FROM campus.payment_fee_supplement_attributions a JOIN campus.payment_fee_supplement_receipts r ON r.attempt_id=a.attempt_id WHERE a.obligation_id=oid AND r.revision_id IS DISTINCT FROM exclude_revision
 ) facts
$$;

CREATE OR REPLACE FUNCTION campus.money_cash_raw(eid uuid,lid uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,campus,pg_temp AS $$
 WITH cash AS (
  SELECT coalesce(sum(ll.debit-ll.credit),0) AS book,coalesce(sum(ll.credit),0) AS debits FROM campus.ledger_lines ll JOIN campus.ledger_journals j ON j.id=ll.journal_id WHERE j.environment_id=eid AND (lid IS NULL OR j.lot_id=lid) AND ll.account='cash'
 ), originals AS (
  SELECT coalesce(sum(available),0) AS available,coalesce(sum(fee),0) AS original_fees FROM (SELECT coalesce(available_cents,0) available,coalesce(actual_fee_cents,0) fee FROM campus.funding_allocations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) UNION ALL SELECT coalesce(sr.available_cents,0),coalesce(sr.fee_cents,0) FROM campus.payment_fee_supplement_receipts sr JOIN campus.funding_lots l ON l.obligation_id=sr.obligation_id WHERE sr.environment_id=eid AND (lid IS NULL OR l.id=lid)) verified_receipts
 ), reserved AS (
  SELECT coalesce(sum(amount_cents-cash_debited_cents),0) AS amount FROM campus.money_reservations WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind IN('transfer','refund','fee_restitution') AND status='reserved'
 ), unresolved_fees AS (
  SELECT coalesce(sum(greatest(0,(SELECT coalesce(sum(amount_cents),0) FROM campus.money_reservations r WHERE r.lot_id=f.lot_id AND kind IN('publisher_fee','recipient_fee') AND status='reserved')-coalesce(f.actual_fee_cents,0)-coalesce((SELECT sum(a.amount_cents) FROM campus.payment_fee_attributions a WHERE a.lot_id=f.lot_id),0))),0) AS amount FROM campus.funding_allocations f WHERE f.environment_id=eid AND (lid IS NULL OR f.lot_id=lid)
 ), restitution_due AS (
  SELECT coalesce(sum(amount),0) AS amount FROM (
 SELECT greatest(0,s.restitution_cents-coalesce((SELECT sum(r.amount_cents) FROM campus.money_reservations r WHERE r.lot_id=s.lot_id AND r.kind='fee_restitution' AND r.status IN('reserved','consumed')),0)) AS amount FROM campus.payment_fee_settlements s WHERE s.environment_id=eid AND (lid IS NULL OR s.lot_id=lid) AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_revision_settlements rs WHERE rs.obligation_id=s.obligation_id)
 UNION ALL SELECT greatest(0,rr.amount_cents-coalesce((SELECT sum(r.amount_cents) FROM campus.money_reservations r JOIN campus.money_operations m ON m.id=r.operation_id WHERE m.payload->>'restitutionId'=rr.id::text AND r.kind='fee_restitution' AND r.status IN('reserved','consumed')),0)) FROM campus.payment_fee_revision_restitutions rr JOIN campus.funding_lots l ON l.obligation_id=rr.obligation_id WHERE rr.environment_id=eid AND (lid IS NULL OR l.id=lid)
 ) owed
 )
 SELECT least(cash.book,originals.available
  +coalesce((SELECT sum(net_cents) FROM campus.payment_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_external_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(net_cents) FROM campus.payment_restitution_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND net_cents>0 AND available),0)
  +coalesce((SELECT sum(amount_cents) FROM campus.payment_network_balance_facts WHERE environment_id=eid AND (lid IS NULL OR lot_id=lid) AND kind='credit' AND available),0)
  -cash.debits+originals.original_fees)-reserved.amount-unresolved_fees.amount-restitution_due.amount-CASE WHEN lid IS NULL THEN 0 ELSE coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_attributions WHERE environment_id=eid AND lot_id=lid),0)+coalesce((SELECT sum(amount_cents) FROM campus.payment_fee_supplement_attributions WHERE environment_id=eid AND lot_id=lid),0) END FROM cash,originals,reserved,unresolved_fees,restitution_due
$$;
CREATE FUNCTION campus.money_fee_plan_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;p campus.payment_fee_plans;
BEGIN
 SELECT * INTO o FROM campus.funding_obligations WHERE id=NEW.obligation_id;SELECT * INTO p FROM campus.payment_fee_plans WHERE id=NEW.plan_id;
 IF (o.environment_id,o.aggregate_type,o.aggregate_id,o.policy_id,o.source_digest) IS DISTINCT FROM (p.environment_id,p.aggregate_type,p.aggregate_id,p.policy_id,p.source_digest) OR o.amount_cents<>(p.body->'maximumPlan'->'lots'->0->>'chargeTotalCents')::bigint OR o.fee_cents<>(p.body->>'maximumFeeCents')::bigint OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p.body->'participants')who WHERE NOT EXISTS(SELECT 1 FROM campus.payment_fee_confirmations c WHERE c.plan_id=p.id AND c.user_id=who::uuid AND c.digest=p.digest)) THEN RAISE EXCEPTION 'fee_plan_scope_mismatch' USING ERRCODE='P0001';END IF;RETURN NEW;
END $$;
CREATE TRIGGER fee_plan_binding_scope BEFORE INSERT ON campus.payment_fee_plan_bindings FOR EACH ROW EXECUTE FUNCTION campus.money_fee_plan_binding_guard();
REVOKE ALL ON FUNCTION campus.money_fee_plan_binding_guard() FROM PUBLIC,campus_app,campus_auth,campus_worker;
ALTER FUNCTION campus.money_projection(text,uuid) RENAME TO money_projection_before_revision_read;
CREATE FUNCTION campus.money_projection(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;o campus.funding_obligations;r campus.payment_fee_revisions;ss campus.payment_fee_revision_settlements;current_evidence boolean;
BEGIN
 result:=campus.money_projection_before_revision_read(kind,resource);SELECT * INTO o FROM campus.funding_obligations WHERE aggregate_type=kind AND aggregate_id=resource ORDER BY created_at DESC LIMIT 1;IF o.id IS NULL THEN RETURN result;END IF;
 SELECT * INTO r FROM campus.payment_fee_revisions WHERE obligation_id=o.id ORDER BY revision DESC LIMIT 1;
 IF r.id IS NOT NULL THEN
  SELECT * INTO ss FROM campus.payment_fee_revision_settlements WHERE revision_id=r.id;current_evidence:=ss.evidence=campus.money_fee_evidence(o.id);
  result:=result||jsonb_build_object('feeRevision',jsonb_build_object('id',r.id,'digest',r.digest,'maximumTotalFeeCents',r.body->>'maximumTotalFeeCents','supplementalAmountCents',r.body->>'supplementalAmountCents','settledActualFeeCents',ss.actual_fee_cents::text,'isCurrentEvidence',coalesce(current_evidence,false)));
  IF current_evidence THEN result:=result||jsonb_build_object('actualFeeCents',ss.actual_fee_cents::text,'feeVarianceCents',(ss.actual_fee_cents-(result->>'estimatedFeeCents')::bigint)::text);END IF;
 END IF;
 IF r.id IS NOT NULL OR EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id AND reason IN('fee_cap_reconfirmation_required','later_fee_correction')) THEN result:=result||jsonb_build_object('allowedActions',(result->'allowedActions')||'"review_fee_revision"'::jsonb);END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION campus.money_projection_before_revision_read(text,uuid),campus.money_projection(text,uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_projection(text,uuid) TO campus_app;
