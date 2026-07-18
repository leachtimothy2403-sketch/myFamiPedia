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

// Human-readable labels for the notification_type values the pipeline
// dispatches (see apps/api/src/routes/notifications.routes.ts's
// NOTIFICATION_TYPES and jobs/scheduledJobs.worker.ts / memories.routes.ts
// for where each is actually sent). Shared so web and mobile's settings
// screens show the same wording instead of the raw snake_case type — those
// were previously rendering `s.notificationType` directly.
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  review_cards_ready: "New photos ready to review",
  manual_tier_nudge: "Reminders to check in on a manual-tier profile",
  question_prompt_ready: "New interview question prompts",
  memory_retracted: "A memory was retracted",
  memory_restore_requested: "A retracted memory's restore was requested",
};

export function notificationTypeLabel(notificationType: string): string {
  return NOTIFICATION_TYPE_LABELS[notificationType] ?? notificationType;
}
