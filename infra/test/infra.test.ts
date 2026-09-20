import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ChaukannaStack } from '../lib/chaukanna-stack';

function synth(appUrl?: string, senderEmail?: string): Template {
  const app = new cdk.App();
  const stack = new ChaukannaStack(app, 'TestChaukannaStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
    appUrl,
    senderEmail,
  });
  return Template.fromStack(stack);
}

/** Every statement of every inline policy in the stack, flattened. */
function policyStatements(template: Template): {
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement,
  );
}

/** The one statement granting `action`, or undefined. */
function statementFor(template: Template, action: string) {
  return policyStatements(template).find((statement) =>
    ([] as string[]).concat(statement.Action).includes(action),
  );
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
  test('ring lambda runs the phase 4 handler on python 3.12, arm', () => {
    synth().hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'chaukanna-ring',
      Runtime: 'python3.12',
      Architectures: ['arm64'],
      Handler: 'lifecycle_service.ring.handler',
      Timeout: 30,
      MemorySize: 256,
    });
  });

  test('no function declares AWS_REGION, which Lambda reserves', () => {
    // CloudFormation rejects the whole stack over this one, not just the function.
    const functions = synth().findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      const variables: Record<string, unknown> = fn.Properties.Environment?.Variables ?? {};
      expect(Object.keys(variables)).not.toContain('AWS_REGION');
    }
  });

  test('ring lambda knows the table and where to send the learner', () => {
    synth('https://main.d123.amplifyapp.com/').hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'chaukanna-ring',
      Environment: {
        Variables: Match.objectLike({
          APP_URL: 'https://main.d123.amplifyapp.com',
          SENDER_EMAIL: '',
          DRILL_DUE_MINUTES: '30',
        }),
      },
    });
  });

  test('ring lambda logs to an explicit group, not the deprecated logRetention lambda', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'chaukanna-ring',
      LoggingConfig: Match.objectLike({ LogGroup: Match.anyValue() }),
    });
  });

  test('ring lambda may move a drill forward and never create or delete one', () => {
    const template = synth();
    const ddb = policyStatements(template).filter(
      (statement) =>
        ([] as string[]).concat(statement.Action).includes('dynamodb:UpdateItem') &&
        !([] as string[]).concat(statement.Action).includes('dynamodb:PutItem'),
    );
    expect(ddb).toHaveLength(1);
    expect(([] as string[]).concat(ddb[0].Action).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ]);
    expect(JSON.stringify(ddb[0].Resource)).toContain('index/*');
  });

  test('scheduler may only assume its role for schedules in this account', () => {
    // The confused deputy guard. Without aws:SourceAccount someone else's schedule could name
    // this role and the scheduler service would assume it for them.
    synth().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'chaukanna-scheduler-invoke-role',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Principal: { Service: 'scheduler.amazonaws.com' },
            // `cdk.Aws.ACCOUNT_ID` stays a Ref in the template, resolved by CloudFormation.
            Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
          }),
        ],
      }),
    });
  });

  test('the scheduler role may ring and do nothing else', () => {
    const invoke = statementFor(synth(), 'lambda:InvokeFunction');
    expect(invoke).toBeDefined();
    expect(([] as string[]).concat(invoke!.Action)).toEqual(['lambda:InvokeFunction']);
  });

  test('compute role manages drill schedules only, by name prefix', () => {
    const create = statementFor(synth(), 'scheduler:CreateSchedule');
    expect(create).toBeDefined();
    expect(([] as string[]).concat(create!.Action).sort()).toEqual([
      'scheduler:CreateSchedule',
      'scheduler:DeleteSchedule',
      'scheduler:GetSchedule',
    ]);
    // The name prefix is the whole authorization boundary for this grant.
    expect(JSON.stringify(create!.Resource)).toContain('schedule/default/chaukanna-drill-*');
  });

  test('compute role may pass exactly the scheduler role, to scheduler only', () => {
    // The phase 4 pitfall: CreateSchedule passes a role, so without this the call fails at
    // runtime with an opaque AccessDenied and nothing in the template looks wrong.
    const template = synth();
    const pass = statementFor(template, 'iam:PassRole');
    expect(pass).toBeDefined();
    expect(pass!.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
    });
    const resources = [pass!.Resource].flat();
    expect(resources).toHaveLength(1);
    const schedulerRole = Object.entries(template.findResources('AWS::IAM::Role')).find(
      ([, role]) => role.Properties.RoleName === 'chaukanna-scheduler-invoke-role',
    );
    expect(JSON.stringify(resources[0])).toContain(schedulerRole![0]);
  });

  test('no ses identity and no send rights until a sender is configured', () => {
    const template = synth();
    template.resourceCountIs('AWS::SES::EmailIdentity', 0);
    expect(statementFor(template, 'ses:SendEmail')).toBeUndefined();
  });

  test('a configured sender is verified and is the only address the ring may send as', () => {
    const template = synth(undefined, 'drills@example.com');
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'drills@example.com',
    });
    const send = statementFor(template, 'ses:SendEmail');
    expect(send).toBeDefined();
    expect(send!.Condition).toEqual({ StringEquals: { 'ses:FromAddress': 'drills@example.com' } });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'chaukanna-ring',
      Environment: { Variables: Match.objectLike({ SENDER_EMAIL: 'drills@example.com' }) },
    });
  });

  test('the lifecycle grants carry no wildcard action either', () => {
    // Same guard as above, run over the stack that also has a sender configured.
    for (const statement of policyStatements(synth(undefined, 'drills@example.com'))) {
      for (const action of ([] as string[]).concat(statement.Action)) {
        expect(action).not.toBe('*');
        expect(action.endsWith(':*')).toBe(false);
      }
    }
  });

  test('the web app is told where to find the ring lambda and the role to pass', () => {
    const outputs = synth().findOutputs('*');
    expect(outputs.RingLambdaArn.Export.Name).toBe('ChaukannaRingLambdaArn');
    expect(outputs.RingLambdaArn.Description).toContain('RING_LAMBDA_ARN');
    expect(outputs.SchedulerInvokeRoleArn.Export.Name).toBe('ChaukannaSchedulerInvokeRoleArn');
    expect(outputs.SchedulerInvokeRoleArn.Description).toContain('SCHEDULER_INVOKE_ROLE_ARN');
  });
});
