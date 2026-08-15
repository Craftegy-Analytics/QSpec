import {
  QueryCompilationError,
  suggest,
  type JsonValue,
  type PathSegment,
  type QSpecIssue,
  type QueryCompileContext,
  type QueryDefinition,
} from "@qspecs/core";
import { scanSql } from "./scan.js";

/**
 * SQL statement text. `QueryDefinition.statement` is typed `unknown` so
 * non-SQL languages can carry a structured statement instead; this package
 * always requires a string. (SPEC.md §35)
 */
export type SqlStatement = string;

/**
 * A compiled query in a form no adapter can turn back into interpolated SQL.
 *
 * There is deliberately no `text` field: an adapter must join `segments` with
 * its own dialect placeholders (`$1…$n`, `?`, …) itself, which makes it
 * structurally impossible for this package to hand a driver a string with a
 * value already spliced into it. (SPEC.md §72.2)
 */
export interface CompiledSqlQuery {
  /** Literal SQL between parameters; join with dialect placeholders to get text. */
  readonly segments: readonly string[];
  /** Parameter name per gap, in order. Length is segments.length - 1. */
  readonly parameterNames: readonly string[];
  /** Resolved value per gap, in the same order. */
  readonly values: readonly JsonValue[];
  /** The logical source this query targets. */
  readonly source: string;
}

function issue(message: string, path: readonly PathSegment[], suggestion?: string): QSpecIssue {
  return {
    code: "QSPEC_MANIFEST_INVALID",
    message,
    path,
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

/** Guards the one constraint `QueryDefinition.statement: unknown` does not: SQL needs text. */
function statementText(statement: unknown): statement is SqlStatement {
  return typeof statement === "string";
}

/**
 * Scans the statement and resolves each `:name` against `context.bindings`,
 * mapping names to values via `Object.hasOwn` — never a bare bracket access,
 * so a statement referencing `:constructor` cannot pick up
 * `Object.prototype.constructor` from a plain object literal.
 *
 * Name coverage — an unknown `:name`, or a declared binding nothing
 * references — is `validateSqlQuery`'s job, which runs earlier during
 * prepare() (SPEC.md §81) against the declarations rather than resolved
 * values. This function still rejects a `:name` with no matching binding so
 * it fails safely if ever called without that check having run first, as
 * this file's own tests do.
 */
export function compileSql(query: QueryDefinition, context: QueryCompileContext): CompiledSqlQuery {
  if (!statementText(query.statement)) {
    throw new QueryCompilationError(
      `SQL statement must be a string, received ${typeof query.statement}.`,
    );
  }

  const { segments, parameterNames } = scanSql(query.statement);

  const values: JsonValue[] = [];
  for (const name of parameterNames) {
    const value = Object.hasOwn(context.bindings, name) ? context.bindings[name] : undefined;
    if (value === undefined) {
      const available = Object.keys(context.bindings);
      const hint = suggest(name, available);
      throw new QueryCompilationError(
        `SQL statement references parameter ":${name}", which has no matching binding. ` +
          `Available bindings: ${available.join(", ") || "(none)"}.`,
        hint === undefined ? undefined : { details: { suggestion: hint } },
      );
    }
    values.push(value);
  }

  return { segments, parameterNames, values, source: context.source };
}

/**
 * Static name-coverage checks, run during prepare() before any connection
 * exists (SPEC.md §81) and against `query.bindings` — the declarations, not
 * resolved values, which do not exist yet at this point. Every `:name` the
 * statement references must have a matching declared binding, and every
 * declared binding must be referenced back: one that is not is almost always
 * a typo in the statement. Issue paths are relative to `spec.query`.
 */
export function validateSqlQuery(query: QueryDefinition): readonly QSpecIssue[] {
  if (!statementText(query.statement)) {
    return [issue("`statement` must be a string of SQL text.", ["statement"])];
  }

  const { parameterNames, positionalPlaceholder } = scanSql(query.statement);
  const declared = query.bindings ?? {};
  const declaredNames = Object.keys(declared);
  const referenced = new Set(parameterNames);

  const issues: QSpecIssue[] = [];

  // Reported first: unlike a name-coverage defect, this one produces a query
  // that runs and returns the wrong rows.
  if (positionalPlaceholder !== undefined) {
    issues.push(
      issue(
        `Statement contains the positional placeholder "${positionalPlaceholder}". An adapter ` +
          `generates its own positional placeholders when it binds :name parameters, so one ` +
          `written into the statement collides with them — Postgres would bind a single value ` +
          `to both references and run a query nobody wrote, without reporting anything. Use a ` +
          `named parameter (":name") with a matching entry in \`bindings\` instead.`,
        ["statement"],
      ),
    );
  }

  for (const name of referenced) {
    if (!Object.hasOwn(declared, name)) {
      issues.push(
        issue(
          `Statement references parameter ":${name}", which has no matching binding.`,
          ["statement"],
          suggest(name, declaredNames),
        ),
      );
    }
  }

  for (const name of declaredNames) {
    if (!referenced.has(name)) {
      issues.push(
        issue(`Binding "${name}" is declared but never referenced by the statement.`, [
          "bindings",
          name,
        ]),
      );
    }
  }

  return issues;
}
