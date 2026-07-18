// Face detection — AWS Rekognition. See docs/media_pipeline.md section 2 for
// the full worker contract this interface exists to support.
//
// Automated face MATCHING (SearchFacesByImage/IndexFaces/collection
// enrollment) is permanently retired for this product — see
// docs/family_administrator_and_privacy_model.md section 5 (running
// biometric identification against family members, including bystanders who
// never consented, is GDPR Article 9 exposure that hasn't been cleared by
// counsel). This interface only covers what's actually still called:
// `detectFaces` (geometry only, no identity — not biometric identification
// data, no Article 9 exposure) for tap-to-tag, and `deleteFaces` for purging
// any legacy collection entries left over from before 2026-07-18, when
// matching was live and did enroll faces. `searchFacesByImage`, `indexFace`,
// and `ensureCollection` were trimmed from this interface —
// docs/photo_pipeline_beta_architecture.md already flagged them as dead code
// nothing calls anymore under the current design.
import { DetectFacesCommand, ListFacesCommand, DeleteFacesCommand } from "@aws-sdk/client-rekognition";
import { getRekognitionClient } from "./rekognitionClient";

export interface FaceBox {
  boundingBox: { width: number; height: number; left: number; top: number };
  confidence: number;
}

export interface VisionService {
  /** DetectFaces — bounding boxes only, no identity. */
  detectFaces(imageBytes: Buffer): Promise<FaceBox[]>;
  /**
   * Removes all faces enrolled under externalImageId (== person id) from the
   * collection, if any exist. Safe to call against a family that never had a
   * collection at all (any family created after matching was retired,
   * 2026-07-18) — a missing collection is treated as "nothing to delete,"
   * not an error, since that's the expected, common case going forward.
   */
  deleteFaces(collectionId: string, externalImageId: string): Promise<void>;
}

function isResourceNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "ResourceNotFoundException";
}

class RekognitionVisionService implements VisionService {
  async detectFaces(imageBytes: Buffer): Promise<FaceBox[]> {
    const res = await getRekognitionClient().send(new DetectFacesCommand({ Image: { Bytes: imageBytes } }));
    return (res.FaceDetails ?? [])
      .filter((f) => f.BoundingBox)
      .map((f) => ({
        boundingBox: {
          width: f.BoundingBox!.Width ?? 0,
          height: f.BoundingBox!.Height ?? 0,
          left: f.BoundingBox!.Left ?? 0,
          top: f.BoundingBox!.Top ?? 0,
        },
        confidence: f.Confidence ?? 0,
      }));
  }

  async deleteFaces(collectionId: string, externalImageId: string): Promise<void> {
    // Rekognition's DeleteFaces takes FaceIds, not an ExternalImageId filter
    // — ListFaces (paginated) is the only way to resolve one to the other.
    const faceIds: string[] = [];
    let nextToken: string | undefined;
    try {
      do {
        const res = await getRekognitionClient().send(
          new ListFacesCommand({ CollectionId: collectionId, NextToken: nextToken, MaxResults: 100 })
        );
        for (const face of res.Faces ?? []) {
          if (face.ExternalImageId === externalImageId && face.FaceId) faceIds.push(face.FaceId);
        }
        nextToken = res.NextToken;
      } while (nextToken);
    } catch (err) {
      if (isResourceNotFound(err)) return; // no collection ever existed for this family — nothing to clean up
      throw err;
    }

    if (faceIds.length === 0) return;
    await getRekognitionClient().send(new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: faceIds }));
  }
}

export const visionService: VisionService = new RekognitionVisionService();

/**
 * Family groups map 1:1 to Rekognition collections; this is the naming
 * convention, not a lookup. Only meaningful for legacy (pre-2026-07-18)
 * collections now — see `deleteFaces` above.
 */
export function collectionIdFor(familyGroupId: string): string {
  return `myfamipedia-${familyGroupId}`;
}
