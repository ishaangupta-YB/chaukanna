import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as vp from 'aws-cdk-lib/aws-verifiedpermissions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
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

/**
 * The scoring state machine's name, exported because the agent starts it from another region
 * and another stack, where the ARN has to be rebuilt from account + region + this name.
 */
export const SCORING_STATE_MACHINE_NAME = 'chaukanna-scoring';

/**
 * The judge and the debrief writer. The bare `anthropic.claude-haiku-4-5-...` model id is
 * rejected with "Invocation with on-demand throughput isn't supported": this family is only
 * reachable through an inference profile, and the `global.` one is the profile that is ACTIVE
 * in `ap-south-1`. Verified with a real `converse` call, not remembered.
 */
const JUDGE_MODEL_ID = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Polly has no `hi-IN` voice at all (`describe-voices --language-code hi-IN` returns nothing).
 * `Kajal` is `en-IN` with `hi-IN` in `AdditionalLanguageCodes` and is the only Hindi-capable
 * neural voice, so both languages are this one voice with a different `LanguageCode`.
 */
const DEBRIEF_VOICE_ID = 'Kajal';

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
  public readonly guardrail: bedrock.CfnGuardrail;
  public readonly scoringStateMachine: sfn.StateMachine;
  public readonly policyStore: vp.CfnPolicyStore;

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
      // Named ids, because these rules are a demo asset as much as a control: a judge opens the
      // Management tab of this bucket and reads the retention promise off the console in five
      // seconds (phase 6 task 6).
      lifecycleRules: [
        { id: 'consent-365-days', prefix: 'consent/', expiration: cdk.Duration.days(365) },
        { id: 'drill-audio-7-days', prefix: 'drill/audio/', expiration: cdk.Duration.days(7) },
        { id: 'drill-transcript-30-days', prefix: 'drill/transcript/', expiration: cdk.Duration.days(30) },
        // What the guardrail wrote back after redaction. Same 30 days as the raw transcript it
        // was made from: a redacted copy that outlived its original would be the longer-lived
        // record of the same conversation.
        { id: 'drill-redacted-30-days', prefix: 'drill/redacted/', expiration: cdk.Duration.days(30) },
        // The learner's own coaching text and its audio. Longer than the transcript it was made
        // from because it is the only thing they can go back to, and it carries no quotes of the
        // call that are not already redacted.
        { id: 'debrief-90-days', prefix: 'debrief/', expiration: cdk.Duration.days(90) },
        // A browser that dropped mid-upload leaves parts nobody can see and everybody pays for.
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
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

    // 8b. Verified Permissions policy store for authorization (created before compute role).
    //
    // Schema defines the entity types and actions. Policies are Cedar statements.
    // Phase 6 tasks: ViewBand, ViewTranscript, ScheduleDrill, TakeDrill.
    // If VP is not available in ap-south-1, the stack deploy will fail; in that case
    // deploy the policy store in a supported region and call cross-region.
    this.policyStore = new vp.CfnPolicyStore(this, 'PolicyStore', {
      description: 'Chaukanna authorization policies for drill access',
      validationSettings: { mode: 'STRICT' },
      schema: {
        // Cedar JSON is keyed by NAMESPACE. Without the `Chaukanna` wrapper the service
        // rejects it with "unknown field `Household`" — the namespace, not the entity type.
        cedarJson: JSON.stringify({
          Chaukanna: {
          entityTypes: {
            Household: {
              shape: {
                type: 'Record',
                attributes: {
                  householdId: { type: 'String' },
                },
              },
            },
            /*
             * STRICT validation treats a declared attribute as required unless it says
             * otherwise, and rejects a request whose entity omits one. So only what the
             * policies actually read is required, and `lib/authz.ts` always supplies it.
             */
            Member: {
              shape: {
                type: 'Record',
                attributes: {
                  memberId: { type: 'String' },
                  householdId: { type: 'String' },
                  status: { type: 'String' },
                  transcriptSharing: { type: 'Boolean', required: false },
                },
              },
            },
            Drill: {
              shape: {
                type: 'Record',
                attributes: {
                  householdId: { type: 'String' },
                  memberId: { type: 'String' },
                  transcriptSharing: { type: 'Boolean' },
                  drillId: { type: 'String', required: false },
                  state: { type: 'String', required: false },
                },
              },
            },
          },
          actions: {
            ViewBand: {
              appliesTo: { principalTypes: ['Member'], resourceTypes: ['Drill'] },
            },
            ViewTranscript: {
              appliesTo: { principalTypes: ['Member'], resourceTypes: ['Drill'] },
            },
            ScheduleDrill: {
              appliesTo: { principalTypes: ['Member'], resourceTypes: ['Member'] },
            },
            TakeDrill: {
              appliesTo: { principalTypes: ['Member'], resourceTypes: ['Drill'] },
            },
          },
          },
        }),
      },
    });

    // Policy: Guardians can view band for drills in their household
    new vp.CfnPolicy(this, 'GuardianViewBandPolicy', {
      policyStoreId: this.policyStore.attrPolicyStoreId,
      definition: {
        static: {
          description: 'Guardians can always see outcomes (band) for their household',
          statement: `permit(principal, action == Chaukanna::Action::"ViewBand", resource) when { resource.householdId == principal.householdId };`,
        },
      },
    });

    // Policy: Transcripts only when learner granted sharing
    new vp.CfnPolicy(this, 'GuardianViewTranscriptPolicy', {
      policyStoreId: this.policyStore.attrPolicyStoreId,
      definition: {
        static: {
          description: 'Transcripts only when learner has granted sharing',
          statement: `permit(principal, action == Chaukanna::Action::"ViewTranscript", resource) when { resource.householdId == principal.householdId && resource.transcriptSharing == true };`,
        },
      },
    });

    // Policy: Guardians schedule drills for members of their own household.
    //
    // Cedar is default deny, so the forbid below is not a policy on its own: without this
    // permit, ScheduleDrill would be denied for everyone, paused or not.
    new vp.CfnPolicy(this, 'GuardianScheduleDrillPolicy', {
      policyStoreId: this.policyStore.attrPolicyStoreId,
      definition: {
        static: {
          description: 'Guardians can schedule a drill for a member of their own household',
          statement: `permit(principal, action == Chaukanna::Action::"ScheduleDrill", resource) when { resource.householdId == principal.householdId };`,
        },
      },
    });

    // Policy: Cannot schedule for paused learner
    new vp.CfnPolicy(this, 'NoSchedulePausedPolicy', {
      policyStoreId: this.policyStore.attrPolicyStoreId,
      definition: {
        static: {
          description: 'A paused learner cannot be scheduled by anyone',
          statement: `forbid(principal, action == Chaukanna::Action::"ScheduleDrill", resource) when { resource.status == "paused" };`,
        },
      },
    });

    // Policy: Learner can take their own drill
    new vp.CfnPolicy(this, 'LearnerTakeDrillPolicy', {
      policyStoreId: this.policyStore.attrPolicyStoreId,
      definition: {
        static: {
          description: 'Learner can take their own drill',
          statement: `permit(principal, action == Chaukanna::Action::"TakeDrill", resource) when { resource.memberId == principal.memberId };`,
        },
      },
    });

    // Policy: Learner can view their own transcript
    new vp.CfnPolicy(this, 'LearnerViewTranscriptPolicy', {
      policyStoreId: this.policyStore.attrPolicyStoreId,
      definition: {
        static: {
          description: 'Learner can view their own transcript',
          statement: `permit(principal, action == Chaukanna::Action::"ViewTranscript", resource) when { resource.memberId == principal.memberId };`,
        },
      },
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
          // `listScores` reads a whole member card's scores in one BatchGetItem. It is a separate
          // IAM action from GetItem and is not implied by it, so without this line the guardian
          // dashboard and the audit log throw for any household that has ever run a drill — and
          // only for those, which is why an empty demo household looks perfectly healthy.
          'dynamodb:BatchGetItem',
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

    // Verified Permissions: allow authorization calls from route handlers and server components.
    // `BatchIsAuthorized` is not implied by `IsAuthorized` — the guardian dashboard and the audit
    // log ask about every drill they render in one batched call, and without this action they get
    // AccessDenied at request time, which default deny correctly turns into an empty screen.
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['verifiedpermissions:IsAuthorized', 'verifiedpermissions:BatchIsAuthorized'],
        resources: [this.policyStore.attrArn],
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

    // 13. The redaction guardrail.
    //
    // Phase 5's first durable write is the redacted transcript, and this is what makes it safe
    // to write. It runs against the transcript before anything else reads it; if the call fails
    // the execution fails rather than falling through to storing raw text.
    //
    // The PII list below is everything in the Bedrock enum that a digital-arrest script actually
    // tries to extract. What is *not* in that enum matters more: Bedrock Guardrails has no
    // India-specific entity types at all — no Aadhaar, no PAN, no UPI — so the two identifiers
    // this product exists to protect are caught by `regexesConfig` instead. That is not a
    // stylistic choice; a `piiEntitiesConfig` naming `IN_AADHAAR` is rejected at deploy time.
    this.guardrail = new bedrock.CfnGuardrail(this, 'DrillRedaction', {
      name: 'chaukanna-drill-redaction',
      description: 'Masks identifiers out of a drill transcript before the first durable write',
      // Required by the API even though nothing here is ever blocked: every policy below
      // ANONYMIZEs, so these strings should never be seen by a learner.
      blockedInputMessaging: 'This content cannot be processed.',
      blockedOutputsMessaging: 'This content cannot be processed.',
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          // Money: what a "verify your account" script asks for.
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'ANONYMIZE' },
          { type: 'CREDIT_DEBIT_CARD_CVV', action: 'ANONYMIZE' },
          { type: 'CREDIT_DEBIT_CARD_EXPIRY', action: 'ANONYMIZE' },
          { type: 'INTERNATIONAL_BANK_ACCOUNT_NUMBER', action: 'ANONYMIZE' },
          { type: 'US_BANK_ACCOUNT_NUMBER', action: 'ANONYMIZE' },
          { type: 'SWIFT_CODE', action: 'ANONYMIZE' },
          // Credentials: PIN and PASSWORD also catch the spoken OTP, which has no entity type.
          { type: 'PIN', action: 'ANONYMIZE' },
          { type: 'PASSWORD', action: 'ANONYMIZE' },
          // Contact details, which the script uses to sound like it already knows the learner.
          { type: 'NAME', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'ADDRESS', action: 'ANONYMIZE' },
        ],
        regexesConfig: [
          {
            name: 'aadhaar',
            description: 'Twelve digit Aadhaar number, spoken or typed in 4-4-4 groups',
            pattern: '\\b[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}\\b',
            action: 'ANONYMIZE',
          },
          {
            name: 'pan',
            description: 'Ten character PAN, five letters, four digits, a letter',
            pattern: '\\b[A-Za-z]{5}[0-9]{4}[A-Za-z]\\b',
            action: 'ANONYMIZE',
          },
          {
            name: 'long-digit-run',
            description: 'Six or more digits together: the agent tripwire threshold, applied again at rest',
            pattern: '\\b[0-9]{6,}\\b',
            action: 'ANONYMIZE',
          },
        ],
      },
    });

    // `DRAFT` on purpose. The guardrail is defined here, so DRAFT always *is* the deployed
    // definition: change a regex, deploy, and the next drill is redacted by the new rule. A
    // published numbered version would add a second thing to remember to bump, and the failure
    // mode of forgetting is that a safety fix silently does not apply.
    const guardrailVersion = 'DRAFT';

    // 14. The five scoring tasks.
    //
    // One asset for all five: same source tree, same exclusions, so CDK hashes and uploads it
    // once. The exclusions are the Phase 4 rule — `Code.fromAsset` installs nothing and ships
    // whatever is on disk, so tests, caches, lock files and a local virtualenv would all ride
    // along and make the asset hash follow the developer's machine rather than the source.
    const scoringCode = lambda.Code.fromAsset(path.join(__dirname, '../../services/scoring'), {
      exclude: ['tests', '.venv', '**/__pycache__', '*.lock', 'uv.lock', '.pytest_cache', '.ruff_cache'],
    });

    const scoringEnvironment = {
      // Not `AWS_REGION`: Lambda reserves that name and CloudFormation rejects the whole stack
      // over a function that declares it. This is the same region, named differently.
      DATA_REGION: this.region,
      TABLE_NAME: this.table.tableName,
      ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
      JUDGE_MODEL_ID,
      GUARDRAIL_ID: this.guardrail.attrGuardrailId,
      GUARDRAIL_VERSION: guardrailVersion,
      DEBRIEF_VOICE_ID,
    };

    /**
     * The timeouts below are ceilings for a call that has hung, not a budget. PRD section 12
     * gives the whole pipeline 60 seconds from session end to a debrief on screen, and in the
     * normal case each task returns in single digit seconds, so the sum of the ceilings is
     * deliberately larger than the target while no single stuck task can eat all of it.
     */
    const scoringTask = (
      id: string,
      functionName: string,
      handler: string,
      timeout: cdk.Duration,
    ) =>
      new lambda.Function(this, id, {
        functionName,
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        handler,
        code: scoringCode,
        timeout,
        memorySize: 512,
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        environment: scoringEnvironment,
      });

    // Reads the transcript, applies the guardrail, writes the redacted copy back.
    const redactFunction = scoringTask(
      'ScoringRedact',
      'chaukanna-scoring-redact',
      'scoring_service.handlers.redact_handler',
      cdk.Duration.seconds(60),
    );
    // One Bedrock call, one retry on a parse failure, so it gets the same room as redaction.
    const judgeFunction = scoringTask(
      'ScoringJudge',
      'chaukanna-scoring-judge',
      'scoring_service.handlers.judge_handler',
      cdk.Duration.seconds(60),
    );
    // Arithmetic. Ten seconds is already generous.
    const scoreFunction = scoringTask(
      'ScoringScore',
      'chaukanna-scoring-score',
      'scoring_service.handlers.score_handler',
      cdk.Duration.seconds(10),
    );
    // A Bedrock call and then a Polly synthesis of up to 120 words.
    const debriefFunction = scoringTask(
      'ScoringDebrief',
      'chaukanna-scoring-debrief',
      'scoring_service.handlers.debrief_handler',
      cdk.Duration.seconds(60),
    );
    // Two DynamoDB writes.
    const finishFunction = scoringTask(
      'ScoringFinish',
      'chaukanna-scoring-finish',
      'scoring_service.handlers.finish_handler',
      cdk.Duration.seconds(15),
    );

    // Redact: exactly one guardrail, and the two prefixes it moves text between. It may read the
    // raw transcript and write the redacted copy, and it may not do the reverse.
    redactFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [this.guardrail.attrGuardrailArn],
      }),
    );
    redactFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('drill/transcript/*')],
      }),
    );
    redactFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [this.artifactsBucket.arnForObjects('drill/redacted/*')],
      }),
    );

    /**
     * Invoking a `global.` inference profile takes two resources, and this is the thing that
     * fails at runtime with a bare AccessDenied if you grant only one. The profile ARN is the
     * resource named in the call; the foundation-model ARN is what the profile routes *to*, and
     * a global profile may route the request to a model in any region, so pinning that second
     * ARN to `ap-south-1` denies exactly the requests the profile was chosen for. The region
     * field is the wildcard, never the model id.
     */
    const judgeModelResources = [
      `arn:${cdk.Aws.PARTITION}:bedrock:${this.region}:${this.account}:inference-profile/${JUDGE_MODEL_ID}`,
      `arn:${cdk.Aws.PARTITION}:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-*`,
    ];

    judgeFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: judgeModelResources }),
    );
    // The judge reads the redacted transcript and only the redacted transcript. Nothing in the
    // scoring path after redaction is allowed near `drill/transcript/`.
    judgeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('drill/redacted/*')],
      }),
    );

    // Score gets no AWS permissions at all, beyond the logs every Lambda writes. That is the
    // point of the task: the model classifies, code counts, and the counting is a pure function
    // of the judgement it was handed. Nothing to read means nothing to get wrong and nothing to
    // leak, and it is why the determinism test is meaningful.

    debriefFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: judgeModelResources }),
    );
    debriefFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['polly:SynthesizeSpeech'],
        resources: ['*'], // Polly has no resource level permissions; AWS requires "*" here
      }),
    );
    /*
     * The debrief writer reads the redacted transcript before it writes anything: the turning
     * point it quotes and the sentences it teaches come from the call itself, so
     * `debrief_handler` opens `drill/redacted/<drill>.json` exactly as the judge does. Without
     * this grant the Debrief task fails on S3, the state machine catches it, routes to
     * `FinishWithoutDebrief`, and every drill ends with a band and silence — which is a failure
     * the product is designed to survive and therefore never reports as one.
     *
     * Redacted only, like the judge. Nothing after redaction goes near `drill/transcript/`.
     */
    debriefFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('drill/redacted/*')],
      }),
    );
    debriefFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [this.artifactsBucket.arnForObjects('debrief/*')],
      }),
    );

    // Finish writes the SCORE row and moves the drill to `scored` or `score_failed`. PutItem is
    // for the score row, UpdateItem for the conditional state transition, GetItem to read the
    // drill it is transitioning. No DeleteItem, no Query: it touches rows it was told about.
    finishFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
      }),
    );

    // 15. The pipeline.
    //
    // Standard rather than Express, deliberately: the runs are short and rare (one per drill),
    // and the visual execution graph is part of the demo. Express would save money that is not
    // being spent and lose the picture.
    // `retryOnServiceExceptions` is switched off on every task below and replaced by this one
    // block. CDK's default adds six attempts of its own, which on a stuck Bedrock call is well
    // past the 60 second debrief target before the pipeline has even given up.
    const transient = {
      errors: [
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
        'ThrottlingException',
      ],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 2,
      backoffRate: 2,
    };

    /**
     * A `Catch` writes Step Functions' own `{Error, Cause}` shape, which says nothing about
     * which task produced it. These Pass states turn that into the `{task, reason}` the finish
     * handler is written against, so one handler covers all three failure shapes.
     */
    const markFailed = (id: string, task: string) =>
      new sfn.Pass(this, id, {
        parameters: { task, reason: sfn.JsonPath.stringAt('$.error.Cause') },
        resultPath: '$.failure',
      });

    const finishFailed = new tasks.LambdaInvoke(this, 'FinishFailed', {
      lambdaFunction: finishFunction,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
    });
    // Separate state, same Lambda. A debrief failure is not a scoring failure: the score exists,
    // it is real, and it is written. The learner loses the audio and gets the generic debrief.
    const finishWithoutDebrief = new tasks.LambdaInvoke(this, 'FinishWithoutDebrief', {
      lambdaFunction: finishFunction,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
    });

    const finish = new tasks.LambdaInvoke(this, 'Finish', {
      lambdaFunction: finishFunction,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
    }).addRetry(transient);

    const debrief = new tasks.LambdaInvoke(this, 'Debrief', {
      lambdaFunction: debriefFunction,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.debrief',
    })
      .addRetry(transient)
      .addCatch(markFailed('DebriefFailed', 'debrief').next(finishWithoutDebrief), {
        resultPath: '$.error',
      });

    const score = new tasks.LambdaInvoke(this, 'Score', {
      lambdaFunction: scoreFunction,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.score',
    })
      .addRetry(transient)
      .addCatch(markFailed('ScoreFailed', 'score').next(finishFailed), { resultPath: '$.error' });

    const judge = new tasks.LambdaInvoke(this, 'Judge', {
      lambdaFunction: judgeFunction,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.judgement',
    })
      .addRetry(transient)
      .addCatch(markFailed('JudgeFailed', 'judge').next(finishFailed), { resultPath: '$.error' });

    const redact = new tasks.LambdaInvoke(this, 'Redact', {
      lambdaFunction: redactFunction,
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: '$.redaction',
    })
      .addRetry(transient)
      .addCatch(markFailed('RedactFailed', 'redact').next(finishFailed), { resultPath: '$.error' });

    const scoringLogGroup = new logs.LogGroup(this, 'ScoringStateMachineLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.scoringStateMachine = new sfn.StateMachine(this, 'Scoring', {
      stateMachineName: SCORING_STATE_MACHINE_NAME,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(
        redact.next(judge).next(score).next(debrief).next(finish),
      ),
      // A drill that has already ended is not urgent, but an execution that never ends is a
      // row stuck in `ended` forever, so the whole run has an outer bound too.
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
      logs: { destination: scoringLogGroup, level: sfn.LogLevel.ERROR },
    });

    // 17. What a route handler may do with a debrief.
    //
    // The audio is written by the debrief Lambda and read by nobody else server side; the web
    // app only ever presigns it for the learner's own player. Read, in one prefix. The table
    // grants the compute role already holds in section 8 cover the score row.
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [this.artifactsBucket.arnForObjects('debrief/*')],
      }),
    );

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

    new cdk.CfnOutput(this, 'ScoringStateMachineArn', {
      value: this.scoringStateMachine.stateMachineArn,
      description: 'The agent starts one execution of this per finished drill',
      exportName: 'ChaukannaScoringStateMachineArn',
    });

    new cdk.CfnOutput(this, 'GuardrailId', {
      value: this.guardrail.attrGuardrailId,
      description: 'Bedrock guardrail applied to a transcript before the first durable write',
    });

    new cdk.CfnOutput(this, 'GuardrailVersion', {
      value: guardrailVersion,
      description: 'DRAFT: the guardrail is defined in CDK, so DRAFT is always what is deployed',
    });

    new cdk.CfnOutput(this, 'JudgeModelId', {
      value: JUDGE_MODEL_ID,
      description: 'Inference profile id used by the judge and the debrief writer',
    });

    new cdk.CfnOutput(this, 'AwsRegion', {
      value: this.region,
      description: 'Primary App & Data AWS Region',
    });

    new cdk.CfnOutput(this, 'VoiceRegion', {
      value: voiceRegion,
      description: 'Voice Agent AWS Region (Bedrock Nova 2 Sonic)',
    });

    new cdk.CfnOutput(this, 'PolicyStoreId', {
      value: this.policyStore.attrPolicyStoreId,
      description: 'Verified Permissions policy store ID for authorization',
    });
  }
}
