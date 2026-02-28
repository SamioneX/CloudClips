import type { SNSEvent } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { ProcessingEvent } from '../../shared/types';
import type { ProcessingEventPayload, VideoRecord } from '../../shared/types';

/**
 * Triggered by SNS VIDEO_PUBLISHED events.
 * Sends an email notification to the user via SES.
 *
 * TODO: Implement SES email sending once email identity is verified.
 * Will need: @aws-sdk/client-ses (SESClient, SendEmailCommand)
 */
export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const payload = JSON.parse(record.Sns.Message) as ProcessingEventPayload;

    if (payload.eventType !== ProcessingEvent.VIDEO_PUBLISHED) {
      console.log(`Ignoring event type: ${payload.eventType}`);
      continue;
    }

    console.log(`Sending publish notification for video ${payload.videoId}`);

    // Fetch video record for title and user info
    const result = await docClient.send(
      new GetCommand({
        TableName: VIDEOS_TABLE,
        Key: { videoId: payload.videoId },
      }),
    );

    const video = result.Item as VideoRecord | undefined;
    if (!video) {
      console.error(`Video ${payload.videoId} not found in database`);
      continue;
    }

    // TODO: Look up user email from Cognito using video.userId
    // TODO: Send email via SES
    console.log(
      `Would send email to user ${video.userId}: Your video "${video.title}" is now live!`,
    );
  }
}
