# SuperCool Finances

Balance service for SuperCool Finances: customer accounts, a double-entry ledger and money movements.

[![CI](https://github.com/torsello/supercool-finances/actions/workflows/ci.yml/badge.svg)](https://github.com/torsello/supercool-finances/actions/workflows/ci.yml)

## Quick start

Prerequisites: Node 24 (the version in `.nvmrc`, for example with `nvm use`) and Docker.

```sh
npm ci
npm run env:sync          # creates .env from .env.example, with random secrets
npm run infra:up          # starts Postgres and Redis
npm run check             # typecheck, lint, format check and unit tests
npm run test:integration  # integration tests against Postgres and Redis
npm run trace             # every acceptance criterion in specs/ with the test that proves it
```

Every behaviour is specified before it is built: the specs, with their requirements and acceptance criteria, are in [`specs/`](specs/README.md), and `npm run trace` fails when an acceptance criterion that must be proven has no passing test.
