-- Up Migration

-- SEC-R29, ADR-0018: every new session of the runtime role starts with these limits. They are
-- set per database, so each database records and reverts its own settings with its migrations.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE scf_app IN DATABASE %I SET statement_timeout = %L',
                 current_database(), '5s');
  EXECUTE format('ALTER ROLE scf_app IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
                 current_database(), '10s');
END $$;

-- Down Migration

DO $$
BEGIN
  EXECUTE format('ALTER ROLE scf_app IN DATABASE %I RESET statement_timeout', current_database());
  EXECUTE format('ALTER ROLE scf_app IN DATABASE %I RESET idle_in_transaction_session_timeout',
                 current_database());
END $$;
