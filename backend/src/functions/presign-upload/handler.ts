import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { docClient, VIDEOS_TABLE } from '../../shared/dynamo';
import { badRequest, created, serverError } from '../../shared/response';
import { VideoStatus } from '../../shared/types';
import type { CreateUploadRequest, CreateUploadResponse } from '../../shared/types';

const s3 = new S3Client({});
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET!;
const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return badRequest('Missing user identity');
    }

    const body = JSON.parse(event.body ?? '{}') as CreateUploadRequest;
    if (!body.title || !body.contentType) {
      return badRequest('title and contentType are required');
    }

    const videoId = uuidv4();
    const ext = body.fileExtension ?? 'mp4';
    const uploadKey = `uploads/${userId}/${videoId}.${ext}`;

    // Generate presigned PUT URL
    const command = new PutObjectCommand({
      Bucket: UPLOAD_BUCKET,
      Key: uploadKey,
      ContentType: body.contentType,
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });

    // Create initial video record
    const now = new Date().toISOString();
    await docClient.send(
      new PutCommand({
        TableName: VIDEOS_TABLE,
        Item: {
          videoId,
          userId,
          status: VideoStatus.UPLOADING,
          title: body.title,
          description: body.description,
          uploadKey,
          viewCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const response: CreateUploadResponse = {
      videoId,
      uploadUrl,
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    };

    return created(response);
  } catch (err) {
    console.error('presign-upload error:', err);
    return serverError();
  }
}
