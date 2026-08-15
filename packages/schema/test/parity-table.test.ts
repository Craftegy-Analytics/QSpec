import { describe, expect, it } from "vitest";
import { validateManifestStructure } from "@qspecs/core";
import { validateWithJsonSchema } from "../src/index.js";

/**
 * A permanent record of the broad validator audit performed while hardening
 * the conformance test (task 18, fix rounds 1-3). The `fixtures/` directory
 * exercises a handful of representative manifests end-to-end (consumed by
 * the CLI test too); this table is denser and exists purely so the two
 * validators can never silently diverge again as new resource kinds and
 * presentation types are added. Every entry records what the *correct*
 * answer is, not just "the two happen to agree" - so a bug that made both
 * validators wrong in the same way would still be caught.
 */
interface Case {
  readonly label: string;
  readonly manifest: unknown;
  readonly expectValid: boolean;
  /**
   * Override for `validateWithJsonSchema` on cases where it legitimately
   * diverges from the correct answer, because the check is not expressible in
   * JSON Schema at all - core enforces it, and the schema deliberately cannot:
   *
   * - A parameter's `default` not conforming to its own declared
   *   `type`/`values`/`items`/`validation`: the schema leaves `default`
   *   unconstrained (`"default": true`) since "must satisfy its sibling
   *   type" isn't practically expressible in JSON Schema. Core enforces it via
   *   `collectDefaultIssues` (shared with `compileParameters` so `validate`
   *   and `prepare` cannot drift). (task 18, fix round 4)
   * - A binding referencing a parameter name that isn't declared in
   *   `spec.parameters`: this is a cross-reference between two different
   *   parts of the manifest, which a single JSON Schema `$ref` cannot express
   *   (it would need something like a dynamic enum of "whatever keys exist
   *   under spec.parameters", which JSON Schema has no mechanism for). Core
   *   enforces it by threading `spec.parameters`'s keys into `validateBindings`.
   *   (task 18, fix round 5)
   *
   * Both are validate-vs-prepare concerns inside core, not schema-vs-core
   * ones - the point of this override is to keep that distinction honest
   * rather than pretending the schema could ever agree here.
   */
  readonly expectSchemaValid?: boolean;
}

const NAME = { name: "x" } as const;

function withSpec(spec: unknown): unknown {
  return { apiVersion: "qspec.dev/v1", kind: "Dataset", metadata: NAME, spec };
}

function withMetadata(metadata: unknown): unknown {
  return { apiVersion: "qspec.dev/v1", kind: "Dataset", metadata, spec: {} };
}

function withTop(overrides: Record<string, unknown>): unknown {
  return {
    apiVersion: "qspec.dev/v1",
    kind: "Dataset",
    metadata: NAME,
    spec: {},
    ...overrides,
  };
}

const CASES: readonly Case[] = [
  // --- metadata ---
  {
    label: "metadata: title wrong type",
    manifest: withMetadata({ name: "x", title: 5 }),
    expectValid: false,
  },
  {
    label: "metadata: description wrong type",
    manifest: withMetadata({ name: "x", description: 5 }),
    expectValid: false,
  },
  {
    label: "metadata: extra unknown key",
    manifest: withMetadata({ name: "x", extra: 1 }),
    expectValid: true,
  },
  {
    label: "metadata: name with trailing dash",
    manifest: withMetadata({ name: "x-" }),
    expectValid: true,
  },
  { label: "metadata: name single char", manifest: withMetadata({ name: "x" }), expectValid: true },
  {
    label: "metadata: name empty string",
    manifest: withMetadata({ name: "" }),
    expectValid: false,
  },
  {
    label: "metadata: tags empty array",
    manifest: withMetadata({ name: "x", tags: [] }),
    expectValid: true,
  },
  { label: "metadata: null", manifest: withTop({ metadata: null }), expectValid: false },

  // --- top level ---
  { label: "top: kind empty string", manifest: withTop({ kind: "" }), expectValid: false },
  { label: "top: kind number", manifest: withTop({ kind: 5 }), expectValid: false },
  {
    label: "top: apiVersion missing",
    manifest: { kind: "Dataset", metadata: NAME, spec: {} },
    expectValid: false,
  },
  { label: "top: extra top-level key", manifest: withTop({ extra: "y" }), expectValid: true },
  { label: "top: $schema wrong type", manifest: withTop({ $schema: 5 }), expectValid: false },

  // --- parameters ---
  {
    label: "param: number type ok, no validation",
    manifest: withSpec({ parameters: { n: { type: "number" } } }),
    expectValid: true,
  },
  {
    label: "param: required non-boolean",
    manifest: withSpec({ parameters: { n: { type: "number", required: "yes" } } }),
    expectValid: false,
  },
  {
    label: "param: description non-string",
    manifest: withSpec({ parameters: { n: { type: "number", description: 5 } } }),
    expectValid: false,
  },
  {
    label:
      "param: default of the wrong type for a scalar parameter (schema deliberately leaves default unconstrained)",
    manifest: withSpec({ parameters: { n: { type: "number", default: { x: 1 } } } }),
    expectValid: false,
    expectSchemaValid: true,
  },
  {
    label:
      "param: default not among an enum's values (schema deliberately leaves default unconstrained)",
    manifest: withSpec({
      parameters: { p: { type: "enum", values: ["7d", "30d"], default: "90d" } },
    }),
    expectValid: false,
    expectSchemaValid: true,
  },
  {
    label:
      "param: default array whose elements violate items.type (schema deliberately leaves default unconstrained)",
    manifest: withSpec({
      parameters: { p: { type: "array", items: { type: "string" }, default: [1, 2] } },
    }),
    expectValid: false,
    expectSchemaValid: true,
  },
  {
    label: "param: well-formed defaults across several types",
    manifest: withSpec({
      parameters: {
        s: { type: "string", default: "hi" },
        n: { type: "number", default: 5 },
        i: { type: "integer", default: 2, validation: { min: 0, max: 10 } },
        b: { type: "boolean", default: true },
        p: { type: "enum", values: ["a", "b"], default: "a" },
        arr: { type: "array", items: { type: "string" }, default: ["x", "y"] },
      },
    }),
    expectValid: true,
  },
  {
    label: "param: presentation.control non-string",
    manifest: withSpec({ parameters: { n: { type: "number", presentation: { control: 5 } } } }),
    expectValid: false,
  },
  {
    label: "param: presentation extra key",
    manifest: withSpec({ parameters: { n: { type: "number", presentation: { foo: "bar" } } } }),
    expectValid: true,
  },
  {
    label: "param: enum values non-array",
    manifest: withSpec({ parameters: { p: { type: "enum", values: "x" } } }),
    expectValid: false,
  },
  {
    label: "param: enum values wrong element types (schema allows any)",
    manifest: withSpec({ parameters: { p: { type: "enum", values: [1, "a", true] } } }),
    expectValid: true,
  },
  {
    label: "param: array items with extra keys",
    manifest: withSpec({
      parameters: { p: { type: "array", items: { type: "string", extra: 1 } } },
    }),
    expectValid: true,
  },
  {
    label: "param: array items type array/enum nested (composite)",
    manifest: withSpec({ parameters: { p: { type: "array", items: { type: "array" } } } }),
    expectValid: false,
  },
  {
    label: "param: null definition",
    manifest: withSpec({ parameters: { p: null } }),
    expectValid: false,
  },
  {
    label: "param: array as parameters value",
    manifest: withSpec({ parameters: [] }),
    expectValid: false,
  },

  // --- dataset ---
  {
    label: "dataset: field with extra unknown key",
    manifest: withSpec({ dataset: { fields: { a: { type: "string", extra: 1 } } } }),
    expectValid: true,
  },
  {
    label: "dataset: field null definition",
    manifest: withSpec({ dataset: { fields: { a: null } } }),
    expectValid: false,
  },
  {
    label: "dataset: fields empty object",
    manifest: withSpec({ dataset: { fields: {} } }),
    expectValid: true,
  },
  {
    label: "dataset: extra key on dataset",
    manifest: withSpec({ dataset: { fields: {}, extra: 1 } }),
    expectValid: true,
  },
  {
    label: "dataset: field type array (composite ok for fields)",
    manifest: withSpec({ dataset: { fields: { a: { type: "array" } } } }),
    expectValid: true,
  },
  {
    label: "dataset: field type object (composite ok for fields)",
    manifest: withSpec({ dataset: { fields: { a: { type: "object" } } } }),
    expectValid: true,
  },
  {
    label: "dataset: field format array instead of object",
    manifest: withSpec({ dataset: { fields: { a: { type: "string", format: [] } } } }),
    expectValid: false,
  },

  // --- query / bindings ---
  {
    label: "query: source empty string",
    manifest: withSpec({ query: { source: "", language: "sql", statement: "x" } }),
    expectValid: false,
  },
  {
    label: "query: language empty string",
    manifest: withSpec({ query: { source: "s", language: "", statement: "x" } }),
    expectValid: false,
  },
  {
    label: "query: extra key on query",
    manifest: withSpec({ query: { source: "s", language: "sql", statement: "x", extra: 1 } }),
    expectValid: true,
  },
  {
    label: "query: statement null",
    manifest: withSpec({ query: { source: "s", language: "sql", statement: null } }),
    expectValid: true,
  },
  {
    label: "query: bindings value is number",
    manifest: withSpec({
      query: { source: "s", language: "sql", statement: "x", bindings: { a: 5 } },
    }),
    expectValid: false,
  },
  {
    label: "query: bindings value is array",
    manifest: withSpec({
      query: { source: "s", language: "sql", statement: "x", bindings: { a: [] } },
    }),
    expectValid: false,
  },
  {
    label:
      "query: binding object extra unknown key with parameter (SPEC.md §48: extensions must be preserved, never rejected)",
    manifest: withSpec({
      parameters: { p: { type: "string" } },
      query: {
        source: "s",
        language: "sql",
        statement: "x",
        bindings: { a: { parameter: "p", extra: 1 } },
      },
    }),
    expectValid: true,
  },
  {
    label: "query: binding object extra unknown key with literal (SPEC.md §48)",
    manifest: withSpec({
      query: {
        source: "s",
        language: "sql",
        statement: "x",
        bindings: { a: { literal: "x", extra: 1 } },
      },
    }),
    expectValid: true,
  },
  {
    label:
      "query: string binding references an undeclared parameter (schema cannot express this cross-reference; fix round 5)",
    manifest: withSpec({
      parameters: { from: { type: "date" } },
      query: { source: "s", language: "sql", statement: "x", bindings: { a: "$parameters.form" } },
    }),
    expectValid: false,
    expectSchemaValid: true,
  },
  {
    label:
      "query: { parameter } binding references an undeclared parameter (schema cannot express this cross-reference; fix round 5)",
    manifest: withSpec({
      parameters: { from: { type: "date" } },
      query: {
        source: "s",
        language: "sql",
        statement: "x",
        bindings: { a: { parameter: "form" } },
      },
    }),
    expectValid: false,
    expectSchemaValid: true,
  },
  {
    label: "query: missing entirely (not required at spec level)",
    manifest: withSpec({}),
    expectValid: true,
  },

  // --- transforms ---
  { label: "transforms: not array", manifest: withSpec({ transforms: {} }), expectValid: false },
  {
    label: "transforms: entry type empty string",
    manifest: withSpec({ transforms: [{ type: "" }] }),
    expectValid: false,
  },
  {
    label: "transforms: entry extra keys (allowed)",
    manifest: withSpec({ transforms: [{ type: "sort", field: "x" }] }),
    expectValid: true,
  },
  {
    label: "transforms: entry null",
    manifest: withSpec({ transforms: [null] }),
    expectValid: false,
  },
  { label: "transforms: empty array", manifest: withSpec({ transforms: [] }), expectValid: true },

  // --- presentation ---
  {
    label: "presentation: type empty string",
    manifest: withSpec({ presentation: { type: "" } }),
    expectValid: false,
  },
  {
    label: "presentation: extra keys (allowed)",
    manifest: withSpec({ presentation: { type: "line", x: { field: "a" } } }),
    expectValid: true,
  },
  { label: "presentation: null", manifest: withSpec({ presentation: null }), expectValid: false },
];

describe("validator parity table (permanent record of the broad audit)", () => {
  it("has the expected number of cases", () => {
    expect(CASES.length).toBe(54);
  });

  for (const { label, manifest, expectValid, expectSchemaValid } of CASES) {
    it(`${label} -> ${expectValid ? "valid" : "invalid"}`, () => {
      const coreValid = validateManifestStructure(manifest).length === 0;
      const schemaValid = validateWithJsonSchema(manifest).valid;
      expect(coreValid, `core: ${label}`).toBe(expectValid);
      expect(schemaValid, `schema: ${label}`).toBe(expectSchemaValid ?? expectValid);
    });
  }
});
