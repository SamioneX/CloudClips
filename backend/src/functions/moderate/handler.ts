import type { SNSEvent } from 'aws-lambda';
import { RekognitionClient, StartContentModerationCommand } from '@aws-sdk/client-rekognition';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import type { ProcessingEventPayload } from '../../shared/types';

const rekognition = new RekognitionClient({});
const REKOGNITION_ROLE_ARN = process.env.REKOGNITION_ROLE_ARN!;
const REKOGNITION_CALLBACK_TOPIC_ARN = process.env.REKOGNITION_CALLBACK_TOPIC_ARN!;

/**
 * Triggered by SNS TRANSCODE_COMPLETE event.
 * Starts Rekognition content moderation on the transcoded video.
 */
export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const payload = JSON.parse(record.Sns.Message) as ProcessingEventPayload;
    console.log(`Starting moderation for video ${payload.videoId}`);

    const uploadKey = payload.metadata?.uploadKey;
    if (!uploadKey) {
      console.error(`No uploadKey in event payload for video ${payload.videoId}`);
      continue;
    }

    // Extract bucket from the upload key context
    // The video in the upload bucket is used for Rekognition (original quality)
    const bucketName = process.env.UPLOAD_BUCKET ?? `cloudclips-uploads-${process.env.AWS_ACCOUNT_ID}`;

    const response = await rekognition.send(
      new StartContentModerationCommand({
        Video: {
          S3Object: {
            Bucket: bucketName,
            Name: uploadKey,
          },
        },
        MinConfidence: 50,
        NotificationChannel: {
          SNSTopicArn: REKOGNITION_CALLBACK_TOPIC_ARN,
          RoleArn: REKOGNITION_ROLE_ARN,
        },
        JobTag: payload.videoId,
      }),
    );

    console.log(
      `Rekognition job started for video ${payload.videoId}: ${response.JobId}`,
    );

    // Store the Rekognition job ID in the video record
    await docClient.send(
      new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { videoId: payload.videoId },
        UpdateExpression: 'SET rekognitionJobId = :jobId, updatedAt = :now',
        ExpressionAttributeValues: {
          ':jobId': response.JobId,
          ':now': new Date().toISOString(),
        },
      }),
    );
  }
}
