exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE voice_models (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid UNIQUE NOT NULL REFERENCES persons(id),
      elevenlabs_model_id text,
      tier text CHECK (tier IN ('instant','professional')),
      audio_seconds_accumulated int NOT NULL DEFAULT 0,
      consent_status text NOT NULL DEFAULT 'none'
        CHECK (consent_status IN ('none','previewed','consented','paused','revoked')),
      consent_date timestamptz,
      consented_by uuid REFERENCES persons(id),
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS voice_models CASCADE');
};
