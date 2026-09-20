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

  // ---- Phase 5, scoring and debrief -------------------------------------------------------

  test('the guardrail catches Aadhaar and PAN with regexes, because Bedrock has no entity for them', () => {
    // The safety property of this phase. Bedrock Guardrails' PII enum has no India-specific
    // types at all, so an Aadhaar or a PAN read aloud during a drill reaches the redacted
    // transcript unless these three patterns exist. If this test goes red the product stores
    // exactly the identifiers it exists to protect.
    const guardrail = Object.values(synth().findResources('AWS::Bedrock::Guardrail'))[0];
    const policy = guardrail.Properties.SensitiveInformationPolicyConfig;
    const regexes: { Name: string; Pattern: string; Action: string; Description: string }[] =
      policy.RegexesConfig;
    const byName = Object.fromEntries(regexes.map((r) => [r.Name, r]));

    expect(Object.keys(byName).sort()).toEqual(['aadhaar', 'long-digit-run', 'pan']);
    for (const regex of regexes) {
      expect(regex.Action).toBe('ANONYMIZE');
      expect(regex.Description.length).toBeGreaterThan(0);
    }
    // Twelve digits, optionally grouped. Aadhaar never starts with 0 or 1.
    expect(new RegExp(byName.aadhaar.Pattern).test('4321 8765 1234')).toBe(true);
    // Five letters, four digits, a letter.
    expect(new RegExp(byName.pan.Pattern).test('ABCDE1234F')).toBe(true);
    // The same six digit threshold the agent's transport tripwire uses, applied again at rest.
    expect(new RegExp(byName['long-digit-run'].Pattern).test('483920')).toBe(true);
    expect(new RegExp(byName['long-digit-run'].Pattern).test('48392')).toBe(false);
  });

  test('the guardrail masks the identifiers a digital arrest script asks for', () => {
    const guardrail = Object.values(synth().findResources('AWS::Bedrock::Guardrail'))[0];
    const entities: { Type: string; Action: string }[] =
      guardrail.Properties.SensitiveInformationPolicyConfig.PiiEntitiesConfig;
    const types = entities.map((e) => e.Type);
    for (const expected of [
      'CREDIT_DEBIT_CARD_NUMBER',
      'CREDIT_DEBIT_CARD_CVV',
      'CREDIT_DEBIT_CARD_EXPIRY',
      'PIN',
      'PASSWORD',
      'EMAIL',
      'PHONE',
      'ADDRESS',
      'NAME',
      'INTERNATIONAL_BANK_ACCOUNT_NUMBER',
      'US_BANK_ACCOUNT_NUMBER',
      'SWIFT_CODE',
    ]) {
      expect(types).toContain(expected);
    }
    for (const entity of entities) expect(entity.Action).toBe('ANONYMIZE');
    // No India-specific type exists in the enum; naming one is rejected at deploy time.
    expect(types.some((t) => t.startsWith('IN_'))).toBe(false);
    expect(guardrail.Properties.Name).toBe('chaukanna-drill-redaction');
    expect(guardrail.Properties.BlockedInputMessaging).toBeDefined();
    expect(guardrail.Properties.BlockedOutputsMessaging).toBeDefined();
  });

  test('the guardrail version the lambdas are given is DRAFT, which is always what is deployed', () => {
    const template = synth();
    expect(template.findOutputs('GuardrailVersion').GuardrailVersion.Value).toBe('DRAFT');
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'chaukanna-scoring-redact',
      Environment: { Variables: Match.objectLike({ GUARDRAIL_VERSION: 'DRAFT' }) },
    });
  });

  test('all five scoring tasks exist on python 3.12, arm, from one source asset', () => {
    const template = synth();
    const expected: Record<string, string> = {
      'chaukanna-scoring-redact': 'scoring_service.handlers.redact_handler',
      'chaukanna-scoring-judge': 'scoring_service.handlers.judge_handler',
      'chaukanna-scoring-score': 'scoring_service.handlers.score_handler',
      'chaukanna-scoring-debrief': 'scoring_service.handlers.debrief_handler',
      'chaukanna-scoring-finish': 'scoring_service.handlers.finish_handler',
    };
    const keys = new Set<string>();
    for (const [name, handler] of Object.entries(expected)) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: name,
        Runtime: 'python3.12',
        Architectures: ['arm64'],
        Handler: handler,
        MemorySize: 512,
      });
    }
    // One asset, five functions: same source tree and same exclusions, so CDK hashes it once.
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      if (String(fn.Properties.FunctionName).startsWith('chaukanna-scoring-')) {
        keys.add(fn.Properties.Code.S3Key);
      }
    }
    expect(keys.size).toBe(1);
  });

  test('every scoring task knows the table, the bucket, the model and the voice', () => {
    const template = synth();
    for (const name of ['chaukanna-scoring-redact', 'chaukanna-scoring-finish']) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: name,
        Environment: {
          Variables: Match.objectLike({
            DATA_REGION: Match.anyValue(),
            TABLE_NAME: Match.anyValue(),
            ARTIFACTS_BUCKET: Match.anyValue(),
            // An inference profile, not a bare model id: on-demand throughput is not supported
            // for this family and the bare id fails at runtime, not at deploy.
            JUDGE_MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
            GUARDRAIL_ID: Match.anyValue(),
            GUARDRAIL_VERSION: 'DRAFT',
            // Polly has no hi-IN voice; Kajal is en-IN with hi-IN as an additional language.
            DEBRIEF_VOICE_ID: 'Kajal',
          }),
        },
      });
    }
  });

  test('redaction reads the raw transcript and writes only the redacted copy', () => {
    const template = synth();
    const apply = statementFor(template, 'bedrock:ApplyGuardrail');
    expect(apply).toBeDefined();
    expect(JSON.stringify(apply!.Resource)).toContain('GuardrailArn');

    const puts = policyStatements(template).filter((s) =>
      JSON.stringify(s.Resource).includes('drill/redacted/*'),
    );
    const putActions = puts.flatMap((s) => ([] as string[]).concat(s.Action));
    expect(putActions).toContain('s3:PutObject');
    // Nothing may write back over the raw transcript, which the agent owns.
    for (const statement of policyStatements(template)) {
      if (([] as string[]).concat(statement.Action).includes('s3:PutObject')) {
        expect(JSON.stringify(statement.Resource)).not.toContain('drill/transcript/');
      }
    }
  });

  test('judge and debrief may invoke the global profile and the model it routes to', () => {
    // A `global.` inference profile can route the call to a model in another region, so a
    // region-pinned foundation-model ARN denies exactly the requests the profile was chosen for.
    const invokes = policyStatements(synth()).filter((s) =>
      ([] as string[]).concat(s.Action).includes('bedrock:InvokeModel'),
    );
    expect(invokes).toHaveLength(2);
    for (const statement of invokes) {
      const resources = JSON.stringify(statement.Resource);
      expect(resources).toContain('inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(resources).toContain('bedrock:*::foundation-model/anthropic.claude-haiku-4-5-*');
    }
  });

  test('the score task has no AWS access at all: it is a pure function', () => {
    // Models classify, code counts. The counting is a function of the judgement it was handed,
    // so there is nothing for it to read and nothing for it to leak.
    const template = synth();
    const scoreRole = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) =>
      id.startsWith('ScoringScoreServiceRole'),
    );
    expect(scoreRole).toBeDefined();
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      const roles = JSON.stringify(policy.Properties.Roles ?? []);
      if (!roles.includes(scoreRole![0])) continue;
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        for (const action of ([] as string[]).concat(statement.Action)) {
          expect(action.startsWith('bedrock:')).toBe(false);
          expect(action.startsWith('s3:')).toBe(false);
          expect(action.startsWith('dynamodb:')).toBe(false);
          expect(action.startsWith('polly:')).toBe(false);
        }
      }
    }
  });

  test('polly is the only wildcard resource added by phase 5', () => {
    const polly = statementFor(synth(), 'polly:SynthesizeSpeech');
    expect(polly).toBeDefined();
    // SynthesizeSpeech has no resource level permissions; AWS requires "*".
    expect(polly!.Resource).toBe('*');
    expect(([] as string[]).concat(polly!.Action)).toEqual(['polly:SynthesizeSpeech']);
  });

  test('the debrief writes audio and the finish task writes rows, each in one place', () => {
    const template = synth();
    const audio = policyStatements(template).find(
      (s) =>
        ([] as string[]).concat(s.Action).includes('s3:PutObject') &&
        JSON.stringify(s.Resource).includes('debrief/*'),
    );
    expect(audio).toBeDefined();

    // Not the compute role, which also writes rows: the finish task's grant is exactly three
    // actions, and the fact that it is exactly three is the thing worth pinning.
    const finish = policyStatements(template).find(
      (s) => ([] as string[]).concat(s.Action).length === 3 &&
        ([] as string[]).concat(s.Action).includes('dynamodb:PutItem') &&
        ([] as string[]).concat(s.Action).includes('dynamodb:UpdateItem'),
    );
    expect(finish).toBeDefined();
    expect(([] as string[]).concat(finish!.Action).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    // The score row lives in the table itself; no index is read by the scoring path.
    expect(JSON.stringify(finish!.Resource)).not.toContain('index/*');
  });

  test('the pipeline is a Standard workflow, traced and logged', () => {
    synth().hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'chaukanna-scoring',
      // Standard on purpose: the runs are rare and short, and the visual execution graph is
      // part of the demo. Express would save money that is not being spent.
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({ Level: 'ERROR' }),
    });
  });

  /** The state machine definition, with the CloudFormation Fn::Join parts flattened out. */
  function definition(template: Template): string {
    const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
    return JSON.stringify(machine.Properties.DefinitionString);
  }

  test('the tasks run in order and merge under the contract result paths', () => {
    const body = definition(synth());
    for (const [state, resultPath] of [
      ['Redact', '$.redaction'],
      ['Judge', '$.judgement'],
      ['Score', '$.score'],
      ['Debrief', '$.debrief'],
    ]) {
      expect(body).toContain(`\\"${state}\\"`);
      expect(body).toContain(`\\"ResultPath\\":\\"${resultPath}\\"`);
    }
    expect(body).toContain('\\"StartAt\\":\\"Redact\\"');
  });

  test('a debrief failure still finishes with the score, a scoring failure does not', () => {
    // Text-to-speech falling over must never throw away a real score: the learner loses the
    // audio and keeps the band. Redact, judge and score failures are a different story.
    const body = definition(synth());
    expect(body).toContain('FinishWithoutDebrief');
    expect(body).toContain('FinishFailed');
    for (const [state, task] of [
      ['RedactFailed', 'redact'],
      ['JudgeFailed', 'judge'],
      ['ScoreFailed', 'score'],
      ['DebriefFailed', 'debrief'],
    ]) {
      expect(body).toContain(state);
      // The Catch writes Step Functions' own {Error, Cause}; the Pass turns it into the
      // {task, reason} shape the one finish handler is written against.
      expect(body).toContain(`\\"task\\":\\"${task}\\"`);
    }
    expect(body).toContain('\\"reason.$\\":\\"$.error.Cause\\"');
    expect(body).toContain('\\"ResultPath\\":\\"$.failure\\"');
  });

  test('transient lambda and bedrock errors are retried with backoff', () => {
    const body = definition(synth());
    for (const error of [
      'Lambda.ServiceException',
      'Lambda.TooManyRequestsException',
      'ThrottlingException',
    ]) {
      expect(body).toContain(error);
    }
    expect(body).toContain('\\"BackoffRate\\":2');
    // CDK's own six-attempt default is switched off; six retries of a stuck Bedrock call is
    // past the PRD's 60 second debrief target before the pipeline has even given up.
    expect(body).not.toContain('\\"MaxAttempts\\":6');
  });

  test('the redacted transcript expires with the raw one it was made from', () => {
    const bucket = Object.values(synth().findResources('AWS::S3::Bucket'))[0];
    const rules: { Prefix: string; ExpirationInDays: number }[] =
      bucket.Properties.LifecycleConfiguration.Rules;
    const byPrefix = Object.fromEntries(rules.map((rule) => [rule.Prefix, rule.ExpirationInDays]));
    expect(byPrefix['drill/redacted/']).toBe(30);
  });

  test('the compute role may read a debrief and never a raw transcript', () => {
    const template = synth();
    const computeRole = Object.entries(template.findResources('AWS::IAM::Role')).find(
      ([, role]) => role.Properties.RoleName === 'chaukanna-amplify-compute-role',
    );
    const computeStatements = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((policy) => JSON.stringify(policy.Properties.Roles ?? []).includes(computeRole![0]))
      .flatMap(
        (policy) => policy.Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[],
      );
    expect(
      computeStatements.some((s) => ([] as string[]).concat(s.Action).includes('s3:GetObject')),
    ).toBe(true);
    const resources = JSON.stringify(computeStatements.map((s) => s.Resource));
    expect(resources).toContain('debrief/*');
    // Presigning the audio is all it gained. The transcript stays out of reach until Phase 6
    // adds the policy that can grant it.
    expect(resources).not.toContain('drill/transcript/');
    expect(resources).not.toContain('drill/redacted/');
  });

  test('phase 5 adds no wildcard action anywhere', () => {
    for (const statement of policyStatements(synth())) {
      for (const action of ([] as string[]).concat(statement.Action)) {
        expect(action).not.toBe('*');
        expect(action.endsWith(':*')).toBe(false);
      }
    }
  });

  test('the outputs tell the agent and the web app what phase 5 created', () => {
    const outputs = synth().findOutputs('*');
    expect(outputs.ScoringStateMachineArn.Export.Name).toBe('ChaukannaScoringStateMachineArn');
    expect(outputs.GuardrailId).toBeDefined();
    expect(outputs.JudgeModelId.Value).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0');
  });
});

/**
 * Every AWS API each runtime role actually calls, against what it is granted.
 *
 * This exists because the stack has now shipped three permission gaps of the same shape, and
 * none of them was visible from the code, from a local run or from a green deploy. A handler
 * calls something its role was never granted; nothing fails at synth, at deploy or at import;
 * and the gap only surfaces on a path nobody had exercised with real data. Two of the three were
 * batch actions mistaken for being implied by their singular form, and the third was a read that
 * looked like a write-only task.
 *
 * So the grants are pinned here, keyed to the call site that needs them. If a handler starts
 * calling something new, this test is where it is supposed to be noticed.
 */
describe('runtime roles cover the calls their handlers make', () => {
  /**
   * The statements of one role's own inline policy, found by the logical id prefix CDK gives it.
   *
   * Scoping to the role is the whole point. "Some statement somewhere grants GetObject on
   * `drill/redacted/`" is true whenever the *judge* is wired up correctly, and would have passed
   * happily while the debrief writer had no read permission at all.
   */
  function statementsForRole(template: Template, rolePrefix: string) {
    return Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith(`${rolePrefix}DefaultPolicy`))
      .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement as {
        Action: string | string[];
        Resource: unknown;
      }[]);
  }

  function roleGrants(template: Template, rolePrefix: string, action: string, needle: string): boolean {
    return statementsForRole(template, rolePrefix).some(
      (statement) =>
        ([] as string[]).concat(statement.Action).includes(action) &&
        JSON.stringify(statement.Resource).includes(needle),
    );
  }

  it('lets the debrief writer read the redacted transcript it quotes', () => {
    // `debrief_handler` calls `_load_redacted(event)` before it writes a word: the turning point
    // it quotes comes from the call. Granting only `s3:PutObject` makes every drill end with a
    // band and silence, and the state machine's DebriefFailed catch hides it as a normal outcome.
    expect(roleGrants(synth(), 'ScoringDebriefServiceRole', 's3:GetObject', 'drill/redacted/')).toBe(true);
    expect(roleGrants(synth(), 'ScoringDebriefServiceRole', 's3:PutObject', 'debrief/')).toBe(true);
  });

  it('lets the judge read the redacted transcript', () => {
    expect(roleGrants(synth(), 'ScoringJudgeServiceRole', 's3:GetObject', 'drill/redacted/')).toBe(true);
  });

  it('keeps everything after redaction away from the raw transcript', () => {
    // `drill/transcript/` is readable by exactly one role, the redactor. Nothing downstream of
    // it may reach the words the learner actually said (CLAUDE.md product rule 2).
    for (const role of ['ScoringJudgeServiceRole', 'ScoringDebriefServiceRole', 'ScoringScoreServiceRole', 'ScoringFinishServiceRole']) {
      expect(roleGrants(synth(), role, 's3:GetObject', 'drill/transcript/')).toBe(false);
    }
    expect(roleGrants(synth(), 'ScoringRedactServiceRole', 's3:GetObject', 'drill/transcript/')).toBe(true);
  });

  it('lets the SSR compute role batch-read scores, which listScores does', () => {
    // BatchGetItem is a separate IAM action and is not implied by GetItem. Without it the
    // guardian dashboard and the audit log throw for any household that has run a drill.
    expect(statementFor(synth(), 'dynamodb:BatchGetItem')).toBeDefined();
    expect(statementFor(synth(), 'dynamodb:GetItem')).toBeDefined();
  });

  it('lets the SSR compute role batch-authorize, which the dashboard does', () => {
    // Likewise: BatchIsAuthorized is not implied by IsAuthorized.
    expect(statementFor(synth(), 'verifiedpermissions:BatchIsAuthorized')).toBeDefined();
    expect(statementFor(synth(), 'verifiedpermissions:IsAuthorized')).toBeDefined();
  });

  it('lets the ring Lambda write its own audit row, and only that', () => {
    /*
     * `write_lifecycle_event` puts a DrillEvent after every `drill.due`, and it sits outside the
     * try/except around the state change — so without PutItem the drill flips to `due`, the
     * Lambda throws, EventBridge retries, and the audit log loses a row per scheduled drill.
     *
     * The grant is scoped by partition key rather than by trust: event rows are `DRILL#<id>`,
     * drill rows are `MEMBER#<id>` and members are `HH#<id>`, so `DRILL#*` permits the audit row
     * and cannot reach a drill, a member or a household.
     */
    const put = statementsForRole(synth(), 'RingLambdaServiceRole').find(
      (statement) => ([] as string[]).concat(statement.Action).includes('dynamodb:PutItem'),
    ) as { Condition?: Record<string, Record<string, unknown>> } | undefined;

    expect(put).toBeDefined();
    expect(put?.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']).toEqual(['DRILL#*']);

    // And still nothing that could remove one.
    for (const statement of statementsForRole(synth(), 'RingLambdaServiceRole')) {
      expect(([] as string[]).concat(statement.Action)).not.toContain('dynamodb:DeleteItem');
    }
  });

  it('still gives the score task no AWS permissions at all', () => {
    // The determinism claim rests on this: the model classifies, code counts, and the counting
    // reads nothing. A grant appearing here means the task grew a dependency it should not have.
    const template = synth();
    const scoreRole = Object.entries(template.findResources('AWS::IAM::Role')).find(([id]) =>
      id.startsWith('ScoringScoreServiceRole'),
    );
    expect(scoreRole).toBeDefined();
    const scorePolicies = Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id]) =>
      id.startsWith('ScoringScoreServiceRoleDefaultPolicy'),
    );
    for (const [, policy] of scorePolicies) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        for (const action of ([] as string[]).concat(statement.Action)) {
          expect(action.startsWith('logs:')).toBe(true);
        }
      }
    }
  });
});
