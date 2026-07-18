// ORPHANED — nothing in src/ or tests/ imports this file (checked
// 2026-07-18). It's an earlier, superseded stub that predates
// vision.service.ts and sceneLabels.service.ts, which are the real,
// currently-wired-up Rekognition boundary files (DetectFaces/DeleteFaces and
// DetectLabels respectively — see docs/photo_pipeline_beta_architecture.md).
// This file's `searchFacesByImage`/`enrollFace` also describe the retired
// automated-matching design, which is permanently disabled (see
// docs/family_administrator_and_privacy_model.md section 5). Safe to delete
// (`rm apps/api/src/services/rekognition.service.ts`) — left in place only
// because this session's tooling couldn't remove the file directly.
//
// AWS Rekognition — face detection/matching. See docs/media_pipeline.md.
// IMPORTANT: only status='active' persons ever get enrolled into the family's
// collection — this is what makes "no biometric processing before consent" true
// structurally, not just as a policy. Do not add an enrollment path for any other status.
export async function detectFaces(_photoR2Key: string): Promise<{ boundingBoxes: unknown[] }> {
  throw new Error("Not implemented");
}

export async function searchFacesByImage(_familyGroupId: string, _photoR2Key: string): Promise<{ matches: unknown[] }> {
  throw new Error("Not implemented");
}

export async function enrollFace(_familyGroupId: string, _personId: string, _photoR2Key: string): Promise<void> {
  throw new Error("Not implemented");
}
