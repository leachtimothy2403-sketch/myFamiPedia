// Fills two gaps found while implementing the invitation lifecycle routes:
//
// 1. invitations had RLS enabled (010) with only a FOR SELECT policy. Since
//    Postgres denies any command with no matching policy once RLS is on,
//    INSERT/UPDATE on invitations were silently blocked entirely — creating
//    or accepting an invitation would fail no matter who ran it.
// 2. Accept/decline (docs/invitation_flow.md) are public, token-authenticated
//    routes with no logged-in person at all — there's no app.current_person_id
//    to check. They need their own session variable (app.invitation_lookup_token)
//    and a policy scoped to it, so a visitor can only ever see/act on the one
//    invitation row whose token they hold, not the whole table.
exports.up = async function (knex) {
  await knex.raw(`
    CREATE POLICY invitation_insert_by_inviter ON invitations
      FOR INSERT
      WITH CHECK (invited_by_person_id = current_setting('app.current_person_id', true)::uuid);

    CREATE POLICY invitation_update_by_inviter ON invitations
      FOR UPDATE
      USING (invited_by_person_id = current_setting('app.current_person_id', true)::uuid)
      WITH CHECK (invited_by_person_id = current_setting('app.current_person_id', true)::uuid);

    -- No FOR clause: applies to every command. Combined (OR'd) with the
    -- policies above/010's invitation_visibility for whichever command is
    -- being run, so a public token-holder can SELECT and UPDATE (accept/
    -- decline) their one row without needing app.current_person_id set at all.
    CREATE POLICY invitation_public_token_access ON invitations
      USING (token = current_setting('app.invitation_lookup_token', true))
      WITH CHECK (token = current_setting('app.invitation_lookup_token', true));
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP POLICY IF EXISTS invitation_public_token_access ON invitations;
    DROP POLICY IF EXISTS invitation_update_by_inviter ON invitations;
    DROP POLICY IF EXISTS invitation_insert_by_inviter ON invitations;
  `);
};
