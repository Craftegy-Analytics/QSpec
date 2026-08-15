import { describe, expect, it } from "vitest";
import { formatPath } from "../../errors.js";
import { validateManifestStructure } from "./manifest.js";

const valid = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "monthly-revenue", title: "Monthly Revenue", tags: ["finance"] },
  spec: {},
};

function paths(manifest: unknown): string[] {
  return validateManifestStructure(manifest).map((issue) => formatPath(issue.path));
}

describe("validateManifestStructure", () => {
  it("accepts a minimal valid manifest", () => {
    expect(validateManifestStructure(valid)).toEqual([]);
  });

  it("accepts an optional $schema", () => {
    expect(validateManifestStructure({ ...valid, $schema: "https://qspec.dev/x.json" })).toEqual(
      [],
    );
  });

  it("requires apiVersion, kind, metadata, and spec", () => {
    expect(paths({})).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  });

  it("rejects an unsupported apiVersion with a dedicated code", () => {
    const issues = validateManifestStructure({ ...valid, apiVersion: "qspec.dev/v9" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("QSPEC_API_VERSION_UNSUPPORTED");
    expect(issues[0]?.path).toEqual(["apiVersion"]);
  });

  it("requires metadata.name", () => {
    expect(paths({ ...valid, metadata: {} })).toEqual(["metadata.name"]);
  });

  it("enforces the metadata.name pattern and suggests a corrected value", () => {
    const issues = validateManifestStructure({ ...valid, metadata: { name: "Monthly Revenue" } });
    expect(issues[0]?.path).toEqual(["metadata", "name"]);
    expect(issues[0]?.suggestion).toBe("monthly-revenue");
  });

  it("requires metadata.tags to be an array of strings", () => {
    expect(paths({ ...valid, metadata: { name: "x", tags: "finance" } })).toEqual([
      "metadata.tags",
    ]);
    expect(paths({ ...valid, metadata: { name: "x", tags: [1] } })).toEqual(["metadata.tags[0]"]);
  });

  it("requires spec to be an object", () => {
    expect(paths({ ...valid, spec: [] })).toEqual(["spec"]);
  });

  it("requires spec.parameters to be an object", () => {
    expect(paths({ ...valid, spec: { parameters: [] } })).toEqual(["spec.parameters"]);
  });

  it("requires spec.dataset to be an object", () => {
    expect(paths({ ...valid, spec: { dataset: [] } })).toEqual(["spec.dataset"]);
  });

  it("requires spec.dataset.fields to be an object", () => {
    expect(paths({ ...valid, spec: { dataset: {} } })).toEqual(["spec.dataset.fields"]);
  });

  it("requires each dataset field declaration to be an object", () => {
    const manifest = { ...valid, spec: { dataset: { fields: { a: "string" } } } };
    expect(paths(manifest)).toEqual(["spec.dataset.fields.a"]);
  });

  it("rejects an unknown dataset field type and suggests a close match", () => {
    const manifest = { ...valid, spec: { dataset: { fields: { a: { type: "strng" } } } } };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.dataset.fields.a.type");
    expect(issues[0]?.suggestion).toBe("string");
  });

  it("rejects a missing dataset field type", () => {
    const manifest = { ...valid, spec: { dataset: { fields: { a: {} } } } };
    expect(paths(manifest)).toEqual(["spec.dataset.fields.a.type"]);
  });

  it("rejects a non-boolean dataset field nullable", () => {
    const manifest = {
      ...valid,
      spec: { dataset: { fields: { a: { type: "string", nullable: "yes" } } } },
    };
    expect(paths(manifest)).toEqual(["spec.dataset.fields.a.nullable"]);
  });

  it("rejects a non-string dataset field label or semanticType", () => {
    expect(
      paths({ ...valid, spec: { dataset: { fields: { a: { type: "string", label: 1 } } } } }),
    ).toEqual(["spec.dataset.fields.a.label"]);
    expect(
      paths({
        ...valid,
        spec: { dataset: { fields: { a: { type: "string", semanticType: 1 } } } },
      }),
    ).toEqual(["spec.dataset.fields.a.semanticType"]);
  });

  it("rejects a non-object dataset field format", () => {
    const manifest = {
      ...valid,
      spec: { dataset: { fields: { a: { type: "string", format: "usd" } } } },
    };
    expect(paths(manifest)).toEqual(["spec.dataset.fields.a.format"]);
  });

  it("accepts well-formed dataset field declarations", () => {
    const manifest = {
      ...valid,
      spec: {
        dataset: {
          fields: {
            a: { type: "string", nullable: false },
            b: {
              type: "number",
              nullable: true,
              label: "B",
              semanticType: "currency",
              format: { currency: "USD" },
            },
          },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("requires spec.transforms entries to declare a non-empty string type", () => {
    expect(paths({ ...valid, spec: { transforms: [{}] } })).toEqual(["spec.transforms[0].type"]);
    expect(paths({ ...valid, spec: { transforms: [{ type: "" }] } })).toEqual([
      "spec.transforms[0].type",
    ]);
  });

  it("requires spec.presentation to declare a non-empty string type", () => {
    expect(paths({ ...valid, spec: { presentation: {} } })).toEqual(["spec.presentation.type"]);
    expect(paths({ ...valid, spec: { presentation: { type: "" } } })).toEqual([
      "spec.presentation.type",
    ]);
  });

  it("requires query.source, query.language, and query.statement", () => {
    expect(paths({ ...valid, spec: { query: {} } })).toEqual([
      "spec.query.source",
      "spec.query.language",
      "spec.query.statement",
    ]);
  });

  it("accepts a structured (non-string) query statement", () => {
    const manifest = {
      ...valid,
      spec: { query: { source: "s", language: "opensearch-dsl", statement: { match_all: {} } } },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("rejects a string binding that is not a $parameters reference", () => {
    const manifest = {
      ...valid,
      spec: { query: { source: "s", language: "sql", statement: "x", bindings: { a: "US" } } },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.query.bindings.a");
    expect(issues[0]?.message).toMatch(/\$parameters\./);
  });

  it("accepts all three binding forms", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: { from: { type: "date" }, to: { type: "date" } },
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: "$parameters.from", b: { parameter: "to" }, c: { literal: "US" } },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("rejects a binding with both parameter and literal, even when parameter is mistyped", () => {
    const manifest = {
      ...valid,
      spec: {
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: { parameter: 5, literal: "x" } },
        },
      },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.query.bindings.a");
  });

  it("rejects a binding object with neither parameter nor literal", () => {
    const manifest = {
      ...valid,
      spec: {
        query: { source: "s", language: "sql", statement: "x", bindings: { a: {} } },
      },
    };
    expect(validateManifestStructure(manifest)).toHaveLength(1);
  });

  it("rejects a non-string parameter when it is the only key", () => {
    const manifest = {
      ...valid,
      spec: {
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: { parameter: 5 } },
        },
      },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/must be a string/);
  });

  it("rejects a binding with both a correctly-typed parameter and literal", () => {
    const manifest = {
      ...valid,
      spec: {
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: { parameter: "p", literal: 1 } },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toHaveLength(1);
  });

  it("accepts an x-vendor extension key alongside a binding's parameter", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: { p: { type: "string" } },
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: { parameter: "p", "x-vendor": { hint: "cache" } } },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  // Matches compileBindings's exact message and did-you-mean suggestion, so
  // `qspec validate` and prepare() report identically. (task 18, fix round 5)
  it("rejects a string binding referencing an undeclared parameter, with a did-you-mean suggestion", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: { from: { type: "date" } },
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: "$parameters.form" },
        },
      },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.query.bindings.a");
    expect(issues[0]?.message).toBe('Binding "a" references undeclared parameter "form".');
    expect(issues[0]?.suggestion).toBe("from");
  });

  it("rejects a { parameter } binding referencing an undeclared parameter, with the same suggestion", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: { from: { type: "date" } },
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: { parameter: "form" } },
        },
      },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.query.bindings.a");
    expect(issues[0]?.message).toBe('Binding "a" references undeclared parameter "form".');
    expect(issues[0]?.suggestion).toBe("from");
  });

  it("accepts a binding referencing a declared parameter, in both forms", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: { from: { type: "date" } },
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: "$parameters.from", b: { parameter: "from" } },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("reports an undeclared reference rather than crashing when spec.parameters is absent entirely", () => {
    const manifest = {
      ...valid,
      spec: {
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: "$parameters.from" },
        },
      },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe('Binding "a" references undeclared parameter "from".');
  });

  it("rejects a binding with an explicitly-undefined literal", () => {
    // Object.hasOwn is true for an explicitly-undefined property, so this
    // fixture must be an object literal, not JSON.parse (which cannot
    // represent undefined).
    const manifest = {
      ...valid,
      spec: {
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: { literal: undefined } },
        },
      },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.query.bindings.a");
    expect(issues[0]?.message).toMatch(/must not be undefined/);
  });

  it("requires each parameter declaration to be an object", () => {
    const manifest = { ...valid, spec: { parameters: { p: "string" } } };
    expect(paths(manifest)).toEqual(["spec.parameters.p"]);
  });

  it("rejects an unknown parameter type and suggests a close match", () => {
    const manifest = { ...valid, spec: { parameters: { p: { type: "strng" } } } };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.parameters.p.type");
    expect(issues[0]?.suggestion).toBe("string");
  });

  it("rejects a missing parameter type without crashing on the suggestion path", () => {
    const manifest = { ...valid, spec: { parameters: { p: {} } } };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.parameters.p.type");
    expect(issues[0]?.suggestion).toBeUndefined();
  });

  it("requires an enum parameter to declare a non-empty values array", () => {
    const manifest = { ...valid, spec: { parameters: { period: { type: "enum" } } } };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.parameters.period.values");

    expect(
      paths({ ...valid, spec: { parameters: { period: { type: "enum", values: [] } } } }),
    ).toEqual(["spec.parameters.period.values"]);
  });

  it("requires an array parameter to declare a scalar items.type", () => {
    expect(paths({ ...valid, spec: { parameters: { tags: { type: "array" } } } })).toEqual([
      "spec.parameters.tags.items",
    ]);
    expect(
      paths({ ...valid, spec: { parameters: { tags: { type: "array", items: {} } } } }),
    ).toEqual(["spec.parameters.tags.items"]);
    expect(
      paths({
        ...valid,
        spec: { parameters: { tags: { type: "array", items: { type: "enum" } } } },
      }),
    ).toEqual(["spec.parameters.tags.items"]);
  });

  it("accepts a well-formed enum and array parameter", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: {
          period: { type: "enum", values: ["7d", "30d"] },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("rejects a non-boolean parameter required", () => {
    const manifest = { ...valid, spec: { parameters: { p: { type: "string", required: "yes" } } } };
    expect(paths(manifest)).toEqual(["spec.parameters.p.required"]);
  });

  it("rejects a non-string parameter description", () => {
    const manifest = { ...valid, spec: { parameters: { p: { type: "string", description: 5 } } } };
    expect(paths(manifest)).toEqual(["spec.parameters.p.description"]);
  });

  it("rejects a non-object parameter presentation", () => {
    const manifest = { ...valid, spec: { parameters: { p: { type: "string", presentation: 5 } } } };
    expect(paths(manifest)).toEqual(["spec.parameters.p.presentation"]);
  });

  it("rejects a non-string parameter presentation.control (advisory but not unvalidated)", () => {
    const manifest = {
      ...valid,
      spec: { parameters: { p: { type: "string", presentation: { control: 5 } } } },
    };
    expect(paths(manifest)).toEqual(["spec.parameters.p.presentation.control"]);
  });

  it("rejects non-string parameter presentation.label, .placeholder, and .help", () => {
    for (const key of ["label", "placeholder", "help"] as const) {
      expect(
        paths({
          ...valid,
          spec: { parameters: { p: { type: "string", presentation: { [key]: 5 } } } },
        }),
      ).toEqual([`spec.parameters.p.presentation.${key}`]);
    }
  });

  it("accepts a well-formed required, description, and presentation on a parameter", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: {
          p: {
            type: "string",
            required: true,
            description: "A description.",
            presentation: { control: "text", label: "P", placeholder: "...", help: "Help." },
          },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("requires parameter validation to be an object", () => {
    const manifest = { ...valid, spec: { parameters: { n: { type: "number", validation: [] } } } };
    expect(paths(manifest)).toEqual(["spec.parameters.n.validation"]);
  });

  it("requires parameter validation.min and validation.max to be numeric", () => {
    expect(
      paths({
        ...valid,
        spec: { parameters: { n: { type: "number", validation: { min: "0" } } } },
      }),
    ).toEqual(["spec.parameters.n.validation.min"]);
    expect(
      paths({
        ...valid,
        spec: { parameters: { n: { type: "number", validation: { max: "10" } } } },
      }),
    ).toEqual(["spec.parameters.n.validation.max"]);
  });

  it("requires parameter validation.minLength and maxLength to be non-negative integers", () => {
    expect(
      paths({
        ...valid,
        spec: { parameters: { s: { type: "string", validation: { minLength: 1.5 } } } },
      }),
    ).toEqual(["spec.parameters.s.validation.minLength"]);
    expect(
      paths({
        ...valid,
        spec: { parameters: { s: { type: "string", validation: { maxLength: -1 } } } },
      }),
    ).toEqual(["spec.parameters.s.validation.maxLength"]);
  });

  it("accepts a well-formed parameter validation block", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: {
          n: { type: "integer", validation: { min: 1, max: 100 } },
          s: { type: "string", validation: { minLength: 0, maxLength: 10 } },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  // These share compileParameters's coerce() logic (via collectDefaultIssues in
  // parameters.ts), so `qspec validate` can never accept a `default` that
  // prepare() would then reject. (task 18, fix round 4)
  it("rejects a default of the wrong type for a scalar parameter", () => {
    const manifest = { ...valid, spec: { parameters: { n: { type: "number", default: "x" } } } };
    expect(paths(manifest)).toEqual(["spec.parameters.n.default"]);
  });

  it("rejects a default not among an enum's values", () => {
    const manifest = {
      ...valid,
      spec: { parameters: { p: { type: "enum", values: ["7d", "30d"], default: "90d" } } },
    };
    expect(paths(manifest)).toEqual(["spec.parameters.p.default"]);
  });

  it("rejects a default array whose elements violate items.type", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: { p: { type: "array", items: { type: "string" }, default: [1, 2] } },
      },
    };
    // One issue per offending element, same as coerce() reports for a
    // runtime array value - default validation reuses that exact logic.
    expect(paths(manifest)).toEqual([
      "spec.parameters.p.default[0]",
      "spec.parameters.p.default[1]",
    ]);
  });

  it("rejects a default violating the parameter's own validation constraints", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: { n: { type: "integer", default: 200, validation: { min: 1, max: 100 } } },
      },
    };
    expect(paths(manifest)).toEqual(["spec.parameters.n.default"]);
  });

  it("does not cascade a default check onto an already-malformed enum/array declaration", () => {
    // The enum has no `values` at all, so coerce() has nothing to check the
    // default against; only the one, clear "must declare values" issue should
    // surface, not a second confusing one about `default`.
    const manifest = {
      ...valid,
      spec: { parameters: { p: { type: "enum", default: "x" } } },
    };
    expect(paths(manifest)).toEqual(["spec.parameters.p.values"]);
  });

  it("accepts well-formed defaults across several parameter types", () => {
    const manifest = {
      ...valid,
      spec: {
        parameters: {
          s: { type: "string", default: "hi" },
          n: { type: "number", default: 5 },
          i: { type: "integer", default: 2, validation: { min: 0, max: 10 } },
          b: { type: "boolean", default: true },
          p: { type: "enum", values: ["a", "b"], default: "a" },
          arr: { type: "array", items: { type: "string" }, default: ["x", "y"] },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("reports every problem in one pass rather than stopping at the first", () => {
    expect(paths({ apiVersion: "qspec.dev/v1", kind: 1, metadata: {}, spec: 5 }).length).toBe(3);
  });

  it("preserves unknown x-vendor extension fields without complaint", () => {
    const manifest = { ...valid, spec: { presentation: { type: "line", "x-echarts": { a: 1 } } } };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });
});
