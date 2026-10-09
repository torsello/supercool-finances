# The service image (spec 008 section 1.6): one image for the local stack and AWS, only the
# configuration differs. Base images are pinned by version and digest (DEP-R22).

# Build stage: every dependency, the sources and the compiled code.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Compiles src/ to dist/ and copies migrations/*.sql to dist/migrations/ (plan 007 section 1) and
# the RDS CA bundle to dist/certs/ (DEP-R41).
RUN npm run build

# Tools stage: the build stage's /app plus gitleaks, the tools image of compose.yaml, which runs
# the seed, token and other npm scripts (DEP-R09) and the whole test suite of `make test`. The
# runtime stage does not depend on it, so building the production image never downloads gitleaks.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS tools
# gitleaks for the DEP-AC25 test: the version of the CI job secret-scan, checked against the
# checksums of its official release.
ARG GITLEAKS_VERSION=8.30.1
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) arch=x64; sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      arm64) arch=arm64; sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      *) echo "no gitleaks checksum for ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && wget -q -O /tmp/gitleaks.tar.gz \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz" \
    && echo "${sum}  /tmp/gitleaks.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
    && rm /tmp/gitleaks.tar.gz
WORKDIR /app
COPY --from=build /app ./

# Runtime stage: the production dependencies and the compiled code only, no sources, tests or
# development dependencies (DEP-R18). The last stage, so it is the image's default target.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
# Then npm, npx, corepack and yarn, which the base image ships and nothing in the container runs,
# are deleted: every entry point is node (DEP-R20), and the CI job security scans the image with
# trivy. seed, token and reconcile run in the tools stage.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg /root/.npm
COPY --from=build /app/dist ./dist
# Every file stays owned by root, so the user node (uid 1000) owns none and the container also runs
# with a read-only root file system (DEP-R19).
USER node
# Liveness with Node itself, no shell or extra binary (DEP-R21).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["node", "dist/healthcheck.js"]
# node as process 1, with no shell or npm in between, so SIGTERM reaches the shutdown of SEC-R25
# (DEP-R20). No CMD.
ENTRYPOINT ["node", "dist/main.js"]
