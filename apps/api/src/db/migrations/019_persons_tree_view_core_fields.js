// persons_tree_view (migration 010) only ever exposed id/family_group_id/status
// plus the two privacy-masked columns (profile_data, ai_summary) — it never
// carried name/birth_date/death_date/user_id/privacy_tier/
// administrator_person_id/timestamps. Every handler that reads through this
// view (GET /family-groups/:id/tree, GET /persons/:id, GET /persons/:id/summary
// in persons.routes.ts) was therefore structurally unable to return a
// person's name.
//
// Caught while wiring up apps/web's tree view against the real API — nothing
// in the existing test suite asserts on `.name` for these three endpoints
// (tree.test.ts only checks `.id` and array lengths), so it shipped
// unnoticed. A family tree UI can't render without names, so this is a
// correctness fix, not a feature addition.
//
// DROP + CREATE rather than CREATE OR REPLACE: Postgres requires a replaced
// view's existing columns to keep the same name/position/type, and this
// reorders things, so REPLACE would fail.
exports.up = async function (knex) {
  await knex.raw(`
    DROP VIEW IF EXISTS persons_tree_view;
    CREATE VIEW persons_tree_view AS
      SELECT id, family_group_id, user_id, name, birth_date, death_date, status,
             privacy_tier, administrator_person_id,
             CASE WHEN status = 'opted_out' THEN NULL ELSE profile_data END AS profile_data,
             CASE WHEN status = 'opted_out' THEN NULL ELSE ai_summary END AS ai_summary,
             created_at, updated_at
      FROM persons;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP VIEW IF EXISTS persons_tree_view;
    CREATE VIEW persons_tree_view AS
      SELECT id, family_group_id, status,
             CASE WHEN status = 'opted_out' THEN NULL ELSE profile_data END AS profile_data,
             CASE WHEN status = 'opted_out' THEN NULL ELSE ai_summary END AS ai_summary
      FROM persons;
  `);
};
