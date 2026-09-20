import { describe, expect, it } from 'vitest';
import { encodeRfc3986, presignQueryUrl } from './aws-sigv4';

/**
 * The expected URLs below were produced by botocore's own `SigV4QueryAuth` at a fixed signing
 * time, with the published example credentials. If this file ever disagrees with botocore, the
 * symptom in production is a 403 on the WebSocket handshake with nothing useful in the message,
 * so it is worth pinning byte for byte.
 *
 * Regenerate with (from apps/agent, so botocore is on the path):
 *
 *     uv run python -c "
 *     import datetime; from unittest import mock; import botocore.auth as auth
 *     from botocore.awsrequest import AWSRequest; from botocore.credentials import ReadOnlyCredentials
 *     ...  # see docs/phases/PHASE_3_AGENT_IN_BROWSER.md notes in the handoff
 *     "
 */

const ARN = 'arn:aws:bedrock-agentcore:ap-northeast-1:123456789012:runtime/chaukanna_drill-AbCdEf';
const HOST = 'bedrock-agentcore.ap-northeast-1.amazonaws.com';
const URL_TO_SIGN =
  `https://${HOST}/runtimes/${encodeURIComponent(ARN)}/ws` +
  '?X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=drill-abc-0123456789abcdef0123456789';

const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const AT = new Date('2026-09-20T11:30:00Z');

const base = {
  url: URL_TO_SIGN,
  service: 'bedrock-agentcore',
  region: 'ap-northeast-1',
  expiresIn: 300,
  now: AT,
};

const WITH_SESSION_TOKEN =
  `https://${HOST}/runtimes/${encodeURIComponent(ARN)}/ws` +
  '?X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=drill-abc-0123456789abcdef0123456789' +
  '&X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=AKIDEXAMPLE%2F20260920%2Fap-northeast-1%2Fbedrock-agentcore%2Faws4_request' +
  '&X-Amz-Date=20260920T113000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host' +
  '&X-Amz-Security-Token=SESSIONTOKENEXAMPLE' +
  '&X-Amz-Signature=197988872d08eddcd4d70419e4e5f7590ccd7a08f86a36c26dea9d1c745024c2';

const WITHOUT_SESSION_TOKEN =
  `https://${HOST}/runtimes/${encodeURIComponent(ARN)}/ws` +
  '?X-Amzn-Bedrock-AgentCore-Runtime-Session-Id=drill-abc-0123456789abcdef0123456789' +
  '&X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=AKIDEXAMPLE%2F20260920%2Fap-northeast-1%2Fbedrock-agentcore%2Faws4_request' +
  '&X-Amz-Date=20260920T113000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=5903be8aaeca06f540d4ec1a4e99dbbf7b6f080c6040119bf43948b573572dd9';

describe('presignQueryUrl', () => {
  it('matches botocore for temporary credentials', () => {
    // The compute role always hands us temporary credentials, so this is the real case.
    const signed = presignQueryUrl({
      ...base,
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: SECRET,
        sessionToken: 'SESSIONTOKENEXAMPLE',
      },
    });
    expect(signed).toBe(WITH_SESSION_TOKEN);
  });

  it('matches botocore for long lived credentials', () => {
    const signed = presignQueryUrl({
      ...base,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET },
    });
    expect(signed).toBe(WITHOUT_SESSION_TOKEN);
  });

  it('keeps the encoded ARN in the path untouched', () => {
    // Re-encoding the path is the classic SigV4 mistake and it fails as an opaque 403.
    const signed = presignQueryUrl({ ...base, credentials: { accessKeyId: 'A', secretAccessKey: SECRET } });
    expect(signed).toContain(`/runtimes/${encodeURIComponent(ARN)}/ws`);
    expect(signed).not.toContain('%253A');
  });

  it('signs the parameters that were already on the URL', () => {
    const withoutSession = presignQueryUrl({
      ...base,
      url: `https://${HOST}/runtimes/${encodeURIComponent(ARN)}/ws`,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET },
    });
    // Same credentials and time, different query: the signature must differ.
    expect(withoutSession).not.toContain('5903be8aaeca06f540d4ec1a4e99dbbf7b6f080c6040119bf43948b573572dd9');
  });

  it('changes the signature when the expiry changes', () => {
    const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET };
    expect(presignQueryUrl({ ...base, credentials, expiresIn: 60 })).not.toBe(
      presignQueryUrl({ ...base, credentials, expiresIn: 300 }),
    );
  });
});

describe('encodeRfc3986', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(encodeRfc3986("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('leaves unreserved characters alone', () => {
    expect(encodeRfc3986('aZ0-_.~')).toBe('aZ0-_.~');
  });

  it('encodes the slashes inside an ARN', () => {
    expect(encodeRfc3986('a/b:c')).toBe('a%2Fb%3Ac');
  });
});
