import { describe, expect, it } from "vitest";
import { LimitExceededError, ManifestValidationError } from "./errors.js";
import { defineManifest, parseManifest } from "./define.js";

const minimal = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "example" },
  spec: { parameters: {} },
};

describe("defineManifest", () => {
  it("returns the manifest unchanged", () => {
    const manifest = defineManifest(minimal);
    expect(manifest).toBe(minimal);
  });

  it("preserves literal types without requiring `as const` at the call site", () => {
    // No `as const` here — literal preservation must come from defineManifest's
    // `const` type parameter. With a plain <T extends QSpecManifest> generic,
    // `kind` would widen to `string` and this assignment would not compile.
    const manifest = defineManifest({
      apiVersion: "qspec.dev/v1",
      kind: "Chart",
      metadata: { name: "example" },
      spec: { parameters: {} },
    });
    const kind: "Chart" = manifest.kind;
    expect(kind).toBe("Chart");
  });
});

describe("parseManifest", () => {
  it("parses a JSON string", () => {
    const manifest = parseManifest(JSON.stringify(minimal));
    expect(manifest.metadata.name).toBe("example");
  });

  it("accepts an already-parsed object", () => {
    expect(parseManifest(minimal).kind).toBe("Dataset");
  });

  it("throws ManifestValidationError on malformed JSON", () => {
    expect(() => parseManifest("{ not json")).toThrow(ManifestValidationError);
  });

  it("rejects a manifest whose root is not an object", () => {
    expect(() => parseManifest("[]")).toThrow(ManifestValidationError);
    expect(() => parseManifest('"hello"')).toThrow(ManifestValidationError);
  });

  it("rejects prototype-polluting keys anywhere in the document", () => {
    const hostile =
      '{"apiVersion":"qspec.dev/v1","kind":"Dataset",' +
      '"metadata":{"name":"x"},"spec":{"__proto__":{"polluted":true}}}';
    expect(() => parseManifest(hostile)).toThrow(ManifestValidationError);
    // No Object.prototype assertion here: JSON.parse creates `__proto__` as an
    // inert own property and never mutates the prototype, so such an assertion
    // would pass even with the guard removed. The throw above is the real proof.
  });

  it("rejects unsafe keys when handed an already-parsed object", () => {
    // Built via JSON.parse rather than an object literal — a literal
    // `{ __proto__: ... }` sets the prototype instead of creating an own
    // property, so it would not exercise the guard.
    const hostile = JSON.parse(
      '{"apiVersion":"qspec.dev/v1","kind":"Dataset",' +
        '"metadata":{"name":"x"},"spec":{"__proto__":{"a":1}}}',
    ) as unknown;
    expect(() => parseManifest(hostile)).toThrow(ManifestValidationError);
  });

  it("reports the path of an unsafe key", () => {
    const hostile =
      '{"apiVersion":"qspec.dev/v1","kind":"Dataset",' +
      '"metadata":{"name":"x"},"spec":{"constructor":1}}';
    try {
      parseManifest(hostile);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).issues[0]?.path).toEqual(["spec", "constructor"]);
    }
  });

  it("enforces maxBytes on string input", () => {
    expect(() => parseManifest(JSON.stringify(minimal), { maxBytes: 10 })).toThrow(
      LimitExceededError,
    );
  });

  it("does not overflow the stack on a cyclic pre-parsed object", () => {
    // Only reachable through the pre-parsed-object branch: JSON.parse cannot
    // produce a cycle, but a caller handing in a live object can.
    const cyclic: Record<string, unknown> = { ...minimal };
    cyclic.self = cyclic;

    expect(() => parseManifest(cyclic)).not.toThrow();
  });
});
