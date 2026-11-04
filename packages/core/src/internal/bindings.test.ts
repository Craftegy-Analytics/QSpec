import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestValidationError } from "../errors.js";
import { compileParameters } from "./validate/parameters.js";
import { compileBindings, describeBinding, resolveBindings } from "./bindings.js";
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

describe("describeBinding", () => {
  it("describes the string reference form", () => {
    expect(describeBinding("$parameters.from")).toEqual({ kind: "parameter", parameter: "from" });
  });

  it("describes the object parameter form", () => {
    expect(describeBinding({ parameter: "to" })).toEqual({ kind: "parameter", parameter: "to" });
  });

  it.each([[{ literal: "US" }], [{ literal: null }], [{ literal: { nested: [1, 2] } }]])(
    "describes the literal form %j without its value",
    (binding) => {
      const described = describeBinding(binding);
      expect(described).toEqual({ kind: "literal" });
      expect(described === undefined ? false : Object.hasOwn(described, "value")).toBe(false);
    },
  );

  it("describes a null-prototype binding object like a literal one", () => {
    const binding: Record<string, unknown> = Object.create(null);
    binding["parameter"] = "from";
    expect(describeBinding(binding)).toEqual({ kind: "parameter", parameter: "from" });
  });

  it.each<readonly [unknown, string]>([
    ["from", "a bare string"],
    ["$parameter.from", "the singular prefix"],
    ["$parameters.1x", "a name starting with a digit"],
    ["$parameters.", "an empty name"],
    ["$parameters.a.b", "a dotted name"],
    [{}, "an object with neither key"],
    [{ parameter: 1 }, "a non-string parameter"],
    [{ parameter: "x", literal: 1 }, "both keys"],
    [{ literal: undefined }, "an undefined literal"],
    [[], "an array"],
    [new (class Binding {})(), "a class instance"],
    [null, "null"],
    [42, "a number"],
    [undefined, "undefined"],
  ])("returns undefined for %j (%s)", (binding) => {
    expect(describeBinding(binding)).toBeUndefined();
  });

  it("returns a frozen description", () => {
    expect(Object.isFrozen(describeBinding("$parameters.from"))).toBe(true);
    expect(Object.isFrozen(describeBinding({ literal: 1 }))).toBe(true);
  });
});

describe("one binding rule", () => {
  // Both former PARAMETER_REFERENCE call sites (compileBindings here and the
  // structural validator in validate/manifest.ts) must classify a binding
  // through describeBinding, so the rule has exactly one place to edit.
  // Reads the sources, the way test/boundaries.test.ts does.
  const sources = Promise.all(
    ["bindings.ts", join("validate", "manifest.ts")].map((file) =>
      readFile(join(import.meta.dirname, file), "utf8"),
    ),
  );

  it("defines the parameter reference pattern exactly once", async () => {
    const [bindings, manifest] = await sources;
    const definition = /PARAMETER_REFERENCE\s*=/g;
    expect(bindings?.match(definition)).toHaveLength(1);
    expect(manifest?.match(definition) ?? []).toHaveLength(0);
    expect(manifest).not.toContain("\\$parameters\\.");
  });

  it("classifies bindings through describeBinding at both call sites", async () => {
    const [bindings, manifest] = await sources;
    expect(bindings?.match(/describeBinding\(binding\)/g)?.length).toBeGreaterThanOrEqual(1);
    expect(manifest).toMatch(/import \{[^}]*\bdescribeBinding\b[^}]*\} from "\.\.\/bindings\.js"/);
    expect(manifest).toContain("describeBinding(binding)");
  });
});
