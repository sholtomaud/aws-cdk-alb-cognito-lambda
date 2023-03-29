import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { Alias, CfnParametersCode, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LambdaDeploymentConfig, LambdaDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import { LambdaTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { AuthenticateCognitoAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export class AwsCdkAlbCognitoLambdaStack extends cdk.Stack {
  public readonly lambdaCode: CfnParametersCode;
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Used for Blue/Green CDKPipelines
    this.lambdaCode = Code.fromCfnParameters();

    // const domainName = '<your.domain.com>';
    // const cognitoDomain = '<some-cognito-domain>';
    // const domainCert = acm.Certificate.fromCertificateArn(this, 'Certificate', '<your-cert-arn>');

    const zone = route53.HostedZone.fromLookup(this, `HostedZone`, { domainName });

    // Create a VPC
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
    });

    // Create a security group for the ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    // Create an ALB 
    const lb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // S3 bucket for storing ALB access logs
    const loggingBucket = new s3.Bucket(this, `ALBAccessLogs`);

    lb.logAccessLogs(loggingBucket, 'Prefix');

    const tg = new elbv2.ApplicationTargetGroup(this, `TargetGroup`, {
      vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targetGroupName: `ApplicationTargetGroup`,
    })

    new route53.ARecord(this, `ARecord`, {
      zone: zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(lb))
    });

    // Create a Cognito user pool for authentication
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      userVerification: {
        emailSubject: 'Verify your email for our app',
        emailBody: 'Hello,\n\nThanks for signing up to our app! Your verification code is {####}\n\n',
        emailStyle: cognito.VerificationEmailStyle.CODE
      },
      signInAliases: {
        username: true,
        preferredUsername: true,
        email: false,
      },
      autoVerify: {
        email: true
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
        requireUppercase: true
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });


    const userPoolClient = new cognito.UserPoolClient(this, 'Client', {
      userPool,
      generateSecret: true,
      authFlows: {
        userPassword: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.PHONE,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.COGNITO_ADMIN,
          cognito.OAuthScope.PROFILE
        ],
        callbackUrls: [
          `https://${domainName}/oauth2/idpresponse`,
        ],
      },
    });

    const userPoolDomain = userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomain,
      }
    });


    // --------------------------------------------------------------------------------------
    // LAMBDA
    // --------------------------------------------------------------------------------------
    const lambdaRole = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), // required
    });

    const func = new NodejsFunction(this, `lambda`, {
      vpc: vpc,
      handler: 'handler',
      memorySize: 1024,
      runtime: Runtime.NODEJS_18_X,
      description: `Function generated on: ${new Date().toISOString()}`, // required for blue/green deployment of Lambda
      environment: {
        USER_POOL_ID: userPool.userPoolId,
      },
      role: lambdaRole
    });

    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonCognitoReadOnly"));
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"));
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchFullAccess"));
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSLambdaExecute"));
    lambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"));

    // Needed for CodePipeline
    const alias = new Alias(this, 'LambdaAlias', {
      aliasName: 'PoC',
      version: func.currentVersion,
    });

    new LambdaDeploymentGroup(this, 'DeploymentGroup', {
      alias,
      deploymentConfig: LambdaDeploymentConfig.ALL_AT_ONCE
    });

    // Setup target and target group
    const target = new LambdaTarget(func);

    tg.addTarget(target);

    const listener = lb.addListener(`ALBListener`, {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      open: true,
      certificates: [domainCert],
      defaultAction: new AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([tg])
      }),
    });

    listener.connections.allowDefaultPortFromAnyIpv4('Open to the world');

    // Output the User Pool App Client ID
    new cdk.CfnOutput(this, 'CognitoIDPUserPoolClientOut', {
      value: userPoolClient.userPoolClientId,
      exportName: 'CognitoIDPUserPoolClientId'
    });

    // Output the ARN of the certificate
    new cdk.CfnOutput(this, 'CertificateArn', {
      value: domainCert.toString()
    });

    // Output the ARN of the certificate
    new cdk.CfnOutput(this, 'URL', {
      value: cognitoDomain
    });

    // Output the ARN of the certificate
    new cdk.CfnOutput(this, 'ALBCoutput', {
      value: lb.loadBalancerDnsName.toString()
    });

  }
}
