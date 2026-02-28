import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

interface ModerationStackProps extends cdk.StackProps {
  processedBucket: s3.IBucket;
  uploadBucket: s3.IBucket;
  videosTable: dynamodb.ITable;
  processingTopic: sns.ITopic;
}

export class ModerationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ModerationStackProps) {
    super(scope, id, props);

    // IAM role for Rekognition to access S3 videos
    const rekognitionRole = new iam.Role(this, 'RekognitionRole', {
      assumedBy: new iam.ServicePrincipal('rekognition.amazonaws.com'),
    });
    props.uploadBucket.grantRead(rekognitionRole);
    props.processedBucket.grantRead(rekognitionRole);

    // SNS topic for Rekognition async job completion callbacks
    const rekognitionCallbackTopic = new sns.Topic(this, 'RekognitionCallbackTopic', {
      topicName: 'cloudclips-rekognition-callback',
    });

    // Lambda: Start Rekognition content moderation (triggered by processing topic)
    const moderateFn = new NodejsFunction(this, 'ModerateFn', {
      functionName: 'cloudclips-moderate',
      entry: path.join(__dirname, '../../../backend/src/functions/moderate/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(1),
      environment: {
        VIDEOS_TABLE: props.videosTable.tableName,
        REKOGNITION_ROLE_ARN: rekognitionRole.roleArn,
        REKOGNITION_CALLBACK_TOPIC_ARN: rekognitionCallbackTopic.topicArn,
      },
    });
    props.videosTable.grantReadWriteData(moderateFn);
    moderateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:StartContentModerationDetection'],
        resources: ['*'],
      }),
    );
    moderateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [rekognitionRole.roleArn],
      }),
    );

    // Subscribe moderate Lambda to processing events (TRANSCODE_COMPLETE)
    props.processingTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(moderateFn, {
        filterPolicy: {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ['TRANSCODE_COMPLETE'],
          }),
        },
      }),
    );

    // Lambda: Handle Rekognition completion callback
    const moderationCompleteFn = new NodejsFunction(this, 'ModerationCompleteFn', {
      functionName: 'cloudclips-moderation-complete',
      entry: path.join(
        __dirname,
        '../../../backend/src/functions/moderation-complete/handler.ts',
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(1),
      environment: {
        VIDEOS_TABLE: props.videosTable.tableName,
        PROCESSING_TOPIC_ARN: props.processingTopic.topicArn,
        MODERATION_CONFIDENCE_THRESHOLD: '80',
      },
    });
    props.videosTable.grantReadWriteData(moderationCompleteFn);
    props.processingTopic.grantPublish(moderationCompleteFn);
    moderationCompleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:GetContentModerationDetection'],
        resources: ['*'],
      }),
    );

    // Subscribe moderation-complete Lambda to Rekognition callback topic
    rekognitionCallbackTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(moderationCompleteFn),
    );

    // Lambda: Transcribe audio for auto-captions
    const transcribeFn = new NodejsFunction(this, 'TranscribeFn', {
      functionName: 'cloudclips-transcribe',
      entry: path.join(__dirname, '../../../backend/src/functions/transcribe/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(1),
      environment: {
        PROCESSED_BUCKET: props.processedBucket.bucketName,
        VIDEOS_TABLE: props.videosTable.tableName,
      },
    });
    props.processedBucket.grantReadWrite(transcribeFn);
    props.videosTable.grantReadWriteData(transcribeFn);
    transcribeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['transcribe:StartTranscriptionJob', 'transcribe:GetTranscriptionJob'],
        resources: ['*'],
      }),
    );

    // Subscribe transcribe Lambda to processing events (TRANSCODE_COMPLETE)
    props.processingTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(transcribeFn, {
        filterPolicy: {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: ['TRANSCODE_COMPLETE'],
          }),
        },
      }),
    );
  }
}
