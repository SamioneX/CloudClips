import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambdaEvents from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

interface ProcessingStackProps extends cdk.StackProps {
  uploadBucket: s3.IBucket;
  processedBucket: s3.IBucket;
  videosTable: dynamodb.ITable;
  processingTopic: sns.ITopic;
}

export class ProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);

    // Dead letter queue for failed processing
    const dlq = new sqs.Queue(this, 'ProcessingDLQ', {
      queueName: 'cloudclips-processing-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // Main processing queue
    const processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: 'cloudclips-processing',
      visibilityTimeout: cdk.Duration.minutes(15),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // IAM role for MediaConvert
    const mediaConvertRole = new iam.Role(this, 'MediaConvertRole', {
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
    });
    props.uploadBucket.grantRead(mediaConvertRole);
    props.processedBucket.grantWrite(mediaConvertRole);

    // Lambda: S3 upload trigger → enqueue for processing
    const processUploadFn = new NodejsFunction(this, 'ProcessUploadFn', {
      functionName: 'cloudclips-process-upload',
      entry: path.join(__dirname, '../../../backend/src/functions/process-upload/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        QUEUE_URL: processingQueue.queueUrl,
        VIDEOS_TABLE: props.videosTable.tableName,
      },
    });
    processingQueue.grantSendMessages(processUploadFn);
    props.videosTable.grantWriteData(processUploadFn);

    // EventBridge rule: S3 ObjectCreated → process-upload Lambda
    // (Using EventBridge avoids circular dependency between Storage and Processing stacks)
    new events.Rule(this, 'UploadEventRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.uploadBucket.bucketName] },
          object: { key: [{ suffix: '.mp4' }] },
        },
      },
      targets: [new eventsTargets.LambdaFunction(processUploadFn)],
    });

    // Lambda: SQS consumer → start MediaConvert job
    const transcodeFn = new NodejsFunction(this, 'TranscodeFn', {
      functionName: 'cloudclips-transcode',
      entry: path.join(__dirname, '../../../backend/src/functions/transcode/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      environment: {
        PROCESSED_BUCKET: props.processedBucket.bucketName,
        VIDEOS_TABLE: props.videosTable.tableName,
        MEDIA_CONVERT_ROLE_ARN: mediaConvertRole.roleArn,
        PROCESSING_TOPIC_ARN: props.processingTopic.topicArn,
      },
    });
    transcodeFn.addEventSource(
      new lambdaEvents.SqsEventSource(processingQueue, { batchSize: 1 }),
    );
    props.uploadBucket.grantRead(transcodeFn);
    props.videosTable.grantReadWriteData(transcodeFn);
    props.processingTopic.grantPublish(transcodeFn);

    // Grant MediaConvert permissions to transcode Lambda
    transcodeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['mediaconvert:CreateJob', 'mediaconvert:DescribeEndpoints'],
        resources: ['*'],
      }),
    );
    transcodeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [mediaConvertRole.roleArn],
      }),
    );
  }
}
