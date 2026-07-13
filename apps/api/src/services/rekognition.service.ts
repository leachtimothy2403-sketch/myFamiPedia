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
