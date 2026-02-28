import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { VideoStatus } from '../../shared/types';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL!;

/**
 * EventBridge event shape for S3 Object Created events.
 */
interface S3EventBridgeEvent {
  source: string;
  'detail-type': string;
  detail: {
    bucket: { name: string };
    object: { key: string; size: number };
  };
}

/**
 * Triggered by EventBridge when a new object is created in the upload bucket.
 * Enqueues a processing message and updates video status.
 */
export async function handler(event: S3EventBridgeEvent): Promise<void> {
  const bucket = event.detail.bucket.name;
  const key = decodeURIComponent(event.detail.object.key.replace(/\+/g, ' '));
  const size = event.detail.object.size;

  console.log(`New upload: s3://${bucket}/${key} (${size} bytes)`);

  // Extract videoId from key: uploads/{userId}/{videoId}.{ext}
  const parts = key.split('/');
  const filename = parts[parts.length - 1];
  const videoId = filename.split('.')[0];
  const userId = parts[1];

  // Update video status to PROCESSING
  await docClient.send(
    new UpdateCommand({
      TableName: VIDEOS_TABLE,
      Key: { videoId },
      UpdateExpression: 'SET #status = :status, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': VideoStatus.PROCESSING,
        ':now': new Date().toISOString(),
      },
    }),
  );

  // Enqueue for transcoding
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        videoId,
        userId,
        bucket,
        key,
        size,
      }),
    }),
  );

  console.log(`Enqueued video ${videoId} for processing`);
}
