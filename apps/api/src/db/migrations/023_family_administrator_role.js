// docs/family_administrator_and_privacy_model.md section 1 — the family-group
// administrator role, separate from family_groups.paying_member_id (billing)
// and from the existing per-deceased-profile persons.administrator_person_id
// (scoped to a single profile's collecting/complete state, untouched here).
//
// A plain column on persons, per the design doc's reasoning: family_group_id
// is already a single required FK (one person belongs to exactly one family
// group), so a column is the simplest thing that fits the existing pattern —
// privacy_tier and administrator_person_id are both already plain columns on
// this same table. A membership table would only earn its complexity if a
// person could ever belong to more than one family group, which nothing here
// anticipates.
//
// "Ship with exactly one administrator per family group, transferable by the
// current one" (design doc section 1) is enforced at the DB level, not just
// app logic — a partial unique index makes a second administrator row in the
// same family group impossible to insert, the same defense-in-depth pattern
// already used elsewhere in this schema (the voice-memory hard-delete
// trigger, the privacy_tier_self_write RLS policy).
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons ADD COLUMN family_role text CHECK (family_role IN ('administrator'));
    CREATE UNIQUE INDEX idx_persons_one_administrator_per_family
      ON persons(family_group_id) WHERE family_role = 'administrator';
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_persons_one_administrator_per_family;
    ALTER TABLE persons DROP COLUMN IF EXISTS family_role;
  `);
};
