exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE persons (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_group_id uuid NOT NULL REFERENCES family_groups(id),
      user_id uuid REFERENCES users(id),
      name text NOT NULL,
      birth_date date,
      death_date date,
      status text NOT NULL DEFAULT 'invited_pending'
        CHECK (status IN ('active','invited_pending','declined_grace','opted_out','deceased')),
      privacy_tier smallint CHECK (privacy_tier IN (1,2,3)),
      administrator_person_id uuid REFERENCES persons(id),
      profile_data jsonb DEFAULT '{}',
      ai_summary text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_persons_family_group ON persons(family_group_id);
    CREATE INDEX idx_persons_status ON persons(status);
    CREATE INDEX idx_persons_name_trgm ON persons USING GIN (name gin_trgm_ops);

    CREATE TABLE relationships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_a_id uuid NOT NULL REFERENCES persons(id),
      person_b_id uuid NOT NULL REFERENCES persons(id),
      relationship_type text NOT NULL,
      created_at timestamptz DEFAULT now(),
      UNIQUE (person_a_id, person_b_id, relationship_type)
    );
    CREATE INDEX idx_relationships_a ON relationships(person_a_id);
    CREATE INDEX idx_relationships_b ON relationships(person_b_id);
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS relationships CASCADE');
  await knex.raw('DROP TABLE IF EXISTS persons CASCADE');
};
