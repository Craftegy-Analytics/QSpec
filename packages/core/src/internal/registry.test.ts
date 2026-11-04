import { describe, expect, it } from "vitest";
import { PluginRegistrationError } from "../errors.js";
import { createRegistry } from "./registry.js";

describe("createRegistry", () => {
  it("registers and retrieves implementations", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    expect(registry.get("filter")).toBe(1);
    expect(registry.has("filter")).toBe(true);
  });

  it("returns undefined for unknown names", () => {
    const registry = createRegistry<number>("transform");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.has("nope")).toBe(false);
  });

  it("throws PluginRegistrationError on duplicate registration", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    expect(() => registry.register("filter", 2)).toThrow(PluginRegistrationError);
    expect(registry.get("filter")).toBe(1);
  });

  it("names the registry and the key in the duplicate error message", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    expect(() => registry.register("filter", 2)).toThrow(/transform.*"filter"/);
  });

  it("allows explicit replacement", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    registry.replace("filter", 2);
    expect(registry.get("filter")).toBe(2);
  });

  it("allows replace on an unregistered name", () => {
    const registry = createRegistry<number>("transform");
    registry.replace("filter", 2);
    expect(registry.get("filter")).toBe(2);
  });

  it("lists names sorted, for deterministic diagnostics", () => {
    const registry = createRegistry<number>("transform");
    registry.register("sort", 1);
    registry.register("filter", 2);
    registry.register("limit", 3);
    expect(registry.list()).toEqual(["filter", "limit", "sort"]);
  });

  it("rejects empty names", () => {
    const registry = createRegistry<number>("transform");
    expect(() => registry.register("", 1)).toThrow(PluginRegistrationError);
  });

  it("is not confused by prototype-shaped names", () => {
    const registry = createRegistry<number>("transform");
    expect(registry.has("constructor")).toBe(false);
    expect(registry.get("__proto__")).toBeUndefined();
    registry.register("constructor", 5);
    expect(registry.get("constructor")).toBe(5);
    expect(registry.list()).toEqual(["constructor"]);
  });
});

describe("createRegistry entries()", () => {
  it("yields registration order, while list() stays alphabetical", () => {
    const registry = createRegistry<number>("execution policy");
    registry.register("b", 1);
    registry.register("a", 2);
    registry.register("c", 3);
    expect(registry.entries().map((entry) => entry.name)).toEqual(["b", "a", "c"]);
    expect(registry.list()).toEqual(["a", "b", "c"]);
  });

  it("replace() on an existing name keeps its position and swaps the implementation", () => {
    const registry = createRegistry<number>("execution policy");
    registry.register("b", 1);
    registry.register("a", 2);
    registry.register("c", 3);
    registry.replace("a", 20);
    expect(registry.entries()).toEqual([
      { name: "b", implementation: 1 },
      { name: "a", implementation: 20 },
      { name: "c", implementation: 3 },
    ]);
  });

  it("replace() on a new name appends it last", () => {
    const registry = createRegistry<number>("execution policy");
    registry.register("b", 1);
    registry.register("a", 2);
    registry.replace("d", 4);
    expect(registry.entries().map((entry) => entry.name)).toEqual(["b", "a", "d"]);
  });

  it("returns a snapshot: a later registration does not change an earlier result", () => {
    const registry = createRegistry<number>("execution policy");
    registry.register("a", 1);
    const before = registry.entries();
    registry.register("b", 2);
    expect(before.map((entry) => entry.name)).toEqual(["a"]);
    expect(Object.isFrozen(before)).toBe(true);
  });

  it("names the execution policy registry in a duplicate error", () => {
    const registry = createRegistry<number>("execution policy");
    registry.register("guard", 1);
    expect(() => registry.register("guard", 2)).toThrow(PluginRegistrationError);
    expect(() => registry.register("guard", 2)).toThrow(
      /An execution policy named "guard" is already registered/,
    );
  });
});
