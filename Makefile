# Shortcuts for the local stack of spec 008. Every target runs through Docker Compose, so Docker is
# the only prerequisite; seed, token and reconcile run in the tools service (DEP-R09).

COMPOSE ?= docker compose
# Every tools command rebuilds the tools image first (from the cache when nothing changed), so it
# never runs older sources than the stack; --quiet keeps stdout to the command's own output.
TOOLS = $(COMPOSE) build --quiet tools && $(COMPOSE) run --rm tools

# The demo user a token is minted for by default: demo-customer-1 of table 1.2 of spec 008.
SUB ?= 0192f0a0-0000-7000-8000-00000000d0c1
ROLE ?= customer

.PHONY: up down logs seed token test reconcile

# Builds the image, the tools image included, and starts the stack, returning once every service
# is healthy. The tools service is not started: seed, token and reconcile run it on demand.
up:
	$(COMPOSE) --profile tools build
	$(COMPOSE) up --wait

# Stops the stack and keeps the database volume; `docker compose down -v` deletes it too.
down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs --follow

# Creates the demo accounts and deposits through the API; running it again changes nothing.
seed:
	@$(TOOLS) npm run --silent seed

# Prints a bearer token: make token, or make token SUB=<uuid> ROLE=operator.
token:
	@$(TOOLS) npm run --silent token -- --sub $(SUB) --role $(ROLE)

# The whole suite in the tools image, with only Docker: typecheck, lint, format check and unit
# tests, the integration tests against the stack's Postgres (database supercool_test) and Redis,
# and the trace gate. Starts the stack's services it needs.
TEST_ENV = \
	-e TEST_DATABASE_URL=postgres://scf_app:scf_app_local_only@postgres:5432/supercool_test \
	-e TEST_MIGRATION_DATABASE_URL=postgres://scf_owner:scf_owner_local_only@postgres:5432/supercool_test

test:
	$(COMPOSE) build --quiet tools
	$(COMPOSE) run --rm $(TEST_ENV) tools sh -c \
		'npm run check && npm run test:integration && npm run trace -- --require unit,integration'

# Checks every cached balance against the ledger of the stack's database.
reconcile:
	@$(TOOLS) npm run --silent reconcile
