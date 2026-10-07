-- Local development only. The password matches .env.example and is never used outside Docker Compose.
CREATE ROLE scf WITH LOGIN PASSWORD 'scf_local_only';

CREATE DATABASE supercool_dev OWNER scf;
CREATE DATABASE supercool_test OWNER scf;
