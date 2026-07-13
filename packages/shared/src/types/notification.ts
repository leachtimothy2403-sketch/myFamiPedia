export interface Notification {
  id: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationSetting {
  userId: string;
  notificationType: string;
  enabled: boolean;
}
