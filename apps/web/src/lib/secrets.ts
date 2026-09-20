import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { config, INVITE_SIGNING_KEY_SECRET_ID } from './config';

let cached: Promise<string> | null = null;

/** Read once per cold start. A failed read is not cached, so the next request retries. */
export function getInviteSigningKey(): Promise<string> {
  if (!cached) {
    const client = new SecretsManagerClient({ region: config.region });
    cached = client
      .send(new GetSecretValueCommand({ SecretId: INVITE_SIGNING_KEY_SECRET_ID }))
      .then((out) => {
        if (!out.SecretString || out.SecretString.length < 32) {
          throw new Error('invite signing key is missing or too short');
        }
        return out.SecretString;
      })
      .catch((error: unknown) => {
        cached = null;
        throw error;
      });
  }
  return cached;
}
