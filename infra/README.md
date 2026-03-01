# infra — AWS CDK Stacks

This package contains all AWS infrastructure for CloudClips, defined as AWS CDK v2 stacks in TypeScript.

---

## Stack Overview

Ten stacks are deployed in dependency order. The entry point [`bin/cloudclips.ts`](bin/cloudclips.ts) instantiates all stacks and wires cross-stack references.

```
CloudClips-Auth
CloudClips-Storage
CloudClips-Database
CloudClips-Notification
CloudClips-Processing       (depends on Storage, Database, Notification)
CloudClips-Moderation       (depends on Storage, Database, Notification)
CloudClips-Api              (depends on Auth, Storage, Database)
CloudClips-Cert             (depends on nothing — reads Secrets Manager at deploy time)
CloudClips-Cdn              (depends on Storage, Auth, Cert)
CloudClips-Dns              (depends on Cdn — reads Secrets Manager at deploy time)
```

---

## Stack Reference

### `CloudClips-Auth` — [lib/stacks/auth-stack.ts](lib/stacks/auth-stack.ts)

**AWS services:** Cognito User Pool + App Client

Creates a Cognito User Pool for email/password authentication:

- Sign-in via email (not username)
- Email auto-verification via Cognito's built-in email sender
- Password policy: 8+ characters, requires uppercase, lowercase, digit
- `ALLOW_USER_SRP_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH` (compatible with Amplify v6)
- Self sign-up enabled

**CloudFormation outputs:**

| Key | Value |
|---|---|
| `UserPoolId` | Cognito User Pool ID (used by frontend + API authorizer) |
| `UserPoolClientId` | App Client ID (used by frontend Amplify config) |

---

### `CloudClips-Storage` — [lib/stacks/storage-stack.ts](lib/stacks/storage-stack.ts)

**AWS services:** S3 (3 buckets)

| Bucket | Purpose | Key config |
|---|---|---|
| `cloudclips-uploads-<account>` | Raw MP4 uploads from users (presigned URL target) | EventBridge enabled, 7-day expiration, CORS PUT allowed |
| `cloudclips-processed-<account>` | FFmpeg-transcoded 720p + 360p outputs + VTT captions | Private, served via CloudFront OAC |
| `cloudclips-frontend-<account>` | React SPA build artifacts | Private, served via CloudFront OAC |

All buckets:
- Block all public access
- S3-managed encryption (SSE-S3)
- `RemovalPolicy.DESTROY` + `autoDeleteObjects: true` (appropriate for dev/portfolio)

Upload bucket lifecycle rules:
- Abort incomplete multipart uploads after 1 day
- Delete raw uploads after 7 days (already transcoded by then)

**CloudFormation outputs:**

| Key | Value |
|---|---|
| `UploadBucketName` | Upload bucket name |
| `ProcessedBucketName` | Processed bucket name |
| `FrontendBucketName` | Frontend bucket name |

---

### `CloudClips-Database` — [lib/stacks/database-stack.ts](lib/stacks/database-stack.ts)

**AWS services:** DynamoDB

Single table `cloudclips-videos` with:

| Key | Type |
|---|---|
| `videoId` (partition key) | String |

**Global Secondary Indexes:**

| GSI name | PK | SK | Purpose |
|---|---|---|---|
| `userId-createdAt-index` | `userId` | `createdAt` | Fetch videos by user |
| `status-createdAt-index` | `status` | `createdAt` | Feed query (PUBLISHED videos, newest first) |

Table settings:
- Pay-per-request billing
- Point-in-time recovery enabled
- `RemovalPolicy.DESTROY`

**CloudFormation outputs:**

| Key | Value |
|---|---|
| `VideosTableName` | DynamoDB table name |

---

### `CloudClips-Notification` — [lib/stacks/notification-stack.ts](lib/stacks/notification-stack.ts)

**AWS services:** SNS

One SNS topic (`cloudclips-pipeline`) acts as the central event bus for the async video processing pipeline.

**Events published to this topic:**

| Event type (`eventType` attribute) | Published by | Consumed by |
|---|---|---|
| `TRANSCODE_COMPLETE` | transcode Lambda | moderate Lambda, transcribe Lambda |
| `MODERATION_COMPLETE` | moderation-complete Lambda | _(logging only)_ |
| `VIDEO_PUBLISHED` | moderation-complete Lambda | notify Lambda |
| `VIDEO_QUARANTINED` | moderation-complete Lambda | _(logging only)_ |

Subscriptions use SNS **message attribute filters** so each Lambda only receives its relevant event type.

**CloudFormation outputs:**

| Key | Value |
|---|---|
| `PipelineTopicArn` | SNS topic ARN |

---

### `CloudClips-Processing` — [lib/stacks/processing-stack.ts](lib/stacks/processing-stack.ts)

**AWS services:** EventBridge, SQS, Lambda (×2)

The transcoding pipeline:

```
S3 ObjectCreated event
        │ EventBridge rule
        ▼
process-upload Lambda
  • Updates DynamoDB: UPLOADING → PROCESSING
  • Sends message to SQS
        │
        ▼
  SQS queue (transcode-jobs)
        │ event source mapping
        ▼
transcode Lambda (ARM64, 2 GB RAM, 900s timeout)
  • Downloads raw MP4 from upload bucket
  • FFmpeg: 720p h.264 crf23, 360p h.264 crf28
  • Uploads transcoded files to processed bucket
  • Updates DynamoDB: PROCESSING → MODERATING
  • Publishes TRANSCODE_COMPLETE to SNS
```

**FFmpeg Lambda layer:** `arn:aws:lambda:us-east-1:145266761615:layer:ffmpeg:1` (ARM64 static binary)

**transcode Lambda configuration:**

| Setting | Value | Reason |
|---|---|---|
| Architecture | ARM64 | FFmpeg layer is ARM64; ~20% cheaper on Graviton |
| Memory | 2048 MB | FFmpeg needs RAM for video processing |
| Ephemeral storage | 2048 MB `/tmp` | Intermediate video files |
| Timeout | 15 minutes | Max Lambda timeout; long videos need time |

**CloudFormation outputs:** _(none — internal to pipeline)_

---

### `CloudClips-Moderation` — [lib/stacks/moderation-stack.ts](lib/stacks/moderation-stack.ts)

**AWS services:** Lambda (×3), Rekognition, Transcribe

Three Lambdas handle AI moderation in parallel after transcoding:

#### `moderate` Lambda

Triggered by SNS (`TRANSCODE_COMPLETE` filter). Starts a Rekognition `StartContentModeration` job on the raw uploaded video (S3 URI). Stores the Rekognition job ID in DynamoDB.

#### `moderation-complete` Lambda

Triggered by SNS (Rekognition publishes results to a dedicated SNS topic). Calls `GetContentModeration`, evaluates labels against a confidence threshold (default 80%). Updates DynamoDB status to `PUBLISHED` or `QUARANTINED`. Publishes outcome event to the pipeline SNS topic.

#### `transcribe` Lambda

Triggered by SNS (`TRANSCODE_COMPLETE` filter). Starts an Amazon Transcribe job on the 720p output. Configures VTT subtitle output in a `captions/` prefix in the processed bucket. Stores the caption S3 key in DynamoDB so the frontend can render `<track>` elements.

**CloudFormation outputs:** _(none — internal to pipeline)_

---

### `CloudClips-Api` — [lib/stacks/api-stack.ts](lib/stacks/api-stack.ts)

**AWS services:** API Gateway (REST), Lambda (×4), Cognito Authorizer

REST API with Cognito JWT authorization on protected routes:

| Method | Path | Lambda | Auth | Description |
|---|---|---|---|---|
| `POST` | `/uploads` | `presign-upload` | Cognito | Create upload record + return presigned S3 URL |
| `GET` | `/videos` | `list-videos` | None | Paginated feed of PUBLISHED videos |
| `GET` | `/videos/{videoId}` | `get-video` | None | Single video metadata |
| `POST` | `/videos/{videoId}/view` | `record-view` | None | Atomic view count increment |

All routes have CORS enabled (responds to OPTIONS preflight).

**presign-upload Lambda:**
- Validates JWT via Cognito authorizer (extracts `sub` as `userId`)
- Generates presigned S3 PUT URL (5-minute TTL, `Content-Type: video/mp4` enforced)
- Creates DynamoDB video record with status `UPLOADING`
- Returns `{ videoId, uploadUrl }`

**list-videos Lambda:**
- Queries `status-createdAt-index` GSI with `status = PUBLISHED`
- Supports `limit` (max 50, default 20) and base64-encoded `nextToken` for pagination
- Returns `{ videos: VideoRecord[], nextToken? }`

**get-video Lambda:**
- DynamoDB `GetItem` by `videoId`
- Returns full `VideoRecord` or 404

**record-view Lambda:**
- Atomic DynamoDB `UpdateItem` with `ADD viewCount :1`
- Conditional on `status = PUBLISHED` (returns 404 for non-published videos)
- Returns `{ viewCount }`

**CloudFormation outputs:**

| Key | Value |
|---|---|
| `ApiUrl` | API Gateway invoke URL (e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/prod/`) |

---

### `CloudClips-Cert` — [lib/stacks/cert-stack.ts](lib/stacks/cert-stack.ts)

**AWS services:** Lambda (Custom Resource), ACM, Secrets Manager

A CDK Lambda-backed Custom Resource that provisions an ACM TLS certificate for the custom domain via Cloudflare DNS validation.

**How it works:**
1. CDK deploys a Lambda (`acm-cert/handler.ts`) as a CloudFormation Custom Resource
2. On stack create/update, the Lambda:
   - Checks for an existing ISSUED or PENDING_VALIDATION certificate for the domain
   - If none found, calls `RequestCertificate` (DNS validation)
   - Reads the DNS validation CNAME from ACM
   - Upserts the validation CNAME to Cloudflare via API (using the token from Secrets Manager)
   - Polls ACM every 5 seconds until status is `ISSUED` (typically 1–2 minutes)
3. Returns the certificate ARN to CloudFormation

The stack exports the certificate ARN so `CloudClips-Cdn` can attach it to CloudFront.

> **Why not `aws-cdk-lib/aws-certificatemanager.Certificate`?** — The built-in CDK certificate construct requires Route 53 for DNS validation. Since DNS is managed by Cloudflare, a custom resource is needed.

**CloudFormation outputs:**

| Key | Value |
|---|---|
| `CertificateArn` | ACM certificate ARN |

---

### `CloudClips-Cdn` — [lib/stacks/cdn-stack.ts](lib/stacks/cdn-stack.ts)

**AWS services:** CloudFront (×2), OAC (×2)

Two CloudFront distributions:

#### Video distribution

Serves transcoded videos and caption files from the processed S3 bucket.

- Origin: processed S3 bucket via OAC (Origin Access Control — no public S3 access)
- Cache policy: managed CachingOptimized
- HTTPS only, TLSv1.2 minimum
- HTTP 403 + 404 → return `/index.html` with 200 (for SPA client-side routing support — not used but harmless)

#### Frontend distribution

Serves the React SPA from the frontend S3 bucket.

- Origin: frontend S3 bucket via OAC
- Custom domain alias: `cloudclips.sokech.com`
- TLS certificate: from `CloudClips-Cert` (must be in `us-east-1` — CloudFront requirement)
- HTTPS-only redirect (HTTP → HTTPS)
- Security headers via CloudFront response headers policy:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
- 403/404 from S3 → `/index.html` + 200 (SPA fallback for React Router)

> **OAC bucket policies note:** Because the CDN stack imports S3 buckets by ARN (to avoid CDK cross-stack circular dependencies), CDK cannot automatically add the OAC bucket policy. The `scripts/deploy.sh` script applies these policies as a post-deploy step. See [scripts/README.md](../scripts/README.md).

**CloudFormation outputs:**

| Key | Value |
|---|---|
| `VideoDistributionId` | Video CloudFront distribution ID |
| `VideoDistributionUrl` | `https://d2xxxxxxx.cloudfront.net` |
| `FrontendDistributionId` | Frontend CloudFront distribution ID |
| `FrontendDistributionUrl` | `https://d1xxxxxxx.cloudfront.net` |

---

### `CloudClips-Dns` — [lib/stacks/dns-stack.ts](lib/stacks/dns-stack.ts)

**AWS services:** Lambda (Custom Resource), Secrets Manager

A CDK Lambda-backed Custom Resource that upserts a Cloudflare DNS record on every deploy.

**How it works:**
1. CDK deploys a Lambda (`cloudflare-dns/handler.ts`) as a CloudFormation Custom Resource
2. On every stack update, the Lambda upserts a CNAME record:
   - `cloudclips.sokech.com` → frontend CloudFront domain
   - Proxy status: DNS-only (orange cloud off — required because CloudFront handles TLS)
3. A `DeployTime` property set to the current timestamp forces the Custom Resource to re-run on every `cdk deploy`, making the DNS record self-healing

> This stack runs **after** `CloudClips-Cdn` so it has the CloudFront domain name available.

---

## Cross-Stack Design Notes

### Why EventBridge instead of S3 event notifications?

S3 can trigger Lambda directly, but this creates a circular CDK dependency: the Storage stack would need to reference the Lambda ARN from the Processing stack, and the Processing stack needs the bucket name from Storage. EventBridge decouples this — Storage enables EventBridge on the bucket, and Processing creates a rule targeting its Lambda.

### Why buckets are imported by ARN in the CDN stack

The CDN stack needs bucket names/ARNs to create OAC origins. If the CDN stack took the bucket constructs as props, it would create a circular dependency with Storage (which needs to be deployed first). Instead, CDN accepts raw ARN strings and uses `s3.Bucket.fromBucketArn()` to import them. The trade-off is that CDK cannot automatically add the OAC-required bucket policy — `deploy.sh` handles this manually post-deploy.

### SNS message attribute filters

The processing pipeline uses a single SNS topic with multiple subscribers. Each Lambda subscription includes a filter policy on the `eventType` message attribute, so each Lambda only receives its relevant events. This is cheaper and simpler than maintaining multiple topics.

---

## Commands

```bash
# Install dependencies
pnpm install

# Typecheck
pnpm typecheck

# Synthesize CloudFormation templates (no deploy)
npx cdk synth

# Deploy a single stack
npx cdk deploy CloudClips-Api

# Deploy all stacks
npx cdk deploy --all --require-approval never

# Diff against deployed stacks
npx cdk diff

# List all stacks
npx cdk list
```
