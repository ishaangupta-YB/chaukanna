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
  /**
   * Where Nova 2 Sonic is offered, and so where the agent runtime lives. Not `ap-south-1`: the
   * voice path is in Tokyo because the model is not in Mumbai.
   */
  get voiceRegion(): string {
    return required('VOICE_REGION');
  },
  /** The AgentCore Runtime the browser opens a WebSocket against, from `agentcore deploy`. */
  get agentRuntimeArn(): string {
    return required('AGENT_RUNTIME_ARN');
  },
  /**
   * The ring Lambda an EventBridge schedule invokes when a drill's moment arrives, and the role
   * the scheduler assumes to invoke it. Both are outputs of `ChaukannaStack`.
   *
   * Read lazily, like everything here, so that a developer without them set can still use "ring
   * now" — the demo path that needs no scheduler at all.
   */
  get ringLambdaArn(): string {
    return required('RING_LAMBDA_ARN');
  },
  get schedulerInvokeRoleArn(): string {
    return required('SCHEDULER_INVOKE_ROLE_ARN');
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
  /**
   * Judge demo mode: a deliberate authentication bypass, for hackathon judging only.
   *
   * Exactly the string "on" turns it on, so a stray "true", "1" or "yes" leaves it off. When it
   * is off, `/api/demo/*` answers 404 and a demo cookie is ignored completely — a cookie that
   * leaks out of a demo deployment must be inert everywhere else, including on the deployment
   * real families use.
   */
  get demoMode(): boolean {
    return process.env.DEMO_MODE === 'on';
  },
};
