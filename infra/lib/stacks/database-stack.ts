import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DatabaseStack extends cdk.Stack {
  public readonly videosTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.videosTable = new dynamodb.Table(this, 'VideosTable', {
      tableName: 'cloudclips-videos',
      partitionKey: { name: 'videoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // GSI: query videos by user
    this.videosTable.addGlobalSecondaryIndex({
      indexName: 'userId-createdAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: query published videos for feed (sorted by recency)
    this.videosTable.addGlobalSecondaryIndex({
      indexName: 'status-createdAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Outputs
    new cdk.CfnOutput(this, 'VideosTableName', { value: this.videosTable.tableName });
    new cdk.CfnOutput(this, 'VideosTableArn', { value: this.videosTable.tableArn });
  }
}
