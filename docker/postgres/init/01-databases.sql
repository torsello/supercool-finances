-- Local development and CI only. The passwords match .env.example and are never used elsewhere.
--
-- Two roles (ADR-0018, section 1.3 of spec 002):
--   scf_owner  runs the migrations and owns the databases, tables and functions. CREATEDB lets
--              tests create scratch databases; CREATEROLE lets one AC create a role of its own.
--   scf_app    the service's runtime role: not a superuser, owns nothing, holds only the grants
--              the migrations give it.
CREATE ROLE scf_owner WITH LOGIN CREATEDB CREATEROLE PASSWORD 'scf_owner_local_only';
CREATE ROLE scf_app WITH LOGIN PASSWORD 'scf_app_local_only';

-- Lets the owner run ALTER ROLE scf_app IN DATABASE ... SET from a migration (SEC-R29), without
-- inheriting or assuming the runtime role's privileges.
GRANT scf_app TO scf_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

CREATE DATABASE supercool_dev OWNER scf_owner;
CREATE DATABASE supercool_test OWNER scf_owner;
