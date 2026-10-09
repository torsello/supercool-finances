#!/usr/bin/env bash
# npm run infra:validate (section 1.7 of spec 008, DEP-R33): formats, validates and lints the
# Terraform of infra/terraform/ and checks it with checkov and the custom policies of
# infra/policies/. Each tool runs from a Docker image pinned by version and digest, so the only
# prerequisite is Docker. It never runs terraform plan, apply, destroy or import and needs no AWS
# credentials (DEP-R34). Any finding fails it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_DIR="infra/terraform"

TERRAFORM_IMAGE="hashicorp/terraform:1.16.5@sha256:c7926feace05d0f7e73542842bf3945924e955a1f782cf000ccbb8d18fa42d77"
TFLINT_IMAGE="ghcr.io/terraform-linters/tflint:v0.64.0@sha256:1c595f42d794c32c45a6ea8b58655fd66433d4ca3b1bc631c574a48d120bd19f"
CHECKOV_IMAGE="bridgecrew/checkov:3.3.26@sha256:8e63f217cb084f1c1a067326a9cf6e37d54bdc82e5822210d50ca4e2f647dd93"

# The repository mounted at /repo, as the calling user, so files the tools write (the provider
# cache in infra/terraform/.terraform, tflint's plugins) belong to that user. No AWS variable or
# credential file is passed in. Usage: docker_run <image> [docker options] -- [tool arguments].
docker_run() {
  local image="$1"
  shift
  local options=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    options+=("$1")
    shift
  done
  shift
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --volume "${ROOT}:/repo" \
    --workdir "/repo/${TERRAFORM_DIR}" \
    --env HOME=/tmp \
    --env TF_IN_AUTOMATION=1 \
    --env CHECKPOINT_DISABLE=1 \
    --env TFLINT_PLUGIN_DIR="/repo/${TERRAFORM_DIR}/.tflint.d/plugins" \
    ${GITHUB_TOKEN:+--env GITHUB_TOKEN} \
    ${options[@]+"${options[@]}"} \
    "${image}" "$@"
}

step() {
  printf '\n== %s\n' "$1"
}

step "terraform fmt -check"
docker_run "${TERRAFORM_IMAGE}" -- fmt -check -recursive -diff

step "terraform init -backend=false"
# The committed lock file pins the provider's version and checksums; init may not change it.
docker_run "${TERRAFORM_IMAGE}" -- init -backend=false -input=false -lockfile=readonly

step "terraform validate"
docker_run "${TERRAFORM_IMAGE}" -- validate

step "tflint (AWS ruleset)"
docker_run "${TFLINT_IMAGE}" --entrypoint tflint -- --init --config "/repo/${TERRAFORM_DIR}/.tflint.hcl"
docker_run "${TFLINT_IMAGE}" --entrypoint tflint -- --recursive --config "/repo/${TERRAFORM_DIR}/.tflint.hcl" --format compact

step "checkov with infra/policies"
docker_run "${CHECKOV_IMAGE}" --workdir /repo --entrypoint checkov -- \
  --directory "${TERRAFORM_DIR}" \
  --framework terraform secrets \
  --external-checks-dir infra/policies \
  --skip-path "${TERRAFORM_DIR}/.terraform" \
  --skip-download \
  --compact \
  --quiet

printf '\ninfra:validate: no finding\n'
