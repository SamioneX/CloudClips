/**
 * Video processing status — represents the lifecycle of a video in the system.
 *
 * Flow: UPLOADING → PROCESSING → MODERATING → PUBLISHED | QUARANTINED
 */
export enum VideoStatus {
  /** User has requested an upload URL but file may not be uploaded yet */
  UPLOADING = 'UPLOADING',
  /** Video is being transcoded by MediaConvert */
  PROCESSING = 'PROCESSING',
  /** Transcoding complete, AI moderation in progress */
  MODERATING = 'MODERATING',
  /** Passed moderation — visible to all users */
  PUBLISHED = 'PUBLISHED',
  /** Failed moderation — flagged for manual review */
  QUARANTINED = 'QUARANTINED',
}

/**
 * Processing pipeline event types published to SNS.
 */
export enum ProcessingEvent {
  TRANSCODE_COMPLETE = 'TRANSCODE_COMPLETE',
  MODERATION_COMPLETE = 'MODERATION_COMPLETE',
  VIDEO_PUBLISHED = 'VIDEO_PUBLISHED',
  VIDEO_QUARANTINED = 'VIDEO_QUARANTINED',
}

/**
 * Video metadata stored in DynamoDB.
 */
export interface VideoRecord {
  videoId: string;
  userId: string;
  status: VideoStatus;
  title: string;
  description?: string;

  /** S3 key for the original uploaded file */
  uploadKey: string;

  /** S3 keys for transcoded outputs, keyed by resolution */
  processedKeys?: Record<string, string>;

  /** S3 key for the VTT caption file */
  captionKey?: string;

  /** Rekognition moderation labels and confidence scores */
  moderationLabels?: ModerationLabel[];

  /** View count */
  viewCount: number;

  /** ISO 8601 timestamps */
  createdAt: string;
  updatedAt: string;
}

export interface ModerationLabel {
  name: string;
  parentName?: string;
  confidence: number;
}

/**
 * Payload for SNS processing events.
 */
export interface ProcessingEventPayload {
  eventType: ProcessingEvent;
  videoId: string;
  userId: string;
  timestamp: string;
  metadata?: Record<string, string>;
}

/**
 * Request body for POST /uploads
 */
export interface CreateUploadRequest {
  title: string;
  description?: string;
  contentType: string;
  fileExtension: string;
}

/**
 * Response for POST /uploads
 */
export interface CreateUploadResponse {
  videoId: string;
  uploadUrl: string;
  expiresIn: number;
}
