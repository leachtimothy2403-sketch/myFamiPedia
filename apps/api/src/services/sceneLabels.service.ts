// AWS Rekognition DetectLabels — stage 1 of the two-stage scene
// classification pipeline (docs/photo_pipeline_beta_architecture.md section
// 5). Structurally different, non-biometric Rekognition API from
// vision.service.ts's SearchFacesByImage/IndexFaces — stateless,
// single-image, no collection, no enrollment, nothing that identifies a
// person. Running this does not reopen the GDPR question closed in
// docs/family_administrator_and_privacy_model.md section 5.
//
// Real implementation needs @aws-sdk/client-rekognition — same dependency
// vision.service.ts is already waiting on. Every method below throws until
// that's wired up against real AWS credentials, same stub pattern as that
// file (the worker that calls this is fully implemented and tested against
// a fake SceneLabelsService; only this boundary is a stub).

export interface SceneLabel {
  label: string;
  confidence: number; // 0-100, Rekognition's convention
}

export interface SceneLabelsService {
  /** DetectLabels — generic scene/object labels, no identity. */
  detectLabels(imageBytes: Buffer): Promise<SceneLabel[]>;
}

class NotConfiguredSceneLabelsService implements SceneLabelsService {
  detectLabels(): Promise<SceneLabel[]> {
    throw new Error(
      "SceneLabelsService.detectLabels is not implemented — wire up @aws-sdk/client-rekognition's " +
        "DetectLabels against real AWS credentials. See docs/photo_pipeline_beta_architecture.md section 5."
    );
  }
}

export const sceneLabelsService: SceneLabelsService = new NotConfiguredSceneLabelsService();

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
