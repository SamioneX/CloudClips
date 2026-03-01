# CloudClips

Serverless short video sharing platform built on AWS. Users upload short MP4 clips, which are automatically transcoded into multiple resolutions, moderated by AI, and served globally via CloudFront CDN.

**Live:** [cloudclips.sokech.com](https://cloudclips.sokech.com)

---

## Table of Contents

- [Architecture](#architecture)
- [Feature Overview](#feature-overview)
- [Tech Stack](#tech-stack)
- [Monorepo Structure](#monorepo-structure)
- [Prerequisites](#prerequisites)
- [From-Scratch Setup Guide](#from-scratch-setup-guide)
- [Development Workflow](#development-workflow)
- [Deployment](#deployment)
- [Tearing Down](#tearing-down)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User's Browser                              │
│                    cloudclips.sokech.com                            │
└────────────────────────┬────────────────────────────────────────────┘
                         │ HTTPS
                         ▼
          ┌──────────────────────────┐
          │   CloudFront (Frontend)  │ ◄── ACM cert (DNS-validated
          │  d1rfco8ezqrq0y.cf.net   │     via Cloudflare)
          └──────────────┬───────────┘
                         │ OAC
                         ▼
               ┌──────────────────┐
               │   S3 (frontend)  │  React + Vite SPA
               └──────────────────┘

  ┌──── Auth ──────────────────────────────────────────────────────┐
  │  AWS Cognito User Pool                                         │
  │  User signs up/logs in → receives JWT ID token                 │
  └────────────────────────────────────────────────────────────────┘

  ┌──── Upload Flow ────────────────────────────────────────────────┐
  │                                                                  │
  │  1. POST /uploads (ID token) → API Gateway                      │
  │         │                                                        │
  │         ▼                                                        │
  │  presign-upload Lambda                                           │
  │    • Creates DynamoDB record (status: UPLOADING)                 │
  │    • Returns presigned S3 PUT URL (5 min TTL)                    │
  │         │                                                        │
  │         ▼                                                        │
  │  2. Browser PUT MP4 → S3 Upload Bucket (presigned URL)           │
  │         │                                                        │
  │         ▼ EventBridge (ObjectCreated)                            │
  │  process-upload Lambda                                           │
  │    • Updates DynamoDB status → PROCESSING                        │
  │    • Enqueues job to SQS                                         │
  └──────────────────────────────────────────────────────────────────┘

  ┌──── Transcoding Pipeline ───────────────────────────────────────┐
  │                                                                  │
  │  transcode Lambda  (ARM64, 2 GB RAM, 15 min, FFmpeg layer)       │
  │    • Downloads from upload bucket                                │
  │    • FFmpeg → 720p (h.264 crf23) + 360p (crf28)                  │
  │    • Uploads to S3 processed bucket                              │
  │    • Updates DynamoDB status → MODERATING                        │
  │    • Publishes SNS: TRANSCODE_COMPLETE                           │
  │                   │                                              │
  │         ┌─────────┴─────────┐                                    │
  │         ▼                   ▼                                    │
  │   moderate Lambda     transcribe Lambda                          │
  │   (SNS filter:        (SNS filter:                               │
  │   TRANSCODE_COMPLETE) TRANSCODE_COMPLETE)                        │
  │         │                   │                                    │
  │         ▼                   ▼                                    │
  │   Rekognition Video   Amazon Transcribe                          │
  │   (content mod.)      (auto-captions → VTT)                      │
  │         │                   │                                    │
  │         ▼                   ▼                                    │
  │   moderation-complete  captionKey stored                         │
  │   Lambda               in DynamoDB                               │
  │    • confidence ≥ 80%                                            │
  │      → PUBLISHED                                                 │
  │    • else → QUARANTINED                                          │
  │         │                                                        │
  │         ▼ SNS: VIDEO_PUBLISHED                                   │
  │   notify Lambda  (TODO: SES email to uploader)                   │
  └──────────────────────────────────────────────────────────────────┘

  ┌──── Serving ────────────────────────────────────────────────────┐
  │                                                                  │
  │  GET /videos         → list-videos Lambda → DynamoDB GSI query   │
  │  GET /videos/:id     → get-video Lambda   → DynamoDB GetItem     │
  │  POST /videos/:id/view → record-view Lambda → atomic increment   │
  │                                                                  │
  │  Video playback:                                                 │
  │  Browser → CloudFront (video CDN) → S3 processed bucket (OAC)   │
  │  Captions via <track> → CloudFront VTT file                      │
  └──────────────────────────────────────────────────────────────────┘

  ┌──── Infrastructure as Code ─────────────────────────────────────┐
  │  CDK stacks (TypeScript), deployed via GitHub Actions            │
  │  OIDC federation — no long-lived AWS keys stored anywhere        │
  │  Custom domain DNS managed via Cloudflare                        │
  └──────────────────────────────────────────────────────────────────┘
```

### Video Lifecycle States

```
UPLOADING → PROCESSING → MODERATING → PUBLISHED
                                    ↘ QUARANTINED
```

| State | Set by | Meaning |
|---|---|---|
| `UPLOADING` | presign-upload Lambda | Record created, awaiting S3 PUT |
| `PROCESSING` | process-upload Lambda | Enqueued for FFmpeg transcoding |
| `MODERATING` | transcode Lambda | Transcoding done, Rekognition running |
| `PUBLISHED` | moderation-complete Lambda | Clean content, visible in feed |
| `QUARANTINED` | moderation-complete Lambda | Flagged content, hidden from feed |

---

## Feature Overview

- **Upload** — drag-and-drop MP4 upload with real-time XHR progress bar
- **Transcoding** — automatic 720p + 360p outputs via FFmpeg on Lambda
- **AI Moderation** — AWS Rekognition Video content moderation (auto-reject if confidence ≥ 80%)
- **Auto-Captions** — Amazon Transcribe generates VTT subtitle files served alongside video
- **Quality Toggle** — players can switch between 720p and 360p without reloading
- **Feed** — paginated public video feed, sorted by newest first
- **Auth** — email/password sign-up with verification code confirmation
- **Custom Domain** — cloudclips.sokech.com with TLS, served from CloudFront
- **CI/CD** — GitHub Actions auto-deploys every push to `main`, OIDC (no stored keys)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 5, Amplify v6, React Router v6, plain CSS |
| Auth | AWS Cognito (User Pool + App Client) |
| API | Amazon API Gateway (REST) + AWS Lambda (Node.js 20) |
| Database | Amazon DynamoDB (pay-per-request, two GSIs) |
| Storage | Amazon S3 (3 buckets: uploads, processed, frontend) |
| Transcoding | FFmpeg on ARM64 Lambda (layer) |
| Moderation | AWS Rekognition Video |
| Captions | Amazon Transcribe |
| CDN | Amazon CloudFront (2 distributions) |
| DNS | Cloudflare (CNAME → CloudFront, managed by CDK) |
| TLS | AWS Certificate Manager (DNS-validated via Cloudflare) |
| IaC | AWS CDK v2 (TypeScript) |
| CI/CD | GitHub Actions + AWS OIDC federation |
| Language | TypeScript everywhere (strict mode) |
| Package Manager | pnpm workspaces |

---

## Monorepo Structure

```
CloudClips/
├── infra/           # AWS CDK stacks (one per domain)
│   ├── bin/
│   │   └── cloudclips.ts        # CDK app entry point — stack instantiation order
│   └── lib/stacks/
│       ├── auth-stack.ts        # Cognito User Pool
│       ├── storage-stack.ts     # S3 buckets (uploads, processed, frontend)
│       ├── database-stack.ts    # DynamoDB videos table + GSIs
│       ├── notification-stack.ts# SNS topic (pipeline events)
│       ├── processing-stack.ts  # EventBridge + SQS + transcode Lambda
│       ├── moderation-stack.ts  # Rekognition + Transcribe Lambdas
│       ├── api-stack.ts         # API Gateway + CRUD Lambdas
│       ├── cert-stack.ts        # ACM cert (Cloudflare DNS validation)
│       ├── cdn-stack.ts         # CloudFront distributions
│       └── dns-stack.ts         # Cloudflare CNAME upsert
│
├── backend/                     # Lambda handlers + shared utilities
│   └── src/
│       ├── functions/
│       │   ├── presign-upload/  # POST /uploads
│       │   ├── process-upload/  # EventBridge → SQS
│       │   ├── transcode/       # FFmpeg transcoding
│       │   ├── moderate/        # Rekognition start
│       │   ├── moderation-complete/ # Rekognition callback
│       │   ├── transcribe/      # Amazon Transcribe captions
│       │   ├── notify/          # SNS → SES email (TODO)
│       │   ├── get-video/       # GET /videos/:id
│       │   ├── list-videos/     # GET /videos
│       │   ├── record-view/     # POST /videos/:id/view
│       │   ├── acm-cert/        # CDK Custom Resource: cert provisioning
│       │   └── cloudflare-dns/  # CDK Custom Resource: DNS upsert
│       └── shared/
│           ├── types.ts         # VideoRecord, VideoStatus, etc.
│           ├── dynamo.ts        # DynamoDB Document Client singleton
│           └── response.ts      # HTTP response helpers (CORS headers)
│
├── frontend/                    # React SPA
│   └── src/
│       ├── contexts/
│       │   └── AuthContext.tsx  # Auth state shared across app
│       ├── components/
│       │   ├── Navbar.tsx
│       │   ├── VideoCard.tsx
│       │   └── ProtectedRoute.tsx
│       ├── pages/
│       │   ├── HomePage.tsx     # Video feed grid
│       │   ├── VideoPage.tsx    # Player + quality toggle
│       │   ├── UploadPage.tsx   # Upload form + progress + polling
│       │   ├── LoginPage.tsx
│       │   ├── SignupPage.tsx
│       │   └── ConfirmPage.tsx  # Email verification code
│       └── services/
│           ├── api.ts           # API client (listVideos, getVideo, createUpload…)
│           └── auth.ts          # Amplify v6 auth wrapper
│
└── scripts/                     # One-time setup helpers
    ├── setup-aws.sh             # CDK bootstrap + SES verification
    ├── setup-oidc.sh            # GitHub Actions OIDC IAM role
    ├── setup-dns.sh             # Cloudflare token → AWS Secrets Manager
    ├── deploy.sh                # Full deploy (CDK + OAC policies)
    ├── test-upload.sh           # End-to-end pipeline test
    └── teardown.sh              # Destroy all stacks
```

See each subdirectory's `README.md` for deeper documentation:
- [infra/README.md](infra/README.md) — CDK stacks reference
- [backend/README.md](backend/README.md) — Lambda functions + API reference
- [frontend/README.md](frontend/README.md) — frontend development guide
- [scripts/README.md](scripts/README.md) — setup and operational scripts

---

## Prerequisites

Before you begin, ensure you have the following.

### Accounts

| Account | Purpose |
|---|---|
| AWS account | All infrastructure |
| Cloudflare account | DNS management for your custom domain |
| GitHub account | Source control + CI/CD |

### Tools (local machine)

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Via `nvm` or `fnm` recommended |
| pnpm | ≥ 9 | `npm install -g pnpm` |
| AWS CLI | v2 | [Install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| AWS CDK CLI | latest | `npm install -g aws-cdk` |

Or use the **dev container** (VS Code + Docker), which includes all tools pre-installed. See [Dev Container](#dev-container).

### AWS permissions

The deploying IAM user/role needs the following AWS permissions (or `AdministratorAccess` for simplicity):
- CloudFormation full access
- S3, Lambda, DynamoDB, API Gateway, CloudFront
- Cognito, SNS, SQS, EventBridge
- Rekognition, Transcribe, ACM, SES
- IAM (to create Lambda execution roles)
- Secrets Manager

### Parameters you will need

| Parameter | Where to get it | Where it goes |
|---|---|---|
| AWS Access Key ID | IAM → Users → Security credentials | `~/.aws/credentials` or `.devcontainer/.env` |
| AWS Secret Access Key | Same | Same |
| AWS Region | Choose (e.g. `us-east-1`) | `~/.aws/config` or `.devcontainer/.env` |
| AWS Account ID | AWS console top-right → account menu | Automatically detected by CDK |
| Cloudflare API Token | Cloudflare → My Profile → API Tokens (Zone:DNS:Edit scope) | `scripts/setup-dns.sh` stores it in Secrets Manager |
| Custom domain | A domain you control in Cloudflare | `infra/lib/stacks/cert-stack.ts` + `dns-stack.ts` (see Setup Guide) |
| GitHub repo owner/name | Your GitHub username + repo name | `scripts/setup-oidc.sh` arguments |
| SES sender email | An email address you own | `scripts/setup-aws.sh` argument |

---

## From-Scratch Setup Guide

Follow these steps **in order** on a fresh AWS account.

### Step 1 — Clone and install

```bash
git clone https://github.com/<your-org>/CloudClips.git
cd CloudClips
pnpm install
```

### Step 2 — Configure AWS credentials

**Option A — Local credentials file** (recommended for local dev):
```bash
aws configure
# AWS Access Key ID: <your-key>
# AWS Secret Access Key: <your-secret>
# Default region: us-east-1
# Default output format: json
```

**Option B — Dev container** (all tools pre-installed):
```bash
cp .devcontainer/.env.example .devcontainer/.env
# Edit .devcontainer/.env:
#   AWS_ACCESS_KEY_ID=...
#   AWS_SECRET_ACCESS_KEY=...
#   AWS_DEFAULT_REGION=us-east-1
# Then: VS Code → "Reopen in Container"
```

Verify credentials work:
```bash
aws sts get-caller-identity
```

### Step 3 — Set your custom domain

Edit the domain name in two files:

**[infra/lib/stacks/cert-stack.ts](infra/lib/stacks/cert-stack.ts)** — find the line:
```typescript
domainName: 'cloudclips.sokech.com',
```
Change `cloudclips.sokech.com` to your domain.

**[infra/lib/stacks/dns-stack.ts](infra/lib/stacks/dns-stack.ts)** — find:
```typescript
domainName: 'cloudclips.sokech.com',
```
Change to the same domain.

Also update the `allowedOrigins` CORS value in **[infra/lib/stacks/storage-stack.ts](infra/lib/stacks/storage-stack.ts)** when you tighten it for production.

### Step 4 — Bootstrap AWS environment

```bash
bash scripts/setup-aws.sh
```

This script:
1. Runs `cdk bootstrap` (creates CDKToolkit stack — needed once per account/region)
2. Verifies/registers your SES email identity for notifications
3. Checks MediaConvert is available in your region

> **SES sandbox note**: New AWS accounts are in the SES sandbox — you can only send to verified email addresses. To send to any address, request production access in the SES console.

### Step 5 — Store your Cloudflare API token

Create a Cloudflare API token with **Zone:DNS:Edit** permission for your domain:

1. Go to Cloudflare → My Profile → API Tokens → Create Token
2. Use the "Edit zone DNS" template; scope it to your specific zone
3. Copy the token, then run:

```bash
# Create a .env file with your token
echo "CLOUDFLARE_TOKEN=<paste-token-here>" > .env

bash scripts/setup-dns.sh
```

This stores the token in AWS Secrets Manager under `cloudclips/cloudflare-api-token`. The CDK cert and DNS stacks read it from there at deploy time.

### Step 6 — Deploy everything

```bash
bash scripts/deploy.sh
```

This script:
1. Installs all dependencies
2. Bootstraps CDK (idempotent)
3. Deploys all 10 CDK stacks in dependency order
4. Applies CloudFront OAC bucket policies (required post-deploy because CDN stack imports buckets by ARN)

The first deploy takes ~10–15 minutes (ACM certificate provisioning + DNS validation can take a few minutes).

At the end, the script prints:
```
Frontend URL: https://d1xxxxxxxxx.cloudfront.net
Video CDN URL: https://d2xxxxxxxxx.cloudfront.net
API URL: https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/
```

Your custom domain becomes live once the Cloudflare CNAME propagates (usually within 1 minute).

### Step 7 — Configure frontend for local development

```bash
# Fetch live values from CloudFormation outputs
VITE_API_URL=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text)

VITE_USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text)

VITE_USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text)

VITE_VIDEO_CDN_URL=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Cdn \
  --query "Stacks[0].Outputs[?OutputKey=='VideoDistributionUrl'].OutputValue" \
  --output text)

cat > frontend/.env.local <<EOF
VITE_API_URL=$VITE_API_URL
VITE_USER_POOL_ID=$VITE_USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$VITE_USER_POOL_CLIENT_ID
VITE_VIDEO_CDN_URL=$VITE_VIDEO_CDN_URL
EOF
```

### Step 8 — Set up GitHub Actions CI/CD

**8a — Create the OIDC IAM role:**
```bash
bash scripts/setup-oidc.sh <github-owner> <repo-name>
# Example: bash scripts/setup-oidc.sh myusername CloudClips
```
This creates an IAM role `cloudclips-github-deploy` with a trust policy scoped to your repo. The role ARN is printed at the end.

**8b — Add secrets to GitHub:**

Go to your GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret name | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | The role ARN from step 8a (e.g. `arn:aws:iam::123456789012:role/cloudclips-github-deploy`) |

**8c — Set GitHub Actions variable (optional):**

If your AWS region is not `us-east-1`, add a repository variable:

| Variable name | Value |
|---|---|
| `AWS_REGION` | e.g. `eu-west-1` |

From now on, every push to `main` automatically deploys the full stack.

### Step 9 — Verify end-to-end

```bash
bash scripts/test-upload.sh
```

This creates a test Cognito user, uploads a video, and polls DynamoDB until the video reaches `PUBLISHED` status (or times out). All 5 pipeline stages are verified with pass/fail output.

---

## Development Workflow

### Running the frontend locally

```bash
cd frontend
pnpm dev        # http://localhost:5173
```

The dev server proxies nothing — it connects directly to the deployed AWS backend using the values in `frontend/.env.local`.

### Typechecking

```bash
pnpm typecheck   # Runs tsc --noEmit in infra, backend, and frontend
```

### Linting + formatting

```bash
pnpm lint         # ESLint
pnpm format       # Prettier (write)
pnpm format:check # Prettier (check only — used in CI)
```

### Synthesizing CDK templates (no deploy)

```bash
cd infra && npx cdk synth
# With dummy account (for CI/offline use):
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-1 npx cdk synth --quiet
```

### Deploying a single stack

```bash
cd infra && npx cdk deploy CloudClips-Api
```

### Adding a new Lambda function

1. Create `backend/src/functions/<name>/handler.ts` exporting a `handler` function
2. Add the function to the appropriate CDK stack in `infra/lib/stacks/`
3. Add any required IAM grants in the stack
4. Wire up the trigger (EventBridge rule, SQS event source, SNS subscription, or API Gateway route)

### Dev Container

For a fully reproducible environment without installing tools locally:

```bash
cp .devcontainer/.env.example .devcontainer/.env
# Fill in AWS credentials in .devcontainer/.env
# Open project in VS Code → Ctrl+Shift+P → "Reopen in Container"
```

The container includes: Node.js 22, pnpm, AWS CLI v2, AWS CDK CLI, Docker CLI.

---

## Deployment

### Automatic (recommended)

Push to `main` — GitHub Actions runs:
1. CDK deploy (all stacks)
2. Fetch `VITE_*` env vars from CloudFormation outputs
3. Build frontend (`pnpm build`)
4. Sync to S3
5. CloudFront cache invalidation

### Manual

```bash
bash scripts/deploy.sh
# Then build and sync frontend manually:
cd frontend && pnpm build
aws s3 sync dist s3://cloudclips-frontend-<account-id> --delete
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/*"
```

---

## Tearing Down

To destroy all AWS resources:

```bash
bash scripts/teardown.sh
```

> **Note:** This does NOT remove the CDKToolkit bootstrap stack, SES email identities, or the GitHub OIDC IAM role. Remove those manually if needed.

---

## Known Limitations / TODOs

- **Email notifications**: `notify/handler.ts` logs the event but does not send SES emails yet (needs Cognito user email lookup).
- **CORS**: Upload bucket `allowedOrigins` is `['*']` — tighten in production.
- **SES sandbox**: New accounts can only send to verified emails. Request production SES access to send to all users.
