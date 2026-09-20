import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ChaukannaVoiceStack } from '../lib/chaukanna-voice-stack';

const ACCOUNT = '123456789012';
const IMAGE = `${ACCOUNT}.dkr.ecr.ap-northeast-1.amazonaws.com/chaukanna-drill:abc123`;

function synth(containerUri?: string): Template {
  const app = new cdk.App();
  const stack = new ChaukannaVoiceStack(app, 'TestChaukannaVoiceStack', {
    env: { account: ACCOUNT, region: 'ap-northeast-1' },
    dataRegion: 'ap-south-1',
    tableName: 'chaukanna',
    artifactsBucket: `chaukanna-artifacts-${ACCOUNT}`,
    inviteSigningKeySecretName: 'chaukanna/invite-signing-key',
    scoringStateMachineName: 'chaukanna-scoring',
    containerUri,
  });
  return Template.fromStack(stack);
}

/** Every statement in the stack, flattened, so a policy can be searched by action. */
function statements(template: Template): { Action: string[]; Resource: string[] }[] {
  const all: { Action: string[]; Resource: string[] }[] = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      all.push({
        Action: ([] as string[]).concat(statement.Action),
        Resource: ([] as unknown[]).concat(statement.Resource).map((r) => JSON.stringify(r)),
      });
    }
  }
  return all;
}

function forAction(template: Template, action: string) {
  return statements(template).filter((s) => s.Action.includes(action));
}

describe('ChaukannaVoiceStack', () => {
  test('creates the image repository even before an image exists', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'chaukanna-drill',
      ImageTagMutability: 'IMMUTABLE',
    });
    // A runtime cannot be created without an image, so the first deploy makes only the plumbing.
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
  });

  test('creates the runtime once an image is given', () => {
    synth(IMAGE).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'chaukanna_drill',
      AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: IMAGE } },
      // WebSocket is carried by the HTTP protocol: one container, /invocations, /ws and /ping.
      ProtocolConfiguration: 'HTTP',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
    });
  });

  test('tells the agent where the data lives, which is not where it runs', () => {
    synth(IMAGE).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        DATA_REGION: 'ap-south-1',
        VOICE_REGION: 'ap-northeast-1',
        TABLE_NAME: 'chaukanna',
        SESSION_MAX_SECONDS: '360',
        SAFE_WORD: 'ROKO',
      }),
    });
  });

  test('carries no secret in its environment', () => {
    const runtime = Object.values(synth(IMAGE).findResources('AWS::BedrockAgentCore::Runtime'))[0];
    const env = JSON.stringify(runtime.Properties.EnvironmentVariables);
    for (const forbidden of ['KEY', 'SECRET', 'TOKEN', 'PASSWORD']) {
      expect(env.toUpperCase()).not.toContain(forbidden);
    }
  });

  test('is assumable only by AgentCore, and only for this account', () => {
    synth().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'chaukanna-agent-execution-role',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: Match.objectLike({ StringEquals: { 'aws:SourceAccount': ACCOUNT } }),
          }),
        ],
      }),
    });
  });

  test('can speak to Nova 2 Sonic and to no other model', () => {
    const [statement] = forAction(synth(), 'bedrock:InvokeModelWithBidirectionalStream');
    expect(statement).toBeDefined();
    expect(statement.Resource.join(' ')).toContain('amazon.nova-2-sonic-v1:0');
    expect(statement.Resource.join(' ')).not.toContain('foundation-model/*');
  });

  test('writes only the drill artifacts, never consent recordings', () => {
    const [statement] = forAction(synth(), 's3:PutObject');
    const resources = statement.Resource.join(' ');
    expect(resources).toContain('drill/audio/*');
    expect(resources).toContain('drill/transcript/*');
    expect(resources).not.toContain('consent/');
  });

  test('cannot read what a learner said in an earlier drill', () => {
    // The agent writes the transcript; nothing gives it a reason to read one back.
    expect(forAction(synth(), 's3:GetObject')).toHaveLength(0);
  });

  test('cannot delete a row or a drill', () => {
    const template = synth();
    for (const action of ['dynamodb:DeleteItem', 'dynamodb:Scan', 's3:DeleteObject']) {
      expect(forAction(template, action)).toHaveLength(0);
    }
  });

  test('reads one secret, in the data region', () => {
    const [statement] = forAction(synth(), 'secretsmanager:GetSecretValue');
    expect(statement.Resource.join(' ')).toContain('ap-south-1');
    expect(statement.Resource.join(' ')).toContain('chaukanna/invite-signing-key');
  });

  test('has no wildcard action anywhere', () => {
    for (const statement of statements(synth(IMAGE))) {
      for (const action of statement.Action) {
        expect(action).not.toBe('*');
        expect(action.endsWith(':*')).toBe(false);
      }
    }
  });

  test('only the three actions that have no resource to scope to use a wildcard resource', () => {
    const allowed = new Set([
      'ecr:GetAuthorizationToken',
      'xray:PutTraceSegments',
      'xray:PutTelemetryRecords',
      'cloudwatch:PutMetricData',
    ]);
    for (const statement of statements(synth(IMAGE))) {
      if (statement.Resource.includes('"*"')) {
        for (const action of statement.Action) expect(allowed.has(action)).toBe(true);
      }
    }
  });

  test('may start a scoring run in the data region, and nothing else about one', () => {
    // The agent hands a finished drill to Phase 5 itself, with its own role: no call back into
    // the web app and no shared secret. The state machine is in ap-south-1 with the data, so
    // its ARN is rebuilt here from region, account and name.
    const [statement] = forAction(synth(), 'states:StartExecution');
    expect(statement).toBeDefined();
    expect(statement.Action).toEqual(['states:StartExecution']);
    const resource = statement.Resource.join(' ');
    expect(resource).toContain('ap-south-1');
    expect(resource).toContain('stateMachine:chaukanna-scoring');
    expect(resource).not.toContain('ap-northeast-1');
    // It may begin a run; it may not stop, redrive or read one.
    for (const other of ['states:StopExecution', 'states:DescribeExecution', 'states:RedriveExecution']) {
      expect(forAction(synth(), other)).toHaveLength(0);
    }
  });

  test('the runtime is told which state machine to start', () => {
    const runtime = Object.values(synth(IMAGE).findResources('AWS::BedrockAgentCore::Runtime'))[0];
    // A CloudFormation Fn::Join, because the partition is a pseudo parameter.
    const arn = JSON.stringify(runtime.Properties.EnvironmentVariables.SCORING_STATE_MACHINE_ARN);
    expect(arn).toContain('ap-south-1');
    expect(arn).toContain('stateMachine:chaukanna-scoring');
  });
});
