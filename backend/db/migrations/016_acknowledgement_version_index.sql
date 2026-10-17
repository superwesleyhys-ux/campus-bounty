-- Match exact-current consent and version-first keyset history reads.
-- Additive access path only; acknowledgement rows and frozen members are unchanged.
CREATE INDEX application_terms_acknowledgements_version_user
  ON campus.application_terms_acknowledgements(application_id, version, user_id);
