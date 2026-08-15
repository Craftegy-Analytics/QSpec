import { describe, expect, it } from "vitest";
import { ManifestValidationError, ParameterValidationError, formatPath } from "../../errors.js";
import { compileParameters, validateParameters } from "./parameters.js";
import type { ParameterDefinition } from "../../types/parameters.js";

function compile(definitions: Record<string, ParameterDefinition>) {
  return compileParameters(definitions);
}

function expectIssues(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
    expect.unreachable("expected ParameterValidationError");
  } catch (error) {
    expect(error).toBeInstanceOf(ParameterValidationError);
    return (error as ParameterValidationError).issues.map((issue) => ({
      path: formatPath(issue.path),
      message: issue.message,
    }));
  }
}

describe("compileParameters", () => {
  it("accepts an absent parameter block", () => {
    expect(compileParameters(undefined).names).toEqual([]);
  });

  it("rejects an unknown parameter type", () => {
    expect(() => compile({ a: { type: "uuid" } as unknown as ParameterDefinition })).toThrow(
      ManifestValidationError,
    );
  });

  it("requires enum parameters to declare values", () => {
    expect(() => compile({ p: { type: "enum" } })).toThrow(/values/);
  });

  it("requires array parameters to declare items", () => {
    expect(() => compile({ p: { type: "array" } })).toThrow(/items/);
  });

  it("rejects a default that does not satisfy its own declaration", () => {
    expect(() => compile({ p: { type: "number", default: "x" } })).toThrow(ManifestValidationError);
  });

  it("rejects an array parameter whose items.type is itself composite", () => {
    expect(() =>
      compile({ p: { type: "array", items: { type: "enum" } } as unknown as ParameterDefinition }),
    ).toThrow(ManifestValidationError);
    expect(() =>
      compile({
        p: { type: "array", items: { type: "array" } } as unknown as ParameterDefinition,
      }),
    ).toThrow(ManifestValidationError);
  });
});

describe("validateParameters", () => {
  it("returns an empty null-prototype object when nothing is declared", () => {
    const values = validateParameters(compileParameters(undefined), {});
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(Object.keys(values)).toEqual([]);
  });

  it("reports every missing required parameter at once", () => {
    const compiled = compile({
      from: { type: "date", required: true },
      to: { type: "date", required: true },
    });
    const issues = expectIssues(() => validateParameters(compiled, {}));
    expect(issues.map((i) => i.path)).toEqual(["parameters.from", "parameters.to"]);
  });

  it("applies declared defaults", () => {
    const compiled = compile({ country: { type: "string", default: "US" } });
    expect(validateParameters(compiled, {})["country"]).toBe("US");
  });

  it("prefers a supplied value over the default", () => {
    const compiled = compile({ country: { type: "string", default: "US" } });
    expect(validateParameters(compiled, { country: "DE" })["country"]).toBe("DE");
  });

  it("omits optional parameters that have no default", () => {
    const compiled = compile({ country: { type: "string" } });
    expect(Object.hasOwn(validateParameters(compiled, {}), "country")).toBe(false);
  });

  it("rejects parameters that were not declared", () => {
    const issues = expectIssues(() => validateParameters(compile({}), { rogue: 1 }));
    expect(issues[0]?.path).toBe("parameters.rogue");
  });

  it("enforces integer vs number", () => {
    const compiled = compile({ n: { type: "integer" } });
    expect(validateParameters(compiled, { n: 5 })["n"]).toBe(5);
    expect(expectIssues(() => validateParameters(compiled, { n: 5.5 }))).toHaveLength(1);
  });

  it("enforces min and max", () => {
    const compiled = compile({ n: { type: "number", validation: { min: 0, max: 10 } } });
    expect(expectIssues(() => validateParameters(compiled, { n: -1 }))[0]?.message).toMatch(/0/);
    expect(expectIssues(() => validateParameters(compiled, { n: 11 }))[0]?.message).toMatch(/10/);
    expect(validateParameters(compiled, { n: 0 })["n"]).toBe(0);
  });

  it("enforces minLength and maxLength on strings", () => {
    const compiled = compile({ s: { type: "string", validation: { minLength: 2, maxLength: 4 } } });
    expect(expectIssues(() => validateParameters(compiled, { s: "a" }))).toHaveLength(1);
    expect(expectIssues(() => validateParameters(compiled, { s: "abcde" }))).toHaveLength(1);
    expect(validateParameters(compiled, { s: "ab" })["s"]).toBe("ab");
  });

  it("enforces enum values and suggests a close match", () => {
    const compiled = compile({ period: { type: "enum", values: ["7d", "30d", "90d"] } });
    const issues = expectIssues(() => validateParameters(compiled, { period: "31d" }));
    expect(issues[0]?.message).toMatch(/7d, 30d, 90d/);
  });

  it("accepts date and datetime as ISO strings", () => {
    const compiled = compile({ d: { type: "date" }, t: { type: "datetime" } });
    const values = validateParameters(compiled, { d: "2026-01-01", t: "2026-01-01T10:00:00Z" });
    expect(values["d"]).toBe("2026-01-01");
    expect(values["t"]).toBe("2026-01-01T10:00:00Z");
  });

  it("rejects a malformed date and an impossible calendar date", () => {
    const compiled = compile({ d: { type: "date" } });
    expect(expectIssues(() => validateParameters(compiled, { d: "01/01/2026" }))).toHaveLength(1);
    expect(expectIssues(() => validateParameters(compiled, { d: "2026-02-31" }))).toHaveLength(1);
  });

  it("rejects a Date object, which is not portable", () => {
    const compiled = compile({ d: { type: "date" } });
    expect(expectIssues(() => validateParameters(compiled, { d: new Date() }))).toHaveLength(1);
  });

  it("rejects a datetime whose calendar date is impossible", () => {
    const compiled = compile({ t: { type: "datetime" } });
    expect(
      expectIssues(() => validateParameters(compiled, { t: "2026-02-30T10:00:00Z" })),
    ).toHaveLength(1);
    expect(validateParameters(compiled, { t: "2024-02-29T10:00:00Z" })["t"]).toBe(
      "2024-02-29T10:00:00Z",
    );
  });

  it("validates array element types and length", () => {
    const compiled = compile({
      ids: { type: "array", items: { type: "integer" }, validation: { maxLength: 2 } },
    });
    expect(validateParameters(compiled, { ids: [1, 2] })["ids"]).toEqual([1, 2]);
    expect(expectIssues(() => validateParameters(compiled, { ids: [1, 2, 3] }))).toHaveLength(1);
    const issues = expectIssues(() => validateParameters(compiled, { ids: [1, "x"] }));
    expect(issues[0]?.path).toBe("parameters.ids[1]");
  });

  it("rejects NaN and Infinity, which do not survive JSON", () => {
    const compiled = compile({ n: { type: "number" } });
    expect(expectIssues(() => validateParameters(compiled, { n: Number.NaN }))).toHaveLength(1);
    expect(expectIssues(() => validateParameters(compiled, { n: Infinity }))).toHaveLength(1);
  });

  it("treats null as absent so JSON callers can omit optional values", () => {
    const compiled = compile({ country: { type: "string", default: "US" } });
    expect(validateParameters(compiled, { country: null })["country"]).toBe("US");
  });

  it("returns a frozen result", () => {
    const values = validateParameters(compile({ a: { type: "string", default: "x" } }), {});
    expect(Object.isFrozen(values)).toBe(true);
  });

  it("deep-freezes an array-typed value, not just the top-level result", () => {
    const compiled = compile({ ids: { type: "array", items: { type: "integer" } } });
    const values = validateParameters(compiled, { ids: [1, 2, 3] });
    expect(Object.isFrozen(values["ids"])).toBe(true);
  });
});
