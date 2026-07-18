// AWS Rekognition DetectLabels — stage 1 of the two-stage scene
// classification pipeline (docs/photo_pipeline_beta_architecture.md section
// 5). Structurally different, non-biometric Rekognition API from
// vision.service.ts's DetectFaces/DeleteFaces — stateless, single-image, no
// collection, no enrollment, nothing that identifies a person. Running this
// does not reopen the GDPR question closed in
// docs/family_administrator_and_privacy_model.md section 5.
import { DetectLabelsCommand } from "@aws-sdk/client-rekognition";
import { getRekognitionClient } from "./rekognitionClient";

export interface SceneLabel {
  label: string;
  confidence: number; // 0-100, Rekognition's convention
}

export interface SceneLabelsService {
  /** DetectLabels — generic scene/object labels, no identity. */
  detectLabels(imageBytes: Buffer): Promise<SceneLabel[]>;
}

// MinConfidence 50 is a permissive request-level floor (cheaper — Rekognition
// doesn't bother returning near-noise labels) well below
// LABEL_CONFIDENCE_THRESHOLD (80, the actual triage bar below) so there's
// still room to tune the real threshold down later without re-querying.
const REQUEST_MIN_CONFIDENCE = 50;
const MAX_LABELS = 25;

class RekognitionSceneLabelsService implements SceneLabelsService {
  async detectLabels(imageBytes: Buffer): Promise<SceneLabel[]> {
    const res = await getRekognitionClient().send(
      new DetectLabelsCommand({
        Image: { Bytes: imageBytes },
        MaxLabels: MAX_LABELS,
        MinConfidence: REQUEST_MIN_CONFIDENCE,
      })
    );
    return (res.Labels ?? [])
      .filter((l) => l.Name && l.Confidence !== undefined)
      .map((l) => ({ label: l.Name!, confidence: l.Confidence! }));
  }
}

export const sceneLabelsService: SceneLabelsService = new RekognitionSceneLabelsService();

// Stage 1's curated "moment" allowlist and confidence bar. Explicitly
// flagged as an open item in the design doc ("needs a first pass against
// real sample photos, not something to hardcode confidently"); this is a
// working starting point so the pipeline is testable end to end, not a
// settled product decision.
export const CANDIDATE_LABEL_ALLOWLIST = [
  "Birthday",
  "Wedding",
  "Graduation",
  "Cake",
  "Party",
  "Beach",
  "Celebration",
  "Holiday",
  "Gathering",
  "Reunion",
  "Anniversary",
];
export const LABEL_CONFIDENCE_THRESHOLD = 80;

export function passesTriage(labels: SceneLabel[]): boolean {
  return labels.some((l) => l.confidence >= LABEL_CONFIDENCE_THRESHOLD && CANDIDATE_LABEL_ALLOWLIST.includes(l.label));
}
