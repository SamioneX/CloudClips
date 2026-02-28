#!/usr/bin/env bash
set -euo pipefail

# CloudClips — GitHub Actions OIDC Federation Setup
#
# Creates an IAM OIDC identity provider for GitHub Actions and a deploy role
# that GitHub can assume using short-lived tokens (no long-lived keys needed).
#
# Prerequisites:
#   - AWS CLI configured with admin-level credentials (aws configure)
#   - A GitHub repo created for this project
#
# Usage:
#   ./scripts/setup-oidc.sh <github-owner> <github-repo>
#
# Example:
#   ./scripts/setup-oidc.sh myusername CloudClips

echo "=== CloudClips — GitHub OIDC Federation Setup ==="
echo ""

# --- Validate inputs ---

if [ $# -lt 2 ]; then
  echo "Usage: $0 <github-owner> <github-repo>"
  echo "Example: $0 myusername CloudClips"
  exit 1
fi

GITHUB_OWNER="$1"
GITHUB_REPO="$2"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_DEFAULT_REGION:-us-east-1}
ROLE_NAME="cloudclips-github-deploy"
OIDC_PROVIDER="token.actions.githubusercontent.com"

echo "GitHub Repo:  ${GITHUB_OWNER}/${GITHUB_REPO}"
echo "AWS Account:  ${ACCOUNT_ID}"
echo "AWS Region:   ${REGION}"
echo "Role Name:    ${ROLE_NAME}"
echo ""

# --- Step 1: Create OIDC Identity Provider (idempotent) ---

echo "--- Step 1: OIDC Identity Provider ---"

EXISTING_PROVIDER=$(aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?ends_with(Arn, '/${OIDC_PROVIDER}')].Arn" \
  --output text 2>/dev/null || echo "")

if [ -n "$EXISTING_PROVIDER" ] && [ "$EXISTING_PROVIDER" != "None" ]; then
  echo "OIDC provider already exists: ${EXISTING_PROVIDER}"
  PROVIDER_ARN="$EXISTING_PROVIDER"
else
  # GitHub's OIDC thumbprint (used by AWS to verify tokens)
  # This is GitHub's well-known thumbprint; AWS also verifies via the OIDC spec
  THUMBPRINT="6938fd4d98bab03faadb97b34396831e3780aea1"

  PROVIDER_ARN=$(aws iam create-open-id-connect-provider \
    --url "https://${OIDC_PROVIDER}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "${THUMBPRINT}" \
    --query "OpenIDConnectProviderArn" \
    --output text)

  echo "Created OIDC provider: ${PROVIDER_ARN}"
fi
echo ""

# --- Step 2: Create IAM Trust Policy ---

echo "--- Step 2: IAM Deploy Role ---"

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "${OIDC_PROVIDER}:sub": "repo:${GITHUB_OWNER}/${GITHUB_REPO}:*"
        }
      }
    }
  ]
}
EOF
)

# --- Step 3: Create the deploy role (or update trust policy if it exists) ---

EXISTING_ROLE=$(aws iam get-role --role-name "${ROLE_NAME}" 2>/dev/null && echo "exists" || echo "")

if [ -n "$EXISTING_ROLE" ]; then
  echo "Role '${ROLE_NAME}' already exists — updating trust policy..."
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "${TRUST_POLICY}"
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --description "GitHub Actions deploy role for CloudClips (OIDC federation)" \
    --max-session-duration 3600 \
    --output text --query "Role.Arn"

  echo "Created role: ${ROLE_NAME}"
fi
echo ""

# --- Step 4: Attach permissions ---
# CDK needs broad permissions because it manages CloudFormation which creates
# all resource types. For a portfolio/dev project, AdministratorAccess is
# pragmatic. For production, you'd scope this down or use CDK's built-in
# bootstrap roles (cdk bootstrap --trust).

echo "--- Step 3: Attaching permissions ---"

# Core CDK permissions
aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "arn:aws:iam::aws:policy/AdministratorAccess" 2>/dev/null || true

echo "Attached AdministratorAccess (appropriate for dev/portfolio project)"
echo ""
echo "NOTE: For production, replace AdministratorAccess with scoped policies."
echo "      CDK's bootstrap trust model is the recommended production pattern:"
echo "      https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html"
echo ""

# --- Step 5: Output ---

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "=== Setup Complete ==="
echo ""
echo "Role ARN: ${ROLE_ARN}"
echo ""
echo "Next steps:"
echo "  1. Go to: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/settings/secrets/actions"
echo "  2. Click 'New repository secret'"
echo "  3. Name:  AWS_DEPLOY_ROLE_ARN"
echo "     Value: ${ROLE_ARN}"
echo "  4. (Optional) Add a repository variable:"
echo "     Settings → Secrets and variables → Actions → Variables tab"
echo "     Name:  AWS_REGION"
echo "     Value: ${REGION}"
echo ""
echo "Your CI/CD pipeline will now authenticate via OIDC — no access keys needed."
