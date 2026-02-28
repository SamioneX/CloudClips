import type { SNSEvent } from 'aws-lambda';
import {
  RekognitionClient,
  GetContentModerationCommand,
} from '@aws-sdk/client-rekognition';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { ProcessingEvent, VideoStatus } from '../../shared/types';
import type { ModerationLabel, ProcessingEventPayload } from '../../shared/types';

const rekognition = new RekognitionClient({});
const sns = new SNSClient({});
const PROCESSING_TOPIC_ARN = process.env.PROCESSING_TOPIC_ARN!;
const CONFIDENCE_THRESHOLD = Number(process.env.MODERATION_CONFIDENCE_THRESHOLD ?? '80');

/**
 * Triggered by Rekognition job completion callback (via SNS).
 * Retrieves moderation results and publishes/quarantines the video.
 */
export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const rekognitionMessage = JSON.parse(record.Sns.Message) as {
      JobId: string;
      Status: string;
      JobTag: string;
    };

    const videoId = rekognitionMessage.JobTag;
    console.log(`Moderation complete for video ${videoId}, status: ${rekognitionMessage.Status}`);

    if (rekognitionMessage.Status !== 'SUCCEEDED') {
      console.error(`Rekognition job failed for video ${videoId}`);
      continue;
    }

    // Get moderation results
    const results = await rekognition.send(
      new GetContentModerationCommand({ JobId: rekognitionMessage.JobId }),
    );

    // Extract labels that exceed confidence threshold
    const flaggedLabels: ModerationLabel[] = [];
    for (const detection of results.ModerationLabels ?? []) {
      const label = detection.ModerationLabel;
      if (label && (label.Confidence ?? 0) >= CONFIDENCE_THRESHOLD) {
        flaggedLabels.push({
          name: label.Name ?? 'Unknown',
          parentName: label.ParentName,
          confidence: label.Confidence ?? 0,
        });
      }
    }

    // Deduplicate labels by name
    const uniqueLabels = Array.from(
      new Map(flaggedLabels.map((l) => [l.name, l])).values(),
    );

    const isFlagged = uniqueLabels.length > 0;
    const newStatus = isFlagged ? VideoStatus.QUARANTINED : VideoStatus.PUBLISHED;

    console.log(
      `Video ${videoId}: ${isFlagged ? 'QUARANTINED' : 'PUBLISHED'} (${uniqueLabels.length} flags)`,
    );

    // Update video record
    await docClient.send(
      new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { videoId },
        UpdateExpression:
          'SET #status = :status, moderationLabels = :labels, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': newStatus,
          ':labels': uniqueLabels,
          ':now': new Date().toISOString(),
        },
      }),
    );

    // Publish outcome event
    const eventType = isFlagged
      ? ProcessingEvent.VIDEO_QUARANTINED
      : ProcessingEvent.VIDEO_PUBLISHED;

    const payload: ProcessingEventPayload = {
      eventType,
      videoId,
      userId: '', // Will be enriched from DB if needed for notification
      timestamp: new Date().toISOString(),
    };

    await sns.send(
      new PublishCommand({
        TopicArn: PROCESSING_TOPIC_ARN,
        Message: JSON.stringify(payload),
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: eventType },
        },
      }),
    );
  }
}
