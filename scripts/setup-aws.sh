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

# 3. MediaConvert endpoint discovery (informational)
echo "--- MediaConvert Endpoint ---"
MC_ENDPOINT=$(aws mediaconvert describe-endpoints --query "Endpoints[0].Url" --output text --region "${REGION}" 2>/dev/null || echo "NONE")
echo "MediaConvert endpoint: ${MC_ENDPOINT}"
echo ""

echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Click the SES verification link in your email"
echo "  2. Set up CI/CD credentials (keyless via OIDC):"
echo "       ./scripts/setup-oidc.sh <github-owner> <github-repo>"
echo "  3. cd infra && npx cdk deploy --all"
echo "  4. cd frontend && pnpm build"
echo "  5. Upload frontend build to S3 (or let CI/CD handle it)"
