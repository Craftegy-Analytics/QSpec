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
