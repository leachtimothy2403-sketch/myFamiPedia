import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // pglite boot (WASM init + running all migrations from scratch) is
    // slower than a real Postgres connection, and gets slower still under
    // CPU contention — see the fileParallelism note below. 60s leaves a
    // comfortable margin even on a modest machine's first run.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each file boots its OWN in-memory Postgres (pglite) instance and runs
    // all migrations against it from scratch. Vitest's default is to run
    // test files concurrently across worker threads — fine on a beefy CI
    // runner, but on a real dev machine, running all ~12 files' worth of
    // pglite boots at once creates enough CPU contention that even a
    // generous hookTimeout gets exceeded (seen in practice: every file's
    // beforeAll timed out simultaneously on first run). Forcing serial file
    // execution trades total wall-clock time (a few minutes instead of
    // ~20s) for actually finishing reliably on ordinary hardware. Individual
    // test files can still be run directly (`vitest run tests/routes/x.test.ts`)
    // for a fast inner loop while developing.
    fileParallelism: false,
  },
});
