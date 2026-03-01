# scripts — Setup and Operational Scripts

One-time setup helpers and operational utilities for CloudClips. These scripts are designed to be run manually (not by CI/CD), and most are idempotent.

---

## Script Reference

### `setup-aws.sh` — Bootstrap the AWS environment

Run **once** before the first deploy on a new AWS account.

```bash
bash scripts/setup-aws.sh
```

**What it does:**
1. Checks for required tools (`aws`, `node`, `cdk`)
2. Runs `cdk bootstrap aws://<account>/<region>` — creates the `CDKToolkit` CloudFormation stack that stores CDK assets (Lambda bundles, etc.) in S3 and ECR
3. Verifies SES email identity — if the address is not already verified, starts the verification process and instructs you to click the confirmation link
4. Checks that MediaConvert is available in your region (it is in all major regions)

**Prerequisites:**
- AWS credentials configured (`aws configure` or env vars)
- CDK CLI installed globally (`npm install -g aws-cdk`)

**Idempotent:** Yes — safe to re-run.

---

### `setup-dns.sh` — Store Cloudflare API token in Secrets Manager

Run **once** before the first deploy if you are using a custom domain.

```bash
# Create a .env file with your Cloudflare API token
echo "CLOUDFLARE_TOKEN=<your-cloudflare-api-token>" > .env

bash scripts/setup-dns.sh
```

**What it does:**
- Reads `CLOUDFLARE_TOKEN` from `.env`
- Creates or updates the secret `cloudclips/cloudflare-api-token` in AWS Secrets Manager

The CDK cert and DNS stacks read this secret at deploy time to:
- Validate the ACM certificate via Cloudflare DNS (cert-stack)
- Upsert the CNAME record pointing your domain to CloudFront (dns-stack)

**Cloudflare API token requirements:**
- Permission: **Zone → DNS → Edit**
- Scope: Specific zone (your domain), or all zones
- Create at: Cloudflare Dashboard → My Profile → API Tokens → Create Token → Edit zone DNS template

**Prerequisites:**
- AWS credentials configured
- `.env` file in the repo root with `CLOUDFLARE_TOKEN=...`

**Idempotent:** Yes — re-running updates the existing secret value.

---

### `setup-oidc.sh` — Create GitHub Actions OIDC IAM role

Run **once** to enable keyless GitHub Actions deployments.

```bash
bash scripts/setup-oidc.sh <github-owner> <repo-name>

# Example:
bash scripts/setup-oidc.sh myusername CloudClips
```

**What it does:**
1. Creates an AWS IAM OIDC Identity Provider for `token.actions.githubusercontent.com` (skips if already exists)
2. Creates an IAM role `cloudclips-github-deploy` with:
   - Trust policy scoped to `repo:<owner>/<repo>:*` — only your GitHub Actions workflows can assume this role
   - `AdministratorAccess` policy attached (appropriate for a dev/portfolio project)
3. Prints the role ARN

**After running this script:**

Add the role ARN as a GitHub Actions secret:
- Go to your repo → Settings → Secrets and variables → Actions → New repository secret
- Name: `AWS_DEPLOY_ROLE_ARN`
- Value: the ARN printed by the script (e.g. `arn:aws:iam::123456789012:role/cloudclips-github-deploy`)

**How OIDC federation works:**

GitHub Actions requests a short-lived OIDC token from GitHub's token endpoint. AWS validates the token signature against the registered OIDC provider and issues temporary AWS credentials. No long-lived access keys are stored anywhere.

**Idempotent:** Yes — re-running with the same arguments is a no-op (the role already exists).

---

### `deploy.sh` — Full deployment

The main deployment script. Handles everything that `cdk deploy` alone does not.

```bash
bash scripts/deploy.sh
```

**What it does:**
1. Runs `pnpm install` (all workspaces)
2. Runs `cdk bootstrap` (idempotent)
3. Runs `cdk deploy --all --require-approval never` — deploys all 10 CDK stacks
4. **Applies CloudFront OAC bucket policies** (post-deploy step):
   - Reads the CloudFront OAC IDs and bucket names from CloudFormation outputs
   - Adds S3 bucket policies allowing the OAC principals to read from the processed and frontend buckets

> **Why is the OAC policy step separate?**
>
> The CDN stack imports S3 buckets by ARN (using `s3.Bucket.fromBucketArn()`) to avoid a CDK circular dependency between the Storage and CDN stacks. When a bucket is imported by ARN rather than by construct reference, CDK cannot automatically add bucket policies. The OAC policy must be applied manually after deployment.

**Output:** Prints the Frontend URL, Video CDN URL, and API URL from CloudFormation outputs.

**Prerequisites:**
- AWS credentials configured
- CDK CLI installed
- pnpm installed
- `scripts/setup-aws.sh` has been run at least once

---

### `test-upload.sh` — End-to-end pipeline test

Verifies the complete video upload pipeline without using the UI.

```bash
bash scripts/test-upload.sh
```

**What it does (in order):**
1. Creates a temporary Cognito test user (`test-upload-<timestamp>@cloudclips-test.invalid`)
2. Authenticates via `ADMIN_USER_PASSWORD_AUTH` to get a Cognito ID token
3. Calls `POST /uploads` → receives `{ videoId, uploadUrl }`
4. Generates a minimal test MP4 (uses FFmpeg if available; otherwise a synthetic binary)
5. PUTs the file to the presigned S3 URL
6. Polls DynamoDB every 2 seconds until status = `PROCESSING` (process-upload Lambda)
7. Polls DynamoDB every 5 seconds until status = `MODERATING` (transcode Lambda + FFmpeg)
8. Verifies 720p and 360p output files exist in S3

Each step prints a PASS/FAIL result. The script cleans up the test Cognito user on exit (via `trap`).

**Timeouts:**
- `PROCESSING`: waits up to 30 seconds
- `MODERATING`: waits up to 10 minutes (FFmpeg can take time for larger files)

**Prerequisites:**
- AWS credentials configured
- `frontend/.env.local` present (or `VITE_API_URL` set in the environment)
- Stack deployed

**Example output:**
```
[1/5] Creating test user...         PASS
[2/5] Creating upload record...     PASS (videoId: abc-123)
[3/5] Uploading to S3...            PASS (12.4 MB in 2.1s)
[4/5] Waiting for PROCESSING...     PASS (3s)
[5/5] Waiting for MODERATING...     PASS (47s)
Verifying S3 outputs...             PASS (720p: 8.2 MB, 360p: 3.1 MB)

All 5 steps passed.
```

---

### `teardown.sh` — Destroy all stacks

Destroys all CloudClips AWS resources. Requires explicit confirmation.

```bash
bash scripts/teardown.sh
```

**What it does:**
- Prompts for `yes` confirmation
- Runs `cdk destroy --all --force`
- Removes all stacks: Auth, Storage, Database, Notification, Processing, Moderation, Api, Cert, Cdn, Dns

**What it does NOT remove:**
- `CDKToolkit` bootstrap stack (remove manually via CloudFormation console if desired)
- SES email identities (remove via SES console)
- GitHub OIDC IAM role and identity provider (remove via IAM console)

> **Warning:** This is irreversible. All S3 objects, DynamoDB records, and CloudFront distributions will be deleted.

---

## Quick Reference — Which script to run when?

| Situation | Script |
|---|---|
| First deploy on a new AWS account | `setup-aws.sh` → `setup-dns.sh` → `deploy.sh` |
| Setting up GitHub Actions CI/CD | `setup-oidc.sh` |
| Updating the Cloudflare API token | `setup-dns.sh` (re-run) |
| Deploying changes | `deploy.sh` (or push to `main`) |
| Verifying the pipeline works | `test-upload.sh` |
| Cleaning up all resources | `teardown.sh` |
