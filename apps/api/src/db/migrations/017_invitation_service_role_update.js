// Found while implementing the Q_CRON daily sweep (docs/invitation_flow.md's
// "Expiry (90 days, no action)"): both of invitations' UPDATE-applicable
// policies (011's invitation_update_by_inviter and
// invitation_public_token_access) require either app.current_person_id or
// app.invitation_lookup_token to match — neither has the app.service_role
// bypass introduced in migration 015. A background worker marking an
// expired invitation's status (no logged-in person, no token — this isn't
// a request at all) would be silently blocked under real RLS, invisible in
// tests for the same reason as every other bug in this class (pglite's
// connection is always a superuser).
exports.up = async function (knex) {
  await knex.raw(`
    DROP POLICY IF EXISTS invitation_update_by_inviter ON invitations;
    CREATE POLICY invitation_update_by_inviter ON invitations
      FOR UPDATE
      USING (
        current_setting('app.service_role', true) = 'true'
        OR invited_by_person_id = current_setting('app.current_person_id', true)::uuid
      )
      WITH CHECK (
        current_setting('app.service_role', true) = 'true'
        OR invited_by_person_id = current_setting('app.current_person_id', true)::uuid
      );
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP POLICY IF EXISTS invitation_update_by_inviter ON invitations;
    CREATE POLICY invitation_update_by_inviter ON invitations
      FOR UPDATE
      USING (invited_by_person_id = current_setting('app.current_person_id', true)::uuid)
      WITH CHECK (invited_by_person_id = current_setting('app.current_person_id', true)::uuid);
  `);
};
