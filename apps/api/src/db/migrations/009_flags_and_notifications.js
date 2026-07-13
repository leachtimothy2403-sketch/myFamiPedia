exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE flags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content_type text NOT NULL,
      content_id uuid NOT NULL,
      reporter_person_id uuid NOT NULL REFERENCES persons(id),
      description text NOT NULL,
      status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','removed','dismissed','appealed')),
      resolution text,
      created_at timestamptz DEFAULT now()
    );

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
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS notification_settings CASCADE');
  await knex.raw('DROP TABLE IF EXISTS notifications CASCADE');
  await knex.raw('DROP TABLE IF EXISTS flags CASCADE');
};
