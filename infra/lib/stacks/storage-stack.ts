import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class StorageStack extends cdk.Stack {
  public readonly uploadBucket: s3.Bucket;
  public readonly processedBucket: s3.Bucket;
  public readonly frontendBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Raw uploads from users (presigned URL target)
    this.uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      bucketName: `cloudclips-uploads-${this.account}`,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'], // Tighten in production
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          // Clean up incomplete uploads after 1 day
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
        {
          // Remove raw uploads after 7 days (already transcoded)
          expiration: cdk.Duration.days(7),
        },
      ],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      eventBridgeEnabled: true, // EventBridge for cross-stack event routing
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Transcoded/processed videos (served via CloudFront)
    this.processedBucket = new s3.Bucket(this, 'ProcessedBucket', {
      bucketName: `cloudclips-processed-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Frontend static assets (served via CloudFront)
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `cloudclips-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Outputs
    new cdk.CfnOutput(this, 'UploadBucketName', { value: this.uploadBucket.bucketName });
    new cdk.CfnOutput(this, 'ProcessedBucketName', { value: this.processedBucket.bucketName });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: this.frontendBucket.bucketName });
  }
}
