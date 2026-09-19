import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ChaukannaStack } from '../lib/chaukanna-stack';

describe('ChaukannaStack', () => {
  test('creates DynamoDB table, S3 bucket, and Cognito User Pool', () => {
    const app = new cdk.App();
    const stack = new ChaukannaStack(app, 'TestChaukannaStack', {
      env: { account: '123456789012', region: 'ap-south-1' },
    });
    const template = Template.fromStack(stack);

    // Verify DynamoDB Table
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

    // Verify S3 Bucket
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

    // Verify Cognito User Pool
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'chaukanna-guardians',
      UsernameAttributes: ['email'],
    });

    // Verify Cognito User Pool Client
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'chaukanna-web-client',
    });
  });
});
