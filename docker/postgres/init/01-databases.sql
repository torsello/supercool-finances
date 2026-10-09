-- Local development and CI only. The passwords match .env.example and are never used elsewhere.
--
-- Two roles (ADR-0018, section 1.3 of spec 002):
--   scf_owner  runs the migrations and owns the databases, tables and functions. CREATEROLE, with
--              the admin option of the grant below, lets the first migration run ALTER ROLE
--              scf_app IN DATABASE ... SET on PostgreSQL 16 (SEC-R29), and lets some tests create
--              roles of their own. CREATEDB lets the tests create scratch databases; it is the one
--              attribute AWS does not give, since nothing there creates a database: the bootstrap
--              of section 1.7 of spec 008 creates scf_owner with LOGIN CREATEROLE only, and
--              DEP-AC30 checks that this script and the bootstrap differ by nothing else.
--   scf_app    the service's runtime role: not a superuser, owns nothing, holds only the grants
--              the migrations give it.
CREATE ROLE scf_owner WITH LOGIN CREATEDB CREATEROLE PASSWORD 'scf_owner_local_only';
CREATE ROLE scf_app WITH LOGIN PASSWORD 'scf_app_local_only';

-- Lets the owner run ALTER ROLE scf_app IN DATABASE ... SET from a migration (SEC-R29), without
-- inheriting or assuming the runtime role's privileges.
GRANT scf_app TO scf_owner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;

CREATE DATABASE supercool_dev OWNER scf_owner;
CREATE DATABASE supercool_test OWNER scf_owner;
