import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

interface DnsStackProps extends cdk.StackProps {
  /** e.g. dXXXX.cloudfront.net — used as the CNAME target */
  distributionDomainName: string;
}

/**
 * CloudClips-Dns
 *
 * Maintains the Cloudflare CNAME record:
 *   cloudclips.sokech.com → <CloudFront distribution domain>
 *
 * Runs on every `cdk deploy` (DeployTime property changes), so the record
 * is self-healing if it is ever deleted from Cloudflare.
 *
 * ACM cert provisioning and CloudFront configuration are handled separately
 * in CloudClips-Cert and CloudClips-Cdn respectively, so this stack stays
 * simple and never mutates the CloudFront distribution directly.
 */
export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const SECRET_NAME = 'cloudclips/cloudflare-api-token';

    const secret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CloudflareApiToken',
      SECRET_NAME,
    );

    const dnsUpdaterFn = new NodejsFunction(this, 'CloudflareDnsUpdaterFn', {
      functionName: 'cloudclips-cloudflare-dns-updater',
      entry: path.join(
        __dirname,
        '../../../backend/src/functions/cloudflare-dns/handler.ts',
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: { SECRET_NAME },
    });

    secret.grantRead(dnsUpdaterFn);

    const provider = new cr.Provider(this, 'CloudflareDnsProvider', {
      onEventHandler: dnsUpdaterFn,
    });

    new cdk.CustomResource(this, 'CloudflareDnsRecord', {
      serviceToken: provider.serviceToken,
      properties: {
        DistributionDomainName: props.distributionDomainName,
        DeployTime: new Date().toISOString(),
      },
    });

    new cdk.CfnOutput(this, 'CustomDomain', {
      value: 'https://cloudclips.sokech.com',
      description: 'Custom domain for the CloudClips frontend',
    });
  }
}
