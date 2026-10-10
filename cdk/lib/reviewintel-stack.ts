import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * ReviewIntelStack — the whole system in one free-tier-friendly stack.
 *
 * Free-tier rules enforced here:
 *  - VPC has PUBLIC subnets only, natGateways: 0 (a NAT gateway is ~$32/mo).
 *  - DynamoDB is pay-per-request (always-free tier).
 *  - No ElastiCache, no Route 53 — documented in DESIGN_DOC.md, not deployed.
 */
export class ReviewIntelStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // 1. Networking: public subnets only, no NAT gateway.
    // ------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'ReviewIntelVpc', {
      maxAzs: 2,
      natGateways: 0, // free-tier: NAT gateway is NOT free
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ------------------------------------------------------------------
    // 2. S3: raw data lake + static frontend hosting.
    //
    // CloudFront can be disabled for accounts that AWS has not verified yet
    // (new accounts get "account must be verified" on distributions):
    //   npx cdk deploy -c enableCloudfront=false
    // The site is then served from S3 website hosting instead.
    // ------------------------------------------------------------------
    const enableCloudfront = this.node.tryGetContext('enableCloudfront') !== 'false';
    const rawBucket = new s3.Bucket(this, 'RawDataLake', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Raw batches age out; processed results live in DynamoDB.
      lifecycleRules: [{ id: 'expire-raw-batches', expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo stack: wipe on destroy
      autoDeleteObjects: true,
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      // Website hosting needs a public bucket policy; CloudFront path stays private via OAC.
      blockPublicAccess: enableCloudfront
        ? s3.BlockPublicAccess.BLOCK_ALL
        : s3.BlockPublicAccess.BLOCK_ACLS,
      websiteIndexDocument: enableCloudfront ? undefined : 'index.html',
      websiteErrorDocument: enableCloudfront ? undefined : 'index.html', // SPA fallback
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    if (!enableCloudfront) {
      // Public read for the S3-website-hosted dashboard (demo only).
      siteBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [siteBucket.arnForObjects('*')],
          principals: [new iam.AnyPrincipal()],
        }),
      );
    }

    // ------------------------------------------------------------------
    // 3. SQS: ingest queue with a dead-letter queue for poison batches.
    // ------------------------------------------------------------------
    const dlq = new sqs.Queue(this, 'IngestDlq', {
      retentionPeriod: cdk.Duration.days(14),
    });
    const ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      visibilityTimeout: cdk.Duration.seconds(300), // >= processor Lambda timeout
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // ------------------------------------------------------------------
    // 4. DynamoDB single table: PK / SK + GSI on sentiment.
    //    PK = PRODUCT#<id>, SK = REVIEW#<id> | SUMMARY
    // ------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'ReviewsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // always-free tier
      pointInTimeRecovery: false, // enable for production
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'SentimentIndex',
      partitionKey: { name: 'sentiment', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['product_id', 'summary'],
    });

    // ------------------------------------------------------------------
    // 5. Processor Lambda: SQS -> Bedrock (Haiku) -> DynamoDB.
    // ------------------------------------------------------------------
    const processor = new lambda.Function(this, 'ProcessorFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'processor')),
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        RAW_BUCKET_NAME: rawBucket.bucketName,
        // Cheapest capable model; override per-region if needed.
        BEDROCK_MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
      },
    });
    processor.addEventSource(
      new lambdaEventSources.SqsEventSource(ingestQueue, { batchSize: 10 }),
    );
    table.grantWriteData(processor);
    table.grantReadData(processor); // recompute pass reads existing items
    rawBucket.grantRead(processor); // batches that reference s3_key
    processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
        ],
      }),
    );

    // ------------------------------------------------------------------
    // 6. Read API Lambda + API Gateway.
    // ------------------------------------------------------------------
    const apiFn = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'api')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadData(apiFn);

    const api = new apigw.RestApi(this, 'ReviewIntelApi', {
      restApiName: 'reviewintel-api',
      description: 'Read API for product review summaries',
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS, // tighten for production
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });
    const products = api.root.addResource('products');
    products.addMethod('GET', new apigw.LambdaIntegration(apiFn));
    products
      .addResource('{id}')
      .addResource('summary')
      .addMethod('GET', new apigw.LambdaIntegration(apiFn));

    // ------------------------------------------------------------------
    // 7. CloudFront distribution for the React dashboard (S3 origin, OAC).
    //    Skipped when enableCloudfront=false (unverified new accounts).
    // ------------------------------------------------------------------
    let distribution: cloudfront.Distribution | undefined;
    if (enableCloudfront) {
      distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
        defaultRootObject: 'index.html',
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        // SPA fallback so client-side routes work on refresh.
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
          },
        ],
      });
    }

    // ------------------------------------------------------------------
    // 8. EventBridge: nightly recompute pass at 03:00 UTC.
    // ------------------------------------------------------------------
    const nightly = new events.Rule(this, 'NightlyRecompute', {
      description: 'Nightly summary recompute pass',
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
    });
    nightly.addTarget(
      new targets.LambdaFunction(processor, {
        event: events.RuleTargetInput.fromObject({ action: 'recompute' }),
      }),
    );

    // ------------------------------------------------------------------
    // 9. EC2 ingest worker: t3.micro, public subnet, user-data bootstrap.
    //    Destroy the stack (or stop the instance) when not demoing to save
    //    the 750 free-tier hours/month.
    // ------------------------------------------------------------------
    const workerRole = new iam.Role(this, 'WorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Least-privilege role for the ReviewIntel ingest worker',
    });
    rawBucket.grantWrite(workerRole);
    ingestQueue.grantSendMessages(workerRole);

    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc,
      description: 'Ingest worker: outbound only (+ SSH for debugging)',
      allowAllOutbound: true,
    });
    // TODO: restrict SSH to your IP before any public demo.
    workerSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH (restrict in prod)');

    let userDataScript = fs.readFileSync(
      path.join(__dirname, '..', '..', 'worker', 'user-data.sh'),
      'utf8',
    );
    userDataScript = userDataScript
      .replaceAll('__RAW_BUCKET__', rawBucket.bucketName)
      .replaceAll('__QUEUE_URL__', ingestQueue.queueUrl);

    new ec2.Instance(this, 'IngestWorker', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true, // public subnet, no NAT needed
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: workerRole,
      securityGroup: workerSg,
      userData: ec2.UserData.custom(userDataScript),
    });

    // ------------------------------------------------------------------
    // 10. CloudWatch alarms (free tier: 10 alarms).
    // ------------------------------------------------------------------
    new cloudwatch.Alarm(this, 'ProcessorErrorsAlarm', {
      metric: processor.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'ReviewIntel processor Lambda reported errors',
    });
    new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Messages landed in the ingest DLQ — see runbook in DESIGN_DOC.md',
    });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: api.metricServerError({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: 'ReviewIntel API 5xx spike',
    });

    // ------------------------------------------------------------------
    // 11. Outputs.
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'SiteUrl', {
      value: enableCloudfront && distribution
        ? `https://${distribution.distributionDomainName}`
        : siteBucket.bucketWebsiteUrl,
    });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, 'RawBucketName', { value: rawBucket.bucketName });
    new cdk.CfnOutput(this, 'IngestQueueUrl', { value: ingestQueue.queueUrl });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
