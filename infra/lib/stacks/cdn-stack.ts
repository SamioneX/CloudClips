import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

interface CdnStackProps extends cdk.StackProps {
  processedBucketArn: string;
  frontendBucketArn: string;
}

export class CdnStack extends cdk.Stack {
  public readonly videoDistribution: cloudfront.Distribution;
  public readonly frontendDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);

    // Import buckets by ARN to avoid circular cross-stack references
    // (withOriginAccessControl modifies the bucket policy, which creates cycles
    // when the bucket is in a different stack)
    const processedBucket = s3.Bucket.fromBucketArn(
      this,
      'ProcessedBucket',
      props.processedBucketArn,
    );
    const frontendBucket = s3.Bucket.fromBucketArn(
      this,
      'FrontendBucket',
      props.frontendBucketArn,
    );

    // Video CDN — serves transcoded videos from processed bucket
    this.videoDistribution = new cloudfront.Distribution(this, 'VideoDistribution', {
      comment: 'CloudClips - Video CDN',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(processedBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
    });

    // Frontend CDN — serves React SPA from frontend bucket
    this.frontendDistribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: 'CloudClips - Frontend',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'VideoDistributionId', {
      value: this.videoDistribution.distributionId,
      description: 'CloudFront distribution ID for transcoded videos',
    });
    new cdk.CfnOutput(this, 'VideoDistributionUrl', {
      value: `https://${this.videoDistribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'FrontendDistributionId', {
      value: this.frontendDistribution.distributionId,
      description: 'CloudFront distribution ID for the React SPA',
    });
    new cdk.CfnOutput(this, 'FrontendDistributionUrl', {
      value: `https://${this.frontendDistribution.distributionDomainName}`,
    });
  }
}
