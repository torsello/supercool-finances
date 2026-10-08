-- Up Migration

-- Idempotency keys, scoped per user and compared exactly (IDM-R04), plan 005 section 2.
CREATE TABLE idempotency_keys (
  user_id     uuid        NOT NULL,
  key         text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  fingerprint char(64)    NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status      smallint,
  headers     jsonb,       -- {"content-type": ..., "location": ...}; never X-Request-Id
  body        bytea,       -- the exact bytes sent
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE INDEX idempotency_keys_expiry ON idempotency_keys (expires_at);

-- IDM-R18: no key row commits without its stored result. The row is read again at commit,
-- because NEW holds the version of the statement that fired the trigger, not the final one; a
-- row deleted before the commit passes.
CREATE FUNCTION idempotency_keys_check_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  incomplete boolean;
BEGIN
  SELECT status IS NULL OR headers IS NULL OR body IS NULL
    INTO incomplete
    FROM public.idempotency_keys
   WHERE user_id = NEW.user_id AND key = NEW.key;
  IF incomplete THEN
    RAISE EXCEPTION 'idempotency key row committed without a stored result'
      USING ERRCODE = '23514', CONSTRAINT = 'idempotency_keys_complete';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER idempotency_keys_complete
  AFTER INSERT OR UPDATE ON idempotency_keys DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION idempotency_keys_check_complete();

-- DELETE is for the cleanup, which runs as the runtime role (IDM-R22, DEP-R37).
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO scf_app;

-- Down Migration

DROP TABLE idempotency_keys;
DROP FUNCTION idempotency_keys_check_complete();
