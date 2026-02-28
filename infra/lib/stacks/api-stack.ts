import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.IUserPool;
  uploadBucket: s3.IBucket;
  videosTable: dynamodb.ITable;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // REST API
    this.api = new apigateway.RestApi(this, 'CloudClipsApi', {
      restApiName: 'CloudClips API',
      description: 'CloudClips video platform API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // Tighten in production
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [props.userPool],
    });

    const authMethodOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // --- Lambda: Generate presigned upload URL ---
    const presignUploadFn = new NodejsFunction(this, 'PresignUploadFn', {
      functionName: 'cloudclips-presign-upload',
      entry: path.join(__dirname, '../../../backend/src/functions/presign-upload/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      environment: {
        UPLOAD_BUCKET: props.uploadBucket.bucketName,
        VIDEOS_TABLE: props.videosTable.tableName,
      },
    });
    props.uploadBucket.grantPut(presignUploadFn);
    props.videosTable.grantWriteData(presignUploadFn);

    // --- Lambda: Get single video metadata ---
    const getVideoFn = new NodejsFunction(this, 'GetVideoFn', {
      functionName: 'cloudclips-get-video',
      entry: path.join(__dirname, '../../../backend/src/functions/get-video/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      environment: {
        VIDEOS_TABLE: props.videosTable.tableName,
      },
    });
    props.videosTable.grantReadData(getVideoFn);

    // --- Lambda: Record a video view ---
    const recordViewFn = new NodejsFunction(this, 'RecordViewFn', {
      functionName: 'cloudclips-record-view',
      entry: path.join(__dirname, '../../../backend/src/functions/record-view/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      environment: {
        VIDEOS_TABLE: props.videosTable.tableName,
      },
    });
    props.videosTable.grantReadWriteData(recordViewFn);

    // --- Lambda: List/feed videos ---
    const listVideosFn = new NodejsFunction(this, 'ListVideosFn', {
      functionName: 'cloudclips-list-videos',
      entry: path.join(__dirname, '../../../backend/src/functions/list-videos/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      environment: {
        VIDEOS_TABLE: props.videosTable.tableName,
      },
    });
    props.videosTable.grantReadData(listVideosFn);

    // --- API Routes ---

    // POST /uploads → presigned URL
    const uploadsResource = this.api.root.addResource('uploads');
    uploadsResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(presignUploadFn),
      authMethodOptions,
    );

    // GET /videos → list/feed
    const videosResource = this.api.root.addResource('videos');
    videosResource.addMethod('GET', new apigateway.LambdaIntegration(listVideosFn));

    // GET /videos/{videoId} → single video
    const videoResource = videosResource.addResource('{videoId}');
    videoResource.addMethod('GET', new apigateway.LambdaIntegration(getVideoFn));

    // POST /videos/{videoId}/view → increment view count (public)
    const viewResource = videoResource.addResource('view');
    viewResource.addMethod('POST', new apigateway.LambdaIntegration(recordViewFn));

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
  }
}
