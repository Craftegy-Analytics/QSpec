import { describe, expect, it } from "vitest";
import {
  QueryCompilationError,
  type JsonValue,
  type QueryCompileContext,
  type QueryDefinition,
} from "@qspecs/core";
import { compileSql } from "./compile.js";
import { isSqlPolicyView, policyView, sqlPolicyView, type SqlPolicyView } from "./policy-view.js";

function definition(statement: unknown, source = "primary"): QueryDefinition {
  return { source, language: "sql", statement };
}

function context(bindings: Record<string, JsonValue>, source = "primary"): QueryCompileContext {
  return { source, bindings, parameters: {} };
}

/** mulberry32: a small, fixed-seed generator, so a failure reproduces exactly. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The scanner's own adversarial fragments: casts, colons inside every skipped context, and
 * parameters, so a generated statement exercises the regions a naive scan gets wrong.
 */
const FRAGMENTS = [
  "SELECT * FROM t WHERE ",
  "created_at::date",
  "::int",
  "'a:b'",
  "$$ :x $$",
  "$tag$ :inside $tag$",
  "/* outer /* :nested */ still :comment */",
  "-- :line comment\n",
  "E'it\\'s :escaped'",
  '"col:name"',
  " AND ",
  " = ",
  ", ",
  "\n",
] as const;

const PARAMETERS = ["from", "to", "region", "p1", "_x"] as const;

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick() from an empty list");
  return item;
}

function randomValue(random: () => number, depth = 0): JsonValue {
  const roll = random();
  if (roll < 0.25) return `v${Math.floor(random() * 1e6)}:'x'`;
  if (roll < 0.45) return Math.floor(random() * 1e9) - 5e8;
  if (roll < 0.55) return null;
  if (roll < 0.65) return random() < 0.5;
  if (depth < 2 && roll < 0.8)
    return [randomValue(random, depth + 1), randomValue(random, depth + 1)];
  if (depth < 2) return { k: randomValue(random, depth + 1) };
  return "leaf";
}

function generatedStatement(random: () => number): { statement: string; names: Set<string> } {
  const names = new Set<string>();
  let statement = "";
  const length = 1 + Math.floor(random() * 12);
  for (let index = 0; index < length; index += 1) {
    if (random() < 0.4) {
      // Parameters repeat on purpose: one name may fill several gaps.
      const name = pick(random, PARAMETERS);
      names.add(name);
      statement += `:${name}`;
    } else {
      statement += pick(random, FRAGMENTS);
    }
    // A separator after every piece, so one piece cannot extend another: `:p1` followed by
    // `created_at` would read as one parameter, and `date` followed by `E'...'` makes the `E`
    // part of an identifier instead of an escape-string prefix.
    statement += " ";
  }
  return { statement, names };
}

function randomBindings(random: () => number, names: Set<string>): Record<string, JsonValue> {
  const bindings: Record<string, JsonValue> = {};
  for (const name of names) bindings[name] = randomValue(random);
  return bindings;
}

describe("policyView", () => {
  it("has exactly segments, parameterNames and source, never values", () => {
    const compiled = compileSql(
      definition("SELECT * FROM t WHERE a = :from AND b = :to"),
      context({ from: "SECRET_FROM", to: 42 }),
    );
    const view = policyView(compiled);
    expect(Object.keys(view).sort()).toEqual(["parameterNames", "segments", "source"]);
    expect(view).toEqual({
      segments: ["SELECT * FROM t WHERE a = ", " AND b = ", ""],
      parameterNames: ["from", "to"],
      source: "primary",
    });
    expect(JSON.stringify(view)).not.toContain("SECRET_FROM");
  });

  it("copies its arrays, so freezing the view never freezes the compiled query", () => {
    const compiled = compileSql(definition("SELECT :a"), context({ a: 1 }));
    const view = policyView(compiled);
    expect(view.segments).not.toBe(compiled.segments);
    expect(view.parameterNames).not.toBe(compiled.parameterNames);
    Object.freeze(view.segments);
    expect(Object.isFrozen(compiled.segments)).toBe(false);
  });
});

describe("sqlPolicyView", () => {
  it("equals policyView(compileSql(...)) for generated statements and bindings (fixed seed)", () => {
    const random = generator(0x5eed);
    for (let run = 0; run < 500; run += 1) {
      const { statement, names } = generatedStatement(random);
      const declared = definition(statement);
      const expected = sqlPolicyView(declared);
      const first = policyView(compileSql(declared, context(randomBindings(random, names))));
      const second = policyView(compileSql(declared, context(randomBindings(random, names))));
      // Two different value sets give the same view: it is a function of the statement only.
      expect(first, statement).toEqual(expected);
      expect(second, statement).toEqual(expected);
    }
  });

  it("is frozen, top to bottom", () => {
    const view = sqlPolicyView(definition("SELECT :a, :b"));
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.segments)).toBe(true);
    expect(Object.isFrozen(view.parameterNames)).toBe(true);
  });

  it("rejects a non-string statement with compileSql's own error", () => {
    const structured = definition({ match_all: {} });
    expect(() => sqlPolicyView(structured)).toThrow(QueryCompilationError);
    expect(() => sqlPolicyView(structured)).toThrow(
      "SQL statement must be a string, received object.",
    );
    expect(() => compileSql(structured, context({}))).toThrow(
      "SQL statement must be a string, received object.",
    );
  });
});

describe("isSqlPolicyView", () => {
  const view: SqlPolicyView = { segments: ["SELECT ", ""], parameterNames: ["a"], source: "s" };

  it("accepts a view, frozen or not", () => {
    expect(isSqlPolicyView(view)).toBe(true);
    expect(isSqlPolicyView(sqlPolicyView(definition("SELECT :a")))).toBe(true);
    expect(isSqlPolicyView(Object.freeze({ ...view }))).toBe(true);
  });

  it.each<{ readonly label: string; readonly value: unknown }>([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "an array", value: [view] },
    { label: "a string", value: "SELECT 1" },
    { label: "a view with values", value: { ...view, values: ["SECRET"] } },
    { label: "a view with any other extra key", value: { ...view, text: "SELECT 1" } },
    { label: "a missing segments", value: { parameterNames: ["a"], source: "s" } },
    { label: "a missing parameterNames", value: { segments: ["SELECT 1"], source: "s" } },
    { label: "a missing source", value: { segments: ["SELECT ", ""], parameterNames: ["a"] } },
    { label: "a non-string segment", value: { ...view, segments: ["SELECT ", 1] } },
    { label: "a non-string parameter name", value: { ...view, parameterNames: [1] } },
    { label: "a sparse segments array", value: { ...view, segments: ["SELECT ", , ""] } },
    { label: "a non-string source", value: { ...view, source: 1 } },
    { label: "too few segments", value: { ...view, segments: ["SELECT "] } },
    { label: "too many segments", value: { ...view, segments: ["SELECT ", "", ""] } },
    { label: "a compiled query", value: compileSql(definition("SELECT :a"), context({ a: 1 })) },
  ])("rejects $label", ({ value }) => {
    expect(isSqlPolicyView(value)).toBe(false);
  });
});
