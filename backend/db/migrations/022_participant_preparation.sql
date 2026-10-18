-- Operator configuration is immutable, owner-only and never installed by this migration.
SET LOCAL lock_timeout='5s';
CREATE TABLE campus.payment_product_configurations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 version integer NOT NULL CHECK(version>0), body jsonb NOT NULL, digest text NOT NULL,
 provenance text NOT NULL CHECK(length(provenance)>0), UNIQUE(environment_id,version)
);
ALTER TABLE campus.payment_product_configurations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campus.payment_product_configurations FROM PUBLIC,campus_app,campus_auth,campus_worker;
CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.payment_product_configurations FOR EACH ROW EXECUTE FUNCTION campus.money_immutable();
CREATE FUNCTION campus.preparation_config(eid uuid) RETURNS campus.payment_product_configurations LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE cfg campus.payment_product_configurations;
 cp campus.payment_collection_profiles;
 bp campus.payment_billing_profiles;
BEGIN
 SELECT * INTO cfg FROM campus.payment_product_configurations WHERE environment_id=eid ORDER BY version DESC LIMIT 1;
 IF cfg.id IS NULL OR cfg.digest IS DISTINCT FROM campus.amend_hash(cfg.body) OR cfg.body->>'enabled' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'payment_configuration_required' USING ERRCODE='P0001';
 END IF;
 SELECT * INTO cp FROM campus.payment_collection_profiles WHERE environment_id=eid ORDER BY version DESC LIMIT 1;
 SELECT * INTO bp FROM campus.payment_billing_profiles WHERE environment_id=eid ORDER BY version DESC LIMIT 1;
 IF cp.id IS NULL OR bp.id IS NULL OR cfg.body->>'collectionProfileId' IS DISTINCT FROM cp.id::text OR cfg.body->>'collectionProfileDigest' IS DISTINCT FROM cp.digest OR cfg.body->>'billingProfileId' IS DISTINCT FROM bp.id::text OR bp.billing_mode='unknown' THEN RAISE EXCEPTION 'payment_configuration_stale' USING ERRCODE='P0001';
 END IF;
 IF coalesce(cfg.body->>'kind','') NOT IN('synthetic_product_v1','approved_product_v1') OR (cfg.body->>'kind'='synthetic_product_v1' AND ((SELECT mode FROM campus.payment_environments WHERE id=eid)<>'sandbox' OR cfg.provenance NOT LIKE 'Synthetic:%')) OR coalesce(cfg.body->>'evidenceRef','')='' OR coalesce(cfg.body->>'evidenceDigest','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'payment_configuration_evidence_required' USING ERRCODE='P0001';
 END IF;
 IF NOT campus.transaction_policy_disclosure_valid(cfg.body->'policyTemplate') OR cfg.body#>>'{policyTemplate,feeAdjustment}' IS DISTINCT FROM 'capped_actual_v1' THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';
 END IF;
 -- Identical immutable configuration bodies keep their original identity.
 SELECT c.* INTO cfg FROM campus.payment_product_configurations c WHERE c.environment_id=eid AND c.digest=cfg.digest ORDER BY c.version LIMIT 1;
 RETURN cfg;
END $$;
-- Explicit operator schedule: ceil(amount * rate / 10000) + fixed cents, within its evidence scope.
CREATE FUNCTION campus.preparation_fee(cfg jsonb,amount bigint) RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE rate bigint;
 fixed bigint;
BEGIN
 IF jsonb_typeof(cfg#>'{feeEstimate,rateBps}') IS DISTINCT FROM 'number' OR jsonb_typeof(cfg#>'{feeEstimate,fixedCents}') IS DISTINCT FROM 'number' OR jsonb_typeof(cfg#>'{feeEstimate,maximumAmountCents}') IS DISTINCT FROM 'number' OR jsonb_typeof(cfg#>'{feeEstimate,minimumAmountCents}') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'fee_estimate_outside_approved_scope' USING ERRCODE='P0001';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(cfg->'feeEstimate') e WHERE e.key IN('rateBps','fixedCents','minimumAmountCents','maximumAmountCents') AND e.value::text !~ '^[0-9]+$') THEN RAISE EXCEPTION 'fee_estimate_outside_approved_scope' USING ERRCODE='P0001';
 END IF;
 rate:=(cfg#>>'{feeEstimate,rateBps}')::bigint;
 fixed:=(cfg#>>'{feeEstimate,fixedCents}')::bigint;
 IF cfg#>>'{feeEstimate,kind}' IS DISTINCT FROM 'approved_linear_ceiling_v1' OR rate IS NULL OR rate<0 OR rate>=10000 OR fixed IS NULL OR fixed<0 OR fixed>1000000 OR amount<0 OR amount>100000000 OR amount>(cfg#>>'{feeEstimate,maximumAmountCents}')::bigint OR amount<(cfg#>>'{feeEstimate,minimumAmountCents}')::bigint THEN RAISE EXCEPTION 'fee_estimate_outside_approved_scope' USING ERRCODE='P0001';
 END IF;
 RETURN fixed+(amount*rate+9999)/10000;
END $$;
CREATE FUNCTION campus.preparation_estimate(cfg jsonb,principal bigint,retained bigint DEFAULT NULL,actual bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE fee bigint:=0;
 nextfee bigint;
 collectible bigint;
 step integer;
BEGIN
 FOR step IN 1..128 LOOP
  IF retained IS NULL THEN collectible:=principal+(fee+least(100,(fee+9)/10)+1)/2;
  ELSE collectible:=greatest(0,(actual+fee+least(100,(fee+9)/10)+1)/2-retained);
 IF collectible>0 THEN collectible:=greatest(50,collectible);
 END IF;
 END IF;
  nextfee:=CASE WHEN retained IS NOT NULL AND collectible=0 THEN 0 ELSE campus.preparation_fee(cfg,collectible) END;
  IF nextfee=fee THEN RETURN jsonb_build_object('fee',fee,'collectible',collectible);
 END IF;
  fee:=nextfee;
 END LOOP;
 RAISE EXCEPTION 'fee_estimate_no_fixed_point' USING ERRCODE='P0001';
END $$;
CREATE FUNCTION campus.prepare_payment_terms(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
<<preparation>>
DECLARE eid uuid;
 cfg campus.payment_product_configurations;
 a campus.applications;
 t campus.tasks;
 g campus.agreements;
 x campus.orders;
 tt campus.agreement_transaction_terms;
 ar campus.agreement_amendment_revisions;
 ob campus.funding_obligations;
 pol campus.payment_execution_policies;
 principal bigint;
 est jsonb;
 payload jsonb;
 source jsonb;
 pid uuid;
 version_value integer;
 source_hash text;
 gid uuid;
BEGIN
 IF NOT campus.is_member() OR NOT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';
 END IF;
 -- Authorize before disclosing any configuration or amount.
 IF kind='application' THEN
  SELECT * INTO a FROM campus.applications WHERE id=resource;
  SELECT * INTO t FROM campus.tasks WHERE id=a.task_id FOR UPDATE;
  IF a.id IS NULL OR NOT (campus.actor()=t.owner_id OR EXISTS(SELECT 1 FROM campus.application_people(resource) WHERE user_id=campus.actor())) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';
 END IF;
  IF a.state NOT IN('applied','invited') THEN RAISE EXCEPTION 'application_closed' USING ERRCODE='P0001';
 END IF;
  principal:=t.reward_cents;
 source:=jsonb_build_object('applicationId',resource,'termsVersion',t.terms_version,'taskRevision',t.revision,'members',(SELECT jsonb_agg(user_id ORDER BY user_id) FROM campus.application_people(resource)));
 ELSIF kind='order' THEN
  SELECT * INTO x FROM campus.orders WHERE id=resource AND campus.actor() IN(buyer_id,seller_id) FOR UPDATE;
  IF x.id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';
 END IF;
  IF x.state<>'pending_payment' OR x.reserved_until<=campus.money_now() THEN RAISE EXCEPTION 'order_not_open' USING ERRCODE='P0001';
 END IF;
  principal:=x.total_cents;
 source:=jsonb_build_object('orderTermsDigest',campus.money_order_terms(resource));
 ELSIF kind IN('agreement','amendment') THEN
  gid:=CASE WHEN kind='agreement' THEN resource ELSE (SELECT agreement_id FROM campus.agreement_amendments WHERE id=resource) END;
  IF gid IS NULL OR NOT campus.in_agreement(gid) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';
 END IF;
  g:=campus.lock_agreement_amendment(gid);
  SELECT at.* INTO tt FROM campus.agreement_transaction_terms at JOIN campus.agreement_transaction_bindings b ON b.transaction_terms_id=at.id JOIN campus.agreement_terms_state s ON s.effective_terms_id=b.terms_id WHERE s.agreement_id=gid;
  IF tt.id IS NULL THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';
 END IF;
  IF kind='agreement' THEN principal:=(tt.plan#>>'{lots,0,principalCents}')::bigint;
 source:=jsonb_build_object('signedPolicyId',tt.policy_id,'transactionTermsId',tt.id,'sourceDigest',tt.digest);
  ELSE
   IF g.owner_id<>campus.actor() THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001';
 END IF;
   SELECT r.* INTO ar FROM campus.agreement_amendment_revisions r JOIN campus.agreement_amendments am ON am.id=r.amendment_id AND am.current_proposal_revision=r.proposal_revision WHERE am.id=resource AND am.status IN('pending','agreed_waiting_funds');
   IF ar.amendment_id IS NULL OR cardinality(ar.retired_milestone_ids)>0 THEN RAISE EXCEPTION 'compensation_policy_unresolved' USING ERRCODE='P0001';
 END IF;
   principal:=(SELECT sum(amount_cents) FROM campus.agreement_milestone_terms WHERE terms_id=ar.terms_id)-(SELECT sum(amount_cents) FROM campus.agreement_milestone_terms WHERE terms_id=ar.base_terms_id);
   IF principal<=0 THEN RAISE EXCEPTION 'no_supported_positive_shortfall' USING ERRCODE='P0001';
 END IF;
   source:=jsonb_build_object('amendmentId',resource,'proposedTermsId',ar.terms_id,'proposalRevision',ar.proposal_revision,'baseTermsId',ar.base_terms_id);
  END IF;
 ELSIF kind='fee_revision' THEN
  ob:=campus.money_lock(resource,true);
 IF ob.payer_id<>campus.actor() THEN RAISE EXCEPTION 'not_payer' USING ERRCODE='P0001';
 END IF;
  source:=jsonb_build_object('originalObligationId',ob.id,'originalSourceDigest',ob.source_digest);
 ELSE RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';
 END IF;
 eid:=campus.money_environment();
 cfg:=campus.preparation_config(eid);
 -- An existing monetary intent is never silently rewritten to current configuration.
 IF kind IN('agreement','order','amendment') AND EXISTS(SELECT 1 FROM campus.funding_obligations WHERE environment_id=eid AND aggregate_type=kind AND aggregate_id=resource) THEN RAISE EXCEPTION 'existing_payment_requires_recovery' USING ERRCODE='P0001';
 END IF;
 IF kind='fee_revision' THEN
  est:=campus.preparation_estimate(cfg.body,0,campus.money_fee_retained_payer(ob.id),(campus.money_fee_evidence(ob.id)->>'totalCents')::bigint);
 ELSE est:=campus.preparation_estimate(cfg.body,principal);
 END IF;
 payload:=(cfg.body->'policyTemplate')||source||jsonb_build_object('kind','exact_charge_estimate','goodsRelease','buyer_confirmed_receipt','principalCents',principal,'estimatedProcessorFeeCents',(est->>'fee')::bigint,'estimatedForAmountCents',(est->>'collectible')::bigint,'chargeTotalCents',principal+((est->>'fee')::bigint+1)/2,'collectionProfileId',cfg.body->>'collectionProfileId','collectionProfileDigest',cfg.body->>'collectionProfileDigest','preparation',jsonb_build_object('configurationId',cfg.id,'configurationDigest',cfg.digest,'source',source));
 IF kind='fee_revision' THEN payload:=payload||jsonb_build_object('supplementalEstimatedFeeCents',(est->>'fee')::bigint,'supplementalEstimatedForAmountCents',(est->>'collectible')::bigint,'supplementalCollectionProfileId',cfg.body->>'collectionProfileId','supplementalCollectionProfileDigest',cfg.body->>'collectionProfileDigest');
 END IF;
 source_hash:=campus.amend_hash(payload);
 IF kind='application' THEN
  SELECT id INTO pid FROM campus.payment_policy_versions WHERE application_id=resource AND listing_version=t.terms_version AND campus.payment_policy_versions.payload=preparation.payload;
  IF pid IS NULL THEN INSERT INTO campus.payment_policy_versions(application_id,listing_version,status,provenance,payload) VALUES(resource,t.terms_version,'approved',cfg.provenance,payload) RETURNING id INTO pid;
 END IF;
 ELSE
  IF kind='fee_revision' THEN resource:=ob.aggregate_id;
 kind:=ob.aggregate_type;
 END IF;
  SELECT * INTO pol FROM campus.payment_execution_policies WHERE environment_id=eid AND aggregate_type=kind AND aggregate_id=resource AND purpose='collection' ORDER BY version DESC LIMIT 1;
  IF pol.digest=source_hash THEN pid:=pol.id;
 ELSE
   version_value:=coalesce(pol.version,0)+1;
   INSERT INTO campus.payment_execution_policies(environment_id,aggregate_type,aggregate_id,purpose,version,status,payload,digest,provenance) VALUES(eid,kind,resource,'collection',version_value,'approved',payload,source_hash,cfg.provenance) RETURNING id INTO pid;
  END IF;
 END IF;
 RETURN jsonb_build_object('resourceId',resource,'policyVersionId',pid,'policyDigest',source_hash,'configurationId',cfg.id,'source',source,'policy',payload,'provenance',cfg.provenance);
END $$;
CREATE FUNCTION campus.prepare_recipient_configuration() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE eid uuid;
 cfg campus.payment_product_configurations;
 payload jsonb;
 existing campus.payment_recipient_configurations;
 op campus.money_operations;
 version_value integer;
BEGIN
 IF NOT campus.is_member() OR NOT EXISTS(SELECT 1 FROM campus.users WHERE id=campus.actor() AND account_status='active') THEN RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';
 END IF;
 PERFORM 1 FROM campus.users WHERE id=campus.actor() FOR UPDATE;
 eid:=campus.money_environment();
 SELECT mo.* INTO op FROM campus.money_operations mo WHERE environment_id=eid AND kind='recipient' AND mo.payload->>'userId'=campus.actor()::text ORDER BY created_at DESC LIMIT 1;
 IF op.id IS NOT NULL THEN RETURN jsonb_build_object('userId',campus.actor(),'operationId',op.id,'preserved',true);
 END IF;
 cfg:=campus.preparation_config(eid);
 IF NOT EXISTS(SELECT 1 FROM campus.identities WHERE user_id=campus.actor() AND verified_at IS NOT NULL) THEN RAISE EXCEPTION 'verified_recipient_email_required' USING ERRCODE='P0001';
 END IF;
 IF jsonb_typeof(cfg.body->'recipientTemplate') IS DISTINCT FROM 'object' OR cfg.body->'recipientTemplate' ?| ARRAY['identity','individual','company','contact_email','display_name','id'] OR cfg.body->>'recipientIdentityMode' IS DISTINCT FROM 'hosted_collection_only' THEN RAISE EXCEPTION 'recipient_identity_configuration_required' USING ERRCODE='P0001';
 END IF;
 -- Only a display label and verified email are copied. Legal identity remains hosted-provider input.
 payload:=(cfg.body->'recipientTemplate')||jsonb_build_object('display_name',(SELECT display_name FROM campus.users WHERE id=campus.actor()),'contact_email',(SELECT email FROM campus.identities WHERE user_id=campus.actor()));
 SELECT * INTO existing FROM campus.payment_recipient_configurations WHERE environment_id=eid AND user_id=campus.actor() ORDER BY version DESC LIMIT 1;
 IF existing.payload IS DISTINCT FROM payload THEN
  version_value:=coalesce(existing.version,0)+1;
  INSERT INTO campus.payment_recipient_configurations VALUES(eid,campus.actor(),version_value,payload,campus.amend_hash(payload),cfg.provenance||' configuration:'||cfg.id::text);
 ELSE version_value:=existing.version;
 END IF;
 RETURN jsonb_build_object('userId',campus.actor(),'configurationVersion',version_value,'configurationId',cfg.id,'preserved',false);
END $$;
-- Both first-quote command and readiness use this identical precollection predicate.
CREATE FUNCTION campus.amend_precollection_reason(p campus.amendment_financial_plans) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF p.baseline->'originalState' IS DISTINCT FROM campus.amend_original_state(p.agreement_id,p.environment_id,p.baseline->'originalObligationIds') THEN RETURN 'original_money_state_changed';
 END IF;
 IF p.baseline->'history' IS DISTINCT FROM campus.amend_history(p.agreement_id,p.environment_id)->'history' THEN RETURN 'financial_plan_stale';
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION campus.amend_money_quote(gid uuid,aid uuid,rev integer,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;
 o campus.funding_obligations;
 tt uuid;
 tr integer;
 q campus.payment_quotes;
 l jsonb;
 v jsonb;
 body jsonb;
BEGIN p:=campus.amend_plan_exact(gid,aid,rev,request);
 IF campus.actor()<>(SELECT owner_id FROM campus.agreements WHERE id=gid) THEN RAISE EXCEPTION 'not_owner' USING ERRCODE='P0001';
 END IF;
 PERFORM campus.money_cash_lock(p.environment_id);
 IF NOT campus.amend_plan_current(p) THEN RAISE EXCEPTION 'financial_plan_stale' USING ERRCODE='P0001';
 END IF;
 IF NOT campus.amend_unanimous(p) THEN RAISE EXCEPTION 'financial_consent_required' USING ERRCODE='P0001';
 END IF;
 IF (p.body->>'chargeTotalCents')::bigint<(p.body->>'minimumChargeCents')::bigint THEN RAISE EXCEPTION 'amount_below_provider_minimum' USING ERRCODE='P0001';
 END IF;
 SELECT x.* INTO o FROM campus.funding_obligations x JOIN campus.amendment_funding_origins ao ON ao.obligation_id=x.id WHERE ao.plan_id=p.id;
 IF o.id IS NULL THEN
  -- No foreign business effects may precede the first collectible quote.
  IF campus.amend_precollection_reason(p) IS NOT NULL THEN RAISE EXCEPTION '%',campus.amend_precollection_reason(p) USING ERRCODE='P0001';
 END IF;
  SELECT coalesce(max(revision),0)+1 INTO tr FROM campus.agreement_transaction_terms WHERE agreement_id=gid;
  INSERT INTO campus.agreement_transaction_terms(agreement_id,revision,release_policy,policy_snapshot,plan,digest,origin,amendment_plan_id)
  SELECT gid,tr,t.release_policy,jsonb_build_object('policyId',p.policy_id,'payload',p.body->'policy'),jsonb_set(p.body->'plan','{lots}',(t.plan->'lots')||(p.body#>'{plan,lots}')),p.digest,'amendment',p.id FROM campus.agreement_transaction_terms t WHERE id=p.base_transaction_id RETURNING id INTO tt;
  INSERT INTO campus.transaction_component_memberships SELECT tt,gid,tr,component_id FROM campus.transaction_component_memberships WHERE transaction_terms_id=p.base_transaction_id;
  l:=(SELECT fp.body#>'{maximumPlan,lots,0}' FROM campus.payment_fee_plans fp WHERE fp.id=p.id);
  INSERT INTO campus.funding_obligations(environment_id,aggregate_type,aggregate_id,agreement_id,amendment_id,payer_id,terms_id,terms_revision,transaction_terms_id,transaction_terms_revision,source_digest,policy_id,currency,principal_cents,fee_cents,publisher_fee_cents,amount_cents)
  VALUES(p.environment_id,'amendment',aid,gid,aid,campus.actor(),p.terms_id,p.terms_revision,tt,tr,p.digest,p.policy_id,'USD',(l->>'principalCents')::bigint,(l->>'estimatedProcessorFeeCents')::bigint,(l->>'publisherProcessorFeeCents')::bigint,(l->>'chargeTotalCents')::bigint) RETURNING * INTO o;
  INSERT INTO campus.amendment_funding_origins VALUES(p.id,gid,o.id,p.environment_id);
  INSERT INTO campus.payment_fee_plan_bindings VALUES(o.id,p.id);
  INSERT INTO campus.funding_lots VALUES((l->>'fundingPlanLotId')::uuid,o.id,p.environment_id,rev,o.principal_cents,o.publisher_fee_cents,o.fee_cents);
  FOR v IN SELECT value FROM jsonb_array_elements(l->'components') LOOP INSERT INTO campus.funding_component_plans(id,lot_id,environment_id,member_id,milestone_id,stage_position,gross_cents,recipient_fee_cents,net_cents) VALUES((v->>'id')::uuid,(l->>'fundingPlanLotId')::uuid,p.environment_id,(v->>'memberId')::uuid,(v->>'milestoneId')::uuid,(v->>'stagePosition')::int,(v->>'grossCents')::bigint,(v->>'recipientFeeCents')::bigint,(v->>'netCents')::bigint);
 END LOOP;
 END IF;
 SELECT * INTO q FROM campus.payment_quotes WHERE obligation_id=o.id AND expires_at>campus.money_now() ORDER BY created_at DESC LIMIT 1;
 IF q.id IS NULL THEN
 body:=p.body||jsonb_build_object('obligationId',o.id,'sourceDigest',p.digest,'transactionTermsId',o.transaction_terms_id,'transactionTermsRevision',o.transaction_terms_revision);
 INSERT INTO campus.payment_quotes(obligation_id,environment_id,payer_id,digest,body,expires_at) VALUES(o.id,o.environment_id,o.payer_id,campus.amend_hash(body),body,campus.money_now()+interval '10 minutes') RETURNING * INTO q;
 END IF;
 RETURN jsonb_build_object('quoteId',q.id,'quoteDigest',q.digest,'obligationId',o.id,'obligationRevision',o.revision,'expiresAt',q.expires_at,'amountCents',o.amount_cents,'currency','USD');
END $$;
CREATE OR REPLACE FUNCTION campus.amend_money_read(gid uuid,aid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.amendment_financial_plans;
 plans jsonb:='[]';
 reasons jsonb;
 actions jsonb;
 confirmed jsonb;
 o campus.funding_obligations;
 funded boolean;
 effective boolean;
 current_plan boolean;
 assessment jsonb;
BEGIN
 IF NOT campus.in_agreement(gid) OR NOT EXISTS(SELECT 1 FROM campus.agreement_amendments WHERE id=aid AND agreement_id=gid) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001';
 END IF;
 FOR p IN SELECT * FROM campus.amendment_financial_plans WHERE agreement_id=gid AND amendment_id=aid ORDER BY revision LOOP
  reasons:='[]';
 actions:='["refresh"]';
 current_plan:=campus.amend_plan_current(p);
 effective:=EXISTS(SELECT 1 FROM campus.amendment_money_activations WHERE plan_id=p.id);
  SELECT coalesce(jsonb_agg(user_id ORDER BY user_id),'[]') INTO confirmed FROM campus.amendment_financial_confirmations WHERE plan_id=p.id AND digest=p.digest;
  SELECT oo.* INTO o FROM campus.funding_obligations oo JOIN campus.amendment_funding_origins ao ON ao.obligation_id=oo.id WHERE ao.plan_id=p.id;
  funded:=EXISTS(SELECT 1 FROM campus.funding_allocations f JOIN campus.funding_lots l ON l.id=f.lot_id WHERE l.obligation_id=o.id);
  IF NOT current_plan AND NOT effective THEN reasons:=reasons||'"financial_plan_stale"'::jsonb;
 END IF;
  IF NOT campus.amend_unanimous(p) THEN reasons:=reasons||'"ordinary_and_financial_consent_required"'::jsonb;
 END IF;
  IF (p.body->>'chargeTotalCents')::bigint<(p.body->>'minimumChargeCents')::bigint THEN reasons:=reasons||'"amount_below_provider_minimum"'::jsonb;
 END IF;
  IF EXISTS(SELECT 1 FROM campus.amendment_money_cancellations WHERE plan_id=p.id) THEN reasons:=reasons||'"cancellation_requested"'::jsonb;
 END IF;
  IF EXISTS(SELECT 1 FROM campus.money_active_holds WHERE obligation_id=o.id) THEN reasons:=reasons||'"funds_held"'::jsonb;
 END IF;
  IF o.id IS NULL AND NOT effective AND campus.amend_precollection_reason(p) IS NOT NULL THEN reasons:=reasons||to_jsonb(campus.amend_precollection_reason(p));
 END IF;
  IF o.id IS NOT NULL AND NOT effective THEN assessment:=campus.amend_assess(p,false);
 IF assessment->>'status'<>'ready' THEN reasons:=reasons||to_jsonb(assessment->>'reason');
 END IF;
 END IF;
  IF current_plan AND NOT confirmed ? campus.actor()::text THEN actions:=actions||'"confirm_financial_plan"'::jsonb;
 END IF;
  IF current_plan AND reasons='[]' AND campus.actor()=(SELECT owner_id FROM campus.agreements WHERE id=gid) THEN actions:=actions||CASE WHEN o.id IS NULL THEN '["request_quote"]'::jsonb WHEN funded THEN '["assess","activate"]'::jsonb ELSE '["request_quote","assess"]'::jsonb END;
 END IF;
  IF current_plan AND campus.actor()=(SELECT owner_id FROM campus.agreements WHERE id=gid) AND reasons='["payment_or_fee_pending"]'::jsonb AND NOT funded THEN
   actions:=actions||'"request_quote"'::jsonb;
   IF EXISTS(SELECT 1 FROM campus.payment_quotes WHERE obligation_id=o.id AND expires_at>campus.money_now()) AND NOT EXISTS(SELECT 1 FROM campus.payment_attempts WHERE obligation_id=o.id AND status NOT IN('failed','canceled')) THEN actions:=actions||'"request_payment_attempt"'::jsonb;
 END IF;
  END IF;
  IF NOT effective THEN actions:=actions||'"request_cancellation"'::jsonb;
 END IF;
  IF NOT (SELECT mutations_enabled AND strict_binding FROM campus.agreement_amendment_settings WHERE singleton) THEN reasons:=reasons||'"agreement_amendments_unavailable"'::jsonb;
 actions:='["refresh"]';
 END IF;
  plans:=plans||jsonb_build_array(jsonb_build_object('planId',p.id,'revision',p.revision,'digest',p.digest,'feePlanDigest',(SELECT digest FROM campus.payment_fee_plans WHERE id=p.id),'feePlan',(SELECT body FROM campus.payment_fee_plans WHERE id=p.id),'plan',p.body,'confirmedParticipantIds',confirmed,'obligationId',o.id,'collection',campus.amend_collection_read(o.id),'funded',funded,'effective',effective,'blockedReasons',reasons,'allowedActions',actions));
 END LOOP;
 RETURN jsonb_build_object('agreementId',gid,'amendmentId',aid,'plans',plans,'effectiveMembership',campus.amend_effective_membership(gid),'financialPolicyLimits',jsonb_build_array('decrease_reallocation_retirement_require_compensation_policy','supported_usd_card_minimum'));
END $$;
ALTER TABLE campus.connected_payee_accounts ADD COLUMN requirement_summary jsonb;
ALTER FUNCTION campus.money_observe_account(uuid,uuid,jsonb) RENAME TO money_observe_account_before_preparation;
CREATE FUNCTION campus.money_observe_account(eid uuid,uid uuid,fact jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 PERFORM campus.money_observe_account_before_preparation(eid,uid,fact);
 IF fact ? 'requirements' THEN
  IF jsonb_typeof(fact->'requirements')<>'object' OR (fact#>>'{requirements,pendingCount}')::int<0 OR (fact#>>'{requirements,pendingCount}')::int>10000 OR coalesce(fact#>>'{requirements,status}','') NOT IN('unknown','none','currently_due','past_due','pending_verification') THEN RAISE EXCEPTION 'provider_scope_mismatch' USING ERRCODE='P0001';
 END IF;
  UPDATE campus.connected_payee_accounts SET requirement_summary=jsonb_build_object('pendingCount',(fact#>>'{requirements,pendingCount}')::int,'status',fact#>>'{requirements,status}') WHERE environment_id=eid AND user_id=uid;
 END IF;
END $$;
ALTER FUNCTION campus.money_account() RENAME TO money_account_before_preparation;
CREATE FUNCTION campus.money_account() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;
 eid uuid;
 op campus.money_operations;
 cfg campus.payment_product_configurations;
 blocked text;
BEGIN
 result:=campus.money_account_before_preparation();
 SELECT id INTO eid FROM campus.payment_environments WHERE enabled;
 BEGIN cfg:=campus.preparation_config(eid);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN blocked:=SQLERRM;
 END;
 SELECT * INTO op FROM campus.money_operations WHERE environment_id=eid AND kind IN('recipient','onboarding') AND payload->>'userId'=campus.actor()::text ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN result||jsonb_build_object('requirements',coalesce((SELECT requirement_summary FROM campus.connected_payee_accounts WHERE environment_id=eid AND user_id=campus.actor()),'{"pendingCount":0,"status":"unknown"}'::jsonb),'operation',CASE WHEN op.id IS NULL THEN NULL ELSE campus.money_read_operation(op.id) END,'configurationBlocker',blocked,'dashboardAvailable',false);
END $$;
CREATE FUNCTION campus.participant_payment_read(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE funding jsonb;
 fees jsonb;
 fee_error text;
 prep_error text;
 eid uuid;
 cfg campus.payment_product_configurations;
 o campus.funding_obligations;
 q campus.payment_quotes;
 people jsonb;
 policy jsonb;
 quote_request jsonb;
BEGIN
 funding:=campus.money_projection(kind,resource);
 SELECT id INTO eid FROM campus.payment_environments WHERE enabled;
 BEGIN cfg:=campus.preparation_config(eid);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN prep_error:=SQLERRM;
 END;
 BEGIN fees:=campus.money_fee_plan_read(kind,resource);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN fee_error:=SQLERRM;
 END;
 SELECT * INTO o FROM campus.funding_obligations WHERE id=(funding->>'obligationId')::uuid;
 IF o.payer_id=campus.actor() THEN SELECT * INTO q FROM campus.payment_quotes WHERE obligation_id=o.id ORDER BY created_at DESC,id DESC LIMIT 1;
 END IF;
 IF kind='agreement' THEN
  SELECT jsonb_build_object('expectedEffectiveTermsId',s.effective_terms_id,'expectedEffectiveRevision',s.effective_revision,'transactionTermsId',b.transaction_terms_id,'transactionTermsRevision',b.transaction_terms_revision) INTO quote_request FROM campus.agreement_terms_state s JOIN campus.agreement_transaction_bindings b ON b.agreement_id=s.agreement_id AND b.terms_id=s.effective_terms_id WHERE s.agreement_id=resource;
  SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) ORDER BY u.id) INTO people FROM campus.users u WHERE u.id IN(SELECT user_id FROM campus.agreement_members WHERE agreement_id=resource UNION SELECT owner_id FROM campus.agreements WHERE id=resource);
 ELSE
  policy:=campus.money_order_policy(resource);
 quote_request:=jsonb_build_object('orderTermsDigest',policy->>'orderTermsDigest','expectedPaymentRevision',policy->'paymentRevision');
  SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name) ORDER BY u.id) INTO people FROM campus.users u WHERE u.id IN(SELECT buyer_id FROM campus.orders WHERE id=resource UNION SELECT seller_id FROM campus.orders WHERE id=resource);
 END IF;
 RETURN jsonb_build_object('kind',kind,'resourceId',resource,'payerId',CASE WHEN kind='agreement' THEN (SELECT owner_id FROM campus.agreements WHERE id=resource) ELSE (SELECT buyer_id FROM campus.orders WHERE id=resource) END,'funding',funding,'feePlan',fees,'feePlanBlocker',fee_error,'preparationBlocker',prep_error,'people',people,'orderPolicy',policy,'quoteRequest',quote_request,'quote',CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object('quoteId',q.id,'quoteDigest',q.digest,'obligationId',q.obligation_id,'obligationRevision',o.revision,'amountCents',q.body->'chargeTotalCents','expiresAt',q.expires_at,'currency','USD') END,'refundSources',coalesce((SELECT jsonb_agg(jsonb_build_object('chargeId',f.charge_id,'amountCents',l.principal_cents+l.publisher_fee_cents,'policyVersionId',o.policy_id)) FROM campus.funding_allocations f JOIN campus.funding_lots l ON l.id=f.lot_id WHERE l.obligation_id=o.id),'[]'::jsonb));
END $$;
DO $$ DECLARE p record;
 BEGIN
 FOR p IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='campus'::regnamespace AND (proname LIKE 'preparation_%' OR proname IN('prepare_payment_terms','prepare_recipient_configuration','amend_precollection_reason','participant_payment_read','money_account_before_preparation','money_observe_account_before_preparation','money_account','money_observe_account')) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,campus_app,campus_auth,campus_worker',p.sig);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION campus.prepare_payment_terms(text,uuid),campus.prepare_recipient_configuration(),campus.participant_payment_read(text,uuid),campus.money_account() TO campus_app;
GRANT EXECUTE ON FUNCTION campus.money_observe_account(uuid,uuid,jsonb) TO campus_worker;

CREATE OR REPLACE FUNCTION campus.money_fee_context(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_execution_policies;
 t campus.agreement_transaction_terms;
 g campus.agreements;
 x campus.orders;
 eid uuid;
 source text;
 plan jsonb;
 people jsonb;
 payer uuid;
 fee bigint;
BEGIN
 PERFORM campus.money_projection(kind,resource);
 eid:=campus.money_environment();
 SELECT * INTO p FROM campus.payment_execution_policies WHERE environment_id=eid AND aggregate_type=kind AND aggregate_id=resource AND purpose='collection' AND status='approved' ORDER BY version DESC LIMIT 1;
 IF p.id IS NULL OR p.payload->>'feeAdjustment' IS DISTINCT FROM 'capped_actual_v1' OR p.digest IS DISTINCT FROM encode(sha256(convert_to(campus.transaction_canonical(p.payload),'UTF8')),'hex') THEN RAISE EXCEPTION 'fee_cap_policy_unavailable' USING ERRCODE='P0001';
 END IF;
 IF kind='agreement' THEN
  SELECT * INTO g FROM campus.agreements WHERE id=resource;
 payer:=g.owner_id;
  SELECT tt.* INTO t FROM campus.agreement_transaction_terms tt JOIN campus.agreement_transaction_bindings b ON b.transaction_terms_id=tt.id JOIN campus.agreement_terms_state st ON st.agreement_id=b.agreement_id AND st.effective_terms_id=b.terms_id WHERE b.agreement_id=resource;
  IF t.id IS NULL OR p.payload->>'signedPolicyId' IS DISTINCT FROM t.policy_id::text OR NOT campus.transaction_policy_disclosure_valid(t.policy_snapshot->'payload') THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';
 END IF;
  source:=t.digest;
 plan:=CASE WHEN p.payload ? 'preparation' THEN campus.money_reprice_plan(t.plan,(p.payload->>'estimatedProcessorFeeCents')::bigint) ELSE t.plan END;
  SELECT jsonb_agg(id ORDER BY id) INTO people FROM (SELECT payer AS id UNION SELECT (v->>'memberId')::uuid FROM jsonb_array_elements(plan->'members')v) u;
 ELSE
  SELECT * INTO x FROM campus.orders WHERE id=resource;
 payer:=x.buyer_id;
 source:=campus.money_order_terms(resource);
  IF p.payload->>'orderTermsDigest' IS DISTINCT FROM source OR NOT campus.transaction_policy_disclosure_valid(p.payload) THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';
 END IF;
  fee:=(p.payload->>'estimatedProcessorFeeCents')::bigint;
  IF fee IS NULL OR fee<0 THEN RAISE EXCEPTION 'financial_policy_unresolved' USING ERRCODE='P0001';
 END IF;
  plan:=jsonb_build_object('calculationVersion','charge_member_stage_v1','currency','USD','platformServiceFeeCents',0,'roundingRule','largest_remainder_uuid_stage;odd_fee_cent_publisher','members',jsonb_build_array(jsonb_build_object('memberId',x.seller_id,'units',10000)),'lots',jsonb_build_array(jsonb_build_object('fundingPlanLotId',resource,'principalCents',x.total_cents,'components',jsonb_build_array(jsonb_build_object('memberId',x.seller_id,'milestoneId','goods','stagePosition',1,'grossCents',x.total_cents)))));
  plan:=campus.money_reprice_plan(plan,fee);
 people:=jsonb_build_array(x.buyer_id,x.seller_id);
 END IF;
 RETURN jsonb_build_object('environmentId',eid,'aggregateType',kind,'aggregateId',resource,'policyId',p.id,'policyDigest',p.digest,'policyVersion',p.version,'policyProvenance',p.provenance,'sourceDigest',source,'payerId',payer,'participants',people,'originalPlan',plan);
END $$;
CREATE FUNCTION campus.preparation_policy_reason(pid uuid) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE p campus.payment_execution_policies;
 cfg campus.payment_product_configurations;
BEGIN
 SELECT * INTO p FROM campus.payment_execution_policies WHERE id=pid;
 IF NOT (p.payload ? 'preparation') THEN RETURN NULL;
 END IF;
 BEGIN cfg:=campus.preparation_config(p.environment_id);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN RETURN SQLERRM;
 END;
 IF p.payload#>>'{preparation,configurationDigest}' IS DISTINCT FROM cfg.digest THEN RETURN 'payment_configuration_changed_existing_intent';
 END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION campus.money_attempt(uuid,jsonb) RENAME TO money_attempt_before_preparation;
CREATE FUNCTION campus.money_attempt(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE o campus.funding_obligations;
 reason_value text;
BEGIN
 o:=campus.money_lock(oid,true);
 -- An existing operation is recovered with its original identity; no rebinding.
 IF NOT EXISTS(SELECT 1 FROM campus.payment_attempts WHERE obligation_id=oid AND status NOT IN('failed','canceled')) THEN
  reason_value:=campus.preparation_policy_reason(o.policy_id);
  IF reason_value IS NOT NULL THEN RAISE EXCEPTION '%',reason_value USING ERRCODE='P0001';
 END IF;
 END IF;
 RETURN campus.money_attempt_before_preparation(oid,request);
END $$;
ALTER FUNCTION campus.money_dispatchable(campus.money_operations) RENAME TO money_dispatchable_before_preparation;
CREATE FUNCTION campus.money_dispatchable(op campus.money_operations) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF op.first_dispatched_at IS NULL THEN
  IF op.kind='checkout' AND campus.preparation_policy_reason((SELECT policy_id FROM campus.funding_obligations WHERE id=op.obligation_id)) IS NOT NULL THEN RETURN false;
 END IF;
  IF op.kind='fee_supplement_checkout' AND campus.preparation_policy_reason((SELECT policy_id FROM campus.payment_fee_revisions WHERE id=(op.payload->>'feeRevisionId')::uuid AND obligation_id=op.obligation_id AND environment_id=op.environment_id)) IS NOT NULL THEN RETURN false;
 END IF;
 END IF;
 RETURN campus.money_dispatchable_before_preparation(op);
END $$;
ALTER FUNCTION campus.participant_payment_read(text,uuid) RENAME TO participant_payment_read_before_configuration;
CREATE FUNCTION campus.participant_payment_read(kind text,resource uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE result jsonb;
 pid uuid;
 blocked text;
 funding jsonb;
 review jsonb;
 current_revision boolean:=false;
 review_summary jsonb;
BEGIN
 result:=campus.participant_payment_read_before_configuration(kind,resource);
 funding:=result->'funding';
 SELECT policy_id INTO pid FROM campus.funding_obligations WHERE id=(funding->>'obligationId')::uuid;
 IF pid IS NULL THEN SELECT p.id INTO pid FROM campus.payment_execution_policies p JOIN campus.payment_environments e ON e.id=p.environment_id AND e.enabled WHERE p.aggregate_type=kind AND p.aggregate_id=resource AND p.purpose='collection' ORDER BY p.version DESC LIMIT 1;
 END IF;
 -- Renewing a quote on the same unchanged obligation does not replace its policy or lots.
 -- The accepted pre-fee-plan projection supplies the existing command eligibility;
 -- require the obligation's exact immutable all-person fee plan as well.
 IF funding->>'obligationId' IS NOT NULL
  AND funding->'activeAttempt'='null'::jsonb
  AND (campus.money_projection_before_fee_plan(kind,resource)->'allowedActions') ? 'request_quote'
  AND EXISTS(
   SELECT 1 FROM campus.payment_fee_plan_bindings b
   JOIN campus.payment_fee_plans p ON p.id=b.plan_id
   JOIN campus.funding_obligations o ON o.id=b.obligation_id
   WHERE o.id=(funding->>'obligationId')::uuid AND p.policy_id=o.policy_id
    AND p.source_digest=o.source_digest
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p.body->'participants') who
     WHERE NOT EXISTS(SELECT 1 FROM campus.payment_fee_confirmations c
      WHERE c.plan_id=p.id AND c.user_id=who::uuid AND c.digest=p.digest))) THEN
  funding:=jsonb_set(funding,'{allowedActions}',(funding->'allowedActions')||'"request_quote"'::jsonb);
 END IF;
 IF funding ? 'feeRevision' THEN
  review:=campus.money_fee_revision_read((funding->>'obligationId')::uuid);
  current_revision:=review->>'state'='settled' AND coalesce((funding#>>'{feeRevision,isCurrentEvidence}')::boolean,false) AND review->>'revisionId'=funding#>>'{feeRevision,id}' AND NOT EXISTS(SELECT 1 FROM campus.payment_fee_evidence_conflicts c WHERE c.environment_id=(funding->>'environmentId')::uuid);
  review_summary:=jsonb_build_object('revisionId',review->'revisionId','state',review->>'state','isCurrentEvidence',current_revision,'settledActualFeeCents',review->'settledActualFeeCents','initialQuoteBlockers',CASE WHEN current_revision AND funding#>>'{activeAttempt,status}'='succeeded' THEN coalesce((SELECT jsonb_agg(value) FROM jsonb_array_elements(funding->'blockedReasons') WHERE value#>>'{}' IN('financial_policy_unresolved','quote_changed')),'[]') ELSE '[]'::jsonb END,'restitutions',coalesce((SELECT jsonb_agg(jsonb_build_object('source',CASE WHEN EXISTS(SELECT 1 FROM campus.funding_allocations fa WHERE fa.charge_id=rr.charge_id AND fa.environment_id=rr.environment_id) THEN 'original' ELSE 'supplemental' END,'amountCents',rr.amount_cents::text,'status',coalesce((SELECT mo.status FROM campus.money_operations mo WHERE mo.obligation_id=rr.obligation_id AND mo.kind='fee_restitution' AND mo.payload->>'restitutionId'=rr.id::text ORDER BY mo.created_at DESC,mo.id DESC LIMIT 1),'owed')) ORDER BY rr.id) FROM campus.payment_fee_revision_restitutions rr WHERE rr.obligation_id=(funding->>'obligationId')::uuid AND rr.revision_id=(review->>'revisionId')::uuid),'[]'));
 END IF;
 blocked:=campus.preparation_policy_reason(pid);
 IF blocked IS NOT NULL THEN
  funding:=funding||jsonb_build_object('allowedActions',(funding->'allowedActions')-'request_quote'-'create_payment_attempt','blockedReasons',(funding->'blockedReasons')||to_jsonb(blocked));
  IF result->'feePlan' <> 'null'::jsonb THEN result:=jsonb_set(result,'{feePlan,allowedActions}','[]');
 END IF;
 END IF;
 RETURN result||jsonb_build_object('funding',funding,'feeReview',review_summary,'configurationChangeBlocker',blocked,'approvedDisclosures',(SELECT payload->'disclosure' FROM campus.payment_execution_policies WHERE id=pid));
END $$;
REVOKE ALL ON FUNCTION campus.preparation_policy_reason(uuid),campus.money_attempt_before_preparation(uuid,jsonb),campus.money_attempt(uuid,jsonb),campus.money_dispatchable_before_preparation(campus.money_operations),campus.money_dispatchable(campus.money_operations),campus.participant_payment_read_before_configuration(text,uuid),campus.participant_payment_read(text,uuid) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_attempt(uuid,jsonb),campus.participant_payment_read(text,uuid) TO campus_app;
CREATE FUNCTION campus.preparation_quote_guard(kind text,resource uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE pid uuid;
 reason_value text;
BEGIN
 PERFORM campus.money_projection(kind,resource);
 SELECT p.id INTO pid FROM campus.payment_execution_policies p JOIN campus.payment_environments e ON e.id=p.environment_id AND e.enabled WHERE p.aggregate_type=kind AND p.aggregate_id=resource AND p.purpose='collection' AND p.status='approved' ORDER BY p.version DESC LIMIT 1;
 reason_value:=campus.preparation_policy_reason(pid);
 IF reason_value IS NOT NULL THEN RAISE EXCEPTION '%',reason_value USING ERRCODE='P0001';
 END IF;
END $$;
ALTER FUNCTION campus.money_agreement_quote(uuid,jsonb) RENAME TO money_agreement_quote_before_preparation;
CREATE FUNCTION campus.money_agreement_quote(gid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN PERFORM campus.preparation_quote_guard('agreement',gid);
 RETURN campus.money_agreement_quote_before_preparation(gid,request);
 END $$;
ALTER FUNCTION campus.money_order_quote(uuid,jsonb) RENAME TO money_order_quote_before_preparation;
CREATE FUNCTION campus.money_order_quote(oid uuid,request jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN PERFORM campus.preparation_quote_guard('order',oid);
 RETURN campus.money_order_quote_before_preparation(oid,request);
 END $$;
REVOKE ALL ON FUNCTION campus.preparation_quote_guard(text,uuid),campus.money_agreement_quote_before_preparation(uuid,jsonb),campus.money_agreement_quote(uuid,jsonb),campus.money_order_quote_before_preparation(uuid,jsonb),campus.money_order_quote(uuid,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
GRANT EXECUTE ON FUNCTION campus.money_agreement_quote(uuid,jsonb),campus.money_order_quote(uuid,jsonb) TO campus_app;
