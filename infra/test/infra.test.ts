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
