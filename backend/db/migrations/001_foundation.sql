REVOKE ALL ON SCHEMA campus FROM PUBLIC;
GRANT USAGE ON SCHEMA campus TO campus_app, campus_auth, campus_worker;
CREATE TABLE campus.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
 account_status text NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','restricted','locked')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campus.institutions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, active boolean NOT NULL DEFAULT false,
 review_evidence text NOT NULL CHECK(length(review_evidence)>0)
);
CREATE TABLE campus.domains (
 domain text PRIMARY KEY CHECK(domain=lower(domain)), institution_id uuid NOT NULL REFERENCES campus.institutions,
 enabled boolean NOT NULL DEFAULT false, reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campus.identities (
 email text PRIMARY KEY CHECK(email=lower(email)), user_id uuid NOT NULL UNIQUE REFERENCES campus.users,
 domain text NOT NULL REFERENCES campus.domains, verified_at timestamptz NOT NULL
);
CREATE TABLE campus.affiliations (
 user_id uuid PRIMARY KEY REFERENCES campus.users, institution_id uuid NOT NULL REFERENCES campus.institutions,
 domain text NOT NULL REFERENCES campus.domains, valid_until timestamptz NOT NULL,
 can_apply boolean NOT NULL DEFAULT false
);
CREATE TABLE campus.challenges (
 id uuid PRIMARY KEY, email text NOT NULL, code_hash text NOT NULL, expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campus.sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES campus.users, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campus.rate_limits (bucket text PRIMARY KEY, hits integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE TABLE campus.mail_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload text, expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','dead')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_id uuid, lease_until timestamptz,
 last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_ready ON campus.mail_jobs(available_at) WHERE status IN ('pending','sending');
CREATE TABLE campus.teams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES campus.users,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), revision integer NOT NULL DEFAULT 1
);
CREATE TABLE campus.team_members (
 team_id uuid NOT NULL REFERENCES campus.teams, user_id uuid NOT NULL REFERENCES campus.users,
 state text NOT NULL CHECK(state IN ('invited','accepted')), PRIMARY KEY(team_id,user_id)
);
CREATE TABLE campus.tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES campus.users,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160), category text NOT NULL,
 description text NOT NULL DEFAULT '', reward_cents integer NOT NULL DEFAULT 0 CHECK(reward_cents BETWEEN 0 AND 100000000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','contracted','closed')), revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_catalog ON campus.tasks(created_at DESC,id DESC);
CREATE TABLE campus.task_milestones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES campus.tasks,
 position integer NOT NULL CHECK(position>0), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 amount_cents integer NOT NULL CHECK(amount_cents>0), deliverable text NOT NULL, UNIQUE(task_id,position)
);
CREATE TABLE campus.applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES campus.tasks,
 applicant_id uuid NOT NULL REFERENCES campus.users, team_id uuid REFERENCES campus.teams,
 proposal text NOT NULL, state text NOT NULL DEFAULT 'applied' CHECK(state IN ('applied','invited','accepted','declined')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,applicant_id)
);
CREATE TABLE campus.agreements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL UNIQUE REFERENCES campus.tasks,
 application_id uuid NOT NULL UNIQUE REFERENCES campus.applications, owner_id uuid NOT NULL REFERENCES campus.users,
 captain_id uuid NOT NULL REFERENCES campus.users, team_id uuid REFERENCES campus.teams,
 state text NOT NULL DEFAULT 'awaiting_funding' CHECK(state IN ('awaiting_funding','active','submitted','completed','cancelled')),
 terms jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(owner_id<>captain_id)
);
CREATE TABLE campus.agreement_members (
 agreement_id uuid NOT NULL REFERENCES campus.agreements, user_id uuid NOT NULL REFERENCES campus.users,
 PRIMARY KEY(agreement_id,user_id)
);
CREATE TABLE campus.milestones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_id uuid NOT NULL REFERENCES campus.agreements,
 position integer NOT NULL CHECK(position>0), title text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents>0), deliverable text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','submitted','accepted')), version integer NOT NULL DEFAULT 0,
 UNIQUE(agreement_id,position)
);
CREATE TABLE campus.submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), milestone_id uuid NOT NULL REFERENCES campus.milestones,
 author_id uuid NOT NULL REFERENCES campus.users, version integer NOT NULL CHECK(version>0), content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(milestone_id,version)
);
CREATE TABLE campus.products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES campus.users,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160), description text NOT NULL,
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 100000000), stock integer NOT NULL CHECK(stock>=0),
 delivery_methods text[] NOT NULL CHECK(cardinality(delivery_methods)>0 AND delivery_methods <@ ARRAY['pickup','shipping']::text[]),
 shipping_cents integer NOT NULL DEFAULT 0 CHECK(shipping_cents>=0 AND shipping_cents<=10000000),
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_catalog ON campus.products(created_at DESC,id DESC);
CREATE TABLE campus.quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES campus.products,
 buyer_id uuid NOT NULL REFERENCES campus.users, seller_id uuid NOT NULL REFERENCES campus.users, product_revision integer NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100), unit_cents integer NOT NULL CHECK(unit_cents>0),
 shipping_cents integer NOT NULL CHECK(shipping_cents>=0), delivery_method text NOT NULL CHECK(delivery_method IN ('pickup','shipping')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(buyer_id<>seller_id)
);
CREATE TABLE campus.orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), quote_id uuid NOT NULL UNIQUE REFERENCES campus.quotes,
 product_id uuid NOT NULL REFERENCES campus.products, buyer_id uuid NOT NULL REFERENCES campus.users, seller_id uuid NOT NULL REFERENCES campus.users,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100), total_cents integer NOT NULL CHECK(total_cents>0),
 delivery_method text NOT NULL CHECK(delivery_method IN ('pickup','shipping')), shipping_address jsonb,
 state text NOT NULL DEFAULT 'pending_payment' CHECK(state IN ('pending_payment','paid','shipped','ready_for_pickup','completed','expired','cancelled')),
 reserved_until timestamptz NOT NULL, terms jsonb NOT NULL, carrier text, tracking_number text,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(buyer_id<>seller_id),
 CHECK((delivery_method='shipping' AND shipping_address IS NOT NULL) OR (delivery_method='pickup' AND shipping_address IS NULL))
);
CREATE INDEX orders_expiry ON campus.orders(reserved_until) WHERE state='pending_payment';
CREATE TABLE campus.messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid NOT NULL REFERENCES campus.users,
 agreement_id uuid REFERENCES campus.agreements, order_id uuid REFERENCES campus.orders,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(agreement_id,order_id)=1)
);
CREATE TABLE campus.saved (
 user_id uuid NOT NULL REFERENCES campus.users, task_id uuid NOT NULL REFERENCES campus.tasks, PRIMARY KEY(user_id,task_id)
);
CREATE TABLE campus.idempotency (
 actor_id uuid NOT NULL REFERENCES campus.users, operation text NOT NULL, key text NOT NULL CHECK(length(key) BETWEEN 8 AND 128),
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,operation,key)
);
CREATE TABLE campus.audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES campus.users, action text NOT NULL,
 object_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campus.events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, object_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION campus.actor() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('campus.actor_id',true),'')::uuid $$;
CREATE FUNCTION campus.is_member() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$
 SELECT EXISTS(SELECT 1 FROM campus.users u JOIN campus.affiliations a ON a.user_id=u.id JOIN campus.domains d ON d.domain=a.domain AND d.institution_id=a.institution_id JOIN campus.institutions i ON i.id=a.institution_id
 WHERE u.id=campus.actor() AND u.account_status<>'locked' AND a.valid_until>now() AND d.enabled AND i.active)
$$;
CREATE FUNCTION campus.owns_task(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.tasks WHERE id=t AND owner_id=campus.actor()) $$;
CREATE FUNCTION campus.on_team(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.teams WHERE id=t AND owner_id=campus.actor()) OR EXISTS(SELECT 1 FROM campus.team_members WHERE team_id=t AND user_id=campus.actor()) $$;
CREATE FUNCTION campus.owns_team(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.teams WHERE id=t AND owner_id=campus.actor()) $$;
CREATE FUNCTION campus.in_agreement(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.agreements WHERE id=a AND (owner_id=campus.actor() OR captain_id=campus.actor())) OR EXISTS(SELECT 1 FROM campus.agreement_members WHERE agreement_id=a AND user_id=campus.actor()) $$;
CREATE FUNCTION campus.in_order(o uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.orders WHERE id=o AND campus.actor() IN (buyer_id,seller_id)) $$;
CREATE FUNCTION campus.in_milestone(m uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,campus AS $$ SELECT EXISTS(SELECT 1 FROM campus.milestones WHERE id=m AND campus.in_agreement(agreement_id)) $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA campus FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA campus TO campus_app;

GRANT SELECT ON campus.users,campus.institutions,campus.domains,campus.affiliations TO campus_app;
GRANT SELECT,INSERT,UPDATE ON campus.teams,campus.team_members,campus.tasks,campus.applications,campus.agreements,campus.milestones,campus.products,campus.orders TO campus_app;
GRANT SELECT,INSERT ON campus.task_milestones,campus.agreement_members,campus.submissions,campus.quotes,campus.messages,campus.idempotency TO campus_app;
GRANT SELECT,INSERT,DELETE ON campus.saved TO campus_app;
GRANT INSERT ON campus.audit,campus.events TO campus_app;
GRANT SELECT,INSERT,UPDATE ON campus.users,campus.identities,campus.affiliations,campus.challenges,campus.sessions,campus.rate_limits,campus.mail_jobs TO campus_auth;
GRANT SELECT ON campus.institutions,campus.domains TO campus_auth;
GRANT SELECT,UPDATE ON campus.mail_jobs TO campus_worker;

ALTER TABLE campus.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_self ON campus.users TO campus_app USING(id=campus.actor());
CREATE POLICY users_auth ON campus.users TO campus_auth USING(true) WITH CHECK(true);
ALTER TABLE campus.affiliations ENABLE ROW LEVEL SECURITY;
CREATE POLICY affiliation_self ON campus.affiliations TO campus_app USING(user_id=campus.actor());
CREATE POLICY affiliation_auth ON campus.affiliations TO campus_auth USING(true) WITH CHECK(true);
ALTER TABLE campus.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_read ON campus.tasks FOR SELECT TO campus_app USING(owner_id=campus.actor() OR campus.is_member());
CREATE POLICY tasks_insert ON campus.tasks FOR INSERT TO campus_app WITH CHECK(owner_id=campus.actor() AND campus.is_member());
CREATE POLICY tasks_update ON campus.tasks FOR UPDATE TO campus_app USING(owner_id=campus.actor() OR EXISTS(SELECT 1 FROM campus.applications WHERE task_id=tasks.id AND applicant_id=campus.actor() AND state='invited'));
ALTER TABLE campus.task_milestones ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_milestones_read ON campus.task_milestones FOR SELECT TO campus_app USING(campus.owns_task(task_id) OR campus.is_member());
CREATE POLICY task_milestones_write ON campus.task_milestones FOR INSERT TO campus_app WITH CHECK(campus.owns_task(task_id));
ALTER TABLE campus.applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY applications_read ON campus.applications FOR SELECT TO campus_app USING(applicant_id=campus.actor() OR campus.owns_task(task_id));
CREATE POLICY applications_insert ON campus.applications FOR INSERT TO campus_app WITH CHECK(applicant_id=campus.actor() AND campus.is_member());
CREATE POLICY applications_update ON campus.applications FOR UPDATE TO campus_app USING(applicant_id=campus.actor() OR campus.owns_task(task_id));
ALTER TABLE campus.teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY teams_read ON campus.teams FOR SELECT TO campus_app USING(campus.on_team(id));
CREATE POLICY teams_write ON campus.teams FOR INSERT TO campus_app WITH CHECK(owner_id=campus.actor() AND campus.is_member());
CREATE POLICY teams_update ON campus.teams FOR UPDATE TO campus_app USING(owner_id=campus.actor());
ALTER TABLE campus.team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_read ON campus.team_members FOR SELECT TO campus_app USING(campus.on_team(team_id));
CREATE POLICY members_insert ON campus.team_members FOR INSERT TO campus_app WITH CHECK(campus.owns_team(team_id));
CREATE POLICY members_update ON campus.team_members FOR UPDATE TO campus_app USING(user_id=campus.actor());
ALTER TABLE campus.agreements ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreements_read ON campus.agreements FOR SELECT TO campus_app USING(campus.in_agreement(id));
CREATE POLICY agreements_insert ON campus.agreements FOR INSERT TO campus_app WITH CHECK(captain_id=campus.actor());
CREATE POLICY agreements_update ON campus.agreements FOR UPDATE TO campus_app USING(campus.in_agreement(id));
ALTER TABLE campus.agreement_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreement_members_read ON campus.agreement_members FOR SELECT TO campus_app USING(campus.in_agreement(agreement_id));
CREATE POLICY agreement_members_insert ON campus.agreement_members FOR INSERT TO campus_app WITH CHECK(EXISTS(SELECT 1 FROM campus.agreements WHERE id=agreement_id AND captain_id=campus.actor()));
ALTER TABLE campus.milestones ENABLE ROW LEVEL SECURITY;
CREATE POLICY milestones_all ON campus.milestones TO campus_app USING(campus.in_agreement(agreement_id)) WITH CHECK(campus.in_agreement(agreement_id));
ALTER TABLE campus.submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY submissions_read ON campus.submissions FOR SELECT TO campus_app USING(campus.in_milestone(milestone_id));
CREATE POLICY submissions_insert ON campus.submissions FOR INSERT TO campus_app WITH CHECK(author_id=campus.actor() AND campus.in_milestone(milestone_id));
ALTER TABLE campus.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY products_read ON campus.products FOR SELECT TO campus_app USING(campus.is_member());
CREATE POLICY products_insert ON campus.products FOR INSERT TO campus_app WITH CHECK(seller_id=campus.actor() AND campus.is_member());
-- Buyers decrement inventory only inside validated order commands; the SQL role is server-only.
CREATE POLICY products_update ON campus.products FOR UPDATE TO campus_app USING(campus.is_member());
ALTER TABLE campus.quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY quotes_read ON campus.quotes FOR SELECT TO campus_app USING(buyer_id=campus.actor());
CREATE POLICY quotes_insert ON campus.quotes FOR INSERT TO campus_app WITH CHECK(buyer_id=campus.actor() AND campus.is_member());
ALTER TABLE campus.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_read ON campus.orders FOR SELECT TO campus_app USING(campus.actor() IN (buyer_id,seller_id));
CREATE POLICY orders_insert ON campus.orders FOR INSERT TO campus_app WITH CHECK(buyer_id=campus.actor() AND campus.is_member());
CREATE POLICY orders_update ON campus.orders FOR UPDATE TO campus_app USING(campus.actor() IN (buyer_id,seller_id));
ALTER TABLE campus.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_read ON campus.messages FOR SELECT TO campus_app USING(campus.in_agreement(agreement_id) OR campus.in_order(order_id));
CREATE POLICY messages_insert ON campus.messages FOR INSERT TO campus_app WITH CHECK(sender_id=campus.actor() AND (campus.in_agreement(agreement_id) OR campus.in_order(order_id)));
ALTER TABLE campus.saved ENABLE ROW LEVEL SECURITY;
CREATE POLICY saved_self ON campus.saved TO campus_app USING(user_id=campus.actor()) WITH CHECK(user_id=campus.actor());
ALTER TABLE campus.idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_self ON campus.idempotency TO campus_app USING(actor_id=campus.actor()) WITH CHECK(actor_id=campus.actor());
ALTER TABLE campus.audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON campus.audit FOR INSERT TO campus_app WITH CHECK(actor_id=campus.actor());
