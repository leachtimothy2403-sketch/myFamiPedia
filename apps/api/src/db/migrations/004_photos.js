// Photos are created before memories so memory_photos (in the next migration) can reference them.
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE photos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_group_id uuid NOT NULL REFERENCES family_groups(id),
      r2_key text NOT NULL,
      uploaded_by uuid NOT NULL REFERENCES persons(id),
      taken_at timestamptz,
      is_private boolean NOT NULL DEFAULT false,
      source text NOT NULL DEFAULT 'camera_roll'
        CHECK (source IN ('camera_roll','physical_scan','interview_prompt','manual_upload')),
      embedding vector(1024),
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_photos_embedding ON photos USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

    CREATE TABLE photo_persons (
      photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      person_id uuid NOT NULL REFERENCES persons(id),
      face_coordinates jsonb,
      identification_status text NOT NULL DEFAULT 'pending'
        CHECK (identification_status IN ('auto_matched','confirmed','pending')),
      face_blurred boolean NOT NULL DEFAULT false,
      PRIMARY KEY (photo_id, person_id)
    );

    CREATE TABLE proposed_memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES persons(id),
      photo_id uuid REFERENCES photos(id),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','rejected')),
      created_at timestamptz DEFAULT now()
    );
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS proposed_memories CASCADE');
  await knex.raw('DROP TABLE IF EXISTS photo_persons CASCADE');
  await knex.raw('DROP TABLE IF EXISTS photos CASCADE');
};
