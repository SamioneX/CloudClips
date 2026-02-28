import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  CertificateStatus,
} from '@aws-sdk/client-acm';

const smClient = new SecretsManagerClient({});
const acmClient = new ACMClient({ region: 'us-east-1' });

const ZONE_NAME = 'sokech.com';
const RECORD_NAME = 'cloudclips.sokech.com';

// ── Cloudflare helpers ────────────────────────────────────────────────────────

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

async function upsertCname(
  token: string,
  zoneId: string,
  name: string,
  content: string,
): Promise<void> {
  const cleanName = name.replace(/\.$/, '');
  const cleanContent = content.replace(/\.$/, '');
  const existing = await cfFetch(
    token,
    'GET',
    `/zones/${zoneId}/dns_records?name=${cleanName}&type=CNAME`,
  );
  const record = existing.result[0] as { id: string } | undefined;
  const payload = { type: 'CNAME', name: cleanName, content: cleanContent, ttl: 1, proxied: false };
  if (record) {
    await cfFetch(token, 'PUT', `/zones/${zoneId}/dns_records/${record.id}`, payload);
  } else {
    await cfFetch(token, 'POST', `/zones/${zoneId}/dns_records`, payload);
  }
  console.log(`Upserted CNAME: ${cleanName} → ${cleanContent}`);
}

// ── ACM helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CertInfo {
  certArn: string;
  validationCname?: { name: string; value: string };
}

async function getOrCreateCert(): Promise<CertInfo> {
  // Reuse an existing ISSUED cert
  const issued = await acmClient.send(
    new ListCertificatesCommand({ CertificateStatuses: [CertificateStatus.ISSUED] }),
  );
  const existing = issued.CertificateSummaryList?.find((c) => c.DomainName === RECORD_NAME);
  if (existing?.CertificateArn) {
    console.log(`Reusing existing ISSUED cert: ${existing.CertificateArn}`);
    return { certArn: existing.CertificateArn };
  }

  // Reuse an existing PENDING_VALIDATION cert (avoid duplicates on retries)
  const pending = await acmClient.send(
    new ListCertificatesCommand({ CertificateStatuses: [CertificateStatus.PENDING_VALIDATION] }),
  );
  const pendingCert = pending.CertificateSummaryList?.find((c) => c.DomainName === RECORD_NAME);
  if (pendingCert?.CertificateArn) {
    console.log(`Found PENDING cert: ${pendingCert.CertificateArn}`);
    return extractValidationCname(pendingCert.CertificateArn);
  }

  // Request a new cert
  const { CertificateArn } = await acmClient.send(
    new RequestCertificateCommand({ DomainName: RECORD_NAME, ValidationMethod: 'DNS' }),
  );
  console.log(`Requested new ACM cert: ${CertificateArn}`);
  return extractValidationCname(CertificateArn!);
}

async function extractValidationCname(certArn: string): Promise<CertInfo> {
  for (let i = 0; i < 12; i++) {
    await sleep(5_000);
    const { Certificate } = await acmClient.send(
      new DescribeCertificateCommand({ CertificateArn: certArn }),
    );
    const option = Certificate?.DomainValidationOptions?.find(
      (o) => o.DomainName === RECORD_NAME,
    );
    if (option?.ResourceRecord?.Name && option?.ResourceRecord?.Value) {
      return {
        certArn,
        validationCname: { name: option.ResourceRecord.Name, value: option.ResourceRecord.Value },
      };
    }
  }
  throw new Error('Timed out waiting for ACM validation CNAME to become available');
}

async function waitForCertIssued(certArn: string): Promise<void> {
  console.log('Waiting for ACM cert to be issued...');
  for (let i = 0; i < 30; i++) {
    await sleep(10_000);
    const { Certificate } = await acmClient.send(
      new DescribeCertificateCommand({ CertificateArn: certArn }),
    );
    if (Certificate?.Status === CertificateStatus.ISSUED) {
      console.log('Cert is ISSUED.');
      return;
    }
    if (Certificate?.Status === CertificateStatus.FAILED) {
      throw new Error('ACM cert validation failed');
    }
    console.log(`Cert status: ${Certificate?.Status} (${i + 1}/30)`);
  }
  throw new Error('Timed out waiting for cert to be issued');
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * CDK Custom Resource handler — provisions an ACM certificate for
 * cloudclips.sokech.com and validates it via a Cloudflare DNS CNAME.
 *
 * Returns Data.CertificateArn so the CdnStack can import it as a CDK token.
 * Idempotent: reuses an existing ISSUED cert on every Update.
 */
export async function handler(event: CloudFormationCustomResourceEvent) {
  // On Delete just return — do not delete the cert (it's referenced by CloudFront)
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? `acm-cert-${RECORD_NAME}` };
  }

  const { SecretString: token } = await smClient.send(
    new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME! }),
  );
  if (!token) throw new Error('Cloudflare API token is empty in Secrets Manager');

  // Resolve Cloudflare zone ID
  const zonesData = await cfFetch(token, 'GET', `/zones?name=${ZONE_NAME}`);
  if (!zonesData.result.length) throw new Error(`Zone "${ZONE_NAME}" not found in Cloudflare`);
  const zoneId = zonesData.result[0].id as string;

  // Get or create the ACM cert
  const { certArn, validationCname } = await getOrCreateCert();

  // Add validation CNAME and wait for issuance only when cert is new/pending
  if (validationCname) {
    await upsertCname(token, zoneId, validationCname.name, validationCname.value);
    await waitForCertIssued(certArn);
  }

  return {
    PhysicalResourceId: certArn,
    Data: { CertificateArn: certArn },
  };
}
