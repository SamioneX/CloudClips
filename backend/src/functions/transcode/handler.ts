import type { SQSEvent } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { spawn } from 'child_process';
import { createWriteStream, createReadStream } from 'fs';
import { unlink, stat } from 'fs/promises';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { ProcessingEvent, VideoStatus } from '../../shared/types';
import type { ProcessingEventPayload } from '../../shared/types';

const s3 = new S3Client({});
const sns = new SNSClient({});
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!;
const PROCESSING_TOPIC_ARN = process.env.PROCESSING_TOPIC_ARN!;

// FFmpeg binary path — the Lambda layer mounts it at /opt/bin/ffmpeg.
// FFMPEG_PATH env var lets you override this in tests.
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? '/opt/bin/ffmpeg';

/** Spawn ffmpeg with the given args and wait for it to finish. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited ${code}. Last stderr:\n${stderr.slice(-1000)}`));
    });
  });
}

/**
 * SQS consumer: downloads the uploaded video from S3, transcodes it to 720p and
 * 360p using FFmpeg (running inside this Lambda), uploads the results back to S3,
 * updates DynamoDB, then publishes TRANSCODE_COMPLETE to SNS.
 *
 * FFmpeg runs synchronously inside the Lambda invocation, so processedKeys are
 * written to DynamoDB only after the transcoded files are confirmed in S3.
 * This is cleaner than the async MediaConvert approach.
 */
export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const { videoId, userId, bucket, key } = JSON.parse(record.body) as {
      videoId: string;
      userId: string;
      bucket: string;
      key: string;
    };

    console.log(`Transcoding video ${videoId} from s3://${bucket}/${key}`);

    const inputPath = `/tmp/input-${videoId}.mp4`;
    const output720Path = `/tmp/${videoId}-720p.mp4`;
    const output360Path = `/tmp/${videoId}-360p.mp4`;

    try {
      // ── 1. Download from S3 ───────────────────────────────────────────────
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(Body as Readable, createWriteStream(inputPath));
      console.log('Download complete');

      // ── 2. Transcode 720p ──────────────────────────────────────────────────
      // scale=-2:720  → height 720, width rounded to nearest even (preserves aspect ratio)
      // preset fast   → good speed/quality balance
      // crf 23        → constant quality (lower = better; 23 is visually lossless for web)
      // +faststart    → moves moov atom to front of file for HTTP progressive playback
      await runFfmpeg([
        '-i', inputPath,
        '-vf', 'scale=-2:720',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        output720Path, '-y',
      ]);
      console.log('720p transcode complete');

      // ── 3. Transcode 360p ──────────────────────────────────────────────────
      // crf 28 and lower audio bitrate → smaller file for mobile/slow connections
      await runFfmpeg([
        '-i', inputPath,
        '-vf', 'scale=-2:360',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        output360Path, '-y',
      ]);
      console.log('360p transcode complete');

      // ── 4. Upload to S3 ────────────────────────────────────────────────────
      const outputPrefix = `videos/${videoId}`;
      const processedKeys: Record<string, string> = {
        '720p': `${outputPrefix}/_720p.mp4`,
        '360p': `${outputPrefix}/_360p.mp4`,
      };

      await Promise.all([
        s3.send(
          new PutObjectCommand({
            Bucket: PROCESSED_BUCKET,
            Key: processedKeys['720p'],
            Body: createReadStream(output720Path),
            ContentType: 'video/mp4',
            ContentLength: (await stat(output720Path)).size,
          }),
        ),
        s3.send(
          new PutObjectCommand({
            Bucket: PROCESSED_BUCKET,
            Key: processedKeys['360p'],
            Body: createReadStream(output360Path),
            ContentType: 'video/mp4',
            ContentLength: (await stat(output360Path)).size,
          }),
        ),
      ]);
      console.log('Uploads complete');

      // ── 5. Update DynamoDB ─────────────────────────────────────────────────
      await docClient.send(
        new UpdateCommand({
          TableName: VIDEOS_TABLE,
          Key: { videoId },
          UpdateExpression: 'SET #status = :status, processedKeys = :keys, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': VideoStatus.MODERATING,
            ':keys': processedKeys,
            ':now': new Date().toISOString(),
          },
        }),
      );

      // ── 6. Publish TRANSCODE_COMPLETE ──────────────────────────────────────
      // Triggers both the moderation Lambda and the transcription Lambda via
      // SNS message attribute filtering (each subscribes with eventType filter).
      const payload: ProcessingEventPayload = {
        eventType: ProcessingEvent.TRANSCODE_COMPLETE,
        videoId,
        userId,
        timestamp: new Date().toISOString(),
        metadata: { uploadKey: key, processedPrefix: outputPrefix },
      };
      await sns.send(
        new PublishCommand({
          TopicArn: PROCESSING_TOPIC_ARN,
          Message: JSON.stringify(payload),
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: ProcessingEvent.TRANSCODE_COMPLETE },
          },
        }),
      );

      console.log(`Transcode complete for video ${videoId}`);
    } finally {
      // Clean up /tmp — Lambda execution environments are reused; always remove temp files
      await Promise.all(
        [inputPath, output720Path, output360Path].map((p) => unlink(p).catch(() => {})),
      );
    }
  }
}
