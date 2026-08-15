import { describe, expect, it } from "vitest";
import { createRow, deepFreeze, isPlainObject, isUnsafeKey, ownKeys, setKey } from "./json.js";

describe("isPlainObject", () => {
  it("accepts object literals", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("accepts null-prototype objects", () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("rejects arrays, null, and class instances", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});

describe("isUnsafeKey", () => {
  it("flags the prototype-pollution keys named in SPEC.md 72.4", () => {
    expect(isUnsafeKey("__proto__")).toBe(true);
    expect(isUnsafeKey("constructor")).toBe(true);
    expect(isUnsafeKey("prototype")).toBe(true);
  });

  it("allows ordinary keys", () => {
    expect(isUnsafeKey("revenue")).toBe(false);
  });
});

describe("createRow", () => {
  it("produces an object with no prototype", () => {
    const row = createRow();
    expect(Object.getPrototypeOf(row)).toBeNull();
    expect((row as Record<string, unknown>)["toString"]).toBeUndefined();
  });

  it("can hold a column literally named __proto__ without polluting anything", () => {
    const row = createRow();
    setKey(row, "__proto__", 42);
    expect(row["__proto__"]).toBe(42);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("creates an own property even on a target with a normal prototype chain", () => {
    // This is the case where defineProperty and plain assignment diverge.
    // Plain assignment to "__proto__" would invoke the inherited setter and
    // reparent the object instead of creating an own property.
    const target: Record<string, unknown> = {};
    const replacement = { polluted: true };
    setKey(target, "__proto__", replacement);

    expect(Object.hasOwn(target, "__proto__")).toBe(true);
    expect(target["__proto__"]).toBe(replacement);
    // The object's own prototype must be untouched...
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    // ...and nothing may have leaked onto Object.prototype itself.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("ownKeys", () => {
  it("returns own enumerable string keys in insertion order", () => {
    expect(ownKeys({ b: 1, a: 2 })).toEqual(["b", "a"]);
  });

  it("returns an empty array for non-objects", () => {
    expect(ownKeys(null)).toEqual([]);
    expect(ownKeys(7)).toEqual([]);
  });
});

describe("deepFreeze", () => {
  it("freezes a nested object and all its properties", () => {
    const inner = { value: 42 };
    const outer = { inner };
    const frozen = deepFreeze(outer);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen((frozen as Record<string, unknown>).inner)).toBe(true);
  });

  it("handles cyclic structures without infinite looping", () => {
    // This test guards against reordering the freeze and recursive descent.
    // If Object.freeze() runs AFTER the recursive descent, this infinite-loops.
    // The ordering of freeze-first is load-bearing.
    const cyclic: Record<string, unknown> = { name: "cyclic" };
    cyclic.self = cyclic;
    const frozen = deepFreeze(cyclic);

    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it("freezes arrays nested inside objects", () => {
    const obj = { items: [1, 2, 3] };
    const frozen = deepFreeze(obj);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen((frozen as Record<string, unknown>).items)).toBe(true);
  });

  it("leaves primitives and null unchanged without throwing", () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("string")).toBe("string");
    expect(deepFreeze(true)).toBe(true);
    expect(deepFreeze(null)).toBe(null);
  });

  it("still descends into an object the caller already shallow-froze", () => {
    // A caller who freezes their own object must not thereby opt out of the
    // deep freeze: that would void the post-prepare immutability guarantee.
    const inner = { value: 42 };
    const outer = Object.freeze({ inner });
    deepFreeze(outer);

    expect(Object.isFrozen(inner)).toBe(true);
  });

  it("terminates on a cycle whose nodes are already frozen", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;
    Object.freeze(a);
    Object.freeze(b);

    expect(() => deepFreeze(a)).not.toThrow();
  });
});
