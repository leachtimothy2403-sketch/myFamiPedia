// docs/section2_pipeline.md section 3 (manual-tier nudge) needs to throttle
// itself so a tier-3 person past the 14-21 day threshold gets nudged once,
// not every single day the sweep runs until they add something manually.
// migration 012 added the equivalent last_review_notification_at for the
// tier-2 review-card cadence; this is the same idea for tier-3.
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons ADD COLUMN last_manual_tier_nudge_sent_at timestamptz;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons DROP COLUMN IF EXISTS last_manual_tier_nudge_sent_at;
  `);
};
