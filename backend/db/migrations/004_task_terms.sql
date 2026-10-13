-- Optional additions preserve existing listings and signed agreements. A due
-- date is a calendar target, not an application cutoff or automatic penalty.
ALTER TABLE campus.tasks ADD COLUMN due_date date
 CHECK(due_date >= DATE '1000-01-01' AND due_date < DATE '10000-01-01');
ALTER TABLE campus.task_milestones ADD COLUMN acceptance_criteria text
 CHECK(acceptance_criteria IS NULL OR
       (length(btrim(acceptance_criteria)) > 0 AND length(acceptance_criteria) <= 10000));
ALTER TABLE campus.milestones ADD COLUMN acceptance_criteria text
 CHECK(acceptance_criteria IS NULL OR
       (length(btrim(acceptance_criteria)) > 0 AND length(acceptance_criteria) <= 10000));

-- Acceptance criteria belong to the same immutable milestone terms as the
-- deliverable and reward. Existing agreement JSON is deliberately untouched.
CREATE OR REPLACE FUNCTION campus.immutable_milestone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.agreement_id,NEW.position,NEW.title,NEW.amount_cents,NEW.deliverable,NEW.acceptance_criteria) IS DISTINCT FROM (OLD.agreement_id,OLD.position,OLD.title,OLD.amount_cents,OLD.deliverable,OLD.acceptance_criteria) THEN RAISE EXCEPTION 'Milestone terms are immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
