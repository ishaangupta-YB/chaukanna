import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface ChaukannaStackProps extends cdk.StackProps {
  appCallbackUrls?: string[];
  appLogoutUrls?: string[];
}

export class ChaukannaStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly artifactsBucket: s3.Bucket;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: ChaukannaStackProps) {
    super(scope, id, props);

    // 1. DynamoDB single-table design for Chaukanna
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: 'chaukanna',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
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

    // 4. Hosted UI Domain
    const domainPrefix = `chaukanna-auth-${cdk.Stack.of(this).account || 'app'}`;
    this.userPoolDomain = this.userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix,
      },
    });

    // 5. User Pool Client
    const callbackUrls = props?.appCallbackUrls ?? [
      'http://localhost:3000/api/auth/callback',
      'https://main.chaukanna.amplifyapp.com/api/auth/callback',
    ];
    const logoutUrls = props?.appLogoutUrls ?? [
      'http://localhost:3000',
      'https://main.chaukanna.amplifyapp.com',
    ];

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'chaukanna-web-client',
      generateSecret: false,
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
        callbackUrls,
        logoutUrls,
      },
    });

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
      value: this.userPoolDomain.domainName,
      description: 'Cognito Hosted UI Domain prefix',
      exportName: 'ChaukannaCognitoDomain',
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
