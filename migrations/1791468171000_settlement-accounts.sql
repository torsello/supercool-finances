-- Up Migration

-- LED-R08: exactly one settlement system account per currency of table 1.3 of spec 000, with
-- fixed UUIDv7 ids, no owner and no cached balance (LED-R13, ADR-0007).
INSERT INTO accounts (id, kind, code, currency) VALUES
  ('01a11bd5-1bfa-7591-b1a8-f3dc4df58b85', 'system', 'external-settlement:USD', 'USD'),
  ('01a11bd5-1bfc-73c6-a32f-b1ccd9e5439b', 'system', 'external-settlement:MXN', 'MXN'),
  ('01a11bd5-1bfc-73c6-a32f-b7dbf9a42bae', 'system', 'external-settlement:EUR', 'EUR'),
  ('01a11bd5-1bfc-73c6-a32f-bbe71984156a', 'system', 'external-settlement:COP', 'COP'),
  ('01a11bd5-1bfc-73c6-a32f-bfbdba284e9b', 'system', 'external-settlement:JPY', 'JPY');

-- Down Migration

-- Fails while a ledger entry still references one of them; migrate:down is for development.
DELETE FROM accounts WHERE kind = 'system';
