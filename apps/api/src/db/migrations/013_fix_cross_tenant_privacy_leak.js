// Serious gap found while implementing search: memory_privacy and
// photo_privacy (010) never check family_group_id at all. As written, any
// memory or photo with is_private=false is visible to every authenticated
// person in every family group, not just the memory/photo's own family —
// tenant_isolation on `persons` doesn't help here since these are separate
// tables with their own SELECT policies, and Postgres RLS policies don't
// inherit checks from other tables' policies. This replaces both with a
// corrected version that ANDs in the same family_group_id check
// tenant_isolation uses on persons.
exports.up = async function (knex) {
  await knex.raw(`
    DROP POLICY IF EXISTS memory_privacy ON memories;
    CREATE POLICY memory_privacy ON memories
      FOR SELECT
      USING (
        family_group_id = current_setting('app.current_family_group_id', true)::uuid
        AND (retracted = false OR current_setting('app.acting_as_administrator', true) = 'true')
        AND (
          is_private = false
          OR contributor_id = current_setting('app.current_person_id', true)::uuid
          OR EXISTS (
            SELECT 1 FROM memory_persons mp
            WHERE mp.memory_id = memories.id
              AND mp.person_id = current_setting('app.current_person_id', true)::uuid
          )
        )
      );

    DROP POLICY IF EXISTS photo_privacy ON photos;
    CREATE POLICY photo_privacy ON photos
      FOR SELECT
      USING (
        family_group_id = current_setting('app.current_family_group_id', true)::uuid
        AND (
          is_private = false
          OR uploaded_by = current_setting('app.current_person_id', true)::uuid
          OR EXISTS (
            SELECT 1 FROM photo_persons pp
            WHERE pp.photo_id = photos.id
              AND pp.person_id = current_setting('app.current_person_id', true)::uuid
          )
        )
      );
  `);
};

exports.down = async function (knex) {
  // Restores the pre-fix (leaky) versions from 010 — down migrations exist
  // for symmetry, not because reverting to the leaky version is desirable.
  await knex.raw(`
    DROP POLICY IF EXISTS memory_privacy ON memories;
    CREATE POLICY memory_privacy ON memories
      FOR SELECT
      USING (
        (retracted = false OR current_setting('app.acting_as_administrator', true) = 'true')
        AND (
          is_private = false
          OR contributor_id = current_setting('app.current_person_id', true)::uuid
          OR EXISTS (
            SELECT 1 FROM memory_persons mp
            WHERE mp.memory_id = memories.id
              AND mp.person_id = current_setting('app.current_person_id', true)::uuid
          )
        )
      );

    DROP POLICY IF EXISTS photo_privacy ON photos;
    CREATE POLICY photo_privacy ON photos
      FOR SELECT
      USING (
        is_private = false
        OR uploaded_by = current_setting('app.current_person_id', true)::uuid
        OR EXISTS (
          SELECT 1 FROM photo_persons pp
          WHERE pp.photo_id = photos.id
            AND pp.person_id = current_setting('app.current_person_id', true)::uuid
        )
      );
  `);
};
