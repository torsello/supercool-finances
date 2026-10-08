# ADR-0011: Amounts as strings in the API and bigint in the domain

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 003-money-movements, 004-reversals

## Context and problem

ADR-0006 stores money as signed integer minor units in `bigint`. Amounts also cross the HTTP API, in requests (deposits, withdrawals, transfers) and responses (balances, history entries, transactions), where the allowed range reaches 9223372036854775807 (SYS-R07). JSON has one number type, and JavaScript parses it as a 64-bit float. The question is how an amount is written in the API and where it becomes a `bigint`.

## Decision drivers

- Exact values across every client language, up to the `bigint` maximum.
- One representation from the API to the domain to the database.
- Strict, simple validation (SYS-R07, SYS-R27).
- An amount means the same thing whatever the currency's exponent.

## Considered options

### Option A: Decimal-digit strings in minor units, with an ISO 4217 code

`{"amount": "1050", "currency": "EUR"}` is 10.50 EUR; `{"amount": "1050", "currency": "JPY"}` is 1050 yen.

- **Pros:**
  - Exact in every client: a string never passes through a float.
  - Matches `pg`, which already returns `bigint` as a string, so the value has one textual form from the database to the client.
  - Unambiguous and strictly validated: a regular expression for digits without sign, leading zero, separator or exponent, then a `bigint` range check from 1 to 9223372036854775807 and the configured maximum (SYS-R07, LED-R24).
  - Converted to `bigint` once, at the HTTP edge, and back to a string once on the way out.
  - Independent of the exponent: the same rule for USD and JPY.
- **Cons:**
  - Less readable for humans: "1050" needs the currency's exponent (table 1.3 of spec 000) to read as 10.50.
  - Clients must know minor units and must not parse the string as a float themselves.
  - A JSON number `1050` is refused with 422 (SYS-AC20), which surprises some clients.

### Option B: JSON numbers in minor units

- **Pros:**
  - Natural JSON; no quoting.
- **Cons:**
  - JavaScript clients, and many JSON libraries, lose precision above 2^53, far below the allowed maximum.

### Option C: Decimal strings in major units ("10.50")

- **Pros:**
  - Friendlier to read; matches how people write money.
- **Cons:**
  - Mixes formatting with value: the number of decimals depends on the currency's exponent, so "10.5", "10.50" and "10.500" need rules per currency, and "10.50" is invalid for JPY.
  - Parsing a decimal string invites float arithmetic at the edges.

## Decision

Chosen option: **Option A**, because JSON numbers lose precision above 2^53 in JavaScript clients, and `pg` already returns `bigint` as a string. Digit strings in minor units are unambiguous, validated by a strict regular expression and a `bigint` range check, and converted to `bigint` at the edge. Decimal strings ("10.50") are friendlier to read, but they mix formatting with value and depend on the currency exponent.

Details fixed by the specs: an accepted amount never has a sign, and the direction of a movement comes from its kind (SYS-R06, SYS-R07); amounts the API returns, such as history entries and transaction entries, may carry a leading minus (SYS-R06, section 1.3 of spec 003); a currency is a code of table 1.3 of spec 000 (SYS-R09).

## Consequences

### Positive

- No precision loss anywhere between client, service and database.
- One validation rule for every amount field in every endpoint.

### Negative / costs

- Clients need the currency table to display amounts; the API documentation must state minor units clearly.
- Every adapter that touches an amount must convert explicitly; a stray `Number()` loses precision silently (ADR-0006).

### To monitor

- Review and lint for `number` on amounts (ADR-0006).
- Unit tests of the amount schema at the edges (zero, leading zero, exponent, the `bigint` maximum and one above it).

### Follow-ups

- Phase 06-domain: the `Money` value object and its parsing from strings.
- Phase 08-api: the shared Zod amount schema and the OpenAPI description of minor units.
