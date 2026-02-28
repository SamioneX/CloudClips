#!/usr/bin/env bash
set -euo pipefail

# CloudClips — End-to-end upload pipeline test
#
# Usage:  ./scripts/test-upload.sh
#
# What this tests (in order):
#   1. POST /uploads  → API Gateway + Cognito auth + presign-upload Lambda + DynamoDB write
#   2. PUT <presignedUrl>  → S3 upload via presigned URL
#   3. EventBridge rule  → S3 Object Created event fires to process-upload Lambda
#   4. process-upload Lambda  → DynamoDB status update + SQS message
#   5. transcode Lambda  → FFmpeg transcode (720p + 360p) + DynamoDB update to MODERATING
#
# How auth works in this script:
#   Uses ADMIN_USER_PASSWORD_AUTH — a server-side Cognito flow that requires AWS IAM
#   credentials (not callable from the browser). A temporary test user is created,
#   used to get a JWT, and deleted at the end of the script.
#
# Prerequisites:
#   - All CDK stacks deployed (./scripts/deploy.sh)
#   - The Cognito app client must have adminUserPassword:true (set in auth-stack.ts)
#   - AWS CLI configured with credentials for account 320524884497
#
# Test video:
#   If ffmpeg is available, a real 3-second video is generated (MediaConvert will
#   transcode it successfully). Otherwise a dummy .mp4 file is used — the pipeline
#   wiring is still fully tested, but the MediaConvert job itself will fail.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
CDK_STACK_PREFIX="CloudClips"
TEST_USER_EMAIL="e2e-test@cloudclips-test.invalid"
TEST_PASSWORD="TestPass1!"        # Meets Cognito policy: upper, lower, digit, 8+ chars
TEST_VIDEO="/tmp/cloudclips-test.mp4"
FAILED=false

# ── Terminal colours ───────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

pass()  { echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail()  { echo -e "  ${RED}[FAIL]${NC} $1"; FAILED=true; }
info()  { echo -e "  ${YELLOW}[INFO]${NC} $1"; }
step()  { echo -e "\n${BOLD}$1${NC}"; }

# ── Cleanup: always delete the test user on exit ───────────────────────────────
# We capture USER_POOL_ID in a global so the trap can use it.
USER_POOL_ID=""
cleanup() {
  if [[ -n "${USER_POOL_ID}" ]]; then
    echo ""
    step "--- Cleanup ---"
    aws cognito-idp admin-delete-user \
      --user-pool-id "${USER_POOL_ID}" \
      --username "${TEST_USER_EMAIL}" \
      --region "${REGION}" 2>/dev/null \
      && info "Test user deleted" \
      || info "Test user was already deleted or never created"
  fi
  rm -f "${TEST_VIDEO}"
}
trap cleanup EXIT

# ── Prerequisites ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=== CloudClips End-to-End Upload Test ===${NC}"
echo ""

command -v aws   >/dev/null 2>&1 || { echo "ERROR: aws CLI not found"; exit 1; }
command -v curl  >/dev/null 2>&1 || { echo "ERROR: curl not found";    exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found"; exit 1; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
info "Account: ${ACCOUNT_ID} | Region: ${REGION}"

# ── Helper: read a CloudFormation output value ─────────────────────────────────
cfn_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks \
    --stack-name "${stack}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}

# ── Helper: poll DynamoDB for a specific status with retries ──────────────────
# Usage: wait_for_status <videoId> <tableName> <expectedStatus> <timeoutSeconds>
wait_for_status() {
  local video_id="$1" table="$2" expected="$3" timeout_secs="$4"
  local elapsed=0 interval=8
  while [[ ${elapsed} -lt ${timeout_secs} ]]; do
    local current
    current=$(aws dynamodb get-item \
      --table-name "${table}" \
      --key "{\"videoId\":{\"S\":\"${video_id}\"}}" \
      --query 'Item.status.S' \
      --output text \
      --region "${REGION}" 2>/dev/null || echo "MISSING")
    if [[ "${current}" == "${expected}" ]]; then
      return 0
    fi
    info "  DynamoDB status=${current}, waiting for ${expected}... (${elapsed}s / ${timeout_secs}s)"
    sleep ${interval}
    elapsed=$((elapsed + interval))
  done
  return 1  # timed out
}

# ── Helper: poll DynamoDB until status advances past a given value ─────────────
# Usage: wait_for_status_past <videoId> <tableName> <stuckStatus> <timeoutSeconds>
# Returns 0 as soon as status is anything other than <stuckStatus> or MISSING.
# Prints the status it advanced to and stores it in ADVANCED_TO.
ADVANCED_TO=""
wait_for_status_past() {
  local video_id="$1" table="$2" stuck="$3" timeout_secs="$4"
  local elapsed=0 interval=8
  while [[ ${elapsed} -lt ${timeout_secs} ]]; do
    local current
    current=$(aws dynamodb get-item \
      --table-name "${table}" \
      --key "{\"videoId\":{\"S\":\"${video_id}\"}}" \
      --query 'Item.status.S' \
      --output text \
      --region "${REGION}" 2>/dev/null || echo "MISSING")
    if [[ "${current}" != "${stuck}" && "${current}" != "MISSING" ]]; then
      ADVANCED_TO="${current}"
      return 0
    fi
    info "  DynamoDB status=${current}, waiting for pipeline to advance past ${stuck}... (${elapsed}s / ${timeout_secs}s)"
    sleep ${interval}
    elapsed=$((elapsed + interval))
  done
  return 1  # timed out
}

# ── Step 0: Fetch stack outputs ────────────────────────────────────────────────
step "[0/5] Fetching stack outputs"

USER_POOL_ID=$(cfn_output "${CDK_STACK_PREFIX}-Auth" "UserPoolId")
CLIENT_ID=$(cfn_output "${CDK_STACK_PREFIX}-Auth" "UserPoolClientId")
API_URL=$(cfn_output "${CDK_STACK_PREFIX}-Api" "ApiUrl")
VIDEOS_TABLE=$(aws cloudformation describe-stacks \
  --stack-name "${CDK_STACK_PREFIX}-Database" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='VideosTableName'].OutputValue" \
  --output text)

if [[ -z "${USER_POOL_ID}" || -z "${CLIENT_ID}" || -z "${API_URL}" || -z "${VIDEOS_TABLE}" ]]; then
  echo "ERROR: Could not read stack outputs. Have you run ./scripts/deploy.sh?"
  exit 1
fi

info "User Pool  : ${USER_POOL_ID}"
info "Client ID  : ${CLIENT_ID}"
info "API URL    : ${API_URL}"
info "Table      : ${VIDEOS_TABLE}"

# ── Step 1: Auth — create test user and get JWT ────────────────────────────────
step "[1/5] Authenticating"

# Create user (admin API — no email verification required)
aws cognito-idp admin-create-user \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${TEST_USER_EMAIL}" \
  --user-attributes Name=email,Value="${TEST_USER_EMAIL}" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region "${REGION}" \
  >/dev/null

# Set a permanent password so we can authenticate immediately
aws cognito-idp admin-set-user-password \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${TEST_USER_EMAIL}" \
  --password "${TEST_PASSWORD}" \
  --permanent \
  --region "${REGION}" \
  >/dev/null

# Authenticate with ADMIN_USER_PASSWORD_AUTH (server-side flow, requires IAM creds)
AUTH_RESULT=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id "${USER_POOL_ID}" \
  --client-id "${CLIENT_ID}" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="${TEST_USER_EMAIL}",PASSWORD="${TEST_PASSWORD}" \
  --region "${REGION}" \
  --output json)

ID_TOKEN=$(echo "${AUTH_RESULT}" | python3 -c "import sys, json; print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])")

if [[ -n "${ID_TOKEN}" ]]; then
  pass "Cognito auth succeeded — got IdToken"
else
  fail "Cognito auth failed — no IdToken in response"
  exit 1
fi

# ── Step 2: POST /uploads → presigned URL ──────────────────────────────────────
step "[2/5] POST /uploads (presign-upload Lambda)"

RESPONSE_BODY_FILE="/tmp/cloudclips-test-response.json"
HTTP_STATUS=$(curl -s -o "${RESPONSE_BODY_FILE}" -w "%{http_code}" \
  -X POST "${API_URL}uploads" \
  -H "Authorization: ${ID_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"title":"E2E Test Video","contentType":"video/mp4","fileExtension":"mp4"}')
HTTP_BODY=$(cat "${RESPONSE_BODY_FILE}")

if [[ "${HTTP_STATUS}" == "201" ]]; then
  pass "POST /uploads → HTTP 201"
else
  fail "POST /uploads → HTTP ${HTTP_STATUS} (expected 201)"
  echo "  Response: ${HTTP_BODY}"
  exit 1
fi

VIDEO_ID=$(echo "${HTTP_BODY}" | python3 -c "import sys, json; print(json.load(sys.stdin)['videoId'])")
UPLOAD_URL=$(echo "${HTTP_BODY}" | python3 -c "import sys, json; print(json.load(sys.stdin)['uploadUrl'])")

pass "Video ID   : ${VIDEO_ID}"
info "Upload URL : ${UPLOAD_URL:0:80}..."

# Confirm the DynamoDB record was written with UPLOADING status
INITIAL_STATUS=$(aws dynamodb get-item \
  --table-name "${VIDEOS_TABLE}" \
  --key "{\"videoId\":{\"S\":\"${VIDEO_ID}\"}}" \
  --query 'Item.status.S' \
  --output text \
  --region "${REGION}")

if [[ "${INITIAL_STATUS}" == "UPLOADING" ]]; then
  pass "DynamoDB record created with status=UPLOADING"
else
  fail "DynamoDB record not found or wrong status (got: ${INITIAL_STATUS})"
fi

# ── Step 3: PUT file to S3 via presigned URL ───────────────────────────────────
step "[3/5] Uploading file to S3"

# Generate a test video. If ffmpeg is available locally, produce a real MP4 so the
# transcode Lambda's FFmpeg can process it. Otherwise, create a minimal synthetic
# file — the pipeline wiring is still tested end-to-end, but the Lambda's FFmpeg
# will fail to transcode an invalid stream.
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -f lavfi -i "color=black:s=64x64:r=1" -t 3 \
    -vcodec libx264 -preset ultrafast -an \
    "${TEST_VIDEO}" -y -loglevel quiet
  info "Generated real MP4 via ffmpeg (64x64, 3s)"
else
  # Minimal ftyp+mdat structure — just enough for S3 to accept as video/mp4.
  # The transcode Lambda will fail on this, but all pipeline steps up to FFmpeg succeed.
  python3 -c "
import struct
# ftyp box: declares this as an MP4 file
ftyp = b'ftyp' + b'mp42' + b'\x00\x00\x00\x00' + b'mp42' + b'isom'
ftyp_box = struct.pack('>I', 8 + len(ftyp)) + ftyp
# mdat box: empty media data
mdat_box = struct.pack('>I', 8) + b'mdat'
with open('${TEST_VIDEO}', 'wb') as f:
    f.write(ftyp_box + mdat_box)
"
  info "Generated minimal synthetic MP4 (no ffmpeg found locally)"
  info "NOTE: transcode Lambda will fail on this dummy file — step 5 will not pass"
fi

# PUT the file — presigned URLs don't need Authorization headers (the signature is in the URL)
PUT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT "${UPLOAD_URL}" \
  -H "Content-Type: video/mp4" \
  --data-binary "@${TEST_VIDEO}")

if [[ "${PUT_STATUS}" == "200" ]]; then
  pass "PUT to presigned S3 URL → HTTP 200"
else
  fail "PUT to presigned S3 URL → HTTP ${PUT_STATUS} (expected 200)"
  exit 1
fi

# ── Step 4: EventBridge → process-upload Lambda ────────────────────────────────
step "[4/5] Waiting for EventBridge → process-upload Lambda → SQS"

# EventBridge delivery + Lambda cold start + DynamoDB write typically takes 5–30s.
# We poll until status advances past UPLOADING — this confirms the process-upload
# Lambda fired and updated DynamoDB.
#
# Note: FFmpeg is fast enough on a 3-second test video that PROCESSING may be
# traversed in under 8 seconds, meaning the status could already be MODERATING
# by the time we first poll. Accepting any status beyond UPLOADING is correct.
if wait_for_status_past "${VIDEO_ID}" "${VIDEOS_TABLE}" "UPLOADING" 60; then
  pass "DynamoDB status advanced to ${ADVANCED_TO} (process-upload Lambda ran)"
else
  fail "Timed out waiting for status to advance past UPLOADING after 60s"
  # Check CloudWatch Logs for clues
  START_MS=$(python3 -c "import time; print(int((time.time() - 120) * 1000))")
  LOG_EVENTS=$(aws logs filter-log-events \
    --log-group-name "/aws/lambda/cloudclips-process-upload" \
    --start-time "${START_MS}" \
    --filter-pattern "\"${VIDEO_ID}\"" \
    --region "${REGION}" \
    --query 'events[*].message' \
    --output text 2>/dev/null || echo "(no log events found)")
  info "CloudWatch Logs for process-upload:\n${LOG_EVENTS}"
fi

# ── Step 5: transcode Lambda → FFmpeg → S3 files ──────────────────────────────
step "[5/5] Waiting for transcode Lambda (FFmpeg) → S3 outputs"

# The transcode Lambda runs FFmpeg synchronously inside the invocation.
# For a 3-second test video it should finish in under 2 minutes.
# We poll DynamoDB for status=MODERATING — the Lambda only sets this AFTER
# both transcoded files are confirmed in S3.
TRANSCODE_TIMEOUT=300  # 5 min max for the test video; real videos may use up to 15 min

if wait_for_status "${VIDEO_ID}" "${VIDEOS_TABLE}" "MODERATING" ${TRANSCODE_TIMEOUT}; then
  pass "DynamoDB status changed to MODERATING (FFmpeg transcode complete)"
else
  fail "Timed out waiting for status=MODERATING after ${TRANSCODE_TIMEOUT}s"
  START_MS=$(python3 -c "import time; print(int((time.time() - 400) * 1000))")
  LOG_EVENTS=$(aws logs filter-log-events \
    --log-group-name "/aws/lambda/cloudclips-transcode" \
    --start-time "${START_MS}" \
    --filter-pattern "\"${VIDEO_ID}\"" \
    --region "${REGION}" \
    --query 'events[*].message' \
    --output text 2>/dev/null || echo "(no log events found)")
  info "CloudWatch Logs for transcode:\n${LOG_EVENTS}"
fi

# Verify the transcoded files actually landed in S3
# (stronger than just checking DynamoDB — confirms bytes were written)
PROCESSED_BUCKET="cloudclips-processed-${ACCOUNT_ID}"

if aws s3api head-object \
    --bucket "${PROCESSED_BUCKET}" \
    --key "videos/${VIDEO_ID}/_720p.mp4" \
    --region "${REGION}" >/dev/null 2>&1; then
  FILE_SIZE=$(aws s3api head-object \
    --bucket "${PROCESSED_BUCKET}" \
    --key "videos/${VIDEO_ID}/_720p.mp4" \
    --region "${REGION}" \
    --query 'ContentLength' --output text)
  pass "720p output in S3 (${FILE_SIZE} bytes)"
else
  fail "720p output not found in S3: s3://${PROCESSED_BUCKET}/videos/${VIDEO_ID}/_720p.mp4"
fi

if aws s3api head-object \
    --bucket "${PROCESSED_BUCKET}" \
    --key "videos/${VIDEO_ID}/_360p.mp4" \
    --region "${REGION}" >/dev/null 2>&1; then
  FILE_SIZE=$(aws s3api head-object \
    --bucket "${PROCESSED_BUCKET}" \
    --key "videos/${VIDEO_ID}/_360p.mp4" \
    --region "${REGION}" \
    --query 'ContentLength' --output text)
  pass "360p output in S3 (${FILE_SIZE} bytes)"
else
  fail "360p output not found in S3: s3://${PROCESSED_BUCKET}/videos/${VIDEO_ID}/_360p.mp4"
fi

# ── Final state in DynamoDB ────────────────────────────────────────────────────
FINAL_ITEM=$(aws dynamodb get-item \
  --table-name "${VIDEOS_TABLE}" \
  --key "{\"videoId\":{\"S\":\"${VIDEO_ID}\"}}" \
  --region "${REGION}" \
  --output json)

FINAL_STATUS=$(echo "${FINAL_ITEM}" | python3 -c "
import sys, json
item = json.load(sys.stdin).get('Item', {})
print(item.get('status',{}).get('S','NOT FOUND'))
")
PROCESSED_KEYS=$(echo "${FINAL_ITEM}" | python3 -c "
import sys, json
item = json.load(sys.stdin).get('Item', {})
keys = item.get('processedKeys', {}).get('M', {})
print(', '.join(f\"{k}: {v['S']}\" for k, v in keys.items()) or 'none yet')
" 2>/dev/null || echo "none yet")

info "Final DynamoDB state:"
info "  status       : ${FINAL_STATUS}"
info "  processedKeys: ${PROCESSED_KEYS}"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}=== Test Summary ===${NC}"
echo ""
if [[ "${FAILED}" == "false" ]]; then
  echo -e "  ${GREEN}All pipeline steps verified successfully.${NC}"
  echo ""
  echo "  Upload flow:"
  echo "    POST /uploads → presign-upload → DynamoDB(UPLOADING)"
  echo "    PUT S3 presigned URL → S3 object created"
  echo "    EventBridge → process-upload → DynamoDB(PROCESSING) + SQS"
  echo "    SQS → transcode (FFmpeg) → 720p+360p in S3 + DynamoDB(MODERATING)"
else
  echo -e "  ${RED}One or more steps failed. See [FAIL] lines above.${NC}"
  echo ""
  echo "  Troubleshooting tips:"
  echo "    - Lambda logs:  aws logs tail /aws/lambda/cloudclips-<name> --follow"
  echo "    - EventBridge:  aws events list-rules (confirm UploadEventRule is ENABLED)"
  echo "    - SQS DLQ:      aws sqs receive-message --queue-url \$(aws sqs get-queue-url --queue-name cloudclips-processing-dlq --query QueueUrl --output text)"
  echo "    - S3 outputs:   aws s3 ls s3://cloudclips-processed-${ACCOUNT_ID}/videos/${VIDEO_ID}/"
  exit 1
fi
