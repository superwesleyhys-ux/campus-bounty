-- Forward-only repair: 001–012 and all historical rows/receipts remain unchanged.
-- Revalidate agreement scope after the authority-lock statements, including when
-- no ordinary-signer row survived the wait. No new grants, trigger or API shape.
CREATE OR REPLACE FUNCTION campus.authorize_message_scope(scope_kind text,scope_id uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE status text; membership_ok boolean; scope_ok boolean; member_locked boolean;
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
