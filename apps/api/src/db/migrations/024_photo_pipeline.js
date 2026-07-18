// docs/photo_pipeline_beta_architecture.md — full schema for the beta photo
// pipeline (detection-only tap-to-tag, admin-gated new-person proposals,
// two-stage scene classification, time/location clustering). Replaces the
// disabled automated face-matching pipeline (migration history: matching
// code disabled 2026-07-18, see docs/family_administrator_and_privacy_model.md
// section 5 — this migration is the schema half of that redesign).
//
// RLS scope decision, made here rather than left implicit: none of the five
// new tables below get row-level security policies. photo_faces is pure
// geometry (no identity, low sensitivity) always accessed through a specific
// photo_id that route handlers already scope by family_group_id.
// person_tag_proposals, photo_classifications, photo_clusters, and
// photo_cluster_photos are all reached exclusively through routes that
// already filter by the caller's family_group_id (and, for proposals,
// requireFamilyAdministrator) at the application layer — the same pattern
// already used for `relationships` and `uploads`, both explicitly documented
// as relying on route-level scoping rather than RLS. This is a scope
// simplification, not an oversight: worth a dedicated RLS hardening pass
// later if these tables' access patterns get more complex than "my family's
// photos" and "I'm the admin."
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE photo_faces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      face_coordinates jsonb NOT NULL,
      confidence numeric,
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_photo_faces_photo ON photo_faces(photo_id);

    ALTER TABLE photos ADD COLUMN face_count int NOT NULL DEFAULT 0;
    -- EXIF GPS, informational/clustering input only (design doc section 6) —
    -- {lat, lng}, nullable since most photos won't carry it. No column
    -- existed for this before the photo pipeline needed it for clustering.
    ALTER TABLE photos ADD COLUMN location jsonb;

    ALTER TABLE photo_persons
      ADD COLUMN face_id uuid REFERENCES photo_faces(id),
      ADD COLUMN tagged_by uuid REFERENCES persons(id);
    -- Structural enforcement of "add-only, not edit" crowdsourced tagging
    -- (design doc section 8): once a detected face has an identity claim,
    -- a second tag attempt on the same face_id fails this index rather than
    -- silently overwriting someone else's identification.
    CREATE UNIQUE INDEX idx_photo_persons_face_unique ON photo_persons(face_id) WHERE face_id IS NOT NULL;

    -- Admin approval queue for a brand-new person proposed via an
    -- unrecognized-face tag (design doc section 2, the "consequential act"
    -- principle). proposed_by_person_id is the original tagger and becomes
    -- invited_by_person_id on the resulting invitation — vouching for the ID
    -- is the tagger's act, not the approving administrator's.
    CREATE TABLE person_tag_proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_group_id uuid NOT NULL REFERENCES family_groups(id),
      proposed_name text NOT NULL,
      proposed_by_person_id uuid NOT NULL REFERENCES persons(id),
      related_to_person_id uuid NOT NULL REFERENCES persons(id),
      relationship_type text NOT NULL,
      photo_id uuid NOT NULL REFERENCES photos(id),
      face_id uuid NOT NULL REFERENCES photo_faces(id),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_person_tag_proposals_family_status ON person_tag_proposals(family_group_id, status);
    -- Same "add-only" structural guard as photo_persons above — a face
    -- already carrying a pending/approved proposal can't collect a second one.
    CREATE UNIQUE INDEX idx_person_tag_proposals_face_unique ON person_tag_proposals(face_id) WHERE status = 'pending';

    -- Two-stage scene classification (design doc section 5). Stage 1
    -- (Rekognition DetectLabels, every synced photo) populates labels +
    -- triage_passed. Stage 2 (Claude Haiku, only photos where triage_passed)
    -- populates suggested_caption + the final is_candidate_worthy verdict
    -- and sets reviewed_at.
    CREATE TABLE photo_classifications (
      photo_id uuid PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
      labels jsonb NOT NULL DEFAULT '[]',
      triage_passed boolean NOT NULL DEFAULT false,
      suggested_caption text,
      is_candidate_worthy boolean NOT NULL DEFAULT false,
      created_at timestamptz DEFAULT now(),
      reviewed_at timestamptz
    );

    -- Non-biometric time/location clustering (design doc section 6) —
    -- EXIF timestamp + GPS proximity only, no image content analysis.
    CREATE TABLE photo_clusters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_group_id uuid NOT NULL REFERENCES family_groups(id),
      representative_taken_at timestamptz,
      location jsonb,
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_photo_clusters_family ON photo_clusters(family_group_id);

    CREATE TABLE photo_cluster_photos (
      cluster_id uuid NOT NULL REFERENCES photo_clusters(id) ON DELETE CASCADE,
      photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      PRIMARY KEY (cluster_id, photo_id)
    );

    -- proposed_memories survives (design doc section 9) — person_id keeps
    -- its original meaning (the device-owner/uploader reviewing a candidate
    -- from their own camera roll), just fed by classification or clustering
    -- instead of face-match. Exactly one of photo_id/cluster_id is set,
    -- depending on which signal produced the candidate.
    ALTER TABLE proposed_memories
      ALTER COLUMN photo_id DROP NOT NULL,
      ADD COLUMN cluster_id uuid REFERENCES photo_clusters(id),
      ADD CONSTRAINT proposed_memories_source_check
        CHECK ((photo_id IS NOT NULL) <> (cluster_id IS NOT NULL));
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE proposed_memories DROP CONSTRAINT IF EXISTS proposed_memories_source_check;
    ALTER TABLE proposed_memories DROP COLUMN IF EXISTS cluster_id;
    ALTER TABLE proposed_memories ALTER COLUMN photo_id SET NOT NULL;

    DROP TABLE IF EXISTS photo_cluster_photos CASCADE;
    DROP TABLE IF EXISTS photo_clusters CASCADE;
    DROP TABLE IF EXISTS photo_classifications CASCADE;
    DROP TABLE IF EXISTS person_tag_proposals CASCADE;

    DROP INDEX IF EXISTS idx_photo_persons_face_unique;
    ALTER TABLE photo_persons DROP COLUMN IF EXISTS tagged_by;
    ALTER TABLE photo_persons DROP COLUMN IF EXISTS face_id;

    ALTER TABLE photos DROP COLUMN IF EXISTS face_count;

    DROP TABLE IF EXISTS photo_faces CASCADE;
  `);
};
