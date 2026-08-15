import type { RawColumn, RawQueryResult } from "@qspecs/core";
import { postgresTypeName } from "./types.js";

/**
 * The subset of `pg`'s query result this module depends on.
 *
 * A structural type rather than `pg`'s own `QueryArrayResult`: `pg` does not
 * ship its own type declarations (`@types/pg` is a devDependency here, not a
 * runtime one — see `dependencies` in package.json), so a public signature
 * built on its types would force every consumer of `@qspecs/postgres` to also
 * install `@types/pg` just to resolve this package's `.d.ts`. This shape is
 * also more precise for our purposes: `@types/pg`'s `QueryResult<R>` types
 * `rows` as `R[]` with `R` defaulting to `any`, so it does not itself encode
 * "rows are arrays" the way `PgArrayModeQueryResult` does.
 *
 * **This function assumes the query that produced `result` was issued with
 * `rowMode: "array"`.** That is what makes `pg`'s rows already match
 * `RawQueryResult.rows` — arrays of positional values, not row objects keyed
 * by column name — and what lets duplicate column names survive instead of
 * being silently collapsed by object-key collision. Task 6, which issues the
 * actual query, must pass `rowMode: "array"`; if it does not, the values in
 * each row here will not line up with `columns` by position.
 */
export interface PgArrayModeQueryResult {
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[];
  readonly rows: readonly (readonly unknown[])[];
}

/**
 * Converts a `pg` array-mode query result into `RawQueryResult`. Rows pass
 * through unchanged — no object-to-array conversion happens here, so
 * duplicate column names (e.g. `SELECT 1 AS id, 2 AS id`) survive exactly as
 * `pg` returned them, deferring any renaming to `normalizeResult` in
 * `@qspecs/core`.
 */
export function normalizePgResult(result: PgArrayModeQueryResult): RawQueryResult {
  const columns: RawColumn[] = result.fields.map((field) => {
    const nativeType = postgresTypeName(field.dataTypeID);
    return nativeType === undefined ? { name: field.name } : { name: field.name, nativeType };
  });

  return { columns, rows: result.rows };
}
