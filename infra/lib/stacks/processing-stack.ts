import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
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

    // SQS visibility timeout must be at least 6× the Lambda timeout.
    // With a 15-min Lambda timeout: 6 × 15 = 90 min.
    const processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: 'cloudclips-processing',
      visibilityTimeout: cdk.Duration.minutes(90),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ── FFmpeg Lambda layer ──────────────────────────────────────────────────
    // CDK uses Docker to build this layer during `cdk deploy`.
    // The build.sh script installs ffmpeg-static (npm) inside the container and
    // copies the Linux x86_64 static binary to /asset-output/bin/ffmpeg.
    // The layer then mounts the binary at /opt/bin/ffmpeg inside the Lambda.
    //
    // Note: first deploy downloads ~65 MB from npm; subsequent deploys use
    // CDK's asset cache and skip the download.
    const ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
      code: lambda.Code.fromAsset(
        path.join(__dirname, '../../../backend/layers/ffmpeg'),
        {
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            command: ['bash', '/asset-input/build.sh'],
          },
        },
      ),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      // ARM_64 matches what ffmpeg-static downloads when built on Apple Silicon
      // (the Docker build container is ARM64 by default on M-series Macs).
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Static FFmpeg binary for in-Lambda video transcoding',
    });

    // ── Lambda: S3 upload trigger → enqueue for processing ──────────────────
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

    // ── Lambda: SQS consumer → FFmpeg transcode → S3 upload ─────────────────
    // FFmpeg runs synchronously inside this Lambda (no external transcoding service).
    // Memory and /tmp storage sized for a 5-minute 1080p source video:
    //   - 2 GB memory  → ~2 vCPUs for FFmpeg (faster than default 128 MB)
    //   - 2 GB /tmp    → input + 2 outputs fit comfortably (typical 5-min video < 500 MB)
    //   - 15 min timeout → worst-case 5-min video at low CPU should still finish
    const transcodeFn = new NodejsFunction(this, 'TranscodeFn', {
      functionName: 'cloudclips-transcode',
      entry: path.join(__dirname, '../../../backend/src/functions/transcode/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64, // matches layer binary + cheaper than x86
      memorySize: 2048,
      timeout: cdk.Duration.minutes(15),
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      layers: [ffmpegLayer],
      environment: {
        PROCESSED_BUCKET: props.processedBucket.bucketName,
        VIDEOS_TABLE: props.videosTable.tableName,
        PROCESSING_TOPIC_ARN: props.processingTopic.topicArn,
      },
    });
    transcodeFn.addEventSource(
      new lambdaEvents.SqsEventSource(processingQueue, { batchSize: 1 }),
    );
    props.uploadBucket.grantRead(transcodeFn);        // download uploaded video
    props.processedBucket.grantWrite(transcodeFn);    // upload transcoded outputs
    props.videosTable.grantReadWriteData(transcodeFn);
    props.processingTopic.grantPublish(transcodeFn);
  }
}
