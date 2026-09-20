import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as path from 'node:path';
import { Construct } from 'constructs';

export interface ChaukannaStackProps extends cdk.StackProps {
  /**
   * Public origin of the deployed web app, e.g. https://main.d123abc.amplifyapp.com.
   * Added to the Cognito callback and logout URLs next to localhost.
   */
  appUrl?: string;
  /**
   * Where the voice path runs. The app and the data are in `ap-south-1`; Nova 2 Sonic is not
   * offered there, so the agent runtime the browser connects to lives in this region instead.
   */
  voiceRegion?: string;
  /**
   * Address the drill nudge email is sent from, e.g. from `-c chaukanna:senderEmail=<address>`.
   * Never written into `cdk.json`: this repository is public and an address is personal data.
   * Leave it unset and the ring Lambda simply skips the email; in-app polling is the primary
   * path either way.
   */
  senderEmail?: string;
}

const LOCAL_APP_URL = 'http://localhost:3000';
const AUTH_CALLBACK_PATH = '/api/auth/callback';
/**
 * Holds `{"clientId": "...", "clientSecret": "..."}` for the Google OAuth client. Created and
 * filled outside this stack, by hand, because CDK cannot mint Google credentials and this
 * repository is public. See docs/AWS_SETUP.md.
 */
const GOOGLE_OAUTH_SECRET_NAME = 'chaukanna/google-oauth';
/** Nova 2 Sonic is not in `ap-south-1`; the voice path runs in Tokyo. */
const DEFAULT_VOICE_REGION = 'ap-northeast-1';

export class ChaukannaStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly artifactsBucket: s3.Bucket;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly googleIdentityProvider: cognito.UserPoolIdentityProviderGoogle;
  public readonly inviteSigningKey: secretsmanager.Secret;
  public readonly computeRole: iam.Role;
  public readonly ringFunction: lambda.Function;
  public readonly schedulerInvokeRole: iam.Role;

  constructor(scope: Construct, id: string, props?: ChaukannaStackProps) {
    super(scope, id, props);

    // 1. DynamoDB single-table design for Chaukanna
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: 'chaukanna',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Hackathon mode
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Origins of the web app: localhost for development plus the Amplify URL once it exists.
    const appUrls = [LOCAL_APP_URL, ...(props?.appUrl ? [props.appUrl.replace(/\/+$/, '')] : [])];
    const voiceRegion = props?.voiceRegion ?? DEFAULT_VOICE_REGION;

    // 2. S3 Bucket for drill recordings, consent, and debrief artifacts
    this.artifactsBucket = new s3.Bucket(this, 'Artifacts', {
      bucketName: `chaukanna-artifacts-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // PRD section 8.6: call audio is kept 7 days, the redacted transcript 30. Lifecycle rules
      // are per prefix, so those two live under different prefixes rather than in one folder per
      // drill. `chaukanna_agent/store.py` writes exactly these keys.
      lifecycleRules: [
        { prefix: 'consent/', expiration: cdk.Duration.days(365) },
        { prefix: 'drill/audio/', expiration: cdk.Duration.days(7) },
        { prefix: 'drill/transcript/', expiration: cdk.Duration.days(30) },
        { prefix: 'debrief/', expiration: cdk.Duration.days(30) },
      ],
      // Browsers upload with presigned PUTs from our own pages only.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: appUrls,
          allowedHeaders: ['content-type'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 3. Cognito User Pool for Guardians.
    //
    // Nobody ever sets a password here. Guardians arrive through Google (section 5 below) and
    // learners never have an account at all, so the pool holds federated identities only.
    // `selfSignUpEnabled: false` closes the native SignUp API; it does not affect federation,
    // which provisions its users through a different path. The password policy stays because
    // Cognito always keeps one for a pool, and a strict unusable policy is the safe default for
    // a credential that is never meant to be created.
    this.userPool = new cognito.UserPool(this, 'Guardians', {
      userPoolName: 'chaukanna-guardians',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 32,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 4. Managed login domain. The prefix takes a suffix from the stack's own UUID so it is
    // globally unique without putting the account id in a URL every guardian sees.
    const stackUuidHead = cdk.Fn.select(0, cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', this.stackId))));
    this.userPoolDomain = this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: { domainPrefix: `chaukanna-${stackUuidHead}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // 5. Google, the only way a guardian signs in.
    //
    // The OAuth client is created by hand in Google Cloud and its id and secret are put into
    // `chaukanna/google-oauth` with the CLI; this stack only references them, so neither value
    // is ever in this repository. Both are CloudFormation dynamic references resolved at deploy
    // time, which means editing the secret later has no effect until the stack is deployed again.
    //
    // Google's authorised redirect URI must be this pool's own endpoint,
    // `https://<CognitoDomain output>/oauth2/idpresponse`, not any URL of ours.
    // Referenced by name rather than through `Secret.fromSecretNameV2`, whose `secretValue`
    // builds a full ARN out of the synthesising environment's own region and account. The
    // reference is resolved by CloudFormation in the region the stack is deploying to, so the
    // bare name is both correct and independent of whoever runs `cdk synth`.
    const googleSecret = (jsonField: string) =>
      cdk.SecretValue.secretsManager(GOOGLE_OAUTH_SECRET_NAME, { jsonField });
    this.googleIdentityProvider = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool: this.userPool,
      // `unsafeUnwrap` is the supported way to place a dynamic reference in a plain string
      // property. Nothing is revealed at synth time: the value stays `{{resolve:...}}` in the
      // template and is only ever resolved inside CloudFormation.
      clientId: googleSecret('clientId').unsafeUnwrap(),
      clientSecretValue: googleSecret('clientSecret'),
      // `openid` is what makes Google return an id token at all; `email` is the only claim the
      // app reads, and `profile` supplies the display name on the dashboard.
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        // Carried through so the pool never holds an address Google itself has not verified.
        emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
      },
    });

    // 6. User Pool Client, public (PKCE), authorization code only
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'chaukanna-web-client',
      generateSecret: false,
      preventUserExistenceErrors: true,
      // No `userSrp`: that is the username-and-password flow, and there are no passwords here.
      authFlows: {},
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: appUrls.map((u) => `${u}${AUTH_CALLBACK_PATH}`),
        logoutUrls: appUrls,
      },
      // Google only. Dropping COGNITO is what removes the password form and the sign-up link
      // from managed login, so there is no native path to hide behind a UI choice.
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
    });
    // Cognito rejects a client naming a provider that does not exist yet, and CloudFormation has
    // no way to infer the ordering from `supportedIdentityProviders` alone.
    this.userPoolClient.node.addDependency(this.googleIdentityProvider);

    // Newer managed login renders nothing until a branding style exists for the client.
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // 7. Invite signing key. Generated by Secrets Manager, never present in the repo.
    this.inviteSigningKey = new secretsmanager.Secret(this, 'InviteSigningKey', {
      secretName: 'chaukanna/invite-signing-key',
      description: 'HMAC key for learner invite links and learner session cookies',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 8. Amplify SSR compute role. Route handlers run with exactly these permissions.
    this.computeRole = new iam.Role(this, 'AmplifyComputeRole', {
      roleName: 'chaukanna-amplify-compute-role',
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      description: 'Runtime role for the Chaukanna Next.js SSR route handlers on Amplify Hosting',
    });
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:Query',
        ],
        resources: [this.table.tableArn, `${this.table.tableArn}/index/*`],
      }),
    );
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('consent/*')],
      }),
    );
    this.inviteSigningKey.grantRead(this.computeRole);

    // Presigning the WebSocket URL a learner's browser opens. The resource is a prefix rather
    // than one runtime because the runtime lives in another region and another stack, so its ARN
    // is not knowable here; it stays inside this account and this region's runtimes.
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:bedrock-agentcore:${voiceRegion}:${cdk.Stack.of(this).account}:runtime/*`,
        ],
      }),
    );

    // 9. Ring Lambda. The one thing that has to happen with no browser open: when a drill's
    // one time EventBridge schedule fires, this function re-checks consent and state, flips
    // `scheduled` to `due`, writes the ring event and nudges the learner by email. The re-check
    // is the safety part. A schedule that fires a second after consent was revoked is normal,
    // and this function is the only thing in a position to refuse it.
    //
    // The code is owned by `services/lifecycle`. Tests, virtualenvs and caches are excluded so
    // the asset hash follows source changes rather than whatever is lying around locally.
    const senderEmail = props?.senderEmail?.trim() ?? '';

    // Explicit log group rather than the deprecated `logRetention` property, which provisions a
    // custom resource Lambda with broad `logs:` rights just to set one number.
    const ringLogGroup = new logs.LogGroup(this, 'RingLambdaLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.ringFunction = new lambda.Function(this, 'RingLambda', {
      functionName: 'chaukanna-ring',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'lifecycle_service.ring.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../services/lifecycle'), {
        exclude: ['tests', '.venv', '**/__pycache__', '*.lock', '.pytest_cache', '.ruff_cache'],
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: ringLogGroup,
      // `AWS_REGION` is deliberately not here. Lambda reserves it and sets it itself, and
      // CloudFormation rejects the entire stack if a function declares it.
      environment: {
        TABLE_NAME: this.table.tableName,
        // The link in the nudge email has to point at somewhere the learner can actually open,
        // which before Amplify exists is the same localhost origin Cognito redirects to.
        APP_URL: props?.appUrl?.replace(/\/+$/, '') ?? LOCAL_APP_URL,
        // Empty when no sender is configured. The Lambda then skips the email and the in-app
        // poll remains the primary path, exactly as the phase file describes.
        SENDER_EMAIL: senderEmail,
        // Nobody answers within half an hour and the drill is missed. Phase 4 evaluates that
        // lazily on the next read, so this is only the expiry marker the ring writes.
        DRILL_DUE_MINUTES: '30',
      },
    });

    // Reads the drill and its consent, queries GSI1 for the member's state rows, and conditionally
    // updates the one row. No PutItem and no DeleteItem: a ring may move a drill forward, never
    // create or destroy one.
    this.ringFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn, `${this.table.tableArn}/index/*`],
      }),
    );

    if (senderEmail) {
      // `ses:FromAddress` pins the envelope sender. Without it a role holding `ses:SendEmail`
      // can send as any identity the account has verified, which is a phishing primitive in a
      // product whose whole subject is phishing.
      this.ringFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [
            `arn:${cdk.Aws.PARTITION}:ses:${this.region}:${this.account}:identity/${senderEmail}`,
          ],
          conditions: { StringEquals: { 'ses:FromAddress': senderEmail } },
        }),
      );
    }

    // 10. The role EventBridge Scheduler assumes to pull the trigger.
    //
    // A schedule carries the role it should use, so the trust policy is the whole defence: the
    // `aws:SourceAccount` condition is the confused deputy guard. Without it, anyone else's
    // schedule in anyone else's account could name this role's ARN and the scheduler service
    // would assume it on their behalf.
    this.schedulerInvokeRole = new iam.Role(this, 'SchedulerInvokeRole', {
      roleName: 'chaukanna-scheduler-invoke-role',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID } },
      }),
      description: 'Assumed by EventBridge Scheduler to invoke the Chaukanna ring Lambda',
    });
    this.schedulerInvokeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.ringFunction.functionArn],
      }),
    );

    // 11. What the web app may do with schedules.
    //
    // Every schedule the app creates is named `chaukanna-drill-<drillId>` on the default bus, so
    // that name prefix is the entire authorization boundary: the compute role can create, read
    // and delete drill schedules and cannot touch any other schedule in the account. Deleting is
    // not optional; a cancelled drill whose schedule survives still fires.
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:scheduler:${this.region}:${this.account}:schedule/default/chaukanna-drill-*`,
        ],
      }),
    );
    // The pitfall the phase file calls out. `CreateSchedule` hands Scheduler a role ARN, which
    // counts as passing a role, so without this the call fails at runtime with an opaque
    // AccessDenied and nothing in the template looks wrong. Scoped to exactly the one role, and
    // conditioned on the service it may be passed to, so this is not a general escalation path.
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.schedulerInvokeRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );

    // 12. The address the nudge email comes from, when there is one.
    //
    // Optional on purpose: the stack deploys and drills still ring with no sender configured,
    // the email is simply skipped. Pass one with `-c chaukanna:senderEmail=<address>` and AWS
    // sends a verification mail to it; the identity is not usable until someone clicks through.
    // SES starts every account in the sandbox, where mail is only delivered to verified
    // addresses, which is all a demo needs and nothing we should try to leave.
    if (senderEmail) {
      new ses.EmailIdentity(this, 'SenderIdentity', {
        identity: ses.Identity.email(senderEmail),
      });
    }

    // Tag everything in stack
    cdk.Tags.of(this).add('project', 'chaukanna');

    // Outputs for Amplify and app consumption
    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'DynamoDB Table Name',
      exportName: 'ChaukannaTableName',
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketName', {
      value: this.artifactsBucket.bucketName,
      description: 'S3 Artifacts Bucket Name',
      exportName: 'ChaukannaArtifactsBucketName',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: 'ChaukannaUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: 'ChaukannaUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `${this.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito managed login host name (no scheme)',
      exportName: 'ChaukannaCognitoDomain',
    });

    new cdk.CfnOutput(this, 'InviteSigningKeySecretName', {
      value: 'chaukanna/invite-signing-key',
      description: 'Secrets Manager secret id read by the web app at runtime',
    });

    new cdk.CfnOutput(this, 'AmplifyComputeRoleArn', {
      value: this.computeRole.roleArn,
      description: 'Attach as the compute role in Amplify console, App settings, IAM roles',
    });

    new cdk.CfnOutput(this, 'RingLambdaArn', {
      value: this.ringFunction.functionArn,
      description: 'Set as RING_LAMBDA_ARN in the web app: the target of every drill schedule',
      exportName: 'ChaukannaRingLambdaArn',
    });

    new cdk.CfnOutput(this, 'SchedulerInvokeRoleArn', {
      value: this.schedulerInvokeRole.roleArn,
      description: 'Set as SCHEDULER_INVOKE_ROLE_ARN in the web app: passed as a schedule target role',
      exportName: 'ChaukannaSchedulerInvokeRoleArn',
    });

    new cdk.CfnOutput(this, 'AwsRegion', {
      value: this.region,
      description: 'Primary App & Data AWS Region',
    });

    new cdk.CfnOutput(this, 'VoiceRegion', {
      value: voiceRegion,
      description: 'Voice Agent AWS Region (Bedrock Nova 2 Sonic)',
    });
  }
}
