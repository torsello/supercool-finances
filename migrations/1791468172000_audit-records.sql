-- Up Migration

-- SYS-R23, ACC-R26, MOV-R24, REV-R15: one record per committed movement or status change
-- (plan 000 section 3). Append-only for the service: scf_app may only insert and read.
CREATE TABLE audit_records (
  id                      uuid        PRIMARY KEY,
  actor_id                uuid        NOT NULL,
  actor_role              text        NOT NULL CHECK (actor_role IN ('customer', 'operator')),
  action                  text        NOT NULL CHECK (action IN ('deposit', 'withdrawal', 'transfer',
                                                     'reversal', 'freeze', 'unfreeze', 'close')),
  account_ids             uuid[]      NOT NULL,
  transaction_id          uuid        REFERENCES transactions (id),
  reversed_transaction_id uuid        REFERENCES transactions (id),
  reason                  text,
  old_status              text        CHECK (old_status IN ('active', 'frozen', 'closed')),
  new_status              text        CHECK (new_status IN ('active', 'frozen', 'closed')),
  request_id              text        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_records_action_columns CHECK (
    (action IN ('deposit', 'withdrawal', 'transfer')
      AND transaction_id IS NOT NULL AND reversed_transaction_id IS NULL AND reason IS NULL
      AND old_status IS NULL AND new_status IS NULL)
    OR (action = 'reversal'
      AND transaction_id IS NOT NULL AND reversed_transaction_id IS NOT NULL AND reason IS NOT NULL
      AND old_status IS NULL AND new_status IS NULL)
    OR (action IN ('freeze', 'unfreeze', 'close')
      AND transaction_id IS NULL AND reversed_transaction_id IS NULL AND reason IS NULL
      AND old_status IS NOT NULL AND new_status IS NOT NULL))
);

CREATE INDEX audit_records_transaction ON audit_records (transaction_id);

GRANT SELECT, INSERT ON audit_records TO scf_app;

-- Down Migration

DROP TABLE audit_records;
