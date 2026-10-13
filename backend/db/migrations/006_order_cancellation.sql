-- Inventory changes by buyers are confined to quote-backed order creation and
-- cancellation. Do not grant a general inventory adjustment capability.
ALTER POLICY products_update ON campus.products
 USING(seller_id=campus.actor() AND campus.is_member())
 WITH CHECK(seller_id=campus.actor() AND campus.is_member());
REVOKE INSERT ON campus.orders FROM campus_app;

CREATE FUNCTION campus.create_order_from_quote(qid uuid, address jsonb)
RETURNS campus.orders LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE
 buyer uuid:=campus.actor();
 q campus.quotes;
 p campus.products;
 result campus.orders;
BEGIN
 IF buyer IS NULL OR NOT campus.is_member() THEN
  RAISE EXCEPTION 'membership_required' USING ERRCODE='P0001';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.users WHERE id=buyer AND account_status='active') THEN
  RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';
 END IF;
 SELECT * INTO q FROM campus.quotes WHERE id=qid AND buyer_id=buyer;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('quote:'||qid::text,0));
 SELECT * INTO result FROM campus.orders WHERE quote_id=qid;
 IF FOUND THEN
  IF result.shipping_address IS DISTINCT FROM address THEN
   RAISE EXCEPTION 'quote_consumed' USING ERRCODE='P0001';
  END IF;
  RETURN result;
 END IF;
 IF q.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'quote_expired' USING ERRCODE='P0001';
 END IF;
 IF q.delivery_method='shipping' AND address IS NULL THEN
  RAISE EXCEPTION 'shipping_address_required' USING ERRCODE='P0001';
 END IF;
 IF q.delivery_method='pickup' AND address IS NOT NULL THEN
  RAISE EXCEPTION 'unexpected_address' USING ERRCODE='P0001';
 END IF;
 IF q.delivery_method='shipping' AND (
  jsonb_typeof(address)<>'object' OR
  address-ARRAY['name','line1','line2','city','region','postalCode','country']<>'{}'::jsonb OR
  (address->>'country') IS DISTINCT FROM 'US' OR
  EXISTS(SELECT 1 FROM (VALUES('name',100),('line1',200),('city',100),('region',100),('postalCode',20)) AS fields(field,max_length)
   WHERE jsonb_typeof(address->field) IS DISTINCT FROM 'string' OR
    length(btrim(address->>field)) NOT BETWEEN 1 AND max_length) OR
  (address ? 'line2' AND (jsonb_typeof(address->'line2')<>'string' OR length(btrim(address->>'line2'))>200))
 ) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='P0001'; END IF;
 SELECT * INTO p FROM campus.products WHERE id=q.product_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF p.seller_id=buyer THEN RAISE EXCEPTION 'self_purchase' USING ERRCODE='P0001'; END IF;
 IF p.revision<>q.product_revision OR p.seller_id<>q.seller_id OR
    p.price_cents<>q.unit_cents OR NOT(q.delivery_method=ANY(p.delivery_methods)) OR
    q.shipping_cents<>(CASE WHEN q.delivery_method='shipping' THEN p.shipping_cents ELSE 0 END) THEN
  RAISE EXCEPTION 'stale_quote' USING ERRCODE='P0001';
 END IF;
 IF q.unit_cents::bigint*q.quantity+q.shipping_cents>100000000 THEN
  RAISE EXCEPTION 'order_limit' USING ERRCODE='P0001';
 END IF;
 IF p.stock<q.quantity THEN RAISE EXCEPTION 'out_of_stock' USING ERRCODE='P0001'; END IF;
 -- Recheck wall time after the product lock wait, at the inventory mutation.
 UPDATE campus.products SET stock=stock-q.quantity
 WHERE id=p.id AND EXISTS(SELECT 1 FROM campus.quotes WHERE id=q.id AND expires_at>clock_timestamp());
 IF NOT FOUND THEN RAISE EXCEPTION 'quote_expired' USING ERRCODE='P0001'; END IF;
 INSERT INTO campus.orders(quote_id,product_id,buyer_id,seller_id,quantity,total_cents,
  delivery_method,shipping_address,reserved_until,terms)
 VALUES(q.id,p.id,buyer,p.seller_id,q.quantity,q.unit_cents*q.quantity+q.shipping_cents,
  q.delivery_method,address,clock_timestamp()+interval '15 minutes',
  jsonb_build_object('title',p.title,'unitCents',q.unit_cents,'shippingCents',q.shipping_cents,'currency','USD'))
 RETURNING * INTO result;
 RETURN result;
END $$;

CREATE FUNCTION campus.cancel_unpaid_order(oid uuid)
RETURNS campus.orders LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,campus,pg_temp AS $$
DECLARE
 buyer uuid:=campus.actor();
 result campus.orders;
BEGIN
 IF buyer IS NULL OR NOT campus.is_member() THEN
  RAISE EXCEPTION 'membership_required' USING ERRCODE='P0001';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM campus.users WHERE id=buyer AND account_status='active') THEN
  RAISE EXCEPTION 'account_restricted' USING ERRCODE='P0001';
 END IF;
 -- The same order-row lock is used by expire_reservations. Only the winner can
 -- observe pending_payment and release the reservation, in one transaction.
 SELECT * INTO result FROM campus.orders WHERE id=oid AND buyer IN(buyer_id,seller_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0001'; END IF;
 IF result.buyer_id<>buyer THEN RAISE EXCEPTION 'not_buyer' USING ERRCODE='P0001'; END IF;
 IF result.state IN('cancelled','expired') THEN RETURN result; END IF;
 IF result.state<>'pending_payment' THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='P0001'; END IF;
 UPDATE campus.products SET stock=stock+result.quantity WHERE id=result.product_id;
 UPDATE campus.orders SET state='cancelled' WHERE id=result.id RETURNING * INTO result;
 RETURN result;
END $$;

-- An app role must not manufacture new reservations or rearm a cancelled order
-- and call the release function again. Preserve normal seller fulfillment and
-- buyer receipt, with all immutable terms still checked by immutable_order.
CREATE FUNCTION campus.guard_order_state() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,campus,pg_temp AS $$
BEGIN
 IF current_user='campus_app' THEN
  IF NEW.reserved_until IS DISTINCT FROM OLD.reserved_until OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
   RAISE EXCEPTION 'Order reservation metadata is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT(
   (OLD.state='paid' AND OLD.seller_id=campus.actor() AND
    ((OLD.delivery_method='shipping' AND NEW.state='shipped') OR
     (OLD.delivery_method='pickup' AND NEW.state='ready_for_pickup'))) OR
   (OLD.state IN('shipped','ready_for_pickup') AND NEW.state='completed' AND OLD.buyer_id=campus.actor())
  ) THEN RAISE EXCEPTION 'Order state transition is not permitted' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_order_state BEFORE UPDATE ON campus.orders
 FOR EACH ROW EXECUTE FUNCTION campus.guard_order_state();

REVOKE ALL ON FUNCTION campus.create_order_from_quote(uuid,jsonb),campus.cancel_unpaid_order(uuid),campus.guard_order_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campus.create_order_from_quote(uuid,jsonb),campus.cancel_unpaid_order(uuid) TO campus_app;
