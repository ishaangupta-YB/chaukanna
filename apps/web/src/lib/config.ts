/**
 * Runtime configuration. Every value comes from the environment (Amplify env vars written to
 * .env.production at build time, or .env.local in development). Nothing here is a secret:
 * secrets are read from Secrets Manager, see lib/secrets.ts.
 *
 * Values are read lazily so that importing a module never throws at build time.
 */

export class ConfigError extends Error {
  constructor(name: string) {
    super(`missing required environment variable ${name}`);
    this.name = 'ConfigError';
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(name);
  return value;
}

/** Secrets Manager id of the HMAC key for invite links and learner sessions. */
export const INVITE_SIGNING_KEY_SECRET_ID = 'chaukanna/invite-signing-key';

export const config = {
  /** Set by the Amplify SSR runtime (the `AWS_` prefix is reserved there) and by .env.local. */
  get region(): string {
    return required('AWS_REGION');
  },
  get tableName(): string {
    return required('TABLE_NAME');
  },
  get artifactsBucket(): string {
    return required('ARTIFACTS_BUCKET');
  },
  get userPoolId(): string {
    return required('USER_POOL_ID');
  },
  get userPoolClientId(): string {
    return required('USER_POOL_CLIENT_ID');
  },
  /** Managed login host name without scheme, e.g. chaukanna-abc.auth.ap-south-1.amazoncognito.com */
  get cognitoDomain(): string {
    return required('COGNITO_DOMAIN').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  },
  /**
   * Public origin of the app. Required in production so that links and OAuth redirects never
   * depend on a proxied Host header. Falls back to the request origin in development.
   */
  appUrl(requestOrigin?: string): string {
    const fromEnv = process.env.APP_URL?.replace(/\/+$/, '');
    if (fromEnv) return fromEnv;
    if (process.env.NODE_ENV !== 'production' && requestOrigin) return requestOrigin;
    throw new ConfigError('APP_URL');
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
};
