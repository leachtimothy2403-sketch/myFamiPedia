export type PhotoSource = "camera_roll" | "physical_scan" | "interview_prompt" | "manual_upload";
export type IdentificationStatus = "auto_matched" | "confirmed" | "pending";

export interface Photo {
  id: string;
  familyGroupId: string;
  r2Key: string;
  uploadedBy: string;
  takenAt: string | null;
  isPrivate: boolean;
  source: PhotoSource;
  createdAt: string;
}

export interface FaceBoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PhotoPerson {
  photoId: string;
  personId: string;
  faceCoordinates: FaceBoundingBox | null;
  identificationStatus: IdentificationStatus;
}
