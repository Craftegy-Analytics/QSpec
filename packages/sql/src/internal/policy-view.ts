import { isPlainObject, type QueryDefinition } from "@qspecs/core";
import { requireSqlStatement, type CompiledSqlQuery } from "./compile.js";
import { scanSql } from "./scan.js";

/**
 * `CompiledSqlQuery` without `values`: what an execution policy may see. (SPEC.md §72.6)
 *
 * `segments` are the literal SQL the manifest author wrote, `parameterNames` name the gap each
 * bound value will fill, and `source` is the logical source. No bound value is reachable from it.
 */
export interface SqlPolicyView {
  /** Literal SQL between parameters. Always one longer than `parameterNames`. */
  readonly segments: readonly string[];
  /** The parameter name filling each gap, in order. */
  readonly parameterNames: readonly string[];
  /** The logical source the query targets. */
  readonly source: string;
}

/**
 * The `sql` language's `QueryLanguage.policyView`: the compiled query with `values` dropped and
 * both arrays copied, so the view shares no mutable structure with what the data source receives.
 * Core deep-freezes the result.
 */
export function policyView(compiled: CompiledSqlQuery): SqlPolicyView {
  return {
    segments: [...compiled.segments],
    parameterNames: [...compiled.parameterNames],
    source: compiled.source,
  };
}

/**
 * The same view, computed statically from `spec.query`, for an admission check that runs when a
 * host stores a manifest rather than when it executes one. Equal to
 * `policyView(compileSql(definition, context))` for every set of bindings, because both come from
 * one `scanSql` call on the same statement and neither depends on a value. Frozen. Throws
 * `QueryCompilationError` for a non-string statement, as `compileSql` does.
 */
export function sqlPolicyView(definition: QueryDefinition): SqlPolicyView {
  const { segments, parameterNames } = scanSql(requireSqlStatement(definition));
  return Object.freeze({
    segments: Object.freeze(segments),
    parameterNames: Object.freeze(parameterNames),
    source: definition.source,
  });
}

const VIEW_KEYS: ReadonlySet<string> = new Set(["segments", "parameterNames", "source"]);

/** Every index holds a string. Reads by index, so a hole reads as `undefined` and fails. */
function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") return false;
  }
  return true;
}

/**
 * Narrows a `PolicyQuery.view` (typed `unknown` in core) to `SqlPolicyView`. Exactly the three
 * keys: anything else, including a stray `values`, is rejected rather than ignored, so a policy
 * written against this guard fails closed instead of being handed a value by mistake.
 */
export function isSqlPolicyView(value: unknown): value is SqlPolicyView {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== VIEW_KEYS.size || !keys.every((key) => VIEW_KEYS.has(key))) return false;
  const { segments, parameterNames, source } = value;
  return (
    typeof source === "string" &&
    isStringArray(segments) &&
    isStringArray(parameterNames) &&
    segments.length === parameterNames.length + 1
  );
}
