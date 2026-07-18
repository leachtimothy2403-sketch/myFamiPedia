// Shared AWS Rekognition client. vision.service.ts (DetectFaces, legacy-
// collection cleanup) and sceneLabels.service.ts (DetectLabels, scene
// classification stage 1) call different APIs on the same underlying
// Rekognition service, so they share one client/credential-check here
// instead of each instantiating their own — same reasoning r2.service.ts
// uses a single S3Client for every R2 operation.
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { env } from "../config/env";

let client: RekognitionClient | null = null;

export function getRekognitionClient(): RekognitionClient {
  if (client) return client;
  if (!env.aws.accessKeyId || !env.aws.secretAccessKey) {
    throw new Error(
      "AWS Rekognition credentials are not configured — set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION in .env"
    );
  }
  client = new RekognitionClient({
    region: env.aws.region,
    credentials: {
      accessKeyId: env.aws.accessKeyId,
      secretAccessKey: env.aws.secretAccessKey,
    },
  });
  return client;
}

/** Test-only escape hatch — lets a test reset the cached client between runs. */
export function resetRekognitionClientForTests(): void {
  client = null;
}
