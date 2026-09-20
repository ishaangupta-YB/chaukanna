#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChaukannaStack } from '../lib/chaukanna-stack';
import { ChaukannaVoiceStack } from '../lib/chaukanna-voice-stack';

const app = new cdk.App();

const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'ap-south-1';
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Nova 2 Sonic is not offered in ap-south-1, so the voice path runs in Tokyo while the learner's
// data stays in Mumbai. Two regions means two stacks: CloudFormation does not cross regions.
const voiceRegion: string = app.node.tryGetContext('chaukanna:voiceRegion') || 'ap-northeast-1';

// The deployed Amplify origin, set once in cdk.json context after the Amplify app exists.
const appUrl: string | undefined = app.node.tryGetContext('chaukanna:appUrl') || undefined;

// The address the drill nudge email is sent from. Deliberately absent from cdk.json: this
// repository is public and an email address is personal data, so it is passed at synth time:
//
//   npx cdk deploy ChaukannaStack -c chaukanna:senderEmail=<address>
//
// Unset, no SES identity is created and the ring Lambda skips the email. SES also starts every
// account in the sandbox, where only verified addresses receive mail, which is fine for a demo.
const senderEmail: string | undefined =
  app.node.tryGetContext('chaukanna:senderEmail') || undefined;

// The agent image to run. An ECR URI contains the account id, and this repository is public, so
// it is never written into cdk.json: pass it on the command line or in the environment.
//
//   AGENT_IMAGE=<account>.dkr.ecr.ap-northeast-1.amazonaws.com/chaukanna-drill:<tag> \
//     npx cdk deploy ChaukannaVoiceStack
//
// Until it is set the voice stack deploys the repository and the execution role only, because a
// runtime cannot be created without an image that already exists.
const agentImage: string | undefined =
  process.env.AGENT_IMAGE || app.node.tryGetContext('chaukanna:agentImage') || undefined;

new ChaukannaStack(app, 'ChaukannaStack', {
  env: { account, region },
  appUrl,
  voiceRegion,
  senderEmail,
  description: 'Chaukanna Core Infrastructure (DynamoDB, S3, Cognito, secrets, Amplify compute role)',
});

new ChaukannaVoiceStack(app, 'ChaukannaVoiceStack', {
  env: { account, region: voiceRegion },
  // Passed as plain strings, not stack references: a CloudFormation export cannot cross a region.
  dataRegion: region,
  tableName: 'chaukanna',
  artifactsBucket: `chaukanna-artifacts-${account ?? cdk.Aws.ACCOUNT_ID}`,
  inviteSigningKeySecretName: 'chaukanna/invite-signing-key',
  containerUri: agentImage,
  description: 'Chaukanna voice path (ECR repository, agent execution role, AgentCore Runtime)',
});
