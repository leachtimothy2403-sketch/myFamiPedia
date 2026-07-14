// Supports docs/media_pipeline.md section 3 step 4: "holding_space rows for
// this person are archived (kept for provenance) rather than deleted
// immediately" once the holding-space-drain worker processes them.
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE holding_space ADD COLUMN archived_at timestamptz;
    CREATE INDEX idx_holding_space_archived ON holding_space(person_id, archived_at);
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_holding_space_archived;
    ALTER TABLE holding_space DROP COLUMN IF EXISTS archived_at;
  `);
};
