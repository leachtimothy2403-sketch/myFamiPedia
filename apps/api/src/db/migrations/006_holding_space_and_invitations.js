exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE holding_space (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES persons(id),
      source_person_id uuid NOT NULL REFERENCES persons(id),
      media_type text NOT NULL CHECK (media_type IN ('photo','mention','voice')),
      r2_key text,
      raw_metadata jsonb,
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_holding_space_person ON holding_space(person_id);

    CREATE TABLE invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES persons(id),
      invited_by_person_id uuid NOT NULL REFERENCES persons(id),
      token text UNIQUE NOT NULL,
      triggering_photo_id uuid REFERENCES photos(id),
      invitee_email citext,
      invitee_phone text,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','declined','expired')),
      decline_at timestamptz,
      grace_period_end timestamptz,
      reinvited boolean NOT NULL DEFAULT false,
      created_at timestamptz DEFAULT now()
    );
    CREATE INDEX idx_invitations_person ON invitations(person_id);
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS invitations CASCADE');
  await knex.raw('DROP TABLE IF EXISTS holding_space CASCADE');
};
