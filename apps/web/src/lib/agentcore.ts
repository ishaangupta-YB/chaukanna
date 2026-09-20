import { S3Client } from '@aws-sdk/client-s3';
import { presignQueryUrl, type AwsCredentials } from './aws-sigv4';
import { config } from './config';

/**
 * The `wss://` URL the browser opens against AgentCore Runtime.
 *
 * Why the browser connects to AWS directly rather than through us: a WebSocket cannot be proxied
 * by Amplify SSR, which serves requests and responses and not long lived sockets. AgentCore's own
 * answer to that is a SigV4 presigned URL, since a browser cannot put signed headers on a
 * handshake. So the compute role signs a URL here, it lives five minutes, and it is useless on
 * its own: the drill session token still has to be sent as the first frame, and the agent still
 * has to claim the drill.
 *
 * Shape and header names come from the AgentCore documentation and match what the
 * `bedrock-agentcore` Python SDK builds (`AgentCoreRuntimeClient.generate_presigned_url`).
 */

/** AgentCore rejects a shorter session id. Ours are longer; this is the floor we keep away from. */
export const MIN_SESSION_ID_LENGTH = 33;
/** The maximum AgentCore accepts on a presigned URL. */
export const MAX_PRESIGN_SECONDS = 300;

const SERVICE = 'bedrock-agentcore';
const SESSION_ID_PARAM = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

export function dataPlaneHost(region: string): string {
  return `${SERVICE}.${region}.amazonaws.com`;
}

/**
 * One AgentCore session per drill attempt, so each call gets its own isolated microVM. The random
 * tail means a retried attempt at the same drill does not land on a session that is being torn
 * down, which AgentCore answers with a retryable 409.
 */
export function agentSessionId(drillId: string, nonce: string): string {
  const id = `chaukanna-drill-${drillId}-${nonce}`;
  return id.length >= MIN_SESSION_ID_LENGTH ? id : id.padEnd(MIN_SESSION_ID_LENGTH, '0');
}

export function agentSocketUrl(runtimeArn: string, region: string, sessionId: string): string {
  const url = new URL(`https://${dataPlaneHost(region)}/runtimes/${encodeURIComponent(runtimeArn)}/ws`);
  url.searchParams.set(SESSION_ID_PARAM, sessionId);
  return url.toString();
}

let credentialsClient: S3Client | null = null;

/**
 * The compute role's current credentials, via the SDK's own provider chain.
 *
 * Borrowing a client's resolved `credentials` provider keeps the chain (container role on
 * Amplify, profile locally) without pulling in a credential package of our own.
 */
async function computeRoleCredentials(): Promise<AwsCredentials> {
  if (!credentialsClient) credentialsClient = new S3Client({ region: config.region });
  const resolved = await credentialsClient.config.credentials();
  return {
    accessKeyId: resolved.accessKeyId,
    secretAccessKey: resolved.secretAccessKey,
    sessionToken: resolved.sessionToken,
  };
}

export interface PresignedSocket {
  wsUrl: string;
  sessionId: string;
  expiresAt: string;
}

export async function presignAgentSocket(
  sessionId: string,
  expiresIn: number = MAX_PRESIGN_SECONDS,
  now: Date = new Date(),
): Promise<PresignedSocket> {
  const region = config.voiceRegion;
  const signed = presignQueryUrl({
    url: agentSocketUrl(config.agentRuntimeArn, region, sessionId),
    service: SERVICE,
    region,
    credentials: await computeRoleCredentials(),
    expiresIn: Math.min(expiresIn, MAX_PRESIGN_SECONDS),
    now,
  });
  return {
    wsUrl: signed.replace(/^https:/, 'wss:'),
    sessionId,
    expiresAt: new Date(now.getTime() + Math.min(expiresIn, MAX_PRESIGN_SECONDS) * 1000).toISOString(),
  };
}
