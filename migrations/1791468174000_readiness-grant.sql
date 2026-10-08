-- Up Migration

-- SEC-R24: readiness compares the applied migrations with those the code ships, as scf_app.
GRANT SELECT ON pgmigrations TO scf_app;

-- Down Migration

REVOKE SELECT ON pgmigrations FROM scf_app;
