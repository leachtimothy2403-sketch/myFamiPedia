export type InvitationStatus = "pending" | "accepted" | "declined" | "expired";

export interface Invitation {
  id: string;
  personId: string;
  invitedByPersonId: string;
  token: string;
  triggeringPhotoId: string | null;
  inviteeEmail: string | null;
  inviteePhone: string | null;
  status: InvitationStatus;
  declineAt: string | null;
  gracePeriodEnd: string | null;
  reinvited: boolean;
  createdAt: string;
}
