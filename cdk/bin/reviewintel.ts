#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReviewIntelStack } from '../lib/reviewintel-stack';

const app = new cdk.App();

// Deploys to the account/region from your AWS CLI profile.
// Override with: cdk deploy -c account=123 -c region=us-east-1 (see README).
new ReviewIntelStack(app, 'ReviewIntelStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'ReviewIntel: AI review intelligence on AWS (free-tier portfolio project)',
});
