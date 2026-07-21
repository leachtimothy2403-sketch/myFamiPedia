// 2026-07-20 — retracting a memory or interview answer that already fed into
// a biography section didn't roll anything back: interview_biography_sections
// (migration 026) only ever stores the current MERGED summary text, with
// nothing recording which individual memory/answer contributed which piece
// of it. Tim reported this live: retracting a Q&A answer from Manage
// left its content sitting in the biography forever. There was no way to fix
// that by editing the summary in place either — recordAnswerInBiography
// folds a new answer INTO the existing prose via Claude, it never learns
// which sentence came from which answer, so there's no "subtract just this
// part" operation possible on the merged text itself.
//
// The fix has to be a full rebuild from surviving sources, not an edit — so
// this table exists purely to make "what are this section's surviving
// sources right now" a real, cheap query instead of an unrecoverable
// question. One row per contribution (every recordAnswerInBiography /
// recordMemoryInBiography call inserts exactly one), holding the same raw
// content that was folded in, so a rebuild never needs to re-derive or
// re-classify anything — see biography.service.ts's recomputeBiographySection.
//
// memory_id is nullable so a hypothetical future caller with no memories row
// to point at (none exist today — every current call site already creates or
// already has one) doesn't hard-fail; recomputeBiographySection treats a null
// memory_id as "no retraction possible, always keep." ON DELETE CASCADE
// mirrors interview_biography_sections' own FK to persons: if the memory is
// ever hard-deleted (DELETE /memories/:id), the source record it fed should
// go with it rather than dangle.
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE interview_biography_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      life_phase text NOT NULL,
      memory_id uuid REFERENCES memories(id) ON DELETE CASCADE,
      stem text NOT NULL,
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_biography_sources_person_phase ON interview_biography_sources(person_id, life_phase);
    CREATE INDEX idx_biography_sources_memory ON interview_biography_sources(memory_id);
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_biography_sources_memory;
    DROP INDEX IF EXISTS idx_biography_sources_person_phase;
    DROP TABLE IF EXISTS interview_biography_sources CASCADE;
  `);
};
