#!/usr/bin/env bash
set -euo pipefail

# CloudClips — Teardown
#
# Usage:  ./scripts/teardown.sh
#
# Destroys every CloudClips CDK stack and all AWS resources they manage:
#   - S3 buckets (uploads, processed videos, frontend) and all their objects
#   - DynamoDB table and all video metadata
#   - Lambda functions, API Gateway, CloudFront distributions
#   - Cognito User Pool and all user accounts
#   - SQS queues, SNS topics, EventBridge rules
#   - IAM roles and policies created by CDK
#
# Bucket emptying: the Storage stack uses removalPolicy=DESTROY + autoDeleteObjects=true,
# so CDK's custom resource Lambda empties the buckets before deleting them. No manual
# bucket-emptying step is needed.
#
# What is NOT removed:
#   - The CDKToolkit bootstrap stack (shared across all CDK apps in the account)
#   - Any SES verified email identities (created by setup-aws.sh)
#   - The GitHub OIDC IAM role (created by setup-oidc.sh)
#
# To redeploy from scratch after teardown: ./scripts/deploy.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "=== CloudClips Teardown ==="
echo ""
echo "This will PERMANENTLY destroy all CloudClips AWS resources:"
echo "  - All S3 objects (uploaded videos, transcoded videos, frontend assets)"
echo "  - All DynamoDB data (video metadata)"
echo "  - All Cognito user accounts"
echo "  - All Lambda, API Gateway, CloudFront, SQS, SNS, EventBridge resources"
echo ""

# Require explicit confirmation before proceeding
read -rp "Type 'yes' to confirm permanent deletion: " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

echo ""

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "  Account : ${ACCOUNT_ID}"
echo "  Region  : ${REGION}"
echo ""

# ── Destroy all CDK stacks ─────────────────────────────────────────────────────
# --force skips the per-stack "are you sure?" prompt (we already confirmed above).
# CDK resolves reverse dependency order automatically — CDN goes before Storage, etc.
echo "--- Destroying all CDK stacks ---"
cd "${ROOT_DIR}/infra"
npx cdk destroy --all --force
echo ""

echo "=== Teardown Complete ==="
echo ""
echo "To redeploy: ./scripts/deploy.sh"
