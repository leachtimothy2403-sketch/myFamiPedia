// Enables the Postgres extensions the whole schema depends on.
// pgcrypto -> gen_random_uuid(), vector -> pgvector, citext -> case-insensitive email columns.
exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS vector');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS citext');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm'); // fuzzy name/place search, see docs/search.md
};

exports.down = async function (knex) {
  await knex.raw('DROP EXTENSION IF EXISTS pg_trgm');
  await knex.raw('DROP EXTENSION IF EXISTS citext');
  await knex.raw('DROP EXTENSION IF EXISTS vector');
  await knex.raw('DROP EXTENSION IF EXISTS pgcrypto');
};
