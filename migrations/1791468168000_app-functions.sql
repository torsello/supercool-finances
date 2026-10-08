-- Up Migration

-- SEC-R31, SEC-R48, ADR-0019, ADR-0021: timeouts set per database transaction through a function
-- call, never a SET statement, so nothing pins a connection behind RDS Proxy and no value outlives
-- the transaction (set_config with is_local true).
CREATE SCHEMA app;

CREATE FUNCTION app.set_lock_timeout(ms integer) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF ms IS NULL OR ms < 1 OR ms > 60000 THEN
    RAISE EXCEPTION 'lock timeout out of range' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('lock_timeout', ms || 'ms', true);
END $$;

CREATE FUNCTION app.set_statement_timeout(ms integer) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF ms IS NULL OR ms < 1 OR ms > 3600000 THEN
    RAISE EXCEPTION 'statement timeout out of range' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('statement_timeout', ms || 'ms', true);
END $$;

-- Only the runtime role may execute them: not PUBLIC, and not the owner's implicit privilege.
REVOKE ALL ON FUNCTION app.set_lock_timeout(integer), app.set_statement_timeout(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.set_lock_timeout(integer), app.set_statement_timeout(integer) FROM scf_owner;
GRANT USAGE ON SCHEMA app TO scf_app;
GRANT EXECUTE ON FUNCTION app.set_lock_timeout(integer), app.set_statement_timeout(integer) TO scf_app;

-- Down Migration

DROP FUNCTION app.set_statement_timeout(integer);
DROP FUNCTION app.set_lock_timeout(integer);
REVOKE USAGE ON SCHEMA app FROM scf_app;
DROP SCHEMA app;
