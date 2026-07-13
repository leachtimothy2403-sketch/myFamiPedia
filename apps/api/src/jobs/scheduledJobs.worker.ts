// Q_CRON from docs/system_architecture.mermaid — daily sweep covering:
//   - camera-roll scan triggers, question-stream prompts, manual-tier nudges (section2_pipeline.md)
//   - invitation grace-period expiry + re-invite window (invitation_flow.md)
//   - subscription grace/cold-storage/deletion lifecycle (data_model.md section 11 in the product doc)
// Reuses the same daily-sweep pattern for both invitation and subscription lifecycles —
// same job, different tables, no need for a second scheduler.
export async function runDailySweep(): Promise<void> {
  throw new Error("Not implemented — see docs/invitation_flow.md and docs/section2_pipeline.md");
}
