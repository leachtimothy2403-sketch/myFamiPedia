// Retires privacy_tier = 1. It originally meant "collect everything,
// auto-submit — no review step" (docs/section2_pipeline.md section 1's old
// tier table), which depended on automated face-matching to know whose
// review queue a candidate belonged to. Matching is permanently disabled
// (docs/family_administrator_and_privacy_model.md section 5), so nothing in
// the codebase has branched on privacy_tier === 1 since — the only
// remaining reference was the retired commitFaceMatch.ts, itself unused.
// Tiers 2 and 3 are untouched and keep exactly the behavior they have today
// (scheduledJobs.worker.ts's review-card cadence and manual-tier nudge,
// respectively) — this migration does not redefine what 2/3 mean, it only
// removes a selectable value that did nothing.
//
// NOT the same thing as the two-tier redefinition proposed in
// docs/family_administrator_and_privacy_model.md section 7 (which would
// repurpose the *remaining* values entirely for the trust-list tag-review
// window) — that redefinition depends on the trust-list feature itself,
// which was discussed and deliberately tabled on 2026-07-18
// (docs/photo_pipeline_beta_architecture.md's open items). This migration
// is a narrower, unrelated cleanup: retiring a dead value, not building the
// eventual replacement semantics.
exports.up = async function (knex) {
  await knex.raw(`
    UPDATE persons SET privacy_tier = 2 WHERE privacy_tier = 1;
    ALTER TABLE persons DROP CONSTRAINT IF EXISTS persons_privacy_tier_check;
    ALTER TABLE persons ADD CONSTRAINT persons_privacy_tier_check CHECK (privacy_tier IN (2,3));
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons DROP CONSTRAINT IF EXISTS persons_privacy_tier_check;
    ALTER TABLE persons ADD CONSTRAINT persons_privacy_tier_check CHECK (privacy_tier IN (1,2,3));
  `);
  // Data is not restored to 1 — which rows were originally 1 isn't
  // recoverable after the up-migration's backfill. Down only restores the
  // constraint shape, same convention as every other down-migration in this
  // set (schema reversal, not a full data-time-machine).
};
