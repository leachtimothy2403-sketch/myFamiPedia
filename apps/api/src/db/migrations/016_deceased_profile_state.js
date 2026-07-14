// Unblocks persons.routes.ts's Section 4 (posthumous contribution) routes,
// left as stubs in an earlier pass — see docs/api_structure.md's "Posthumous
// contribution (Section 4)" table: POST /persons/deceased creates a profile
// in "collecting memories" state, PATCH /persons/:id/state moves it
// collecting <-> complete. persons.status already has a 'deceased' value,
// but nothing tracked which of those two sub-states a deceased profile was
// in — this adds that as its own column rather than overloading
// profile_data (which is life-fact tags / "who she was" content, not state
// machine data).
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons ADD COLUMN deceased_profile_state text
      CHECK (deceased_profile_state IN ('collecting', 'complete'));
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE persons DROP COLUMN IF EXISTS deceased_profile_state;`);
};
