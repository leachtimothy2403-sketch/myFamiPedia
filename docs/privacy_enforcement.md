# myFamiPedia — Privacy Enforcement at the Database Level

The product doc's hard rules (privacy tier is self-owned, administrators have a fixed and non-extendable permission set, pending members are biometrically invisible) are enforced with Postgres Row-Level Security, not just controller-layer checks. Rationale: a bug in one Express route shouldn't be able to leak another family's data or let an administrator overreach — the database itself refuses the query.

## Session context

Express auth middleware, after verifying the JWT, opens the request's DB transaction with:
```sql
SET LOCAL app.current_person_id = '<uuid>';
SET LOCAL app.current_family_group_id = '<uuid>';
```
Every RLS policy below reads these via `current_setting('app.current_person_id')`.

## Row-Level Security policies

```sql
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE holding_space ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE flags ENABLE ROW LEVEL SECURITY;

-- Tenant isolation, applies everywhere
CREATE POLICY tenant_isolation ON persons
  USING (family_group_id = current_setting('app.current_family_group_id')::uuid);

-- Opted-out persons: visible as non-clickable stub only (name only, no profile_data)
-- enforced via a column-masking view rather than row exclusion, since the tree
-- still needs to render their node.
CREATE VIEW persons_tree_view AS
  SELECT id, family_group_id, status,
         CASE WHEN status = 'opted_out' THEN NULL ELSE profile_data END AS profile_data,
         CASE WHEN status = 'opted_out' THEN NULL ELSE ai_summary END AS ai_summary
  FROM persons;

-- Privacy tier: only the person themselves can write it. No administrator exception.
CREATE POLICY privacy_tier_self_write ON persons
  FOR UPDATE
  USING (id = current_setting('app.current_person_id')::uuid OR
         -- allow the update statement through for OTHER columns...
         true)
  WITH CHECK (
    -- ...but reject if privacy_tier is being changed by anyone but the owner
    privacy_tier IS NOT DISTINCT FROM (SELECT privacy_tier FROM persons p2 WHERE p2.id = persons.id)
    OR id = current_setting('app.current_person_id')::uuid
  );

-- Holding space: visible only to the source (inviting) person — "X moments waiting" is private
CREATE POLICY holding_space_owner_only ON holding_space
  FOR SELECT
  USING (source_person_id = current_setting('app.current_person_id')::uuid);

-- Invitations: grace-period countdown is inviter-private
CREATE POLICY invitation_visibility ON invitations
  FOR SELECT
  USING (invited_by_person_id = current_setting('app.current_person_id')::uuid
         OR person_id = current_setting('app.current_person_id')::uuid); -- the invitee can see their own invite

-- Voice consent: only the person themselves can move status to 'consented'
CREATE POLICY voice_consent_self_only ON voice_models
  FOR UPDATE
  WITH CHECK (
    consent_status IS DISTINCT FROM 'consented'
    OR person_id = current_setting('app.current_person_id')::uuid
  );

-- Private memories: visible to contributor + tagged persons only.
-- Retracted memories are additionally hidden from everyone except the
-- administrator's retraction-review queue, regardless of privacy tier.
CREATE POLICY memory_privacy ON memories
  FOR SELECT
  USING (
    (retracted = false OR current_setting('app.acting_as_administrator', true) = 'true')
    AND (
      is_private = false
      OR contributor_id = current_setting('app.current_person_id')::uuid
      OR EXISTS (
        SELECT 1 FROM memory_persons mp
        WHERE mp.memory_id = memories.id
          AND mp.person_id = current_setting('app.current_person_id')::uuid
      )
    )
  );

-- Retraction and restoration: only the original contributor can flip
-- `retracted` in either direction. An administrator can set up a restore
-- request (a notification, not a write to this column) but cannot undo
-- a retraction unilaterally — matches "cannot override a retraction
-- without the original contributor's consent."
CREATE POLICY memory_retraction_self_only ON memories
  FOR UPDATE
  WITH CHECK (
    retracted IS NOT DISTINCT FROM (SELECT retracted FROM memories m2 WHERE m2.id = memories.id)
    OR contributor_id = current_setting('app.current_person_id')::uuid
  );

-- Private photos: same rule, mirrors memory_privacy so the multimodal search
-- union (see search doc) can't leak a private photo through the image-search leg
CREATE POLICY photo_privacy ON photos
  FOR SELECT
  USING (
    is_private = false
    OR uploaded_by = current_setting('app.current_person_id')::uuid
    OR EXISTS (
      SELECT 1 FROM photo_persons pp
      WHERE pp.photo_id = photos.id
        AND pp.person_id = current_setting('app.current_person_id')::uuid
    )
  );
```

## Administrator boundary — trigger, not just RLS

RLS handles *visibility* and *who can write a given column*, but the "administrator cannot..." list from the product doc (can't delete original recordings, can't change provenance labels, can't retroactively erase built voice/consent history, can't touch another member's privacy tier) is column-immutability, which is cleaner as a trigger than a policy:

```sql
CREATE OR REPLACE FUNCTION enforce_administrator_limits() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_admin_guard
  BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION enforce_administrator_limits();
```
Express sets `app.acting_as_administrator = 'true'` only when the request is explicitly using an admin-scoped endpoint (e.g. `PATCH /flags/:id`), so normal self-edits never trip this check.

Administrators never get a DELETE path at all — `disputed = true` (flag, preserves the memory) and the `flags` moderation queue are their only tools. Contributors do get a real `DELETE /memories/:id`, but it's gated to unlinked/unreacted, non-voice, non-posthumous memories per the deletion policy above (data model doc); anything else routes to retraction instead. Voice-provenance rows are blocked from hard delete at the trigger level regardless of who's asking, including the contributor themselves. Beyond that, the one other real deletion path (90-day grace expiry, opt-out, subscription cold-storage) runs exclusively from the `Q_CRON` worker under a service role that bypasses RLS by design — application code never gets that path, only the scheduled job does.

## Face-recognition boundary (recap from media pipeline doc)

The GDPR "no processing before consent" rule isn't a permissions check at all — it's structural: the Rekognition/Vision face collection per family group only ever receives enrollments for `status = 'active'` persons. There's no query or trigger to bypass because there's no code path that enrolls a non-active person in the first place.
