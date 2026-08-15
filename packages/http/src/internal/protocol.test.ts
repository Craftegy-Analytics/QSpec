import { describe, expect, it } from "vitest";
import { parseExecuteRequest } from "./protocol.js";

/** Builds an array nested `depth` levels deep: depth 2 is `[[[]]]`. */
function deeplyNestedArray(depth: number): unknown[] {
  let value: unknown[] = [];
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

/** Asserts `fn` throws an `Error` and returns it, narrowed, for further assertions. */
function captureThrownError(fn: () => unknown): Error {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof Error)) throw new Error("expected the function to throw an Error");
  return thrown;
}

describe("parseExecuteRequest", () => {
  it("parses a minimal valid request, with parameters absent", () => {
    const result = parseExecuteRequest({ resource: "x" });
    expect(result).toEqual({ resource: "x" });
    expect(Object.hasOwn(result, "parameters")).toBe(false);
  });

  it("parses a valid request with parameters and preserves their values", () => {
    const result = parseExecuteRequest({
      resource: "orders",
      parameters: { id: 1, name: "a", active: true, tags: ["x", "y"], nested: { a: [1, null] } },
    });
    expect(result).toEqual({
      resource: "orders",
      parameters: { id: 1, name: "a", active: true, tags: ["x", "y"], nested: { a: [1, null] } },
    });
  });

  it("rejects a non-object body (string)", () => {
    expect(() => parseExecuteRequest("resource")).toThrow(
      "Execute request body must be a JSON object.",
    );
  });

  it("rejects a non-object body (number)", () => {
    expect(() => parseExecuteRequest(42)).toThrow("Execute request body must be a JSON object.");
  });

  it("rejects null", () => {
    expect(() => parseExecuteRequest(null)).toThrow("Execute request body must be a JSON object.");
  });

  it("rejects an array", () => {
    expect(() => parseExecuteRequest(["x"])).toThrow("Execute request body must be a JSON object.");
  });

  it("rejects a missing resource", () => {
    expect(() => parseExecuteRequest({})).toThrow(
      '"resource" is required and must be a non-empty string.',
    );
  });

  it("rejects a non-string resource", () => {
    expect(() => parseExecuteRequest({ resource: 42 })).toThrow(
      '"resource" is required and must be a non-empty string.',
    );
  });

  it("rejects an empty-string resource", () => {
    expect(() => parseExecuteRequest({ resource: "" })).toThrow(
      '"resource" is required and must be a non-empty string.',
    );
  });

  it("rejects a resource longer than the length limit, without echoing the resource itself", () => {
    const resource = "x".repeat(300);
    const thrown = captureThrownError(() => parseExecuteRequest({ resource }));
    expect(thrown.message).toBe('"resource" must be at most 256 characters (received 300).');
    expect(thrown.message).not.toContain("x".repeat(300));
  });

  it("rejects a resource named __proto__ — the server looks resources up by name, the same risk parameter names carry", () => {
    expect(() => parseExecuteRequest({ resource: "__proto__" })).toThrow(
      '"resource" must not be "__proto__", which can corrupt object prototypes.',
    );
  });

  it("rejects a resource named constructor", () => {
    expect(() => parseExecuteRequest({ resource: "constructor" })).toThrow(
      '"resource" must not be "constructor", which can corrupt object prototypes.',
    );
  });

  it("rejects a resource named prototype", () => {
    expect(() => parseExecuteRequest({ resource: "prototype" })).toThrow(
      '"resource" must not be "prototype", which can corrupt object prototypes.',
    );
  });

  it("rejects parameters that are present but not a plain object (array)", () => {
    expect(() => parseExecuteRequest({ resource: "x", parameters: ["a"] })).toThrow(
      '"parameters" must be an object.',
    );
  });

  it("rejects parameters that are present but not a plain object (string)", () => {
    expect(() => parseExecuteRequest({ resource: "x", parameters: "a" })).toThrow(
      '"parameters" must be an object.',
    );
  });

  it("rejects parameters that are present but not a plain object (null)", () => {
    expect(() => parseExecuteRequest({ resource: "x", parameters: null })).toThrow(
      '"parameters" must be an object.',
    );
  });

  it("rejects a top-level parameter named __proto__ — parameters cross a trust boundary and are later indexed by name", () => {
    // Parsed via JSON.parse rather than written as an object literal:
    // `{ __proto__: 1 }` as a literal sets the prototype at parse time
    // instead of creating an own property, which would not exercise the
    // same code path a real request body takes.
    const body: unknown = JSON.parse('{"resource":"x","parameters":{"__proto__":1}}');
    expect(() => parseExecuteRequest(body)).toThrow(
      'Parameter name "__proto__" is not allowed (at "parameters").',
    );
  });

  it("rejects a top-level parameter named constructor", () => {
    expect(() => parseExecuteRequest({ resource: "x", parameters: { constructor: 1 } })).toThrow(
      'Parameter name "constructor" is not allowed (at "parameters").',
    );
  });

  it("rejects a top-level parameter named prototype", () => {
    expect(() => parseExecuteRequest({ resource: "x", parameters: { prototype: 1 } })).toThrow(
      'Parameter name "prototype" is not allowed (at "parameters").',
    );
  });

  it("rejects an unsafe key nested inside a parameter value, not only among top-level parameter names", () => {
    // As above, built via JSON.parse so `__proto__` is a real own property of
    // the nested object rather than setting its prototype.
    const body: unknown = JSON.parse('{"resource":"x","parameters":{"filter":{"__proto__":1}}}');
    expect(() => parseExecuteRequest(body)).toThrow(
      'Parameter name "__proto__" is not allowed (at "parameters.filter").',
    );
  });

  it("rejects undefined nested inside an array parameter value — not something JSON.parse could produce, but a hand-built object can", () => {
    expect(() => parseExecuteRequest({ resource: "x", parameters: { list: [undefined] } })).toThrow(
      'Parameter value is not a valid JSON value (at "parameters.list[0]").',
    );
  });

  it("rejects a JSON.parse'd body nested past the depth ceiling instead of overflowing the stack", () => {
    // Mirrors a real request body: a 50,000-deep nested array is well under
    // any byte-size limit and parses fine under JSON.parse; only a recursive
    // walk without a depth ceiling would overflow the stack on it.
    const json = `{"resource":"x","parameters":{"p":${"[".repeat(50_000)}1${"]".repeat(50_000)}}}`;
    const body: unknown = JSON.parse(json);
    expect(() => parseExecuteRequest(body)).toThrow(/exceeds the maximum nesting depth of 64/);
  });

  it("accepts a parameter value nested well under the depth ceiling", () => {
    const nested = deeplyNestedArray(10);
    expect(() => parseExecuteRequest({ resource: "x", parameters: { p: nested } })).not.toThrow();
  });

  it("rejects a self-referential parameter value (object) with a circular-reference message, instead of overflowing the stack", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => parseExecuteRequest({ resource: "x", parameters: { p: circular } })).toThrow(
      /circular reference/,
    );
  });

  it("rejects a self-referential parameter value (array)", () => {
    const circular: unknown[] = [];
    circular.push(circular);
    expect(() => parseExecuteRequest({ resource: "x", parameters: { p: circular } })).toThrow(
      /circular reference/,
    );
  });

  it("rejects a two-hop cycle (a.next = b; b.next = a)", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a["next"] = b;
    b["next"] = a;
    expect(() => parseExecuteRequest({ resource: "x", parameters: { p: a } })).toThrow(
      /circular reference/,
    );
  });

  it("accepts the same object referenced twice under different parameter names — a DAG, not a cycle", () => {
    // An in-process caller reusing a shared defaults object (`{from: DEFAULTS,
    // to: DEFAULTS}`) hits exactly this shape; throw-on-revisit semantics
    // would reject it even though nothing here is actually circular.
    const shared = { x: 1 };
    expect(() =>
      parseExecuteRequest({ resource: "x", parameters: { a: shared, b: shared } }),
    ).not.toThrow();
  });

  it("accepts an array containing two references to the same object", () => {
    const shared = { x: 1 };
    expect(() =>
      parseExecuteRequest({ resource: "x", parameters: { list: [shared, shared] } }),
    ).not.toThrow();
  });

  it("still catches an unsafe key inside a value shared by two parameter names — pruning a validated revisit cannot hide it, because the key check runs on the first visit before any second reference is reached", () => {
    // Built via JSON.parse, as elsewhere in this file, so `__proto__` is a
    // real own property rather than setting the object's prototype.
    const shared: unknown = JSON.parse('{"__proto__":1}');
    expect(() =>
      parseExecuteRequest({ resource: "x", parameters: { a: shared, b: shared } }),
    ).toThrow('Parameter name "__proto__" is not allowed (at "parameters.a").');
  });

  it("completes quickly on a diamond DAG repeated near the depth ceiling, instead of re-traversing the shared subtree on every reference to it", () => {
    // Each level reuses the SAME next-level object for both `a` and `b`, so
    // without single-traversal pruning the number of node visits doubles per
    // level: exponential in `levels`, not linear. 60 stays under the depth
    // ceiling (64) while making that blowup enormous if pruning regresses.
    const levels = 60;
    let node: unknown = { leaf: true };
    for (let i = 0; i < levels; i++) {
      node = { a: node, b: node };
    }
    const start = performance.now();
    expect(() => parseExecuteRequest({ resource: "x", parameters: { p: node } })).not.toThrow();
    const elapsed = performance.now() - start;
    // Loose on purpose: the property pinned here is termination in a
    // reasonable time, not a tight performance target. Correct
    // (single-traversal) cost is roughly linear in `levels`, so this
    // trivially fits; the exponential alternative would not complete within
    // any bound like this at all.
    expect(elapsed).toBeLessThan(1000);
  });

  it("sanitizes control characters and Unicode line terminators before a parameter name can appear in an error message", () => {
    // Built from code points rather than literal characters in source: ASCII
    // LF and CR, plus the three separators formatPath's JSON.stringify-based
    // escaping does NOT cover — NEL (0x85), LINE SEPARATOR (0x2028), and
    // PARAGRAPH SEPARATOR (0x2029). Any of the five, left in, would let a
    // client control the line structure of whatever eventually logs the
    // rejection.
    const lineTerminatorCodePoints = [0x0a, 0x0d, 0x85, 0x2028, 0x2029];
    const lineTerminators = lineTerminatorCodePoints.map((codePoint) =>
      String.fromCodePoint(codePoint),
    );
    const badKey = `bad${lineTerminators.join("")}keycontrol${"z".repeat(200)}`;
    const thrown = captureThrownError(() =>
      parseExecuteRequest({ resource: "x", parameters: { [badKey]: [undefined] } }),
    );
    for (const terminator of lineTerminators) {
      expect(thrown.message).not.toContain(terminator);
    }
    // The raw key is ~223 characters; a message that echoed it verbatim
    // would be at least that long. The sanitized, truncated form is not.
    expect(thrown.message.length).toBeLessThan(200);
  });

  it("bounds the whole thrown message, not just each path segment", () => {
    // 80 levels of a 300-character key: each segment truncates to about 100
    // characters on its own, but the path holds far more segments than the
    // depth ceiling (64) allows, so without a whole-message bound the
    // rendered message would run to several kilobytes.
    const longKey = "k".repeat(300);
    let value: unknown = { leaf: true };
    for (let i = 0; i < 80; i++) {
      value = { [longKey]: value };
    }
    const thrown = captureThrownError(() =>
      parseExecuteRequest({ resource: "x", parameters: { p: value } }),
    );
    expect(thrown.message).toContain("exceeds the maximum nesting depth of 64");
    // fail() truncates at MAX_MESSAGE_LENGTH (500) and appends "..." (3 chars).
    expect(thrown.message.length).toBeLessThanOrEqual(503);
  });

  it("ignores extra unknown top-level keys, so a newer client can talk to an older server", () => {
    const result = parseExecuteRequest({ resource: "x", futureField: "whatever" });
    expect(result).toEqual({ resource: "x" });
  });
});
