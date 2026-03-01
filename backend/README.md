# backend — Lambda Functions

All Lambda handler code for CloudClips. Each function is a single TypeScript file that CDK bundles with esbuild at deploy time — no build step is needed locally.

---

## Structure

```
backend/
└── src/
    ├── functions/          # One directory per Lambda function
    │   ├── presign-upload/
    │   ├── process-upload/
    │   ├── transcode/
    │   ├── moderate/
    │   ├── moderation-complete/
    │   ├── transcribe/
    │   ├── notify/
    │   ├── get-video/
    │   ├── list-videos/
    │   ├── record-view/
    │   ├── acm-cert/
    │   └── cloudflare-dns/
    └── shared/             # Shared utilities and types
        ├── types.ts
        ├── dynamo.ts
        └── response.ts
```

---

## Shared Utilities

### [`shared/types.ts`](src/shared/types.ts)

Core TypeScript types used across all Lambda functions.

**`VideoStatus` enum**

```
UPLOADING → PROCESSING → MODERATING → PUBLISHED
                                    ↘ QUARANTINED
```

**`VideoRecord` interface** — the DynamoDB item shape:

| Field | Type | Description |
|---|---|---|
| `videoId` | `string` | UUID, partition key |
| `userId` | `string` | Cognito `sub` of uploader |
| `title` | `string` | User-provided title |
| `status` | `VideoStatus` | Current pipeline state |
| `uploadKey` | `string` | S3 key in upload bucket |
| `processedKeys` | `Record<string, string>` | e.g. `{ '720p': 'videos/id/720p.mp4', '360p': '...' }` |
| `captionKey` | `string?` | S3 key of VTT caption file (if Transcribe completed) |
| `moderationLabels` | `ModerationLabel[]?` | Rekognition labels (only on QUARANTINED) |
| `viewCount` | `number` | Atomic increment counter |
| `createdAt` | `string` | ISO 8601 timestamp |
| `updatedAt` | `string` | ISO 8601 timestamp |

**`ProcessingEventPayload`** — SNS message body:

```typescript
{
  eventType: 'TRANSCODE_COMPLETE' | 'MODERATION_COMPLETE' | 'VIDEO_PUBLISHED' | 'VIDEO_QUARANTINED',
  videoId: string,
  userId: string,
  // ...event-specific fields
}
```

### [`shared/dynamo.ts`](src/shared/dynamo.ts)

Exports a singleton `DynamoDBDocumentClient` (AWS SDK v3) and `VIDEOS_TABLE` (from the `VIDEOS_TABLE_NAME` env var set by CDK).

Usage:
```typescript
import { dynamo, VIDEOS_TABLE } from '../../shared/dynamo';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

const result = await dynamo.send(new GetCommand({
  TableName: VIDEOS_TABLE,
  Key: { videoId },
}));
```

### [`shared/response.ts`](src/shared/response.ts)

HTTP response helper functions with CORS headers automatically included:

```typescript
import { success, created, badRequest, notFound, serverError } from '../../shared/response';

return success({ videoId, uploadUrl });   // 200
return created({ videoId });             // 201
return badRequest('Missing title');      // 400
return notFound('Video not found');      // 404
return serverError('Internal error');    // 500
```

All responses include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type,Authorization
Access-Control-Allow-Methods: GET,POST,OPTIONS
Content-Type: application/json
```

---

## API Functions

### `presign-upload` — POST /uploads

**Trigger:** API Gateway (Cognito-authorized)

**Request:**
```json
{
  "title": "My video clip",
  "contentType": "video/mp4"
}
```

**Response:**
```json
{
  "videoId": "uuid-v4",
  "uploadUrl": "https://cloudclips-uploads-<account>.s3.amazonaws.com/..."
}
```

**What it does:**
1. Extracts `userId` from the Cognito JWT (via `requestContext.authorizer.claims.sub`)
2. Generates a UUID `videoId`
3. Creates a DynamoDB record with `status: UPLOADING`
4. Returns a presigned S3 PUT URL (5-minute TTL, `Content-Type: video/mp4` enforced)

The S3 object key is `videos/{userId}/{videoId}/original.mp4`.

**Environment variables:** `UPLOAD_BUCKET_NAME`, `VIDEOS_TABLE_NAME`

---

### `get-video` — GET /videos/{videoId}

**Trigger:** API Gateway (no auth)

**Response:**
```json
{
  "videoId": "...",
  "title": "...",
  "status": "PUBLISHED",
  "processedKeys": { "720p": "videos/id/720p.mp4", "360p": "videos/id/360p.mp4" },
  "captionKey": "captions/id.vtt",
  "viewCount": 42,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

Returns 404 if the video does not exist.

**Environment variables:** `VIDEOS_TABLE_NAME`

---

### `list-videos` — GET /videos

**Trigger:** API Gateway (no auth)

**Query parameters:**

| Parameter | Type | Default | Max |
|---|---|---|---|
| `limit` | number | 20 | 50 |
| `nextToken` | string | — | — |

`nextToken` is a base64-encoded DynamoDB `LastEvaluatedKey` from the previous page.

**Response:**
```json
{
  "videos": [ /* VideoRecord[] */ ],
  "nextToken": "base64-encoded-key-or-absent"
}
```

Queries the `status-createdAt-index` GSI with `status = PUBLISHED`, sorted by `createdAt` descending.

**Environment variables:** `VIDEOS_TABLE_NAME`

---

### `record-view` — POST /videos/{videoId}/view

**Trigger:** API Gateway (no auth)

**Response:**
```json
{ "viewCount": 43 }
```

Atomically increments `viewCount` using DynamoDB `UpdateItem` with `ADD viewCount :1`. The update has a condition expression `#status = :published` — returns 404 if the video is not in `PUBLISHED` status.

**Environment variables:** `VIDEOS_TABLE_NAME`

---

## Pipeline Functions

### `process-upload` — S3 EventBridge trigger

**Trigger:** EventBridge rule (`aws.s3` source, `Object Created` detail type, filtered to the upload bucket)

**What it does:**
1. Parses `videoId` and `userId` from the S3 object key (`videos/{userId}/{videoId}/original.mp4`)
2. Updates DynamoDB status: `UPLOADING` → `PROCESSING`
3. Sends a message to SQS with `{ videoId, userId, uploadKey }`

**Environment variables:** `VIDEOS_TABLE_NAME`, `TRANSCODE_QUEUE_URL`

---

### `transcode` — SQS consumer

**Trigger:** SQS queue (`transcode-jobs`)

**Configuration:** ARM64, 2 GB memory, 2 GB `/tmp`, 15-minute timeout, FFmpeg Lambda layer

**What it does:**
1. Downloads the raw MP4 from the upload bucket to `/tmp/input.mp4`
2. Runs FFmpeg twice:
   - 720p: `ffmpeg -i input.mp4 -vf scale=-2:720 -c:v libx264 -crf 23 -preset fast -c:a aac 720p.mp4`
   - 360p: `ffmpeg -i input.mp4 -vf scale=-2:360 -c:v libx264 -crf 28 -preset fast -b:v 500k -c:a aac 360p.mp4`
3. Uploads both files to the processed bucket under `videos/{videoId}/`
4. Updates DynamoDB: `processedKeys: { '720p': ..., '360p': ... }`, `status: MODERATING`
5. Publishes `TRANSCODE_COMPLETE` to SNS with the video metadata

**Environment variables:** `UPLOAD_BUCKET_NAME`, `PROCESSED_BUCKET_NAME`, `VIDEOS_TABLE_NAME`, `PIPELINE_TOPIC_ARN`

---

### `moderate` — SNS consumer (TRANSCODE_COMPLETE)

**Trigger:** SNS topic subscription with filter `eventType = TRANSCODE_COMPLETE`

**What it does:**
1. Calls Rekognition `StartContentModeration` with the raw upload S3 URI
2. Configures SNS notification for when the job completes (Rekognition publishes async results to a dedicated SNS topic)
3. Stores the `rekognitionJobId` in DynamoDB

**Environment variables:** `VIDEOS_TABLE_NAME`, `REKOGNITION_TOPIC_ARN`, `REKOGNITION_ROLE_ARN`

---

### `moderation-complete` — SNS consumer (Rekognition callback)

**Trigger:** SNS topic (Rekognition publishes job completion here)

**What it does:**
1. Calls `GetContentModeration` to fetch all detected labels
2. Filters labels by confidence threshold (default 80%)
3. If any labels exceed the threshold → status = `QUARANTINED`; else → `PUBLISHED`
4. Updates DynamoDB with `status`, `moderationLabels` (if quarantined)
5. Publishes `VIDEO_PUBLISHED` or `VIDEO_QUARANTINED` to the pipeline SNS topic

**Moderation labels:** AWS Rekognition categories include Explicit Nudity, Violence, Suggestive, Visually Disturbing, etc.

**Environment variables:** `VIDEOS_TABLE_NAME`, `PIPELINE_TOPIC_ARN`

---

### `transcribe` — SNS consumer (TRANSCODE_COMPLETE)

**Trigger:** SNS topic subscription with filter `eventType = TRANSCODE_COMPLETE`

**What it does:**
1. Starts an Amazon Transcribe `StartTranscriptionJob` on the 720p output
2. Configures VTT subtitle output to `captions/{videoId}.vtt` in the processed bucket
3. Stores the caption S3 key in DynamoDB

Caption files are served via CloudFront alongside the video, and the frontend renders them via a `<track>` element.

**Environment variables:** `PROCESSED_BUCKET_NAME`, `VIDEOS_TABLE_NAME`

---

### `notify` — SNS consumer (VIDEO_PUBLISHED)

**Trigger:** SNS topic subscription with filter `eventType = VIDEO_PUBLISHED`

**Current state:** Logs the event. Email sending is not yet implemented.

**TODO:** Look up the user's email from Cognito (`AdminGetUser` with the `userId`), then send an SES email notifying them that their video is live.

**Environment variables:** `PIPELINE_TOPIC_ARN` _(future: Cognito User Pool ID, SES from address)_

---

## CDK Custom Resource Functions

These functions are invoked by CloudFormation during `cdk deploy`, not by end-user traffic.

### `acm-cert` — Certificate provisioner

**Trigger:** CloudFormation Custom Resource (Create/Update/Delete)

**What it does (on Create/Update):**
1. Lists existing ACM certificates; reuses one if it's already `ISSUED` or `PENDING_VALIDATION` for the domain
2. If no suitable cert exists, calls `RequestCertificate` (DNS validation type)
3. Reads the CNAME validation record from ACM
4. Upserts the validation CNAME to Cloudflare via API (token from Secrets Manager)
5. Polls ACM every 5 seconds until status is `ISSUED`
6. Returns `{ certificateArn }` to CloudFormation

**What it does (on Delete):** No-op (certificate is retained to avoid accidental deletion).

**Environment variables:** Read at invoke time from the Custom Resource properties (no Lambda env vars — properties are passed by CDK).

---

### `cloudflare-dns` — DNS CNAME upsert

**Trigger:** CloudFormation Custom Resource (Create/Update/Delete)

**What it does (on Create/Update):**
1. Fetches the Cloudflare API token from Secrets Manager
2. Lists DNS records for the zone; finds existing CNAME for the domain
3. Creates or updates the CNAME to point to the CloudFront domain
4. Sets proxy status to DNS-only (orange cloud off — required because CloudFront handles TLS)

**What it does (on Delete):** No-op (DNS record is retained).

---

## Environment Variables Reference

CDK injects environment variables into each Lambda at deploy time. Here is the complete list:

| Variable | Set by stack | Used by |
|---|---|---|
| `UPLOAD_BUCKET_NAME` | Processing, Api | presign-upload, transcode |
| `PROCESSED_BUCKET_NAME` | Processing, Moderation | transcode, transcribe |
| `VIDEOS_TABLE_NAME` | Database | all pipeline + API functions |
| `TRANSCODE_QUEUE_URL` | Processing | process-upload |
| `PIPELINE_TOPIC_ARN` | Notification | transcode, moderation-complete, notify |
| `REKOGNITION_TOPIC_ARN` | Moderation | moderate |
| `REKOGNITION_ROLE_ARN` | Moderation | moderate |

---

## Development Notes

### No build step

CDK uses esbuild to bundle each handler at `cdk deploy` time. You do not need to run `tsc` in the backend package to deploy. Typechecking is separate:

```bash
pnpm typecheck   # from repo root, or:
cd backend && pnpm typecheck
```

### Adding a new function

1. Create `src/functions/<name>/handler.ts` exporting `export const handler = async (event) => { ... }`
2. Add a `NodejsFunction` construct in the appropriate CDK stack
3. Grant IAM permissions (`bucket.grantRead(fn)`, `table.grantReadWriteData(fn)`, etc.)
4. Add an event source or trigger as needed

### AWS SDK v3

All AWS SDK calls use modular v3 imports:
```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
```

The SDK clients are instantiated outside the handler function (module scope) so they are reused across warm invocations.
