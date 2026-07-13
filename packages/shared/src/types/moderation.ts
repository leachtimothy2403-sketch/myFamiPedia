export type FlagContentType = "memory" | "photo";
export type FlagStatus = "open" | "removed" | "dismissed" | "appealed";

export interface Flag {
  id: string;
  contentType: FlagContentType;
  contentId: string;
  reporterPersonId: string;
  description: string;
  status: FlagStatus;
  resolution: string | null;
  createdAt: string;
}
