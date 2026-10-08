-- Up Migration

-- The double-entry ledger (plan 002 section 2.1) with the reversal link of plan 004 section 2.
CREATE TABLE transactions (
  id                      uuid        PRIMARY KEY,
  kind                    text        NOT NULL
                                      CHECK (kind IN ('deposit', 'withdrawal', 'transfer', 'reversal')),
  currency                char(3)     NOT NULL CHECK (currency IN ('USD', 'MXN', 'EUR', 'COP', 'JPY')),
  reversed_transaction_id uuid        CONSTRAINT transactions_reversed_transaction_id_fkey
                                      REFERENCES transactions (id),
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),                -- LED-R18
  -- REV-R05: at most one reversal per transaction. Not deferrable, so a second reversal fails at
  -- its insert, inside the savepoint where it can still be stored as a 409 (IDM-R14).
  CONSTRAINT transactions_reversed_transaction_id_key UNIQUE (reversed_transaction_id),
  CONSTRAINT transactions_reversal_link
    CHECK ((kind = 'reversal') = (reversed_transaction_id IS NOT NULL)),
  UNIQUE (id, currency)  -- target of the entries' composite foreign key
);

CREATE TABLE ledger_entries (
  id             uuid        PRIMARY KEY,
  transaction_id uuid        NOT NULL,
  account_id     uuid        NOT NULL,
  amount         bigint      NOT NULL CONSTRAINT ledger_entries_amount_not_zero CHECK (amount <> 0), -- LED-R03
  currency       char(3)     NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),                          -- LED-R18
  -- LED-R07: an entry shares its transaction's currency and its account's currency.
  CONSTRAINT ledger_entries_transaction_id_currency_fkey
    FOREIGN KEY (transaction_id, currency) REFERENCES transactions (id, currency),
  CONSTRAINT ledger_entries_account_id_currency_fkey
    FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency)
);

CREATE INDEX ledger_entries_history ON ledger_entries (account_id, created_at DESC, id DESC);
CREATE INDEX ledger_entries_transaction ON ledger_entries (transaction_id);

-- LED-R04 to LED-R07: checked at commit, so entries can be inserted one by one (LED-R06). The
-- trigger on transactions also catches a transaction row with no entries at all.
-- SYS-R15, LED-R01: a transaction's entries are written with it, never appended later. The
-- movement skeleton writes the transaction row and all its entries in one subtransaction (the
-- savepoint "work" of plan 000 section 6.2), so they share one xmin; an entry inserted by another
-- database transaction, or by another subtransaction, has another xmin and is refused.
CREATE FUNCTION ledger_check_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  tx_id      uuid;
  entries    bigint;
  total      numeric;
  currencies bigint;
  appended   bigint;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    tx_id := NEW.id;
  ELSE
    tx_id := NEW.transaction_id;
  END IF;

  SELECT count(*), COALESCE(SUM(amount::numeric), 0), count(DISTINCT currency)
    INTO entries, total, currencies
    FROM public.ledger_entries
   WHERE transaction_id = tx_id;

  IF entries < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has fewer than two entries', tx_id
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_min_entries';
  END IF;
  IF currencies <> 1 THEN
    RAISE EXCEPTION 'ledger transaction % mixes currencies', tx_id
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_one_currency';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not sum to zero', tx_id
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_balanced';
  END IF;

  SELECT count(*) INTO appended
    FROM public.ledger_entries e
    JOIN public.transactions t ON t.id = e.transaction_id
   WHERE e.transaction_id = tx_id AND e.xmin <> t.xmin;
  IF appended > 0 THEN
    RAISE EXCEPTION 'ledger transaction % has entries written by another database transaction', tx_id
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_written_once';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER transactions_check_at_commit
  AFTER INSERT ON transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction();
CREATE CONSTRAINT TRIGGER ledger_entries_check_at_commit
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction();

-- LED-R16: append-only, for the owner role too; only DDL or a superuser can bypass it.
CREATE FUNCTION ledger_refuse_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are append-only: % on % refused', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION ledger_refuse_change();
CREATE TRIGGER transactions_no_truncate
  BEFORE TRUNCATE ON transactions FOR EACH STATEMENT EXECUTE FUNCTION ledger_refuse_change();
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_refuse_change();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION ledger_refuse_change();

-- LED-R17: the runtime role only reads and appends.
GRANT SELECT, INSERT ON transactions, ledger_entries TO scf_app;

-- Down Migration

DROP TABLE ledger_entries;
DROP TABLE transactions;
DROP FUNCTION ledger_refuse_change();
DROP FUNCTION ledger_check_transaction();
