// Fixes a class of bug found while wiring up the background workers: several
// tables have RLS enabled (migration 010) but only ever got a SELECT (or
// SELECT+UPDATE) policy defined for them. Under real Postgres RLS, enabling
// RLS with no matching policy for a command denies that command outright —
// it doesn't fall through to "allowed." That means, against a real
// non-superuser DB role, every one of these already-shipped code paths would
// silently fail in production (pglite's tests can't catch this: its
// connection is always a superuser, which bypasses RLS entirely — see
// tests/helpers/testDb.ts):
//   - memories: no INSERT policy at all -> collection.routes.ts's proposed-
//     memory accept, and the new transcription/holding-space-drain workers,
//     could never actually create a memories row.
//   - photos: no INSERT policy at all -> collection.routes.ts's camera-roll
//     sync could never actually create a photos row.
//   - holding_space: no INSERT or UPDATE policy at all (only the SELECT-only
//     holding_space_owner_only) -> the face-detection worker's "naming
//     triggers invitation" flow and the holding-space-drain worker's archive
//     step would both be silently blocked.
//   - voice_models: no INSERT policy at all -> voice.routes.ts's
//     preview/consent flows could never create the first row for a person.
//   - flags: RLS enabled with ZERO policies of any kind -> moderation.routes.ts
//     would be entirely non-functional (SELECT included) in production.
//   - persons: tenant_isolation covers the normal (logged-in) update path,
//     but invitations.routes.ts's accept/decline handlers run under
//     withTokenContext (no app.current_person_id/current_family_group_id set
//     at all, by design — the caller isn't logged in) and need to flip
//     persons.status. There was no token-scoped policy for that, so
//     `persons.status -> 'active'` on accept would silently update zero rows.
//
// Also introduces `app.service_role`, a session GUC background workers set
// via db/pool.ts's withServiceContext (see that file's doc comment) instead
// of the person/family context a request has. Every policy below ORs it in.
exports.up = async function (knex) {
  await knex.raw(`
    -- persons: recreate tenant_isolation with the service-role bypass, and
    -- add a narrow token-scoped UPDATE policy for the accept/decline flow.
    DROP POLICY IF EXISTS tenant_isolation ON persons;
    CREATE POLICY tenant_isolation ON persons
      USING (
        family_group_id = current_setting('app.current_family_group_id', true)::uuid
        OR current_setting('app.service_role', true) = 'true'
      );

    CREATE POLICY persons_invitation_token_status_update ON persons
      FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM invitations i
          WHERE i.person_id = persons.id
            AND i.token = current_setting('app.invitation_lookup_token', true)
        )
      )
      WITH CHECK (true);

    -- memories: SELECT policy gets the service-role bypass; INSERT was
    -- entirely missing.
    DROP POLICY IF EXISTS memory_privacy ON memories;
    CREATE POLICY memory_privacy ON memories
      FOR SELECT
      USING (
        current_setting('app.service_role', true) = 'true'
        OR (
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
        )
      );

    CREATE POLICY memories_insert ON memories
      FOR INSERT
      WITH CHECK (
        current_setting('app.service_role', true) = 'true'
        OR family_group_id = current_setting('app.current_family_group_id', true)::uuid
      );

    -- photos: same pattern.
    DROP POLICY IF EXISTS photo_privacy ON photos;
    CREATE POLICY photo_privacy ON photos
      FOR SELECT
      USING (
        current_setting('app.service_role', true) = 'true'
        OR (
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
        )
      );

    CREATE POLICY photos_insert ON photos
      FOR INSERT
      WITH CHECK (
        current_setting('app.service_role', true) = 'true'
        OR family_group_id = current_setting('app.current_family_group_id', true)::uuid
      );

    -- holding_space: SELECT gets the bypass; INSERT (face-detection worker)
    -- and UPDATE (holding-space-drain worker's archive step) were both missing.
    DROP POLICY IF EXISTS holding_space_owner_only ON holding_space;
    CREATE POLICY holding_space_owner_only ON holding_space
      FOR SELECT
      USING (
        current_setting('app.service_role', true) = 'true'
        OR source_person_id = current_setting('app.current_person_id', true)::uuid
      );

    CREATE POLICY holding_space_insert ON holding_space
      FOR INSERT
      WITH CHECK (
        current_setting('app.service_role', true) = 'true'
        OR source_person_id = current_setting('app.current_person_id', true)::uuid
      );

    CREATE POLICY holding_space_service_update ON holding_space
      FOR UPDATE
      USING (current_setting('app.service_role', true) = 'true')
      WITH CHECK (current_setting('app.service_role', true) = 'true');

    -- voice_models: INSERT was entirely missing. docs/privacy_enforcement.md
    -- only calls for a write restriction on the consent_status escalation
    -- (voice_consent_self_only, FOR UPDATE, unchanged here) — it doesn't
    -- document any narrower rule for who may create the row in the first
    -- place (voice.routes.ts's "preview" moment is deliberately facilitator-
    -- operable, not self-only), so this only enforces tenant membership.
    CREATE POLICY voice_models_insert ON voice_models
      FOR INSERT
      WITH CHECK (
        current_setting('app.service_role', true) = 'true'
        OR EXISTS (
          SELECT 1 FROM persons p
          WHERE p.id = voice_models.person_id
            AND p.family_group_id = current_setting('app.current_family_group_id', true)::uuid
        )
      );

    -- flags: RLS was enabled with no policies at all, so every command
    -- (moderation.routes.ts's full surface) was silently denied. One
    -- ALL-commands policy, family-scoped via a join since flags has no
    -- family_group_id column of its own; fine-grained rules (reporter-only
    -- insert, admin-only resolution, appeal ownership) stay enforced at the
    -- app layer as they already were, matching this codebase's existing
    -- convention of RLS-for-tenant-isolation + app-layer-for-business-rules.
    CREATE POLICY flags_tenant_isolation ON flags
      USING (
        current_setting('app.service_role', true) = 'true'
        OR EXISTS (
          SELECT 1 FROM persons p
          WHERE p.id = flags.reporter_person_id
            AND p.family_group_id = current_setting('app.current_family_group_id', true)::uuid
        )
      );
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP POLICY IF EXISTS flags_tenant_isolation ON flags;
    DROP POLICY IF EXISTS voice_models_insert ON voice_models;
    DROP POLICY IF EXISTS holding_space_service_update ON holding_space;
    DROP POLICY IF EXISTS holding_space_insert ON holding_space;
    DROP POLICY IF EXISTS holding_space_owner_only ON holding_space;
    CREATE POLICY holding_space_owner_only ON holding_space
      FOR SELECT
      USING (source_person_id = current_setting('app.current_person_id', true)::uuid);

    DROP POLICY IF EXISTS photos_insert ON photos;
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

    DROP POLICY IF EXISTS memories_insert ON memories;
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

    DROP POLICY IF EXISTS persons_invitation_token_status_update ON persons;
    DROP POLICY IF EXISTS tenant_isolation ON persons;
    CREATE POLICY tenant_isolation ON persons
      USING (family_group_id = current_setting('app.current_family_group_id', true)::uuid);
  `);
};
