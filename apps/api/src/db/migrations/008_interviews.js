exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE interview_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      text text NOT NULL,
      life_phase text NOT NULL,
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
      memory_id uuid REFERENCES memories(id),
      created_at timestamptz DEFAULT now()
    );

    -- Photos captured/uploaded mid-conversation, before the answer's memory_id exists.
    -- The transcription worker copies these into memory_photos once the memory is created.
    CREATE TABLE interview_answer_photos (
      interview_answer_id uuid NOT NULL REFERENCES interview_answers(id) ON DELETE CASCADE,
      photo_id uuid NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      PRIMARY KEY (interview_answer_id, photo_id)
    );
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS interview_answer_photos CASCADE');
  await knex.raw('DROP TABLE IF EXISTS interview_answers CASCADE');
  await knex.raw('DROP TABLE IF EXISTS interview_sessions CASCADE');
  await knex.raw('DROP TABLE IF EXISTS interview_questions CASCADE');
};
