import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const smClient = new SecretsManagerClient({});

const ZONE_NAME = 'sokech.com';
const RECORD_NAME = 'cloudclips.sokech.com';

interface CfApiResponse {
  success: boolean;
  result: Array<Record<string, unknown>>;
  errors: Array<{ message: string }>;
}

async function cfFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfApiResponse> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json()) as CfApiResponse;
  if (!data.success) {
    throw new Error(`Cloudflare API error: ${data.errors.map((e) => e.message).join(', ')}`);
  }
  return data;
}

/**
 * CDK Custom Resource handler — upserts a Cloudflare CNAME record pointing
 * cloudclips.sokech.com → the CloudFront frontend distribution domain.
 *
 * Triggered on every deploy (DeployTime property changes each synth).
 * Delete is a no-op to avoid breaking live traffic.
 */
export async function handler(event: CloudFormationCustomResourceEvent) {
  const physicalResourceId = `cloudflare-dns-${RECORD_NAME}`;

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }

  const { DistributionDomainName } = event.ResourceProperties as unknown as {
    DistributionDomainName: string;
  };

  const { SecretString: token } = await smClient.send(
    new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME! }),
  );
  if (!token) throw new Error('Cloudflare API token is empty in Secrets Manager');

  // Resolve Cloudflare zone ID
  const zonesData = await cfFetch(token, 'GET', `/zones?name=${ZONE_NAME}`);
  if (!zonesData.result.length) throw new Error(`Zone "${ZONE_NAME}" not found in Cloudflare`);
  const zoneId = zonesData.result[0].id as string;

  // Upsert the CNAME: cloudclips.sokech.com → CloudFront domain
  const existing = await cfFetch(
    token,
    'GET',
    `/zones/${zoneId}/dns_records?name=${RECORD_NAME}&type=CNAME`,
  );
  const record = existing.result[0] as { id: string } | undefined;
  const payload = {
    type: 'CNAME',
    name: RECORD_NAME,
    content: DistributionDomainName,
    ttl: 1,
    proxied: false,
  };

  if (record) {
    await cfFetch(token, 'PUT', `/zones/${zoneId}/dns_records/${record.id}`, payload);
  } else {
    await cfFetch(token, 'POST', `/zones/${zoneId}/dns_records`, payload);
  }
  console.log(`Upserted CNAME: ${RECORD_NAME} → ${DistributionDomainName}`);

  return { PhysicalResourceId: physicalResourceId };
}
