// Backs POST /uploads/presign + POST /uploads/:id/complete
// (docs/api_structure.md's cross-cutting uploads note). Presign inserts a
// pending row so /complete can be called with just an id (matching the
// already-shipped `apiClient.completeUpload(uploadId)` client signature,
// which sends no body) and still know the r2_key/context/family_group_id it
// needs — nothing else in the schema tracks an in-flight upload between
// those two calls. No RLS here (same as `relationships`); tenant isolation
// is enforced by filtering on family_group_id in the route handlers directly.
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE uploads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_group_id uuid NOT NULL REFERENCES family_groups(id),
      uploaded_by uuid NOT NULL REFERENCES persons(id),
      r2_key text NOT NULL,
      context text NOT NULL CHECK (context IN ('memory', 'photo', 'voice')),
      content_type text,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
      created_at timestamptz DEFAULT now()
    );
  `);
};

exports.down = async function (knex) {
  await knex.raw("DROP TABLE IF EXISTS uploads CASCADE");
};
