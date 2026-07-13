exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_group_id uuid NOT NULL REFERENCES family_groups(id),
      contributor_id uuid NOT NULL REFERENCES persons(id),
      content text,
      media_url text,
      event_date date,
      provenance_type text NOT NULL
        CHECK (provenance_type IN ('voice','photo','text','ai_generated')),
      provenance_label text,
      is_private boolean NOT NULL DEFAULT false,
      disputed boolean NOT NULL DEFAULT false,
      retracted boolean NOT NULL DEFAULT false,
      retracted_at timestamptz,
      is_posthumous_contribution boolean NOT NULL DEFAULT false,
      embedding vector(1024),
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_memories_family_group ON memories(family_group_id);
    CREATE INDEX idx_memories_event_date ON memories(event_date);
    CREATE INDEX idx_memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
    CREATE INDEX idx_memories_content_fts ON memories USING GIN (to_tsvector('simple', coalesce(content,'')));

    CREATE TABLE memory_persons (
      memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      person_id uuid NOT NULL REFERENCES persons(id),
      PRIMARY KEY (memory_id, person_id)
    );

    CREATE TABLE memory_photos (
      memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      PRIMARY KEY (memory_id, photo_id)
    );

    CREATE TABLE reactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      person_id uuid NOT NULL REFERENCES persons(id),
      reaction_type text NOT NULL,
      created_at timestamptz DEFAULT now(),
      UNIQUE (memory_id, person_id, reaction_type)
    );

    -- Original voice recordings are never hard-deletable, contributor included.
    -- See docs/data_model.md, "Memory deletion policy".
    CREATE OR REPLACE FUNCTION block_voice_memory_deletion() RETURNS trigger AS $BODY$
    BEGIN
      IF OLD.provenance_type = 'voice' THEN
        RAISE EXCEPTION 'Voice-provenance memories cannot be hard-deleted, only retracted';
      END IF;
      RETURN OLD;
    END;
    $BODY$ LANGUAGE plpgsql;

    CREATE TRIGGER memories_block_voice_delete
      BEFORE DELETE ON memories
      FOR EACH ROW EXECUTE FUNCTION block_voice_memory_deletion();
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TRIGGER IF EXISTS memories_block_voice_delete ON memories');
  await knex.raw('DROP FUNCTION IF EXISTS block_voice_memory_deletion()');
  await knex.raw('DROP TABLE IF EXISTS reactions CASCADE');
  await knex.raw('DROP TABLE IF EXISTS memory_photos CASCADE');
  await knex.raw('DROP TABLE IF EXISTS memory_persons CASCADE');
  await knex.raw('DROP TABLE IF EXISTS memories CASCADE');
};
