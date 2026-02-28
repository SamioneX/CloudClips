import type { SNSEvent } from 'aws-lambda';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
} from '@aws-sdk/client-transcribe';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import type { ProcessingEventPayload } from '../../shared/types';

const transcribe = new TranscribeClient({});
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!;

/**
 * Triggered by SNS TRANSCODE_COMPLETE event.
 * Starts an Amazon Transcribe job to generate auto-captions.
 */
export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const payload = JSON.parse(record.Sns.Message) as ProcessingEventPayload;
    console.log(`Starting transcription for video ${payload.videoId}`);

    const processedPrefix = payload.metadata?.processedPrefix;
    if (!processedPrefix) {
      console.error(`No processedPrefix in event payload for video ${payload.videoId}`);
      continue;
    }

    // Use the 720p version for transcription (best audio quality of transcoded outputs)
    const mediaFileUri = `s3://${PROCESSED_BUCKET}/${processedPrefix}/_720p.mp4`;
    const outputKey = `${processedPrefix}/captions.json`;

    await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: `cloudclips-${payload.videoId}`,
        LanguageCode: 'en-US',
        MediaFormat: 'mp4',
        Media: { MediaFileUri: mediaFileUri },
        OutputBucketName: PROCESSED_BUCKET,
        OutputKey: outputKey,
        Subtitles: {
          Formats: ['vtt'],
          OutputStartIndex: 0,
        },
      }),
    );

    // Store caption key in video record
    await docClient.send(
      new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { videoId: payload.videoId },
        UpdateExpression: 'SET captionKey = :key, updatedAt = :now',
        ExpressionAttributeValues: {
          ':key': `${processedPrefix}/captions.vtt`,
          ':now': new Date().toISOString(),
        },
      }),
    );

    console.log(`Transcription job started for video ${payload.videoId}`);
  }
}
