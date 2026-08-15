import { describe, expect, it } from "vitest";
import {
  QueryCompilationError,
  type QueryCompileContext,
  type QueryDefinition,
} from "@qspecs/core";
import { compileSql, validateSqlQuery } from "./compile.js";

function definition(overrides: Partial<QueryDefinition> = {}): QueryDefinition {
  return {
    source: "primary",
    language: "sql",
    statement: "SELECT 1",
    ...overrides,
  };
}

function context(overrides: Partial<QueryCompileContext> = {}): QueryCompileContext {
  return {
    source: "primary",
    bindings: {},
    parameters: {},
    ...overrides,
  };
}

describe("compileSql", () => {
  it("compiles a statement with no parameters to one segment and empty parameterNames/values", () => {
    const result = compileSql(definition({ statement: "SELECT * FROM t" }), context());
    expect(result.segments).toEqual(["SELECT * FROM t"]);
    expect(result.parameterNames).toEqual([]);
    expect(result.values).toEqual([]);
  });

  it("resolves :from from context.bindings.from", () => {
    const result = compileSql(
      definition({ statement: "SELECT * FROM t WHERE a = :from" }),
      context({ bindings: { from: "x" } }),
    );
    expect(result.parameterNames).toEqual(["from"]);
    expect(result.values).toEqual(["x"]);
  });

  it("resolves two parameters in statement order, not binding-declaration order", () => {
    // Declared b before a; the statement references a before b. If compile
    // ever emitted values in Object.keys(bindings) order instead of
    // statement order, this would catch it — a same-order statement
    // wouldn't.
    const result = compileSql(
      definition({ statement: "SELECT * FROM t WHERE x = :a AND y = :b" }),
      context({ bindings: { b: "second", a: "first" } }),
    );
    expect(result.parameterNames).toEqual(["a", "b"]);
    expect(result.values).toEqual(["first", "second"]);
  });

  it("yields a repeated parameter's value twice", () => {
    const result = compileSql(
      definition({ statement: "WHERE a = :from OR b = :from" }),
      context({ bindings: { from: "x" } }),
    );
    expect(result.parameterNames).toEqual(["from", "from"]);
    expect(result.values).toEqual(["x", "x"]);
  });

  it("carries source from context.source", () => {
    const result = compileSql(
      definition({ statement: "SELECT 1" }),
      context({ source: "reporting" }),
    );
    expect(result.source).toBe("reporting");
  });

  it("throws naming the parameter, with a did-you-mean suggestion from the available bindings, when nothing matches", () => {
    try {
      compileSql(
        definition({ statement: "SELECT * FROM t WHERE a = :from" }),
        context({ bindings: { form: "x" } }),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryCompilationError);
      const compilationError = error as QueryCompilationError;
      expect(compilationError.message).toContain(":from");
      expect(compilationError.details).toEqual({ suggestion: "form" });
    }
  });

  it("rejects a non-string statement — SQL requires text even though QueryDefinition.statement is unknown", () => {
    expect(() => compileSql(definition({ statement: 42 }), context())).toThrow(
      QueryCompilationError,
    );
  });

  it("never bracket-accesses bindings without Object.hasOwn — :constructor does not pick up Object.prototype.constructor", () => {
    // A plain object literal's `constructor` resolves through the prototype
    // chain to Function `Object`. A bare `context.bindings["constructor"]`
    // would return that instead of `undefined`, so this would silently pass
    // a function through as the bound value instead of throwing.
    expect(() =>
      compileSql(
        definition({ statement: "SELECT * FROM t WHERE a = :constructor" }),
        context({ bindings: {} }),
      ),
    ).toThrow(QueryCompilationError);
  });
});

describe("validateSqlQuery", () => {
  it("rejects a non-string statement, which core's structural validator does not require", () => {
    // Core requires `spec.query.statement` to be *present* but deliberately
    // not to be a string (`QueryDefinition.statement: unknown`, so a language
    // can carry a structured statement), so `42` really does reach here
    // during prepare().
    //
    // Removing this guard does NOT produce a loud failure, which is why the
    // test matters: `scanSql(42)` reads `(42).length` as `undefined`, its
    // loop never runs, and validation reports zero issues — the manifest
    // passes prepare() clean and fails only later, out of `compileSql`.
    const issues = validateSqlQuery(definition({ statement: 42 }));
    expect(issues).toEqual([
      {
        code: "QSPEC_MANIFEST_INVALID",
        message: "`statement` must be a string of SQL text.",
        path: ["statement"],
      },
    ]);
  });

  it("reports a positional placeholder written into the statement", () => {
    const issues = validateSqlQuery(
      definition({
        statement: "SELECT * FROM t WHERE a = $1 AND b = :from",
        bindings: { from: "$parameters.x" },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["statement"]);
    expect(issues[0]?.message).toContain('"$1"');
    expect(issues[0]?.message).toContain(":name");
  });

  it("reports a binding declared but never referenced by the statement — almost always a typo", () => {
    const issues = validateSqlQuery(
      definition({
        statement: "SELECT * FROM t WHERE a = :from",
        bindings: { from: "$parameters.x", unused: "$parameters.y" },
      }),
    );
    expect(issues).toEqual([
      {
        code: "QSPEC_MANIFEST_INVALID",
        message: 'Binding "unused" is declared but never referenced by the statement.',
        path: ["bindings", "unused"],
      },
    ]);
  });
});
