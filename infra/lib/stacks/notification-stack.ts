import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export class NotificationStack extends cdk.Stack {
  public readonly processingTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Central topic for video processing pipeline events
    // Events: TRANSCODE_COMPLETE, MODERATION_COMPLETE, VIDEO_PUBLISHED, VIDEO_QUARANTINED
    this.processingTopic = new sns.Topic(this, 'ProcessingTopic', {
      topicName: 'cloudclips-processing-events',
      displayName: 'CloudClips Video Processing Events',
    });

    // TODO: Add SES email subscription Lambda for user notifications
    // Will be wired up when the notify Lambda is implemented

    // Outputs
    new cdk.CfnOutput(this, 'ProcessingTopicArn', { value: this.processingTopic.topicArn });
  }
}
