import { definePlugin, type QSpecPlugin, type QueryLanguage } from "@qspecs/core";
import { compileSql, validateSqlQuery, type CompiledSqlQuery } from "./internal/compile.js";

export type { CompiledSqlQuery, SqlStatement } from "./internal/compile.js";

/**
 * The "sql" query language: named-parameter statements (`:name`) compiled to
 * `CompiledSqlQuery`, a dialect-neutral form a Postgres (or other SQL)
 * adapter turns into text and driver parameters. This package never talks to
 * a database itself — see CompiledSqlQuery's doc comment for why there is no
 * `text` field to make that structurally true. Built at module scope: unlike
 * @qspecs/transforms' expression-based transforms, neither function here
 * depends on per-runtime configuration, so there is nothing `sql()` needs to
 * capture at setup time.
 */
const language: QueryLanguage<unknown, CompiledSqlQuery> = {
  compile: compileSql,
  validate: validateSqlQuery,
};

/** Registers the "sql" query language. */
export function sql(): QSpecPlugin {
  return definePlugin({
    name: "@qspecs/sql",
    setup(api) {
      api.queryLanguages.register("sql", language as QueryLanguage);
    },
  });
}
