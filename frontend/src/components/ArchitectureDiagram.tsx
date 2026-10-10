/**
 * Placeholder for the architecture diagram.
 *
 * TODO: replace with the real diagram (export from your drawing tool as SVG
 * and drop it in src/assets/architecture.svg, then render it here).
 * The canonical sketch lives in the parent agent's chat widget and in
 * DESIGN_SKETCH.md at the workspace root.
 */
export default function ArchitectureDiagram() {
  return (
    <div className="diagram-placeholder">
      <strong>Architecture diagram goes here</strong>
      <p>
        EC2 worker → S3 + SQS → Lambda + Bedrock → DynamoDB → API Gateway + Lambda
        → React on S3/CloudFront. Ops: EventBridge, CloudWatch, CDK.
      </p>
    </div>
  );
}
