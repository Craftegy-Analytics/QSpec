import { describe, expect, it } from "vitest";
import { QSPEC_V1_SCHEMA_ID, qspecV1Schema, validateWithJsonSchema } from "./index.js";

const minimal = { apiVersion: "qspec.dev/v1", kind: "Dataset", metadata: { name: "x" }, spec: {} };

describe("@qspecs/schema", () => {
  it("exposes the schema and its immutable id", () => {
    expect(QSPEC_V1_SCHEMA_ID).toBe("https://qspec.dev/schemas/v1/qspec.json");
    expect(qspecV1Schema).toHaveProperty("$id", QSPEC_V1_SCHEMA_ID);
  });

  it("freezes the exported schema so it cannot be edited before first compile", () => {
    // The validator is compiled lazily on first use, so a mutation landing
    // before that call would silently change what every later call validates.
    expect(Object.isFrozen(qspecV1Schema)).toBe(true);
    expect(() => {
      qspecV1Schema["type"] = "string";
    }).toThrow(TypeError);
  });

  it("accepts a valid manifest", () => {
    expect(validateWithJsonSchema(minimal)).toEqual({ valid: true, errors: [] });
  });

  it("reports a dotted path for a nested failure", () => {
    const result = validateWithJsonSchema({ ...minimal, metadata: { name: "Bad Name" } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe("metadata.name");
  });

  it("rejects an unsupported apiVersion", () => {
    expect(validateWithJsonSchema({ ...minimal, apiVersion: "qspec.dev/v2" }).valid).toBe(false);
  });

  it("requires enum parameters to declare values", () => {
    const manifest = {
      ...minimal,
      spec: { parameters: { p: { type: "enum" } } },
    };
    expect(validateWithJsonSchema(manifest).valid).toBe(false);
  });

  it("rejects a bare string binding that is not a parameter reference", () => {
    const manifest = {
      ...minimal,
      spec: {
        query: { source: "s", language: "sql", statement: "x", bindings: { a: "US" } },
      },
    };
    expect(validateWithJsonSchema(manifest).valid).toBe(false);
  });
});
