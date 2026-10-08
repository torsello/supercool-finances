-- Up Migration

-- Customer and system accounts (plan 001 section 2). The settlement rows are added by the
-- migration settlement-accounts (plan 002); system accounts keep no cached balance (ADR-0007).
CREATE TABLE accounts (
  id          uuid        PRIMARY KEY,
  kind        text        NOT NULL CHECK (kind IN ('customer', 'system')),
  code        text        UNIQUE,
  owner_id    uuid,
  currency    char(3)     NOT NULL CHECK (currency IN ('USD', 'MXN', 'EUR', 'COP', 'JPY')),  -- SYS-R08
  status      text        CHECK (status IN ('active', 'frozen', 'closed')),
  balance     bigint      CHECK (balance >= 0),                                               -- LED-R12
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_kind_columns CHECK (
    (kind = 'customer' AND owner_id IS NOT NULL AND status IS NOT NULL AND balance IS NOT NULL
      AND code IS NULL)
    OR (kind = 'system' AND owner_id IS NULL AND status IS NULL AND balance IS NULL           -- LED-R13
      AND code = 'external-settlement:' || currency)),
  CONSTRAINT accounts_closed_is_empty CHECK (status IS DISTINCT FROM 'closed' OR balance = 0),
  UNIQUE (id, currency)  -- target of the ledger entries' composite foreign key (plan 002)
);

CREATE UNIQUE INDEX accounts_one_system_per_currency ON accounts (currency) WHERE kind = 'system';
CREATE INDEX accounts_owner_list ON accounts (owner_id, created_at DESC, id DESC)
  WHERE kind = 'customer';

GRANT SELECT, INSERT ON accounts TO scf_app;
GRANT UPDATE (status, balance, updated_at) ON accounts TO scf_app;

-- Down Migration

DROP TABLE accounts;
