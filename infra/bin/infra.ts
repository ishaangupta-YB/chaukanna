#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChaukannaStack } from '../lib/chaukanna-stack';

const app = new cdk.App();

const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'ap-south-1';
const account = process.env.CDK_DEFAULT_ACCOUNT;

new ChaukannaStack(app, 'ChaukannaStack', {
  env: {
    account,
    region,
  },
  description: 'Chaukanna Core Infrastructure (DynamoDB, S3, Cognito)',
});
