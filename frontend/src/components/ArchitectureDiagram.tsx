import architectureSvg from './architecture.svg';

/**
 * Renders the ReviewIntel system architecture diagram.
 * The diagram source lives in ./architecture.svg (also copied to docs/
 * at the repo root for the README).
 */
export default function ArchitectureDiagram() {
  return (
    <figure className="architecture-diagram">
      <img
        src={architectureSvg}
        alt="ReviewIntel system architecture: EC2 ingest worker to S3 and SQS, Lambda plus Bedrock into DynamoDB, served by API Gateway and a React dashboard on S3, with EventBridge, CloudWatch, and budget ops"
      />
      <figcaption>
        Live deployment in us-east-1, served over HTTPS via CloudFront.
      </figcaption>
    </figure>
  );
}
