import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ChaukannaStackProps extends cdk.StackProps {
  /**
   * Public origin of the deployed web app, e.g. https://main.d123abc.amplifyapp.com.
   * Added to the Cognito callback and logout URLs next to localhost.
   */
  appUrl?: string;
}

const LOCAL_APP_URL = 'http://localhost:3000';
const AUTH_CALLBACK_PATH = '/api/auth/callback';

export class ChaukannaStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly artifactsBucket: s3.Bucket;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly inviteSigningKey: secretsmanager.Secret;
  public readonly computeRole: iam.Role;

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

    // 2. S3 Bucket for drill recordings, consent, and debrief artifacts
    this.artifactsBucket = new s3.Bucket(this, 'Artifacts', {
      bucketName: `chaukanna-artifacts-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        { prefix: 'consent/', expiration: cdk.Duration.days(365) },
        { prefix: 'drill/', expiration: cdk.Duration.days(7) },
        { prefix: 'debrief/', expiration: cdk.Duration.days(30) },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 3. Cognito User Pool for Guardians
    this.userPool = new cognito.UserPool(this, 'Guardians', {
      userPoolName: 'chaukanna-guardians',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 10,
        requireDigits: false,
        requireLowercase: false,
        requireUppercase: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 4. Managed login domain. The prefix takes a suffix from the stack's own UUID so it is
    // globally unique without putting the account id in a URL every guardian sees.
    const stackUuidHead = cdk.Fn.select(0, cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', this.stackId))));
    this.userPoolDomain = this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: { domainPrefix: `chaukanna-${stackUuidHead}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // 5. User Pool Client, public (PKCE), authorization code only
    const appUrls = [LOCAL_APP_URL, ...(props?.appUrl ? [props.appUrl.replace(/\/+$/, '')] : [])];

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'chaukanna-web-client',
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: {
        userSrp: true,
      },
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
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    // Newer managed login renders nothing until a branding style exists for the client.
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // 6. Invite signing key. Generated by Secrets Manager, never present in the repo.
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

    // 7. Amplify SSR compute role. Route handlers run with exactly these permissions.
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

    new cdk.CfnOutput(this, 'AwsRegion', {
      value: this.region,
      description: 'Primary App & Data AWS Region',
    });

    new cdk.CfnOutput(this, 'VoiceRegion', {
      value: 'ap-northeast-1',
      description: 'Voice Agent AWS Region (Bedrock Nova 2 Sonic)',
    });
  }
}
