#!/usr/bin/env bash
set -euo pipefail

# CloudClips — Bootstrap + Deploy
#
# Usage:  ./scripts/deploy.sh
#
# What this does:
#   1. Installs all workspace dependencies via pnpm
#   2. Bootstraps CDK in the target AWS account/region (idempotent — safe to re-run)
#   3. Deploys all 8 CDK stacks in dependency order
#   4. Applies CloudFront OAC bucket policies to the processed and frontend S3 buckets
#
# Why step 4 is needed:
#   The CDN stack imports S3 buckets by ARN (instead of passing construct references)
#   to avoid CDK circular cross-stack dependencies. Imported buckets are read-only to
#   CDK — it cannot modify their bucket policies. We must apply the OAC policy ourselves.
#   This step is idempotent: put-bucket-policy replaces the policy on every run.
#
# Re-running this script after a teardown is safe — it will bootstrap again and
# redeploy everything from scratch.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CDK_STACK_PREFIX="CloudClips"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# ── Prerequisites ──────────────────────────────────────────────────────────────
echo "=== CloudClips Deploy ==="
echo ""

command -v aws  >/dev/null 2>&1 || { echo "ERROR: aws CLI not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: pnpm not found  (npm install -g pnpm)"; exit 1; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "  Account : ${ACCOUNT_ID}"
echo "  Region  : ${REGION}"
echo ""

# ── Install dependencies ───────────────────────────────────────────────────────
echo "--- [1/4] Installing workspace dependencies ---"
cd "${ROOT_DIR}"
pnpm install --frozen-lockfile
echo ""

# ── CDK Bootstrap ─────────────────────────────────────────────────────────────
# Creates the CDKToolkit stack in the account (staging bucket, ECR repo, roles).
# Completely idempotent — skips any resources that already exist.
echo "--- [2/4] CDK Bootstrap ---"
cd "${ROOT_DIR}/infra"
npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"
echo ""

# ── Deploy all CDK stacks ──────────────────────────────────────────────────────
# --require-approval never skips the "do you want to deploy security changes?" prompt.
# CDK resolves cross-stack references and deploys in the correct dependency order.
echo "--- [3/4] Deploying CDK stacks ---"
npx cdk deploy --all --require-approval never
echo ""

# ── CloudFront OAC bucket policies ────────────────────────────────────────────
# Read the distribution IDs we published as CloudFormation outputs in cdn-stack.ts.
# Then look up the OAC ID from each distribution's origin config and write a
# bucket policy that lets exactly that distribution (and no other) read from S3.
echo "--- [4/4] Applying CloudFront OAC bucket policies ---"
cd "${ROOT_DIR}"

# Helper: fetch a single CloudFormation output value
cfn_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks \
    --stack-name "${stack}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}

# Read the CloudFront distribution IDs from the CDN stack outputs
VIDEO_DIST_ID=$(cfn_output "${CDK_STACK_PREFIX}-Cdn" "VideoDistributionId")
FRONTEND_DIST_ID=$(cfn_output "${CDK_STACK_PREFIX}-Cdn" "FrontendDistributionId")

echo "  Video distribution    : ${VIDEO_DIST_ID}"
echo "  Frontend distribution : ${FRONTEND_DIST_ID}"

# Each distribution has one origin; read its Origin Access Control ID
VIDEO_OAC_ID=$(aws cloudfront get-distribution-config \
  --id "${VIDEO_DIST_ID}" \
  --query 'DistributionConfig.Origins.Items[0].OriginAccessControlId' \
  --output text)

FRONTEND_OAC_ID=$(aws cloudfront get-distribution-config \
  --id "${FRONTEND_DIST_ID}" \
  --query 'DistributionConfig.Origins.Items[0].OriginAccessControlId' \
  --output text)

echo "  Video OAC             : ${VIDEO_OAC_ID}"
echo "  Frontend OAC          : ${FRONTEND_OAC_ID}"

# Bucket names are deterministic — set in storage-stack.ts using the account ID
PROCESSED_BUCKET="cloudclips-processed-${ACCOUNT_ID}"
FRONTEND_BUCKET="cloudclips-frontend-${ACCOUNT_ID}"

# Helper: write an OAC policy to a bucket
# $1 = bucket name, $2 = CloudFront distribution ID
apply_oac_policy() {
  local bucket="$1" dist_id="$2"
  # The Condition restricts access to *this specific distribution* only —
  # any other CloudFront distribution cannot access the bucket even with OAC.
  aws s3api put-bucket-policy --bucket "${bucket}" --policy "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${bucket}/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${dist_id}"
        }
      }
    }
  ]
}
JSON
)"
  echo "  [OK] Policy applied to s3://${bucket}"
}

apply_oac_policy "${PROCESSED_BUCKET}" "${VIDEO_DIST_ID}"
apply_oac_policy "${FRONTEND_BUCKET}"  "${FRONTEND_DIST_ID}"
echo ""

# ── Summary ────────────────────────────────────────────────────────────────────
FRONTEND_URL=$(cfn_output "${CDK_STACK_PREFIX}-Cdn" "FrontendDistributionUrl")
VIDEO_URL=$(cfn_output "${CDK_STACK_PREFIX}-Cdn" "VideoDistributionUrl")
API_URL=$(cfn_output "${CDK_STACK_PREFIX}-Api" "ApiUrl")

echo "=== Deploy Complete ==="
echo ""
echo "  Frontend : ${FRONTEND_URL}"
echo "  Video CDN: ${VIDEO_URL}"
echo "  API      : ${API_URL}"
echo ""
echo "Next steps:"
echo "  - Upload a frontend build : cd frontend && pnpm build && aws s3 sync dist/ s3://${FRONTEND_BUCKET}/"
echo "  - Set up CI/CD (OIDC)    : ./scripts/setup-oidc.sh <github-owner> <repo>"
