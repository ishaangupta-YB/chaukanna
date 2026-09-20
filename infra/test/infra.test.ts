import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ChaukannaStack } from '../lib/chaukanna-stack';

function synth(appUrl?: string): Template {
  const app = new cdk.App();
  const stack = new ChaukannaStack(app, 'TestChaukannaStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
    appUrl,
  });
  return Template.fromStack(stack);
}

describe('ChaukannaStack', () => {
  test('creates DynamoDB table, S3 bucket, and Cognito User Pool', () => {
    const template = synth();

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'chaukanna',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });

    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    });

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'chaukanna-guardians',
      UsernameAttributes: ['email'],
    });
  });

  test('bucket CORS allows only the app origins, never a wildcard', () => {
    synth('https://main.example.amplifyapp.com/').hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedOrigins: ['http://localhost:3000', 'https://main.example.amplifyapp.com'],
            AllowedHeaders: ['content-type'],
          }),
        ],
      },
    });
  });

  test('user pool client allows localhost only until the app url is known', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'chaukanna-web-client',
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      CallbackURLs: ['http://localhost:3000/api/auth/callback'],
      LogoutURLs: ['http://localhost:3000'],
    });
  });

  test('user pool client adds the deployed app url, trailing slash stripped', () => {
    synth('https://main.d123.amplifyapp.com/').hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: [
        'http://localhost:3000/api/auth/callback',
        'https://main.d123.amplifyapp.com/api/auth/callback',
      ],
      LogoutURLs: ['http://localhost:3000', 'https://main.d123.amplifyapp.com'],
    });
  });

  test('google is the only sign-in route: no native provider, no self sign-up', () => {
    const template = synth();
    // Dropping COGNITO from the client is what removes the password form and the sign-up link
    // from managed login. If this ever reads ['COGNITO', 'Google'] the password path is back.
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      SupportedIdentityProviders: ['Google'],
      ExplicitAuthFlows: Match.absent(),
    });
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  test('google client id and secret are dynamic references, never literals', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderName: 'Google',
      ProviderType: 'Google',
      ProviderDetails: Match.objectLike({
        authorize_scopes: 'openid email profile',
        client_id: Match.stringLikeRegexp('^\\{\\{resolve:secretsmanager:chaukanna/google-oauth:'),
        client_secret: Match.stringLikeRegexp('^\\{\\{resolve:secretsmanager:chaukanna/google-oauth:'),
      }),
    });
  });

  test('the pool only ever holds an email google itself verified', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      AttributeMapping: Match.objectLike({ email: 'email', email_verified: 'email_verified' }),
    });
  });

  test('the client is created after the provider it names', () => {
    const client = Object.values(
      synth().findResources('AWS::Cognito::UserPoolClient'),
    )[0] as { DependsOn?: string[] | string };
    const dependsOn = [client.DependsOn ?? []].flat();
    expect(dependsOn.some((d) => d.includes('Google'))).toBe(true);
  });

  test('uses newer managed login with a branding style', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
    template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', { UseCognitoProvidedValues: true });
  });

  test('invite signing key is generated, never a literal', () => {
    synth().hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'chaukanna/invite-signing-key',
      GenerateSecretString: Match.objectLike({ PasswordLength: 64 }),
      SecretString: Match.absent(),
    });
  });

  test('audio expires in 7 days and the transcript in 30, under their own prefixes', () => {
    // PRD section 8.6. Lifecycle rules are per prefix, so the two cannot share a folder.
    const bucket = Object.values(synth().findResources('AWS::S3::Bucket'))[0];
    const rules: { Prefix: string; ExpirationInDays: number }[] = bucket.Properties.LifecycleConfiguration.Rules;
    const byPrefix = Object.fromEntries(rules.map((rule) => [rule.Prefix, rule.ExpirationInDays]));
    expect(byPrefix['drill/audio/']).toBe(7);
    expect(byPrefix['drill/transcript/']).toBe(30);
    expect(byPrefix['drill/']).toBeUndefined();
  });

  test('compute role may open a drill socket, in the voice region only', () => {
    const template = synth();
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[],
    );
    const socket = statements.find((statement) =>
      ([] as string[])
        .concat(statement.Action)
        .includes('bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream'),
    );
    expect(socket).toBeDefined();
    const resource = JSON.stringify(socket!.Resource);
    expect(resource).toContain('ap-northeast-1');
    expect(resource).toContain('runtime/');
    // Presigning a URL is all it may do: it must not be able to change or delete a runtime.
    for (const statement of statements) {
      for (const action of ([] as string[]).concat(statement.Action)) {
        if (action.startsWith('bedrock-agentcore:')) {
          expect(action).toBe('bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream');
        }
      }
    }
  });

  test('compute role trusts Amplify and has no wildcard actions', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'chaukanna-amplify-compute-role',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: 'amplify.amazonaws.com' } })],
      }),
    });

    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const actions: string[] = [].concat(statement.Action);
        for (const action of actions) {
          expect(action).not.toBe('*');
          expect(action.endsWith(':*')).toBe(false);
        }
      }
    }
  });
});
