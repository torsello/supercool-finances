# ADR-0017: Keyset pagination with signed cursors

- **Status:** Accepted
- **Date:** 2026-10-08
- **Related specs:** 000-overview, 001-accounts, 002-ledger, 007-security-ops, 008-deployment

## Context and problem

Two lists are paged: a customer's accounts and an account's history (ACC-R08, ACC-R21). A history grows while a client pages through it, and its entries are money: a page that skips or repeats an entry misreports a balance. Any replica may serve the next page (SYS-R16), and a client must not be able to tamper with a cursor to read past what it is allowed to see. The question is how pages are addressed and how the cursor is protected.

## Decision drivers

- No skipped or repeated history entries while new ones arrive (ACC-R22).
- Constant cost per page, however deep.
- Cursors work on every replica (ACC-R30).
- A tampered, foreign or other-list cursor is refused (ACC-R23).
- No state kept per client.

## Considered options

### Option A: Keyset pagination by (`created_at`, `id`) with an HMAC-signed opaque cursor

- **Pros:**
  - Each page starts strictly after the last (`created_at`, `id`) returned, an index range scan whose cost does not grow with depth.
  - An entry's `created_at` is taken when it is inserted, after its account lock is held (LED-R18), so the entries of one account are ordered by `created_at` as they committed, and a page never skips or repeats one.
  - The cursor carries `created_at` at its stored microsecond precision, so ties at the millisecond the API shows are not lost (ACC-R22).
  - Signed with HMAC-SHA256 using `CURSOR_SECRET`, and carrying the list, the account id for a history and the user it was issued to, so a tampered or foreign cursor answers 400 on any replica (ACC-R23, ACC-R30).
- **Cons:**
  - No jumping to page N and no total count.
  - The cursor depends on the sort key; changing the order later invalidates cursors in flight.
  - For the account list, an account created while a client pages may be missed, because account creation takes no lock and its `created_at` order can differ from its commit order (ACC-R22).
  - One more secret to manage and rotate.

### Option B: Offset pagination (`?offset=40&limit=20`)

- **Pros:**
  - Simplest; allows jumping to any page.
- **Cons:**
  - Slow on deep pages: the database reads and discards every earlier row.
  - Unstable while entries arrive: a new entry shifts every offset, so a page repeats or skips entries.

### Option C: Keyset with a plain, unsigned cursor

- **Pros:**
  - The same paging behaviour with no secret.
- **Cons:**
  - A client can edit the cursor to start anywhere or reuse it on another list or account; authorization still applies, but malformed positions must each be validated, and the cursor is no longer opaque.

### Option D: Keyset with an encrypted cursor

- **Pros:**
  - Hides the cursor's contents as well as protecting them.
- **Cons:**
  - More machinery for no benefit: the contents (a timestamp and an id of an item the caller already saw) are not secret.

## Decision

Chosen option: **Option A**. Lists page by (`created_at`, `id`), never by offset; an entry's `created_at` is taken after its account lock is held, so entries of one account are ordered as they committed and a history page never skips or repeats one. The cursor is opaque, carries `created_at` at microsecond precision and the user it was issued to, and is signed with HMAC-SHA256 using `CURSOR_SECRET`, a secret separate from `JWT_SECRET` and shared by all replicas, so a tampered or foreign cursor answers 400 on any replica. Offset pagination is simpler but slow on deep pages and unstable while entries arrive.

Details fixed by section 1.5 of spec 001: newest first, page size 1 to 100 with default 20, `{"items", "nextCursor"}` with `nextCursor` absent on the last page, and the cursor as the base64url payload followed by its tag. `CURSOR_SECRET` is at least 32 bytes and different from `JWT_SECRET`, so one key never serves two purposes (section 1.2 of spec 007); it is redacted from logs (SEC-R22) and the demo value is refused in production (DEP-R07).

## Consequences

### Positive

- Stable, constant-cost paging through a history that grows during the read.
- Any replica serves any page.
- Cursor tampering is detected without a database lookup.

### Negative / costs

- No page numbers or totals for clients.
- Rotating `CURSOR_SECRET` invalidates every cursor in flight; clients restart from the first page.
- The tag must be compared in constant time.

### To monitor

- History query plans: the (`account_id`, `created_at`, `id`) index must serve every page.
- 400 responses for cursors, which may show a client bug or tampering.

### Follow-ups

- Phase 05-schema: the indexes for both lists and `created_at` from `clock_timestamp()` at insert (LED-R18).
- Phase 08-api: cursor encoding, signing and verification.
