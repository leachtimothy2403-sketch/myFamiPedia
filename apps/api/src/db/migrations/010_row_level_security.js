// Translates docs/privacy_enforcement.md into actual RLS policies + triggers.
// The Express auth middleware (src/middleware/auth.ts) sets these per-request:
//   SET LOCAL app.current_person_id
//   SET LOCAL app.current_family_group_id
//   SET LOCAL app.acting_as_administrator   (only on admin-scoped routes)
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
    ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
    ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE holding_space ENABLE ROW LEVEL SECURITY;
    ALTER TABLE voice_models ENABLE ROW LEVEL SECURITY;
    ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE flags ENABLE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON persons
      USING (family_group_id = current_setting('app.current_family_group_id', true)::uuid);

    CREATE VIEW persons_tree_view AS
      SELECT id, family_group_id, status,
             CASE WHEN status = 'opted_out' THEN NULL ELSE profile_data END AS profile_data,
             CASE WHEN status = 'opted_out' THEN NULL ELSE ai_summary END AS ai_summary
      FROM persons;

    CREATE POLICY privacy_tier_self_write ON persons
      FOR UPDATE
      USING (true)
      WITH CHECK (
        privacy_tier IS NOT DISTINCT FROM (SELECT privacy_tier FROM persons p2 WHERE p2.id = persons.id)
        OR id = current_setting('app.current_person_id', true)::uuid
      );

    CREATE POLICY holding_space_owner_only ON holding_space
      FOR SELECT
      USING (source_person_id = current_setting('app.current_person_id', true)::uuid);

    CREATE POLICY invitation_visibility ON invitations
      FOR SELECT
      USING (
        invited_by_person_id = current_setting('app.current_person_id', true)::uuid
        OR person_id = current_setting('app.current_person_id', true)::uuid
      );

    CREATE POLICY voice_consent_self_only ON voice_models
      FOR UPDATE
      WITH CHECK (
        consent_status IS DISTINCT FROM 'consented'
        OR person_id = current_setting('app.current_person_id', true)::uuid
      );

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

    CREATE POLICY memory_retraction_self_only ON memories
      FOR UPDATE
      WITH CHECK (
        retracted IS NOT DISTINCT FROM (SELECT retracted FROM memories m2 WHERE m2.id = memories.id)
        OR contributor_id = current_setting('app.current_person_id', true)::uuid
      );

    -- Administrator column-immutability guard: RLS handles row visibility/writability,
    -- this trigger handles the "cannot change provenance" hard rule regardless of policy gaps.
    CREATE OR REPLACE FUNCTION enforce_administrator_limits() RETURNS trigger AS $BODY$
    BEGIN
      IF current_setting('app.acting_as_administrator', true) = 'true' THEN
        IF NEW.provenance_type IS DISTINCT FROM OLD.provenance_type
           OR NEW.provenance_label IS DISTINCT FROM OLD.provenance_label
           OR NEW.contributor_id IS DISTINCT FROM OLD.contributor_id THEN
          RAISE EXCEPTION 'Administrators cannot modify provenance';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $BODY$ LANGUAGE plpgsql;

    CREATE TRIGGER memories_admin_guard
      BEFORE UPDATE ON memories
      FOR EACH ROW EXECUTE FUNCTION enforce_administrator_limits();
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP TRIGGER IF EXISTS memories_admin_guard ON memories;
    DROP FUNCTION IF EXISTS enforce_administrator_limits();
    DROP POLICY IF EXISTS memory_retraction_self_only ON memories;
    DROP POLICY IF EXISTS photo_privacy ON photos;
    DROP POLICY IF EXISTS memory_privacy ON memories;
    DROP POLICY IF EXISTS voice_consent_self_only ON voice_models;
    DROP POLICY IF EXISTS invitation_visibility ON invitations;
    DROP POLICY IF EXISTS holding_space_owner_only ON holding_space;
    DROP POLICY IF EXISTS privacy_tier_self_write ON persons;
    DROP VIEW IF EXISTS persons_tree_view;
    DROP POLICY IF EXISTS tenant_isolation ON persons;
  `);
};
