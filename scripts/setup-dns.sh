#!/usr/bin/env bash
set -euo pipefail

# CloudClips — Cloudflare DNS Setup
#
# Usage:  ./scripts/setup-dns.sh
#
# What this does:
#   Reads the CLOUDFLARE_TOKEN from .env (project root) and stores it in AWS
#   Secrets Manager under the name "cloudclips/cloudflare-api-token".
#
#   This is a one-time prerequisite for the CloudClips-Dns CDK stack, which
#   deploys a Lambda-backed Custom Resource that keeps the Cloudflare CNAME
#   record (cloudclips.sokech.com → CloudFront) in sync on every deployment.
#
# Re-running this script is safe — it updates the secret if it already exists.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
SECRET_NAME="cloudclips/cloudflare-api-token"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "=== CloudClips DNS Setup ==="
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || { echo "ERROR: aws CLI not found"; exit 1; }

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: .env file not found at ${ENV_FILE}"
  echo "  Create it from .env.example and populate CLOUDFLARE_TOKEN."
  exit 1
fi

# Read token from .env
CLOUDFLARE_TOKEN=$(grep '^CLOUDFLARE_TOKEN=' "${ENV_FILE}" | cut -d= -f2-)
if [[ -z "${CLOUDFLARE_TOKEN}" || "${CLOUDFLARE_TOKEN}" == "YOUR_CLOUDFLARE_TOKEN_HERE" ]]; then
  echo "ERROR: CLOUDFLARE_TOKEN is not set in ${ENV_FILE}"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "  Account : ${ACCOUNT_ID}"
echo "  Region  : ${REGION}"
echo "  Secret  : ${SECRET_NAME}"
echo ""

# ── Create or update the secret ───────────────────────────────────────────────
if aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" \
    >/dev/null 2>&1; then
  echo "--- Updating existing secret ---"
  aws secretsmanager update-secret \
    --secret-id "${SECRET_NAME}" \
    --secret-string "${CLOUDFLARE_TOKEN}" \
    --region "${REGION}" \
    --output text --query 'ARN'
else
  echo "--- Creating new secret ---"
  aws secretsmanager create-secret \
    --name "${SECRET_NAME}" \
    --secret-string "${CLOUDFLARE_TOKEN}" \
    --region "${REGION}" \
    --output text --query 'ARN'
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next step: deploy the DNS stack"
echo "  cd infra && npx cdk deploy CloudClips-Dns --require-approval never"
echo ""
echo "  The stack will create a Lambda that upserts the Cloudflare CNAME:"
echo "    cloudclips.sokech.com → <CloudFront frontend domain>"
echo ""
echo "  DNS propagation typically takes 1-5 minutes."
