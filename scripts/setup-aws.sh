#!/usr/bin/env bash
set -euo pipefail

# CloudClips — One-time AWS account setup
# Run this once before the first deployment.

echo "=== CloudClips AWS Setup ==="
echo ""

# Check prerequisites
command -v aws >/dev/null 2>&1 || { echo "ERROR: AWS CLI not found. Install it first."; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "ERROR: npx not found. Install Node.js first."; exit 1; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_DEFAULT_REGION:-us-east-1}

echo "Account: ${ACCOUNT_ID}"
echo "Region:  ${REGION}"
echo ""

# 1. Bootstrap CDK (required for first-time CDK deployment)
echo "--- Bootstrapping CDK ---"
npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"
echo ""

# 2. Verify SES email identity (required for sending notifications)
echo "--- SES Email Setup ---"
read -rp "Enter the email address for sending notifications: " SENDER_EMAIL
aws ses verify-email-identity --email-address "${SENDER_EMAIL}" --region "${REGION}"
echo "Verification email sent to ${SENDER_EMAIL}. Check your inbox and click the link."
echo ""

# 3. MediaConvert activation check
# MediaConvert requires a one-time account-level activation via the console.
# There is no CLI/API to do this — it must be done manually.
echo "--- MediaConvert Activation ---"
MC_ACTIVE=$(aws mediaconvert describe-endpoints \
  --query "Endpoints[0].Url" --output text --region "${REGION}" 2>/dev/null || echo "NOT_ACTIVATED")

if [[ "${MC_ACTIVE}" == "NOT_ACTIVATED" ]]; then
  echo ""
  echo "  ACTION REQUIRED: MediaConvert is not yet activated in this account."
  echo ""
  echo "  1. Open: https://console.aws.amazon.com/mediaconvert/home?region=${REGION}"
  echo "  2. Click 'Get started' and accept the terms."
  echo "  3. Re-run this script to confirm activation."
  echo ""
  read -rp "Press Enter once you have activated MediaConvert, or Ctrl+C to exit and do it later: "
  MC_ACTIVE=$(aws mediaconvert describe-endpoints \
    --query "Endpoints[0].Url" --output text --region "${REGION}" 2>/dev/null || echo "NOT_ACTIVATED")
fi

if [[ "${MC_ACTIVE}" != "NOT_ACTIVATED" ]]; then
  echo "MediaConvert endpoint: ${MC_ACTIVE}"
else
  echo "WARNING: MediaConvert still not activated. Transcoding will not work until this is done."
fi
echo ""

echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Click the SES verification link in your email"
echo "  2. Set up CI/CD credentials (keyless via OIDC):"
echo "       ./scripts/setup-oidc.sh <github-owner> <github-repo>"
echo "  3. Deploy everything:  ./scripts/deploy.sh"
echo "  4. Tear everything down and redeploy: ./scripts/teardown.sh && ./scripts/deploy.sh"
