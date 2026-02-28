import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * CloudClips-Cert
 *
 * Provisions an ACM certificate for cloudclips.sokech.com via a Lambda-backed
 * Custom Resource that:
 *  1. Creates (or reuses) an ACM certificate with DNS validation
 *  2. Adds the ACM validation CNAME to Cloudflare
 *  3. Polls until the certificate is ISSUED
 *
 * Exports `certificateArn` so CdnStack can declare the cert+alias in CDK,
 * ensuring CloudFront distribution updates never lose the configuration.
 *
 * Prerequisite (one-time): run scripts/setup-dns.sh to seed the Cloudflare
 * API token into AWS Secrets Manager before deploying this stack.
 */
export class CertStack extends cdk.Stack {
  /** CDK token resolving to the issued ACM cert ARN (us-east-1). */
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const SECRET_NAME = 'cloudclips/cloudflare-api-token';

    const secret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CloudflareApiToken',
      SECRET_NAME,
    );

    const certFn = new NodejsFunction(this, 'AcmCertFn', {
      functionName: 'cloudclips-acm-cert',
      entry: path.join(__dirname, '../../../backend/src/functions/acm-cert/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(10),
      environment: { SECRET_NAME },
    });

    secret.grantRead(certFn);

    certFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['acm:ListCertificates', 'acm:RequestCertificate', 'acm:DescribeCertificate'],
        resources: ['*'],
      }),
    );

    const provider = new cr.Provider(this, 'AcmCertProvider', {
      onEventHandler: certFn,
    });

    // Properties are stable (domain name doesn't change), so the Lambda only
    // runs on the first deploy (Create) or if the cert is lost (Update triggers
    // a new Create). The PhysicalResourceId is the cert ARN itself.
    const certResource = new cdk.CustomResource(this, 'AcmCertResource', {
      serviceToken: provider.serviceToken,
      properties: {
        Domain: 'cloudclips.sokech.com',
      },
    });

    this.certificateArn = certResource.getAttString('CertificateArn');
  }
}
