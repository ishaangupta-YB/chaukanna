import { createHash, createHmac } from 'node:crypto';

/**
 * Signature Version 4, query string form, for a GET with no body.
 *
 * This exists for one job: handing the browser a `wss://` URL it can open against AgentCore
 * Runtime. A browser cannot set headers on a WebSocket handshake, so the credentials have to
 * travel in the query string, and no AWS SDK client exposes a presigner for that endpoint.
 *
 * It is forty lines of a published algorithm rather than three more dependencies, in the same
 * spirit as `auth.ts` verifying Cognito tokens with `node:crypto`. `aws-sigv4.test.ts` pins the
 * output against a URL produced by botocore's own `SigV4QueryAuth`, so a drift shows up as a
 * failing test rather than as a 403 on a learner's phone.
 *
 * Reference: AWS General Reference, "Signing AWS API requests".
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
/**
 * SHA-256 of the empty string: a presigned GET has no body, and it is hashed rather than declared
 * `UNSIGNED-PAYLOAD`. The constant string is an S3-only rule (botocore uses it in
 * `S3SigV4QueryAuth` and nowhere else); using it here signs a canonical request the service will
 * not reproduce, and the only symptom is a bare 403 on the handshake.
 */
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface PresignInput {
  /** Full https URL including any query parameters that must be signed. */
  url: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  expiresIn: number;
  /** Fixed signing time, for tests. Defaults to now. */
  now?: Date;
}

/**
 * `encodeURIComponent` leaves `!'()*` alone; RFC 3986 and SigV4 do not. Everything that is not
 * unreserved must be percent encoded or the canonical request will not match the service's.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDate(at: Date): string {
  return at.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Sorted by encoded key, then encoded value, exactly as the canonical request requires. */
function canonicalQuery(params: [string, string][]): string {
  return params
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export function presignQueryUrl({ url, service, region, credentials, expiresIn, now }: PresignInput): string {
  const target = new URL(url);
  const at = now ?? new Date();
  const timestamp = amzDate(at);
  const dateStamp = timestamp.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const params: [string, string][] = [...target.searchParams.entries()];
  params.push(['X-Amz-Algorithm', ALGORITHM]);
  params.push(['X-Amz-Credential', `${credentials.accessKeyId}/${scope}`]);
  params.push(['X-Amz-Date', timestamp]);
  params.push(['X-Amz-Expires', String(expiresIn)]);
  params.push(['X-Amz-SignedHeaders', 'host']);
  if (credentials.sessionToken) params.push(['X-Amz-Security-Token', credentials.sessionToken]);

  // The canonical URI is the path encoded a *second* time, segment by segment. The AgentCore
  // path already carries a percent encoded ARN, so `%3A` becomes `%253A` here while the URL we
  // hand the browser keeps the single encoding. Signing the single encoded path is the classic
  // way to get an unexplained 403 out of this endpoint. (S3 is the exception and does not do
  // this, which is where the confusion usually comes from.)
  const canonicalUri = target.pathname.split('/').map(encodeRfc3986).join('/');
  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery(params),
    `host:${target.host}\n`,
    'host',
    EMPTY_BODY_SHA256,
  ].join('\n');

  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  params.push(['X-Amz-Signature', signature]);

  const query = params.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join('&');
  return `${target.origin}${target.pathname}?${query}`;
}
