// Face detection / recognition — AWS Rekognition (or GCP Vision) collection-based
// matching. See docs/media_pipeline.md section 2 for the full worker contract
// this interface exists to support, and section 4/5 for the collection-scope
// privacy rule this is built around: only `persons.status = 'active'` members
// are ever indexed (ExternalImageId = person.id), so a "match" always resolves
// straight to a person row with zero extra lookup tables needed.
//
// Real implementation needs @aws-sdk/client-rekognition (SigV4-signed calls,
// not plain REST — deliberately not hand-rolled here) and R2/S3 object bytes
// (see r2.service.ts's getObjectBuffer, itself not yet implemented for the
// same reason: needs @aws-sdk/client-s3 wired against real R2 credentials).
// Every method below throws until that dependency is added; the workers that
// call this are fully implemented and tested against a fake VisionService —
// only this boundary is a stub.

export interface FaceBox {
  boundingBox: { width: number; height: number; left: number; top: number };
  confidence: number;
}

export interface FaceMatch {
  externalImageId: string; // == persons.id, by convention (see module doc comment)
  similarity: number; // 0-100, Rekognition's convention
}

export interface VisionService {
  /** DetectFaces — bounding boxes only, no identity. */
  detectFaces(imageBytes: Buffer): Promise<FaceBox[]>;
  /** SearchFacesByImage against the family group's collection. */
  searchFacesByImage(collectionId: string, imageBytes: Buffer): Promise<FaceMatch[]>;
  /** IndexFaces — enrolls a face into the collection under externalImageId (== person id). */
  indexFace(collectionId: string, imageBytes: Buffer, externalImageId: string): Promise<void>;
  /** Removes all faces enrolled under externalImageId from the collection (opt-out / decline expiry). */
  deleteFaces(collectionId: string, externalImageId: string): Promise<void>;
  /** Creates the per-family-group collection if it doesn't already exist. Idempotent. */
  ensureCollection(collectionId: string): Promise<void>;
}

class NotConfiguredVisionService implements VisionService {
  private fail(op: string): never {
    throw new Error(
      `VisionService.${op} is not implemented — wire up @aws-sdk/client-rekognition ` +
        `(CreateCollection/DetectFaces/SearchFacesByImage/IndexFaces/DeleteFaces) against ` +
        `real AWS credentials. See docs/media_pipeline.md section 2.`
    );
  }
  detectFaces(): Promise<FaceBox[]> {
    this.fail("detectFaces");
  }
  searchFacesByImage(): Promise<FaceMatch[]> {
    this.fail("searchFacesByImage");
  }
  indexFace(): Promise<void> {
    this.fail("indexFace");
  }
  deleteFaces(): Promise<void> {
    this.fail("deleteFaces");
  }
  ensureCollection(): Promise<void> {
    this.fail("ensureCollection");
  }
}

export const visionService: VisionService = new NotConfiguredVisionService();

/** Family groups map 1:1 to Rekognition collections; this is the naming convention, not a lookup. */
export function collectionIdFor(familyGroupId: string): string {
  return `myfamipedia-${familyGroupId}`;
}
