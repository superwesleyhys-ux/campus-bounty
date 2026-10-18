-- Injectable only by the database owner; production has no configurable clock.
CREATE FUNCTION campus.money_now() RETURNS timestamptz LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT clock_timestamp() $$;
REVOKE ALL ON FUNCTION campus.money_now() FROM PUBLIC,campus_app,campus_auth,campus_worker;
-- Forward-only money authority. Prior migrations are immutable. No default environment or policy.
CREATE TABLE campus.payment_environments (
 id uuid PRIMARY KEY, provider text NOT NULL CHECK(provider='stripe'), mode text NOT NULL CHECK(mode IN('sandbox','live')),
 platform_account_id text NOT NULL CHECK(platform_account_id LIKE 'acct_%'), release_identity text NOT NULL,
 api_version text NOT NULL CHECK(api_version='2026-09-30.endive'), sdk_version text NOT NULL CHECK(sdk_version='23.0.0'),
 origin text NOT NULL, enabled boolean NOT NULL DEFAULT false, UNIQUE(id,platform_account_id)
);
CREATE TABLE campus.payment_execution_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 aggregate_type text NOT NULL CHECK(aggregate_type IN('agreement','order','amendment')),aggregate_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN('collection','release','refund','reversal','amendment')),
 version integer NOT NULL CHECK(version>0),status text NOT NULL CHECK(status IN('pending','approved')),
 payload jsonb NOT NULL, digest text NOT NULL,provenance text NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(environment_id,aggregate_type,aggregate_id,purpose,version),UNIQUE(id,environment_id,aggregate_type,aggregate_id)
);
CREATE TABLE campus.connected_payee_accounts (
 environment_id uuid NOT NULL REFERENCES campus.payment_environments,user_id uuid NOT NULL REFERENCES campus.users,
 provider_account_id text NOT NULL,revision integer NOT NULL DEFAULT 1,
 transfer_capability text NOT NULL DEFAULT 'unknown',payout_capability text NOT NULL DEFAULT 'unknown',
 observed_at timestamptz,PRIMARY KEY(environment_id,user_id),UNIQUE(environment_id,provider_account_id)
);
CREATE TABLE campus.funding_obligations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 aggregate_type text NOT NULL CHECK(aggregate_type IN('agreement','order','amendment')),aggregate_id uuid NOT NULL,
 agreement_id uuid REFERENCES campus.agreements,order_id uuid REFERENCES campus.orders,amendment_id uuid,
 payer_id uuid NOT NULL REFERENCES campus.users,terms_id uuid,terms_revision integer,transaction_terms_id uuid,transaction_terms_revision integer,
 allocation_revision integer,source_digest text NOT NULL,policy_id uuid NOT NULL,currency text NOT NULL CHECK(currency='USD'),
 principal_cents bigint NOT NULL CHECK(principal_cents BETWEEN 1 AND 100000000),fee_cents bigint NOT NULL CHECK(fee_cents>=0),
 publisher_fee_cents bigint NOT NULL CHECK(publisher_fee_cents>=0),amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 CHECK(amount_cents=principal_cents+publisher_fee_cents AND publisher_fee_cents=(fee_cents+1)/2),
 CHECK((agreement_id IS NOT NULL)::integer+(order_id IS NOT NULL)::integer=1),
 CHECK((aggregate_type='agreement' AND aggregate_id=agreement_id AND amendment_id IS NULL) OR (aggregate_type='order' AND aggregate_id=order_id AND amendment_id IS NULL) OR (aggregate_type='amendment' AND amendment_id IS NOT NULL AND aggregate_id=amendment_id AND agreement_id IS NOT NULL)),
 UNIQUE(id,environment_id),UNIQUE(environment_id,aggregate_type,aggregate_id,source_digest),
 FOREIGN KEY(policy_id,environment_id,aggregate_type,aggregate_id) REFERENCES campus.payment_execution_policies(id,environment_id,aggregate_type,aggregate_id),
 FOREIGN KEY(terms_id,agreement_id,terms_revision) REFERENCES campus.agreement_terms(id,agreement_id,revision),
 FOREIGN KEY(transaction_terms_id,agreement_id,transaction_terms_revision) REFERENCES campus.agreement_transaction_terms(id,agreement_id,revision)
);
CREATE TABLE campus.payment_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),obligation_id uuid NOT NULL,environment_id uuid NOT NULL,payer_id uuid NOT NULL REFERENCES campus.users,
 digest text NOT NULL,body jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(id,obligation_id,environment_id),FOREIGN KEY(obligation_id,environment_id) REFERENCES campus.funding_obligations(id,environment_id)
);
CREATE TABLE campus.funding_lots (
 id uuid PRIMARY KEY,obligation_id uuid NOT NULL,environment_id uuid NOT NULL,source_plan_revision integer NOT NULL DEFAULT 1,
 principal_cents bigint NOT NULL,publisher_fee_cents bigint NOT NULL,fee_cents bigint NOT NULL,
 UNIQUE(id,environment_id),UNIQUE(obligation_id),
 FOREIGN KEY(obligation_id,environment_id) REFERENCES campus.funding_obligations(id,environment_id)
);
CREATE TABLE campus.funding_component_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lot_id uuid NOT NULL,environment_id uuid NOT NULL,
 allocation_component_id uuid REFERENCES campus.payee_allocations(component_id),member_id uuid NOT NULL REFERENCES campus.users,
 milestone_id uuid,stage_position integer NOT NULL,gross_cents bigint NOT NULL CHECK(gross_cents>=0),recipient_fee_cents bigint NOT NULL CHECK(recipient_fee_cents>=0),
 net_cents bigint NOT NULL CHECK(net_cents>=0 AND net_cents+recipient_fee_cents=gross_cents),
 UNIQUE(id,environment_id,lot_id),UNIQUE(lot_id,member_id,stage_position),FOREIGN KEY(lot_id,environment_id) REFERENCES campus.funding_lots(id,environment_id)
);
CREATE TABLE campus.money_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,obligation_id uuid,
 kind text NOT NULL CHECK(kind IN('checkout','transfer','refund','reversal','expire','onboarding','recipient')),business_key text NOT NULL,
 payload jsonb NOT NULL,payload_hash text NOT NULL,provider_key text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','dispatching','succeeded','failed','unknown','held')),
 provider_id text,first_dispatched_at timestamptz,lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,
 result jsonb,created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(id,environment_id),UNIQUE(environment_id,kind,business_key),UNIQUE(environment_id,provider_key),
 FOREIGN KEY(obligation_id,environment_id) REFERENCES campus.funding_obligations(id,environment_id)
);
CREATE TABLE campus.payment_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL,obligation_id uuid NOT NULL,quote_id uuid NOT NULL,
 operation_id uuid NOT NULL,status text NOT NULL DEFAULT 'creating' CHECK(status IN('creating','requires_action','processing','succeeded','failed','canceled','unknown')),
 session_id text,intent_id text,charge_id text,hosted_url text,expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT campus.money_now(),UNIQUE(id,environment_id),UNIQUE(operation_id),UNIQUE(environment_id,session_id),UNIQUE(environment_id,charge_id),
 FOREIGN KEY(quote_id,obligation_id,environment_id) REFERENCES campus.payment_quotes(id,obligation_id,environment_id),
 FOREIGN KEY(operation_id,environment_id) REFERENCES campus.money_operations(id,environment_id)
);
CREATE UNIQUE INDEX payment_attempt_exclusive ON campus.payment_attempts(obligation_id) WHERE status NOT IN('failed','canceled');
CREATE TABLE campus.payment_outbox (
 operation_id uuid PRIMARY KEY REFERENCES campus.money_operations,attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT campus.money_now(),dead_letter boolean NOT NULL DEFAULT false,last_code text
);
CREATE TABLE campus.provider_inbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 origin_account text NOT NULL,event_id text NOT NULL,event_type text NOT NULL,payload_digest text NOT NULL,payload jsonb NOT NULL,
 parser text NOT NULL CHECK(parser IN('snapshot','thin')),status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT campus.money_now(),lease_until timestamptz,fence bigint NOT NULL DEFAULT 0,last_code text,reconciliation_cursor text,
 UNIQUE(environment_id,origin_account,event_id)
);
CREATE TABLE campus.payment_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 operation_id uuid REFERENCES campus.money_operations,kind text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now()
);
CREATE TABLE campus.ledger_journals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,
 lot_id uuid,source_effect text NOT NULL,currency text NOT NULL CHECK(currency='USD'),created_at timestamptz NOT NULL DEFAULT campus.money_now(),
 UNIQUE(environment_id,source_effect),UNIQUE(id,environment_id),FOREIGN KEY(lot_id,environment_id) REFERENCES campus.funding_lots(id,environment_id)
);
CREATE TABLE campus.ledger_lines (
 journal_id uuid NOT NULL,environment_id uuid NOT NULL,position integer NOT NULL,
 account text NOT NULL CHECK(account IN('cash','reward_liability','publisher_fee_liability','fee_expense','fee_recovery','payable','suspense','network_exposure')),
 member_id uuid REFERENCES campus.users,component_id uuid REFERENCES campus.funding_component_plans,
 debit bigint NOT NULL DEFAULT 0 CHECK(debit>=0),credit bigint NOT NULL DEFAULT 0 CHECK(credit>=0),CHECK((debit=0)<>(credit=0)),
 PRIMARY KEY(journal_id,position),FOREIGN KEY(journal_id,environment_id) REFERENCES campus.ledger_journals(id,environment_id)
);
CREATE TABLE campus.funding_allocations (
 lot_id uuid PRIMARY KEY,environment_id uuid NOT NULL,attempt_id uuid NOT NULL,charge_id text NOT NULL,receipt_journal_id uuid NOT NULL,
 actual_fee_cents bigint,fee_fact_id text,fee_state text NOT NULL DEFAULT 'fee_actual_pending' CHECK(fee_state IN('fee_actual_pending','fee_variance_pending','matched')),
 available_cents bigint,UNIQUE(environment_id,charge_id),UNIQUE(attempt_id),
 FOREIGN KEY(lot_id,environment_id) REFERENCES campus.funding_lots(id,environment_id),
 FOREIGN KEY(attempt_id,environment_id) REFERENCES campus.payment_attempts(id,environment_id),
 FOREIGN KEY(receipt_journal_id,environment_id) REFERENCES campus.ledger_journals(id,environment_id)
);
CREATE TABLE campus.money_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL,lot_id uuid NOT NULL,component_id uuid,
 operation_id uuid REFERENCES campus.money_operations,kind text NOT NULL CHECK(kind IN('publisher_fee','recipient_fee','transfer','refund','reversal')),
 amount_cents bigint NOT NULL CHECK(amount_cents>=0),cash_debited_cents bigint NOT NULL DEFAULT 0 CHECK(cash_debited_cents>=0 AND cash_debited_cents<=amount_cents),status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','consumed','released')),
 UNIQUE(operation_id,component_id,kind),FOREIGN KEY(lot_id,environment_id) REFERENCES campus.funding_lots(id,environment_id),
 FOREIGN KEY(component_id,environment_id,lot_id) REFERENCES campus.funding_component_plans(id,environment_id,lot_id)
);
CREATE UNIQUE INDEX original_fee_bucket ON campus.money_reservations(lot_id,coalesce(component_id,'00000000-0000-0000-0000-000000000000'),kind) WHERE kind IN('publisher_fee','recipient_fee');
CREATE TABLE campus.fee_consumptions (
 reservation_id uuid PRIMARY KEY REFERENCES campus.money_reservations,environment_id uuid NOT NULL,lot_id uuid NOT NULL,fee_fact_id text NOT NULL,
 journal_id uuid NOT NULL,FOREIGN KEY(lot_id,environment_id) REFERENCES campus.funding_lots(id,environment_id),FOREIGN KEY(journal_id,environment_id) REFERENCES campus.ledger_journals(id,environment_id)
);
CREATE TABLE campus.payment_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),obligation_id uuid NOT NULL REFERENCES campus.funding_obligations,member_id uuid REFERENCES campus.users,
 reason text NOT NULL,source_effect text NOT NULL,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT campus.money_now(),UNIQUE(obligation_id,source_effect)
);
CREATE TABLE campus.reconciliation_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),environment_id uuid NOT NULL REFERENCES campus.payment_environments,obligation_id uuid REFERENCES campus.funding_obligations,
 source_effect text NOT NULL,reason text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT campus.money_now(),UNIQUE(environment_id,source_effect)
);
CREATE FUNCTION campus.money_visible(oid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT campus.is_member() AND EXISTS(SELECT 1 FROM campus.funding_obligations o WHERE o.id=oid AND
 ((o.agreement_id IS NOT NULL AND campus.actor()=ANY(campus.notification_agreement_people(o.agreement_id))) OR
 (o.order_id IS NOT NULL AND EXISTS(SELECT 1 FROM campus.orders x WHERE x.id=o.order_id AND campus.actor() IN(x.buyer_id,x.seller_id)))))
$$;
CREATE FUNCTION campus.money_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
 BEGIN RAISE EXCEPTION 'Money history is immutable' USING ERRCODE='23514';END $$;
CREATE FUNCTION campus.money_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE jid uuid;
BEGIN IF TG_TABLE_NAME='ledger_journals' THEN jid:=NEW.id;ELSE jid:=NEW.journal_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.ledger_lines WHERE journal_id=jid) OR (SELECT sum(debit-credit) FROM campus.ledger_lines WHERE journal_id=jid)<>0 THEN RAISE EXCEPTION 'unbalanced_journal' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER journal_balance AFTER INSERT ON campus.ledger_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION campus.money_balanced();
CREATE CONSTRAINT TRIGGER line_balance AFTER INSERT ON campus.ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION campus.money_balanced();
CREATE FUNCTION campus.money_journal(eid uuid,lid uuid,effect text,entries jsonb) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE jid uuid;v jsonb;i integer:=0;
BEGIN
 SELECT id INTO jid FROM campus.ledger_journals WHERE environment_id=eid AND source_effect=effect;IF FOUND THEN RETURN jid;END IF;
 INSERT INTO campus.ledger_journals(environment_id,lot_id,source_effect,currency) VALUES(eid,lid,effect,'USD') RETURNING id INTO jid;
 FOR v IN SELECT value FROM jsonb_array_elements(entries) LOOP
  IF coalesce((v->>'debit')::bigint,0)+coalesce((v->>'credit')::bigint,0)=0 THEN CONTINUE;END IF;i:=i+1;
  IF v?'componentId' AND NOT EXISTS(SELECT 1 FROM campus.funding_component_plans WHERE id=(v->>'componentId')::uuid AND environment_id=eid AND lot_id=lid AND (NOT v?'memberId' OR member_id=(v->>'memberId')::uuid)) THEN RAISE EXCEPTION 'journal_component_scope_mismatch' USING ERRCODE='23514';END IF;
  INSERT INTO campus.ledger_lines VALUES(jid,eid,i,v->>'account',(v->>'memberId')::uuid,(v->>'componentId')::uuid,coalesce((v->>'debit')::bigint,0),coalesce((v->>'credit')::bigint,0));
 END LOOP;RETURN jid;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payment_environments','payment_execution_policies','connected_payee_accounts','funding_obligations','payment_quotes','funding_lots','funding_component_plans','money_operations','payment_attempts','payment_outbox','provider_inbox','payment_events','ledger_journals','ledger_lines','funding_allocations','money_reservations','fee_consumptions','payment_holds','reconciliation_cases'] LOOP
 EXECUTE format('ALTER TABLE campus.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON campus.%I FROM PUBLIC,campus_app,campus_auth,campus_worker',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['payment_execution_policies','payment_quotes','funding_lots','funding_component_plans','payment_events','ledger_journals','ledger_lines','fee_consumptions'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_money BEFORE UPDATE OR DELETE ON campus.%I FOR EACH ROW EXECUTE FUNCTION campus.money_immutable()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION campus.money_visible(uuid),campus.money_immutable(),campus.money_balanced(),campus.money_journal(uuid,uuid,text,jsonb) FROM PUBLIC,campus_app,campus_auth,campus_worker;
