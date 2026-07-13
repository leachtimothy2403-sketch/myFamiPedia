// See docs/data_model.md for the full table-by-table rationale.
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE family_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      paying_member_id uuid,
      subscription_status text NOT NULL DEFAULT 'active'
        CHECK (subscription_status IN ('active','grace','cold_storage','deleted')),
      grace_period_end timestamptz,
      cold_storage_end timestamptz,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email citext UNIQUE NOT NULL,
      password_hash text,
      language text NOT NULL DEFAULT 'en',
      created_at timestamptz DEFAULT now(),
      last_login_at timestamptz
    );

    ALTER TABLE family_groups
      ADD CONSTRAINT fk_paying_member FOREIGN KEY (paying_member_id) REFERENCES users(id);
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS family_groups CASCADE');
  await knex.raw('DROP TABLE IF EXISTS users CASCADE');
};
