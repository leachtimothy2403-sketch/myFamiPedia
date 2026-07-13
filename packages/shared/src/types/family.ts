export type SubscriptionStatus = "active" | "grace" | "cold_storage" | "deleted";

export interface FamilyGroup {
  id: string;
  name: string;
  payingMemberId: string | null;
  subscriptionStatus: SubscriptionStatus;
  gracePeriodEnd: string | null;
  coldStorageEnd: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  language: string;
  createdAt: string;
  lastLoginAt: string | null;
}
