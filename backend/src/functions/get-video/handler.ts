import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { badRequest, notFound, serverError, success } from '../../shared/response';
import type { VideoRecord } from '../../shared/types';

/**
 * GET /videos/{videoId}
 * Returns metadata for a single video.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const videoId = event.pathParameters?.videoId;
    if (!videoId) {
      return badRequest('videoId is required');
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: VIDEOS_TABLE,
        Key: { videoId },
      }),
    );

    const video = result.Item as VideoRecord | undefined;
    if (!video) {
      return notFound(`Video ${videoId} not found`);
    }

    return success(video);
  } catch (err) {
    console.error('get-video error:', err);
    return serverError();
  }
}
