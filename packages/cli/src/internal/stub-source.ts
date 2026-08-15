import type { DataSource } from "@qspecs/core";

/**
 * The message `createStubSource()`'s `execute` throws. Exported so a caller
 * that wants to prove `execute()` was never invoked (e.g. `validate.test.ts`'s
 * plugin-aware suite) can assert against this exact string instead of a
 * second, hand-copied substring that could silently drift from the real
 * message — as it already once did before this constant existed.
 */
export const STUB_SOURCE_EXECUTE_MESSAGE =
  "The qspec CLI stub data source cannot execute queries. Plugin-aware " +
  "validation only calls prepare(), never execute(); seeing this error " +
  "means that assumption no longer holds.";

/**
 * A DataSource that exists only so `prepare()` can resolve a manifest's source
 * without a database. Its `execute` throws: plugin-aware validation runs
 * `prepare()`, never `execute()`, and if that ever changes this throw is how
 * we find out.
 *
 * It deliberately OMITS `supportedLanguages`. A source that omits it accepts
 * any language (SPEC.md §62, and the compatibility guarantee in Plan 3's
 * decision 6), which is exactly what a stub needs — it must not reject `sql`,
 * or any language a third-party plugin registers.
 */
export function createStubSource(): DataSource {
  return {
    execute() {
      throw new Error(STUB_SOURCE_EXECUTE_MESSAGE);
    },
  };
}
