# myFamiPedia — Detailed Data Model

PostgreSQL, `pgvector` extension enabled. All tables carry `created_at timestamptz default now()`; updated_at added where rows mutate after creation. UUIDs (`uuid default gen_random_uuid()`) as primary keys throughout.

```sql
-- Family / account scope
CREATE TABLE family_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  paying_member_id uuid, -- FK to users, added after users table
  subscription_status text NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('active','grace','cold_storage','deleted')),
  grace_period_end timestamptz,
  cold_storage_end timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  created_at timestamptz DEFAULT now(),
  last_login_at timestamptz
);

ALTER TABLE family_groups
  ADD CONSTRAINT fk_paying_member FOREIGN KEY (paying_member_id) REFERENCES users(id);

-- Core tree
CREATE TABLE persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id uuid NOT NULL REFERENCES family_groups(id),
  user_id uuid REFERENCES users(id), -- null until/unless person is an active app user
  name text NOT NULL,
  birth_date date,
  death_date date,
  status text NOT NULL DEFAULT 'invited_pending'
    CHECK (status IN ('active','invited_pending','declined_grace','opted_out','deceased')),
  privacy_tier smallint CHECK (privacy_tier IN (1,2,3)), -- self-owned, see task 9
  administrator_person_id uuid REFERENCES persons(id),
  profile_data jsonb DEFAULT '{}', -- life-fact tags, "who she was" fields
  ai_summary text, -- cached AI-generated paragraph, always rendered with AI label in UI
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX idx_persons_family_group ON persons(family_group_id);
CREATE INDEX idx_persons_status ON persons(status);

CREATE TABLE relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_a_id uuid NOT NULL REFERENCES persons(id),
  person_b_id uuid NOT NULL REFERENCES persons(id),
  relationship_type text NOT NULL, -- parent_of, spouse_of, sibling_of, etc.
  created_at timestamptz DEFAULT now(),
  UNIQUE (person_a_id, person_b_id, relationship_type)
);
CREATE INDEX idx_relationships_a ON relationships(person_a_id);
CREATE INDEX idx_relationships_b ON relationships(person_b_id);

-- Memories & media
CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id uuid NOT NULL REFERENCES family_groups(id),
  contributor_id uuid NOT NULL REFERENCES persons(id),
  content text,
  media_url text, -- R2 key, nullable for text-only memories
  event_date date,
  provenance_type text NOT NULL
    CHECK (provenance_type IN ('voice','photo','text','ai_generated')),
  provenance_label text, -- e.g. "Recorded by Marie with Hélène, March 2026" — display cache
  is_private boolean NOT NULL DEFAULT false,
  disputed boolean NOT NULL DEFAULT false, -- administrator flag, memory preserved either way
  retracted boolean NOT NULL DEFAULT false, -- contributor-initiated soft delete, see notes below
  retracted_at timestamptz,
  is_posthumous_contribution boolean NOT NULL DEFAULT false, -- set true when contributed via section 4 (deceased profile)
  embedding vector(1024), -- voyage-multimodal-3.5 text-mode embedding, see task 8
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_memories_family_group ON memories(family_group_id);
CREATE INDEX idx_memories_event_date ON memories(event_date);
CREATE INDEX idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_memories_content_fts ON memories USING GIN (to_tsvector('simple', coalesce(content,'')));

-- Original voice recordings are never deletable by anyone, contributor included.
-- This is a hard backstop below the app-level eligibility check (see notes below
-- and the API/privacy docs) — even a future buggy admin tool can't slip past it.
CREATE OR REPLACE FUNCTION block_voice_memory_deletion() RETURNS trigger AS $$
BEGIN
  IF OLD.provenance_type = 'voice' THEN
    RAISE EXCEPTION 'Voice-provenance memories cannot be hard-deleted, only retracted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_block_voice_delete
  BEFORE DELETE ON memories
  FOR EACH ROW EXECUTE FUNCTION block_voice_memory_deletion();

CREATE TABLE memory_persons (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id),
  PRIMARY KEY (memory_id, person_id)
);

-- A memory (e.g. a life-story answer) can be illustrated by 0+ photos;
-- a photo (e.g. a digitized physical print) can illustrate 0+ memories over time.
CREATE TABLE memory_photos (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, photo_id)
);

CREATE TABLE reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id),
  reaction_type text NOT NULL, -- 'touched_me' | 'i_remember_this_too'
  created_at timestamptz DEFAULT now(),
  UNIQUE (memory_id, person_id, reaction_type)
);

CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_group_id uuid NOT NULL REFERENCES family_groups(id),
  r2_key text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES persons(id),
  taken_at timestamptz,
  is_private boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'camera_roll'
    CHECK (source IN ('camera_roll','physical_scan','interview_prompt','manual_upload')),
  embedding vector(1024), -- voyage-multimodal-3.5 image-mode embedding, same space as memories.embedding
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_photos_embedding ON photos USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE photo_persons (
  photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES persons(id),
  face_coordinates jsonb, -- bounding box from Rekognition/Vision
  identification_status text NOT NULL DEFAULT 'pending'
    CHECK (identification_status IN ('auto_matched','confirmed','pending')),
  PRIMARY KEY (photo_id, person_id)
);

-- Section 2: automatic collection review queue
CREATE TABLE proposed_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons(id), -- profile owner (device owner)
  photo_id uuid REFERENCES photos(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected')),
  created_at timestamptz DEFAULT now()
);

-- Pending-member data isolation (GDPR)
CREATE TABLE holding_space (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons(id), -- the not-yet-consented person
  source_person_id uuid NOT NULL REFERENCES persons(id), -- who added/tagged it
  media_type text NOT NULL CHECK (media_type IN ('photo','mention','voice')),
  r2_key text,
  raw_metadata jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_holding_space_person ON holding_space(person_id);

-- Invitations & consent lifecycle
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons(id),
  invited_by_person_id uuid NOT NULL REFERENCES persons(id),
  token text UNIQUE NOT NULL,
  triggering_photo_id uuid REFERENCES photos(id), -- nullable: manual "add family member" adds may have no photo yet
  invitee_email citext, -- delivery address, if the inviter has one; both nullable
  invitee_phone text,   -- if neither is known, the inviter shares the link themselves (see notes)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','expired')),
  decline_at timestamptz,
  grace_period_end timestamptz,
  reinvited boolean NOT NULL DEFAULT false, -- one re-invite allowed, enforced here
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_invitations_person ON invitations(person_id);

-- Voice
CREATE TABLE voice_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid UNIQUE NOT NULL REFERENCES persons(id),
  elevenlabs_model_id text,
  tier text CHECK (tier IN ('instant','professional')),
  audio_seconds_accumulated int NOT NULL DEFAULT 0,
  consent_status text NOT NULL DEFAULT 'none'
    CHECK (consent_status IN ('none','previewed','consented','paused','revoked')),
  consent_date timestamptz,
  consented_by uuid REFERENCES persons(id), -- normally = person_id (self-consent only)
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Interviews (Section 3)
CREATE TABLE interview_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  life_phase text NOT NULL, -- childhood, education, work, relationships, family, values, legacy
  sort_order int
);

CREATE TABLE interview_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons(id),
  facilitator_person_id uuid NOT NULL REFERENCES persons(id),
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','completed')),
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE interview_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES interview_questions(id),
  audio_r2_key text NOT NULL,
  transcript text,
  memory_id uuid REFERENCES memories(id), -- linked once transcribed
  created_at timestamptz DEFAULT now()
);

-- Photos captured or uploaded mid-conversation, while an answer is still being
-- recorded (before its memory_id exists). Q_TRANS copies these into memory_photos
-- once the transcript lands and the memory row is created. See voice pipeline doc.
CREATE TABLE interview_answer_photos (
  interview_answer_id uuid NOT NULL REFERENCES interview_answers(id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (interview_answer_id, photo_id)
);

-- Moderation
CREATE TABLE flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type text NOT NULL, -- 'memory' | 'photo'
  content_id uuid NOT NULL,
  reporter_person_id uuid NOT NULL REFERENCES persons(id),
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','removed','dismissed','appealed')),
  resolution text,
  created_at timestamptz DEFAULT now()
);

-- Notifications
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  payload jsonb DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE notification_settings (
  user_id uuid NOT NULL REFERENCES users(id),
  notification_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, notification_type)
);
```

## Notes on relationships between tables

`persons` is the spine — `user_id` is nullable because most rows start as non-app-using subjects (deceased, or living-but-not-yet-onboarded relatives) and only gain a `users` row on activation. `holding_space` and `invitations` both key off `persons.id`, not `users.id`, since a person can accumulate holding-space data long before they have an account.

**Decided:** embeddings run on Voyage AI's `voyage-multimodal-3.5` for both `memories.embedding` and the new `photos.embedding` — a single transformer encoder puts text and images in the same vector space, so a text query like "cooking" can retrieve a relevant photo directly, not just text mentioning cooking. `vector(1024)` uses the model's Matryoshka-truncated 1024-dim output (it also supports 2048/512/256; 1024 is the quality/storage balance point). Text-only content (`memories.content`, interview transcripts) is embedded in the model's text mode; `photos` rows are embedded in image mode straight from the R2 object, no captioning step needed. See the search doc for the query-side implications of a shared space.

`proposed_memories` vs `holding_space`: separate concerns. `proposed_memories` is the Section 2 review queue for the *consented device owner's own* photos awaiting a swipe/tap decision. `holding_space` is GDPR-driven storage for data *about a not-yet-consented person*, untouched by any AI processing until they accept.

`invitations.reinvited` is a boolean guard on the "one re-invitation allowed" rule enforced at the row level, not just in application code.

**Adding a family member — living vs. deceased branch:** the original doc only spelled out invitation creation via naming someone in a photo, and profile creation for someone who's died. There's a third entry point worth making explicit — a manual "add family member" action from the tree, for a living person you don't happen to have a recent photo of yet (a distant cousin, an in-law). Same `persons` row + `relationships` row + `invitations` row as the photo-triggered path, just `triggering_photo_id` left null and `invitee_email`/`invitee_phone` filled in instead (both nullable — if neither is known, the inviter gets a shareable link to send themselves, same MVP fallback already noted in the invitation flow doc). The "this person has passed away" toggle on the same form switches to the section 4 path instead: no email/phone fields, `birth_date`/`death_date` collected, straight to `POST /persons/deceased`, no `invitations` row at all since there's no one to invite.

**Photo-as-conversation-starter:** `photos.source = 'physical_scan'` covers the "take a picture of a picture" capture flow inside Share your story — camera-captured digitizations of printed photos, used either as a prompt shown before recording or attached afterward to illustrate the answer. This reuses the existing media pipeline and `voyage-multimodal-3.5` embedding unchanged — a scanned photo is still just a `photos` row, still gets face-matched (this is in fact the main way a grandparent's own childhood photos enter the tree, since those predate camera rolls) and still lands in the same searchable vector space as everything else. `memory_photos` is the only new structure this needed: a many-to-many between memories and photos, since one story can be illustrated by several photos and one photo can end up attached to more than one memory over time. `source='interview_prompt'` distinguishes a photo used to *trigger* a story from one merely uploaded alongside it — useful later if you want to show "started from this photo" on the memory card.

**Memory deletion policy (resolves the earlier open item):** "the archive is permanent" was always a trust principle aimed at the platform (don't destroy family data, don't erase provenance, don't let a lapsed subscription wipe things out) — not a rule against contributors managing their own contributions. The resolved policy, three tiers:

1. **Unlinked, unreacted memories** (no `reactions` rows, no `memory_persons` row pointing at anyone other than the contributor, `provenance_type != 'voice'`, `is_posthumous_contribution = false`) — hard delete, `DELETE FROM memories`, no friction beyond a confirmation tap. These never fully entered the shared archive.
2. **Linked or reacted memories** — no hard delete. The contributor can retract (`retracted = true`, `retracted_at = now()`): content disappears from feed/profile/search for everyone, but the row and its provenance stay in the database, visible only to the administrator's queue. Reactors get notified ("a memory you reacted to was removed by its contributor"). Restoring requires the *contributor's own* action — an administrator can request a restore (notification round-trip) but cannot flip `retracted` back to `false` themselves; only `contributor_id` can, enforced at the RLS layer the same way `privacy_tier` and voice consent already are.
3. **Posthumous contributions** (`is_posthumous_contribution = true`) — no unilateral retract or delete at all. These go through the existing flags/moderation path (section 6), since a memory contributed about a deceased person is subject to family governance, not individual withdrawal.

The one absolute: `provenance_type = 'voice'` rows (real recorded audio) are never hard-deletable, full stop — enforced by the trigger above, not just app logic. A voice memory's only lifecycle option is retraction (hidden from view, audio and transcript preserved forever) — "the voice belongs to the person who spoke, not the person holding the phone."

`interview_answer_photos` exists because timing doesn't line up otherwise: a photo taken mid-answer (while someone's still talking about a memory) happens before that answer has been transcribed, so `memory_id` doesn't exist yet to attach it to. The answer row (`interview_answers.id`) does exist from the moment recording starts, so photos attach there first, then get promoted to `memory_photos` once `Q_TRANS` creates the memory — same destination table as the "start from a photo" and "illustrate afterward" cases, just a different entry point and a short-lived staging table in between.
