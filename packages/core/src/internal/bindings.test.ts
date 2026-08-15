import { describe, expect, it } from "vitest";
import { ManifestValidationError } from "../errors.js";
import { compileParameters } from "./validate/parameters.js";
import { compileBindings, resolveBindings } from "./bindings.js";
import type { Binding } from "../types/query.js";

const declared = compileParameters({
  from: { type: "date", required: true },
  country: { type: "string", default: "US" },
});

const at = ["spec", "query", "bindings"] as const;

describe("compileBindings", () => {
  it("returns an empty list when there are no bindings", () => {
    expect(compileBindings(undefined, declared, at)).toEqual([]);
  });

  it("compiles the string reference form", () => {
    expect(compileBindings({ a: "$parameters.from" }, declared, at)).toEqual([
      { name: "a", kind: "parameter", parameter: "from" },
    ]);
  });

  it("compiles the object parameter form", () => {
    expect(compileBindings({ a: { parameter: "from" } }, declared, at)).toEqual([
      { name: "a", kind: "parameter", parameter: "from" },
    ]);
  });

  it("compiles the literal form", () => {
    expect(compileBindings({ a: { literal: "US" } }, declared, at)).toEqual([
      { name: "a", kind: "literal", value: "US" },
    ]);
  });

  it("rejects a bare string that is not a parameter reference", () => {
    expect(() => compileBindings({ a: "US" }, declared, at)).toThrow(ManifestValidationError);
  });

  it("rejects a near-miss reference prefix rather than treating it as a literal", () => {
    expect(() => compileBindings({ a: "$parameter.from" }, declared, at)).toThrow(
      ManifestValidationError,
    );
  });

  it("rejects a reference to an undeclared parameter and suggests a declared one", () => {
    try {
      compileBindings({ a: "$parameters.form" }, declared, at);
      expect.unreachable("should have thrown");
    } catch (error) {
      const issue = (error as ManifestValidationError).issues[0];
      expect(issue?.suggestion).toBe("from");
      expect(issue?.path).toEqual(["spec", "query", "bindings", "a"]);
    }
  });

  it("rejects an object with both parameter and literal", () => {
    expect(() =>
      compileBindings({ a: { parameter: "from", literal: 1 } as never }, declared, at),
    ).toThrow(ManifestValidationError);
  });

  it("rejects an explicitly-undefined literal", () => {
    // Object.hasOwn is true for an explicitly-undefined property, so this
    // fixture must be an object literal, not JSON.parse (which cannot
    // represent undefined).
    expect(() =>
      compileBindings({ a: { literal: undefined } as unknown as Binding }, declared, at),
    ).toThrow(ManifestValidationError);
  });

  it.each([
    ["$parameter.from", "missing the plural s"],
    ["$parameters.", "empty parameter name"],
    ["$parameters.9x", "name starting with a digit"],
    ["$parameters.a.b", "dotted name"],
  ])("rejects the bare string %s (%s)", (value) => {
    expect(() => compileBindings({ a: value }, declared, at)).toThrow(ManifestValidationError);
  });

  it.each(["$parameters._x", "$parameters.a1"])("accepts the reference %s", (value) => {
    const parameters = compileParameters({ _x: { type: "string" }, a1: { type: "string" } });
    expect(compileBindings({ a: value }, parameters, at)).toHaveLength(1);
  });
});

describe("resolveBindings", () => {
  it("resolves parameter references against validated values", () => {
    const compiled = compileBindings({ f: "$parameters.from", c: { literal: 7 } }, declared, at);
    const resolved = resolveBindings(compiled, { from: "2026-01-01" });
    expect(resolved["f"]).toBe("2026-01-01");
    expect(resolved["c"]).toBe(7);
  });

  it("resolves an absent optional parameter to null", () => {
    const compiled = compileBindings({ c: "$parameters.country" }, declared, at);
    expect(resolveBindings(compiled, {})["c"]).toBeNull();
  });

  it("returns a null-prototype frozen object", () => {
    const resolved = resolveBindings(compileBindings({}, declared, at), {});
    expect(Object.getPrototypeOf(resolved)).toBeNull();
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});
