import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { badRequest, notFound, serverError, success } from '../../shared/response';
import { VideoStatus } from '../../shared/types';

/**
 * POST /videos/{videoId}/view
 * Atomically increments the view count for a PUBLISHED video.
 * Returns the updated view count.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const videoId = event.pathParameters?.videoId;
    if (!videoId) {
      return badRequest('videoId is required');
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { videoId },
        // Only increment if the video is PUBLISHED
        ConditionExpression: '#status = :published',
        UpdateExpression: 'ADD viewCount :one SET updatedAt = :now',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':published': VideoStatus.PUBLISHED,
          ':one': 1,
          ':now': new Date().toISOString(),
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );

    return success({ viewCount: result.Attributes?.viewCount });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return notFound('Video not found or not published');
    }
    console.error('record-view error:', err);
    return serverError();
  }
}
