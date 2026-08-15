import { describe, expect, it } from "vitest";
import {
  LimitExceededError,
  ManifestValidationError,
  PresentationError,
  UnknownDataSourceError,
  UnknownQueryLanguageError,
  UnknownResourceKindError,
  formatPath,
} from "../errors.js";
import { definePlugin } from "../define.js";
import type { Field } from "../types/dataset.js";
import type { DataSource } from "../types/plugin.js";
import { createQSpec } from "./runtime.js";

interface ChartSpec {
  parameters: Record<string, { type: string; required?: boolean }>;
  query?: {
    source: string;
    language: string;
    statement: string;
    bindings: Record<string, string>;
  };
  dataset?: { fields: Record<string, { type: string }> };
  transforms?: { type: string; [key: string]: unknown }[];
  presentation: { type: string; x?: { field: string }; series?: { field: string }[] };
}

interface ChartManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: ChartSpec;
}

function chartManifest(overrides: Partial<ChartSpec> = {}): ChartManifest {
  return {
    apiVersion: "qspec.dev/v1",
    kind: "Chart",
    metadata: { name: "monthly-revenue" },
    spec: {
      parameters: { from: { type: "date", required: true } },
      query: {
        source: "analytics",
        language: "sql",
        statement: "SELECT 1",
        bindings: { from: "$parameters.from" },
      },
      dataset: {
        fields: { month: { type: "datetime" }, revenue: { type: "number" } },
      },
      presentation: { type: "line", x: { field: "month" }, series: [{ field: "revenue" }] },
      ...overrides,
    },
  };
}

/** A runtime with just enough registered capability to prepare a chart. */
function runtime() {
  return createQSpec().use(
    definePlugin({
      name: "test-capabilities",
      setup(api) {
        api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
        api.queryLanguages.register("sql", { compile: (query) => query.statement });
        api.sources.register("analytics", { execute: async () => ({ columns: [], rows: [] }) });
        api.presentations.register("line", {
          fieldReferences: (definition) => {
            const references: { field: string; path: (string | number)[] }[] = [];
            const x = (definition as { x?: { field?: string } }).x;
            if (x?.field !== undefined) references.push({ field: x.field, path: ["x", "field"] });
            const series = (definition as { series?: { field?: string }[] }).series ?? [];
            series.forEach((entry, index) => {
              if (entry.field !== undefined) {
                references.push({ field: entry.field, path: ["series", index, "field"] });
              }
            });
            return references;
          },
        });
        api.transforms.register("rename", {
          execute: (dataset) => dataset,
          describe: (fields, spec) => {
            const { from, to } = spec as { from: string; to: string };
            return fields.map((field): Field =>
              field.name === from ? { ...field, name: to } : field,
            );
          },
        });
        api.transforms.register("opaque", { execute: (dataset) => dataset });
      },
    }),
  );
}

describe("prepare", () => {
  it("prepares a valid chart manifest", async () => {
    const prepared = await runtime().prepare(chartManifest());
    expect(prepared.kind).toBe("Chart");
    expect(prepared.projectedFields).toEqual(["month", "revenue"]);
  });

  it("rejects a structurally invalid manifest before touching capabilities", async () => {
    await expect(runtime().prepare({ apiVersion: "qspec.dev/v1" })).rejects.toThrow(
      ManifestValidationError,
    );
  });

  it("rejects an unknown resource kind", async () => {
    const manifest = chartManifest();
    manifest.kind = "Widget";
    await expect(runtime().prepare(manifest)).rejects.toThrow(UnknownResourceKindError);
  });

  it("carries a did-you-mean hint in details, and leaves details unset without one", async () => {
    // `{ suggestion: undefined }` is a truthy object, so passing it
    // unconditionally would sail past QSpecError's `details !== undefined`
    // guard and leave every consumer holding an object with an empty hint.
    const near = chartManifest();
    near.kind = "Chrat";
    await expect(runtime().prepare(near)).rejects.toMatchObject({
      details: { suggestion: "Chart" },
    });

    const far = chartManifest();
    far.kind = "Zzzzzzzzzzzz";
    try {
      await runtime().prepare(far);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownResourceKindError);
      // Asserted on the value, not on the key: `details` is declared as a class
      // field, so under useDefineForClassFields the property always exists.
      expect((error as UnknownResourceKindError).details).toBeUndefined();
    }
  });

  it("rejects an unknown query language", async () => {
    const manifest = chartManifest();
    if (manifest.spec.query !== undefined) manifest.spec.query.language = "promql";
    await expect(runtime().prepare(manifest)).rejects.toThrow(UnknownQueryLanguageError);
  });

  it("rejects an unknown data source", async () => {
    const manifest = chartManifest();
    if (manifest.spec.query !== undefined) manifest.spec.query.source = "warehouse";
    await expect(runtime().prepare(manifest)).rejects.toThrow(UnknownDataSourceError);
  });

  describe("DataSource.supportedLanguages", () => {
    /** A source whose `execute` calls are countable, for the before-execute assertion. */
    function trackedSource(supportedLanguages?: readonly string[]) {
      const state = { calls: 0 };
      const source: DataSource = {
        execute: async () => {
          state.calls += 1;
          return { columns: [], rows: [] };
        },
        ...(supportedLanguages === undefined ? {} : { supportedLanguages }),
      };
      return { source, state };
    }

    /** Two registered query languages ("sql", "mysql") and one configurable source. */
    function languageRuntime(source: DataSource) {
      return createQSpec().use(
        definePlugin({
          name: "language-pairing",
          setup(api) {
            api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
            api.queryLanguages.register("sql", { compile: (query) => query.statement });
            api.queryLanguages.register("mysql", { compile: (query) => query.statement });
            api.sources.register("warehouse", source);
            api.presentations.register("line", {});
          },
        }),
      );
    }

    function warehouseManifest(language: string) {
      const manifest = chartManifest();
      if (manifest.spec.query !== undefined) {
        manifest.spec.query.source = "warehouse";
        manifest.spec.query.language = language;
      }
      return manifest;
    }

    it("prepares fine when the source declares support for the requested language", async () => {
      const { source } = trackedSource(["sql"]);
      const prepared = await languageRuntime(source).prepare(warehouseManifest("sql"));
      expect(prepared.kind).toBe("Chart");
    });

    it("rejects a language the source does not support, at spec.query.language", async () => {
      const { source } = trackedSource(["sql"]);
      try {
        await languageRuntime(source).prepare(warehouseManifest("mysql"));
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ManifestValidationError);
        const issues = (error as ManifestValidationError).issues;
        expect(issues).toHaveLength(1);
        expect(formatPath(issues[0]?.path ?? [])).toBe("spec.query.language");
        // Names both the source and its supported languages. Asserted as the
        // actual clause, not a bare `toContain("sql")`: "sql" is a substring
        // of "mysql", which the requested-language assertion below already
        // proves is in the message, so a token-only check on "sql" could
        // never fail even if the supported-languages clause were deleted.
        expect(issues[0]?.message).toContain("warehouse");
        expect(issues[0]?.message).toContain("mysql");
        expect(issues[0]?.message).toContain("Supported languages: sql");
      }
    });

    it("accepts any language when the source omits supportedLanguages (compatibility guarantee)", async () => {
      const { source } = trackedSource(undefined);
      const prepared = await languageRuntime(source).prepare(warehouseManifest("mysql"));
      expect(prepared.kind).toBe("Chart");
    });

    it("checks the language/source pairing before compileBindings or language.validate() run", async () => {
      // `state.calls === 0` on the source would be vacuous: prepare() never
      // calls DataSource.execute() under any implementation (that only
      // happens later, via PreparedResource.execute()), so that counter
      // would read 0 whether this check runs first, last, or not at all.
      // language.validate() is a real, later step in the same branch
      // (prepare.ts runs it after compileBindings), so counting its calls
      // actually distinguishes "the mismatch check ran first" from "it
      // didn't run, or ran too late."
      const { source } = trackedSource(["sql"]);
      const validateState = { calls: 0 };
      const qspec = createQSpec().use(
        definePlugin({
          name: "language-pairing-order",
          setup(api) {
            api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
            api.queryLanguages.register("sql", { compile: (query) => query.statement });
            api.queryLanguages.register("mysql", {
              compile: (query) => query.statement,
              validate: () => {
                validateState.calls += 1;
              },
            });
            api.sources.register("warehouse", source);
            api.presentations.register("line", {});
          },
        }),
      );
      await expect(qspec.prepare(warehouseManifest("mysql"))).rejects.toThrow(
        ManifestValidationError,
      );
      expect(validateState.calls).toBe(0);
    });

    it("suggests a close supported language on a near-miss name", async () => {
      const { source } = trackedSource(["mysql"]);
      try {
        await languageRuntime(source).prepare(warehouseManifest("sql"));
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ManifestValidationError);
        const issues = (error as ManifestValidationError).issues;
        expect(issues[0]?.suggestion).toBe("mysql");
      }
    });

    it("treats an empty supportedLanguages as supporting no language, with no bogus suggestion", async () => {
      const { source } = trackedSource([]);
      try {
        await languageRuntime(source).prepare(warehouseManifest("sql"));
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ManifestValidationError);
        const issues = (error as ManifestValidationError).issues;
        expect(issues[0]?.message).toContain("Supported languages: (none)");
        expect(issues[0]?.suggestion).toBeUndefined();
      }
    });
  });

  it("requires a query when the resource kind demands one", async () => {
    const manifest = chartManifest();
    delete manifest.spec.query;
    await expect(runtime().prepare(manifest)).rejects.toThrow(/query/);
  });

  it("rejects an unknown transform type and suggests a registered one", async () => {
    const manifest = chartManifest({ transforms: [{ type: "renmae", from: "a", to: "b" }] });
    await expect(runtime().prepare(manifest)).rejects.toThrow(/rename/);
  });

  it("fails static presentation validation for a misspelled field", async () => {
    const manifest = chartManifest();
    manifest.spec.presentation.series = [{ field: "reveneu" }];
    await expect(runtime().prepare(manifest)).rejects.toThrow(PresentationError);
  });

  it("projects renamed fields so presentation validation follows the pipeline", async () => {
    const manifest = chartManifest({
      transforms: [{ type: "rename", from: "revenue", to: "total" }],
    });
    manifest.spec.presentation.series = [{ field: "total" }];
    const prepared = await runtime().prepare(manifest);
    expect(prepared.projectedFields).toEqual(["month", "total"]);
  });

  it("stops projecting at a schema-opaque transform and skips the field check", async () => {
    const manifest = chartManifest({ transforms: [{ type: "opaque" }] });
    manifest.spec.presentation.series = [{ field: "anything-goes" }];
    const prepared = await runtime().prepare(manifest);
    expect(prepared.projectedFields).toBeUndefined();
  });

  it("skips static field checks when no dataset schema is declared", async () => {
    const manifest = chartManifest();
    delete manifest.spec.dataset;
    manifest.spec.presentation.series = [{ field: "unknowable" }];
    const prepared = await runtime().prepare(manifest);
    expect(prepared.projectedFields).toBeUndefined();
  });

  it("rejects a binding to an undeclared parameter", async () => {
    // "form" is a typo for the declared "from" - this is now caught by
    // structural validation (validateManifestStructure), before prepare()
    // ever reaches compileBindings, so the two report identically. (task 18,
    // fix round 5)
    const manifest = chartManifest();
    if (manifest.spec.query !== undefined) {
      manifest.spec.query.bindings = { from: "$parameters.form" };
    }
    try {
      await runtime().prepare(manifest);
      expect.unreachable("expected prepare() to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      const issues = (error as ManifestValidationError).issues;
      expect(issues.some((issue) => /form/.test(issue.message))).toBe(true);
      expect(issues[0]?.suggestion).toBe("from");
    }
  });

  it("enforces maxTransforms", async () => {
    const transforms = Array.from({ length: 5 }, () => ({ type: "opaque" }));
    const qspec = createQSpec({ limits: { maxTransforms: 2 } }).use(
      definePlugin({
        name: "t",
        setup: (api) => {
          api.resources.register("Dataset2", {});
          api.transforms.register("opaque", { execute: (d) => d });
        },
      }),
    );
    await expect(
      qspec.prepare({
        apiVersion: "qspec.dev/v1",
        kind: "Dataset2",
        metadata: { name: "x" },
        spec: { transforms },
      }),
    ).rejects.toThrow(LimitExceededError);
  });

  it("does not freeze the capability implementations it planned against", async () => {
    const source = { execute: async () => ({ columns: [], rows: [] }), state: { calls: 0 } };
    const qspec = createQSpec().use(
      definePlugin({
        name: "stateful",
        setup: (api) => {
          api.resources.register("Dataset3", { requiresQuery: true });
          api.queryLanguages.register("sql", { compile: (query) => query.statement });
          api.sources.register("analytics", source);
        },
      }),
    );
    await qspec.prepare({
      apiVersion: "qspec.dev/v1",
      kind: "Dataset3",
      metadata: { name: "x" },
      spec: {
        query: { source: "analytics", language: "sql", statement: "SELECT 1" },
      },
    });
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.state)).toBe(false);
  });

  it("freezes the manifest so a later mutation cannot bypass static validation", async () => {
    const manifest = chartManifest();
    const prepared = await runtime().prepare(manifest);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.spec)).toBe(true);
    expect(Object.isFrozen(manifest.spec.presentation)).toBe(true);

    const query = manifest.spec.query;
    if (query === undefined) throw new Error("expected the fixture to declare a query");
    expect(Object.isFrozen(query)).toBe(true);
    // Modules are strict mode, so writing to a frozen property throws rather
    // than silently no-opping. Either way the plan must be unaffected.
    expect(() => {
      query.statement = "DROP TABLE users";
    }).toThrow(TypeError);
    expect(query.statement).toBe("SELECT 1");
    expect(prepared.projectedFields).toEqual(["month", "revenue"]);
  });

  // Named for what it actually checks. The compiled parameter record that
  // `freezeParameters` freezes lives on the internal plan, which is captured in
  // the PreparedResource.execute closure and is unreachable from a test; this
  // covers the manifest side instead — that the deep freeze recurses past the
  // top level rather than stopping at `spec`.
  it("deep-freezes nested manifest nodes, not just the top level", async () => {
    const manifest = chartManifest();
    await runtime().prepare(manifest);
    expect(Object.isFrozen(manifest.spec.parameters)).toBe(true);

    // Resolved and checked for existence first: Object.isFrozen(undefined) is
    // `true`, so asserting on a missing node would pass while proving nothing.
    const from = manifest.spec.parameters["from"];
    const revenue = manifest.spec.dataset?.fields["revenue"];
    expect(from).toBeDefined();
    expect(revenue).toBeDefined();
    expect(Object.isFrozen(from)).toBe(true);
    expect(Object.isFrozen(revenue)).toBe(true);
  });

  it("deep-freezes a manifest the caller had already shallow-frozen", async () => {
    // Object.freeze on the caller's side must not opt the manifest out of the
    // deep freeze; otherwise `spec` stays mutable and post-prepare mutation
    // could change what a later execute() runs.
    const manifest = Object.freeze(chartManifest());
    await runtime().prepare(manifest);

    expect(Object.isFrozen(manifest.spec)).toBe(true);
    expect(Object.isFrozen(manifest.spec.query)).toBe(true);
    expect(() => {
      manifest.spec.presentation = { type: "bar" };
    }).toThrow(TypeError);
  });

  it("reports every issue a transform's validate hook returns, rebased onto the manifest", async () => {
    const qspec = createQSpec().use(
      definePlugin({
        name: "returning-transform",
        setup(api) {
          api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
          api.queryLanguages.register("sql", { compile: (query) => query.statement });
          api.sources.register("analytics", { execute: async () => ({ columns: [], rows: [] }) });
          api.presentations.register("line", {});
          api.transforms.register("picky", {
            execute: (dataset) => dataset,
            validate: () => [
              { code: "QSPEC_TRANSFORM_INVALID", message: "`by` is required", path: ["by"] },
              { code: "QSPEC_TRANSFORM_INVALID", message: "`n` must be positive", path: ["n"] },
            ],
          });
        },
      }),
    );

    try {
      await qspec.prepare(chartManifest({ transforms: [{ type: "picky" }] }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      const issues = (error as ManifestValidationError).issues;
      expect(issues.map((issue) => formatPath(issue.path))).toEqual([
        "spec.transforms[0].by",
        "spec.transforms[0].n",
      ]);
    }
  });

  it("reports issues returned by the query language and resource kind hooks", async () => {
    const qspec = createQSpec().use(
      definePlugin({
        name: "returning-language",
        setup(api) {
          api.resources.register("Chart", {});
          api.queryLanguages.register("sql", {
            compile: (query) => query.statement,
            validate: () => [
              { code: "QSPEC_QUERY_INVALID", message: "no SELECT *", path: ["statement"] },
            ],
          });
          api.sources.register("analytics", { execute: async () => ({ columns: [], rows: [] }) });
          api.presentations.register("line", {});
        },
      }),
    );

    await expect(qspec.prepare(chartManifest())).rejects.toThrow(ManifestValidationError);
    await qspec
      .prepare(chartManifest())
      .catch((error: ManifestValidationError) =>
        expect(formatPath(error.issues[0]?.path ?? [])).toBe("spec.query.statement"),
      );
  });

  it("still lets a thrown plugin error propagate unchanged", async () => {
    const qspec = createQSpec().use(
      definePlugin({
        name: "throwing-kind",
        setup(api) {
          api.resources.register("Chart", {
            validate: () => {
              throw new Error("kind says no");
            },
          });
          api.queryLanguages.register("sql", { compile: (query) => query.statement });
          api.sources.register("analytics", { execute: async () => ({ columns: [], rows: [] }) });
          api.presentations.register("line", {});
        },
      }),
    );

    await expect(qspec.prepare(chartManifest())).rejects.toThrow("kind says no");
  });

  it("is reusable: preparing once allows many executions", async () => {
    const prepared = await runtime().prepare(chartManifest());
    expect(typeof prepared.execute).toBe("function");
  });
});
