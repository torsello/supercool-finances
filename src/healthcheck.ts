// node dist/healthcheck.js: the container healthcheck of the image (DEP-R21, section 1.6 of spec
// 008). Liveness, not readiness, so a database outage never makes Docker or ECS replace every
// container; the load balancer checks readiness.
import { checkLiveness } from './platform/health/liveness-probe.js';

process.exitCode = await checkLiveness({ port: process.env['PORT'] });
