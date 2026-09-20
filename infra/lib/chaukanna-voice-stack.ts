import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ChaukannaVoiceStackProps extends cdk.StackProps {
  /** Where the table, the bucket and the secret live: `ap-south-1`, not this stack's region. */
  dataRegion: string;
  tableName: string;
  artifactsBucket: string;
  inviteSigningKeySecretName: string;
  /**
   * The image the runtime serves, e.g. `<account>.dkr.ecr.ap-northeast-1.amazonaws.com/chaukanna-drill:abc123`.
   * Left undefined on the first deploy, which creates the repository and the role and nothing
   * else, because a runtime cannot be created without an image that already exists.
   */
  containerUri?: string;
  /** Overrides for the agent, all non-secret. Secrets are read at runtime, never set here. */
  sessionMaxSeconds?: number;
  safeWord?: string;
}

/**
 * Everything the voice path needs, in `ap-northeast-1`.
 *
 * It is a separate stack for one reason: Nova 2 Sonic is not offered in `ap-south-1`, so the
 * agent runs in Tokyo while the learner's data stays in Mumbai. CloudFormation does not cross
 * regions, so the two cannot be one stack, and cross-region references cannot be CloudFormation
 * exports. The few values that have to travel are passed as plain strings and turned back into
 * ARNs here, which is why `dataRegion` is a property rather than something inferred.
 *
 * Deploy order, and it matters:
 *   1. `cdk deploy ChaukannaVoiceStack`      creates the repository and the execution role
 *   2. build and push the image              see apps/agent/Dockerfile
 *   3. set `chaukanna:agentImage` in cdk.json and deploy again, which creates the runtime
 */
export class ChaukannaVoiceStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly executionRole: iam.Role;
  public readonly runtime?: cdk.CfnResource;

  constructor(scope: Construct, id: string, props: ChaukannaVoiceStackProps) {
    super(scope, id, props);

    const { account } = cdk.Stack.of(this);
    const dataArn = (service: string, resource: string) =>
      `arn:${cdk.Aws.PARTITION}:${service}:${props.dataRegion}:${account}:${resource}`;
    const tableArn = dataArn('dynamodb', `table/${props.tableName}`);
    const bucketArn = `arn:${cdk.Aws.PARTITION}:s3:::${props.artifactsBucket}`;

    // 1. Where the agent image lives. AgentCore pulls from ECR in its own region.
    this.repository = new ecr.Repository(this, 'AgentImages', {
      repositoryName: 'chaukanna-drill',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ description: 'Keep the last 10 images', maxImageCount: 10 }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // 2. The role the drill runs as. One call's worth of permissions and nothing more.
    this.executionRole = new iam.Role(this, 'AgentExecutionRole', {
      roleName: 'chaukanna-agent-execution-role',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${this.region}:${account}:*` },
        },
      }),
      description: 'Runtime role for the Chaukanna drill agent on AgentCore Runtime',
    });

    // Speak to Nova 2 Sonic, here in the voice region. The model id is pinned: a wildcard would
    // let a mistake in an environment variable reach a model nobody reviewed.
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModelWithBidirectionalStream', 'bedrock:InvokeModel'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:bedrock:${this.region}::foundation-model/amazon.nova-2-sonic-v1:0`,
          `arn:${cdk.Aws.PARTITION}:bedrock:${this.region}:${account}:inference-profile/*nova-2-sonic*`,
        ],
      }),
    );

    // Read the member row, claim the drill, write the outcome and the event log. No DeleteItem
    // and no Scan: a drill can finish a row, never remove one.
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem', 'dynamodb:BatchWriteItem'],
        resources: [tableArn],
      }),
    );

    // Write the drill's own artifacts and nothing else. Consent recordings are somebody else's
    // to write and nobody's to read from here.
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`${bucketArn}/drill/audio/*`, `${bucketArn}/drill/transcript/*`],
      }),
    );

    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [dataArn('secretsmanager', `secret:${props.inviteSigningKeySecretName}-??????`)],
      }),
    );

    // Pull its own image, and write its own logs and traces.
    this.repository.grantPull(this.executionRole);
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'], // this action has no resource to scope to; AWS requires "*"
      }),
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
        resources: [`arn:${cdk.Aws.PARTITION}:logs:${this.region}:${account}:log-group:/aws/bedrock-agentcore/*`],
      }),
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords', 'cloudwatch:PutMetricData'],
        resources: ['*'], // neither action supports resource level permissions
      }),
    );

    // 3. The runtime itself. There is no L2 construct for AgentCore yet, so this is the
    // CloudFormation resource directly. `HTTP` is the protocol that carries WebSocket: the same
    // container serves /invocations, /ws and /ping on port 8080.
    if (props.containerUri) {
      this.runtime = new cdk.CfnResource(this, 'DrillRuntime', {
        type: 'AWS::BedrockAgentCore::Runtime',
        properties: {
          AgentRuntimeName: 'chaukanna_drill',
          Description: 'Consented practice scam call, Hindi and Indian English',
          AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: props.containerUri } },
          RoleArn: this.executionRole.roleArn,
          NetworkConfiguration: { NetworkMode: 'PUBLIC' },
          ProtocolConfiguration: 'HTTP',
          EnvironmentVariables: {
            DATA_REGION: props.dataRegion,
            TABLE_NAME: props.tableName,
            ARTIFACTS_BUCKET: props.artifactsBucket,
            VOICE_REGION: this.region,
            SESSION_MAX_SECONDS: String(props.sessionMaxSeconds ?? 360),
            SAFE_WORD: props.safeWord ?? 'ROKO',
          },
          LifecycleConfiguration: {
            // A drill is six minutes. A session that is still idle after fifteen is a browser
            // that went away, and holding it open costs a session slot for nothing.
            IdleRuntimeSessionTimeout: 900,
            MaxLifetime: 3600,
          },
        },
      });
      this.runtime.node.addDependency(this.executionRole);

      new cdk.CfnOutput(this, 'AgentRuntimeArn', {
        value: this.runtime.getAtt('AgentRuntimeArn').toString(),
        description: 'Set as AGENT_RUNTIME_ARN in the Amplify environment variables',
      });
    }

    cdk.Tags.of(this).add('project', 'chaukanna');

    new cdk.CfnOutput(this, 'AgentRepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'Push the agent image here, then set chaukanna:agentImage in cdk.json',
    });
    new cdk.CfnOutput(this, 'AgentExecutionRoleArn', { value: this.executionRole.roleArn });
  }
}
