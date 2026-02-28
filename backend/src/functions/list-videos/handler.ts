import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { serverError, success } from '../../shared/response';
import { VideoStatus } from '../../shared/types';

const DEFAULT_LIMIT = 20;

/**
 * GET /videos
 * Returns a paginated list of published videos (feed).
 * Query params: limit, nextToken (for pagination)
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const limit = Math.min(
      Number(event.queryStringParameters?.limit ?? DEFAULT_LIMIT),
      50,
    );
    const nextToken = event.queryStringParameters?.nextToken;

    const result = await docClient.send(
      new QueryCommand({
        TableName: VIDEOS_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': VideoStatus.PUBLISHED },
        ScanIndexForward: false, // newest first
        Limit: limit,
        ExclusiveStartKey: nextToken ? JSON.parse(atob(nextToken)) : undefined,
      }),
    );

    const response = {
      videos: result.Items ?? [],
      nextToken: result.LastEvaluatedKey
        ? btoa(JSON.stringify(result.LastEvaluatedKey))
        : undefined,
    };

    return success(response);
  } catch (err) {
    console.error('list-videos error:', err);
    return serverError();
  }
}
