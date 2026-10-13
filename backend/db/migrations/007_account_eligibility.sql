ALTER TABLE campus.users ADD COLUMN bio text NOT NULL DEFAULT '' CHECK(length(bio)<=500);
-- NULL preserves separately provisioned legacy eligibility; all new reviews expire.
ALTER TABLE campus.affiliations ADD COLUMN student_valid_until timestamptz;
UPDATE campus.affiliations SET student_valid_until=valid_until WHERE can_apply;
REVOKE INSERT,UPDATE ON campus.affiliations FROM campus_auth;
GRANT INSERT(user_id,institution_id,domain,valid_until),UPDATE(valid_until) ON campus.affiliations TO campus_auth;
CREATE FUNCTION campus.clear_changed_student_affiliation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF NEW.institution_id IS DISTINCT FROM OLD.institution_id OR NEW.domain IS DISTINCT FROM OLD.domain THEN
   NEW.can_apply:=false; NEW.student_valid_until:=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER clear_changed_student_affiliation BEFORE UPDATE ON campus.affiliations
 FOR EACH ROW EXECUTE FUNCTION campus.clear_changed_student_affiliation();
REVOKE ALL ON FUNCTION campus.clear_changed_student_affiliation() FROM PUBLIC;
GRANT UPDATE(display_name,bio) ON campus.users TO campus_app;

CREATE TABLE campus.eligibility_reviewers (
 user_id uuid NOT NULL REFERENCES campus.users,
 institution_id uuid NOT NULL REFERENCES campus.institutions,
 PRIMARY KEY(user_id,institution_id)
);
ALTER TABLE campus.eligibility_reviewers ENABLE ROW LEVEL SECURITY;
-- Only the trusted database owner provisions reviewers. No runtime role can grant itself authority.
CREATE FUNCTION campus.can_review_eligibility(i uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM campus.eligibility_reviewers r
 JOIN campus.users u ON u.id=r.user_id
 JOIN campus.affiliations a ON a.user_id=u.id AND a.institution_id=r.institution_id
 JOIN campus.domains d ON d.domain=a.domain AND d.institution_id=a.institution_id
 JOIN campus.institutions n ON n.id=a.institution_id
 WHERE r.user_id=campus.actor() AND (i IS NULL OR r.institution_id=i)
 AND u.account_status='active' AND a.valid_until>clock_timestamp() AND d.enabled AND n.active)
$$;
CREATE OR REPLACE FUNCTION campus.eligible_student(u uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM campus.users x JOIN campus.affiliations a ON a.user_id=x.id
 JOIN campus.domains d ON d.domain=a.domain AND d.institution_id=a.institution_id
 JOIN campus.institutions i ON i.id=a.institution_id
 WHERE x.id=u AND x.account_status='active' AND a.can_apply AND a.valid_until>clock_timestamp()
 AND (a.student_valid_until IS NULL OR a.student_valid_until>clock_timestamp()) AND d.enabled AND i.active)
$$;

CREATE TABLE campus.eligibility_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES campus.users,
 display_name text NOT NULL, institution_id uuid NOT NULL REFERENCES campus.institutions,
 institution_name text NOT NULL, domain text NOT NULL REFERENCES campus.domains,
 enrollment_summary text NOT NULL CHECK(length(btrim(enrollment_summary)) BETWEEN 1 AND 1000),
 attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reviewer_id uuid REFERENCES campus.users, reviewed_at timestamptz, review_reason text, valid_until timestamptz,
 CHECK((status='pending' AND reviewer_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL AND valid_until IS NULL)
 OR (status IN ('approved','rejected') AND reviewer_id IS NOT NULL AND reviewer_id<>user_id AND reviewed_at IS NOT NULL
 AND length(btrim(review_reason)) BETWEEN 1 AND 1000 AND ((status='approved' AND valid_until>reviewed_at) OR (status='rejected' AND valid_until IS NULL))))
);
CREATE UNIQUE INDEX eligibility_one_pending ON campus.eligibility_requests(user_id) WHERE status='pending';
CREATE INDEX eligibility_review_queue ON campus.eligibility_requests(institution_id,status,created_at DESC,id DESC);
ALTER TABLE campus.eligibility_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY eligibility_visible ON campus.eligibility_requests FOR SELECT TO campus_app
 USING(user_id=campus.actor() OR campus.can_review_eligibility(institution_id));
GRANT SELECT ON campus.eligibility_requests TO campus_app;

CREATE FUNCTION campus.eligibility_requests_visible() RETURNS TABLE(
 id uuid,user_id uuid,display_name text,institution_id uuid,institution_name text,enrollment_summary text,
 status text,created_at timestamptz,reviewed_at timestamptz,review_reason text,valid_until timestamptz,
 affiliation_valid_until timestamptz,membership_current boolean,can_review boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
 SELECT r.id,r.user_id,r.display_name,r.institution_id,r.institution_name,r.enrollment_summary,
 r.status,r.created_at,r.reviewed_at,r.review_reason,r.valid_until,a.valid_until,
 coalesce(a.institution_id=r.institution_id AND a.domain=r.domain AND a.valid_until>clock_timestamp()
 AND u.account_status='active' AND d.enabled AND i.active,false),
 r.user_id<>campus.actor() AND campus.can_review_eligibility(r.institution_id)
 FROM campus.eligibility_requests r
 JOIN campus.users u ON u.id=r.user_id
 LEFT JOIN campus.affiliations a ON a.user_id=r.user_id
 LEFT JOIN campus.domains d ON d.domain=a.domain AND d.institution_id=a.institution_id
 LEFT JOIN campus.institutions i ON i.id=a.institution_id
 WHERE EXISTS(SELECT 1 FROM campus.users me WHERE me.id=campus.actor() AND me.account_status<>'locked')
 AND (r.user_id=campus.actor() OR campus.can_review_eligibility(r.institution_id))
$$;

CREATE FUNCTION campus.request_student_eligibility(summary text,attestation boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE u campus.users; a campus.affiliations; request_id uuid; school_name text;
BEGIN
 IF attestation IS DISTINCT FROM true OR summary IS NULL OR length(btrim(summary)) NOT BETWEEN 1 AND 1000
 THEN RAISE EXCEPTION 'invalid_eligibility_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO u FROM campus.users WHERE id=campus.actor() FOR UPDATE;
 SELECT * INTO a FROM campus.affiliations WHERE user_id=campus.actor() FOR UPDATE;
 SELECT i.name INTO school_name FROM campus.institutions i JOIN campus.domains d ON d.institution_id=i.id
 WHERE i.id=a.institution_id AND d.domain=a.domain AND d.enabled AND i.active;
 IF u.id IS NULL OR u.account_status<>'active' OR a.valid_until IS NULL OR a.valid_until<=clock_timestamp() OR school_name IS NULL
 THEN RAISE EXCEPTION 'membership_required' USING ERRCODE='42501'; END IF;
 IF campus.eligible_student(campus.actor()) THEN RAISE EXCEPTION 'eligibility_current' USING ERRCODE='P0001'; END IF;
 SELECT id INTO request_id FROM campus.eligibility_requests WHERE user_id=campus.actor() AND status='pending';
 IF request_id IS NOT NULL THEN RAISE EXCEPTION 'eligibility_pending' USING ERRCODE='P0001'; END IF;
 INSERT INTO campus.eligibility_requests(user_id,display_name,institution_id,institution_name,domain,enrollment_summary)
 VALUES(u.id,u.display_name,a.institution_id,school_name,a.domain,btrim(summary)) RETURNING id INTO request_id;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'eligibility.request',request_id);
 INSERT INTO campus.events(kind,object_id) VALUES('eligibility.request',request_id);
 RETURN request_id;
END $$;

CREATE FUNCTION campus.decide_student_eligibility(request_id uuid,decision text,reason text,until_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE r campus.eligibility_requests; a campus.affiliations; applicant campus.users;
BEGIN
 IF decision IS NULL OR decision NOT IN ('approved','rejected') OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 1000
 OR (decision='approved' AND until_at IS NULL) OR (decision='rejected' AND until_at IS NOT NULL)
 THEN RAISE EXCEPTION 'invalid_eligibility_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM campus.eligibility_requests WHERE id=request_id FOR UPDATE;
 IF r.id IS NULL OR NOT campus.can_review_eligibility(r.institution_id) THEN RAISE EXCEPTION 'review_forbidden' USING ERRCODE='42501'; END IF;
 IF r.user_id=campus.actor() THEN RAISE EXCEPTION 'self_review_forbidden' USING ERRCODE='42501'; END IF;
 -- Lock identities in a stable order so concurrent reviews cannot invert account locks.
 PERFORM id FROM campus.users WHERE id IN (r.user_id,campus.actor()) ORDER BY id FOR UPDATE;
 PERFORM user_id FROM campus.affiliations WHERE user_id IN (r.user_id,campus.actor()) ORDER BY user_id FOR UPDATE;
 -- Prevent trusted revocation of this reviewer from racing the decision after authorization.
 PERFORM 1 FROM campus.eligibility_reviewers WHERE user_id=campus.actor() AND institution_id=r.institution_id FOR SHARE;
 SELECT * INTO applicant FROM campus.users WHERE id=r.user_id;
 SELECT * INTO a FROM campus.affiliations WHERE user_id=r.user_id;
 IF NOT campus.can_review_eligibility(r.institution_id) THEN RAISE EXCEPTION 'review_forbidden' USING ERRCODE='42501'; END IF;
 IF r.status<>'pending' THEN
   IF r.status=decision AND r.review_reason=btrim(reason) AND r.valid_until IS NOT DISTINCT FROM until_at THEN RETURN r.id; END IF;
   RAISE EXCEPTION 'eligibility_decided' USING ERRCODE='P0001';
 END IF;
 IF decision='approved' THEN
   IF applicant.account_status<>'active' OR a.institution_id IS DISTINCT FROM r.institution_id OR a.domain IS DISTINCT FROM r.domain
   OR a.valid_until IS NULL OR a.valid_until<=clock_timestamp()
   OR NOT EXISTS(SELECT 1 FROM campus.domains d JOIN campus.institutions i ON i.id=d.institution_id
     WHERE d.domain=a.domain AND d.institution_id=a.institution_id AND d.enabled AND i.active)
   THEN RAISE EXCEPTION 'applicant_membership_changed' USING ERRCODE='P0001'; END IF;
   IF until_at<=clock_timestamp() OR until_at>clock_timestamp()+interval '365 days' OR until_at>a.valid_until
   THEN RAISE EXCEPTION 'invalid_eligibility_expiry' USING ERRCODE='22023'; END IF;
   UPDATE campus.affiliations SET can_apply=true,student_valid_until=until_at WHERE user_id=r.user_id;
 END IF;
 UPDATE campus.eligibility_requests SET status=decision,reviewer_id=campus.actor(),reviewed_at=clock_timestamp(),review_reason=btrim(reason),valid_until=until_at WHERE id=r.id;
 INSERT INTO campus.audit(actor_id,action,object_id) VALUES(campus.actor(),'eligibility.'||decision,r.id);
 INSERT INTO campus.events(kind,object_id) VALUES('eligibility.'||decision,r.id);
 RETURN r.id;
END $$;

REVOKE ALL ON FUNCTION campus.can_review_eligibility(uuid),campus.eligibility_requests_visible(),campus.request_student_eligibility(text,boolean),campus.decide_student_eligibility(uuid,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.can_review_eligibility(uuid),campus.eligibility_requests_visible(),campus.request_student_eligibility(text,boolean),campus.decide_student_eligibility(uuid,text,text,timestamptz) TO campus_app;
