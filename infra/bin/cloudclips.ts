#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/stacks/auth-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { ProcessingStack } from '../lib/stacks/processing-stack';
import { ModerationStack } from '../lib/stacks/moderation-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { CdnStack } from '../lib/stacks/cdn-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const prefix = 'CloudClips';

// Foundation stacks (no cross-stack dependencies)
const authStack = new AuthStack(app, `${prefix}-Auth`, { env });
const storageStack = new StorageStack(app, `${prefix}-Storage`, { env });
const databaseStack = new DatabaseStack(app, `${prefix}-Database`, { env });

// Notification stack (depends on nothing yet, but others depend on it)
const notificationStack = new NotificationStack(app, `${prefix}-Notification`, {
  env,
});

// Processing pipeline (depends on storage, database, notification)
new ProcessingStack(app, `${prefix}-Processing`, {
  env,
  uploadBucket: storageStack.uploadBucket,
  processedBucket: storageStack.processedBucket,
  videosTable: databaseStack.videosTable,
  processingTopic: notificationStack.processingTopic,
});

// AI moderation (depends on storage, database, notification)
new ModerationStack(app, `${prefix}-Moderation`, {
  env,
  processedBucket: storageStack.processedBucket,
  uploadBucket: storageStack.uploadBucket,
  videosTable: databaseStack.videosTable,
  processingTopic: notificationStack.processingTopic,
});

// API layer (depends on auth, storage, database)
new ApiStack(app, `${prefix}-Api`, {
  env,
  userPool: authStack.userPool,
  uploadBucket: storageStack.uploadBucket,
  videosTable: databaseStack.videosTable,
});

// CDN (uses bucket ARNs to avoid circular cross-stack references)
new CdnStack(app, `${prefix}-Cdn`, {
  env,
  processedBucketArn: storageStack.processedBucket.bucketArn,
  frontendBucketArn: storageStack.frontendBucket.bucketArn,
});

app.synth();
