import type { SQSEvent } from 'aws-lambda';
import {
  MediaConvertClient,
  CreateJobCommand,
  DescribeEndpointsCommand,
} from '@aws-sdk/client-mediaconvert';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { ProcessingEvent, VideoStatus } from '../../shared/types';
import type { ProcessingEventPayload } from '../../shared/types';

const sns = new SNSClient({});
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!;
const MEDIA_CONVERT_ROLE_ARN = process.env.MEDIA_CONVERT_ROLE_ARN!;
const PROCESSING_TOPIC_ARN = process.env.PROCESSING_TOPIC_ARN!;

let mediaConvertEndpoint: string | undefined;

async function getMediaConvertEndpoint(): Promise<string> {
  if (mediaConvertEndpoint) return mediaConvertEndpoint;

  const client = new MediaConvertClient({});
  const response = await client.send(new DescribeEndpointsCommand({ MaxResults: 0 }));
  mediaConvertEndpoint = response.Endpoints?.[0]?.Url;

  if (!mediaConvertEndpoint) throw new Error('Could not discover MediaConvert endpoint');
  return mediaConvertEndpoint;
}

/**
 * Consumes from the processing SQS queue.
 * Starts a MediaConvert job to transcode the video into 360p and 720p.
 */
export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as {
      videoId: string;
      userId: string;
      bucket: string;
      key: string;
    };

    console.log(`Transcoding video ${message.videoId}`);

    const endpoint = await getMediaConvertEndpoint();
    const mediaConvert = new MediaConvertClient({ endpoint });

    const outputPrefix = `videos/${message.videoId}`;

    await mediaConvert.send(
      new CreateJobCommand({
        Role: MEDIA_CONVERT_ROLE_ARN,
        Settings: {
          Inputs: [
            {
              FileInput: `s3://${message.bucket}/${message.key}`,
              AudioSelectors: {
                'Audio Selector 1': { DefaultSelection: 'DEFAULT' },
              },
            },
          ],
          OutputGroups: [
            {
              Name: 'File Group',
              OutputGroupSettings: {
                Type: 'FILE_GROUP_SETTINGS',
                FileGroupSettings: {
                  Destination: `s3://${PROCESSED_BUCKET}/${outputPrefix}/`,
                },
              },
              Outputs: [
                {
                  NameModifier: '_720p',
                  ContainerSettings: { Container: 'MP4' },
                  VideoDescription: {
                    Width: 1280,
                    Height: 720,
                    CodecSettings: {
                      Codec: 'H_264',
                      H264Settings: {
                        RateControlMode: 'QVBR',
                        MaxBitrate: 5000000,
                        QvbrSettings: { QvbrQualityLevel: 7 },
                      },
                    },
                  },
                  AudioDescriptions: [
                    {
                      CodecSettings: {
                        Codec: 'AAC',
                        AacSettings: { Bitrate: 128000, CodingMode: 'CODING_MODE_2_0' },
                      },
                    },
                  ],
                },
                {
                  NameModifier: '_360p',
                  ContainerSettings: { Container: 'MP4' },
                  VideoDescription: {
                    Width: 640,
                    Height: 360,
                    CodecSettings: {
                      Codec: 'H_264',
                      H264Settings: {
                        RateControlMode: 'QVBR',
                        MaxBitrate: 1000000,
                        QvbrSettings: { QvbrQualityLevel: 7 },
                      },
                    },
                  },
                  AudioDescriptions: [
                    {
                      CodecSettings: {
                        Codec: 'AAC',
                        AacSettings: { Bitrate: 96000, CodingMode: 'CODING_MODE_2_0' },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        UserMetadata: {
          videoId: message.videoId,
          userId: message.userId,
        },
      }),
    );

    // Update DB with processed keys and status
    const processedKeys = {
      '720p': `${outputPrefix}/_720p.mp4`,
      '360p': `${outputPrefix}/_360p.mp4`,
    };

    await docClient.send(
      new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { videoId: message.videoId },
        UpdateExpression:
          'SET #status = :status, processedKeys = :keys, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': VideoStatus.MODERATING,
          ':keys': processedKeys,
          ':now': new Date().toISOString(),
        },
      }),
    );

    // Publish TRANSCODE_COMPLETE event
    const payload: ProcessingEventPayload = {
      eventType: ProcessingEvent.TRANSCODE_COMPLETE,
      videoId: message.videoId,
      userId: message.userId,
      timestamp: new Date().toISOString(),
      metadata: {
        uploadKey: message.key,
        processedPrefix: outputPrefix,
      },
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

    console.log(`Transcode job submitted for video ${message.videoId}`);
  }
}
