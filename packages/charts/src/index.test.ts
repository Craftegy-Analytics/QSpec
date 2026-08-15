import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  PresentationError,
  QSPEC_V1,
  createQSpec,
  definePlugin,
  formatPath,
  type PresentationType,
} from "@qspecs/core";
import { memory, runPresentationContractTests } from "@qspecs/testing";
import { charts } from "./index.js";
import { cartesianPresentationType } from "./internal/cartesian.js";
import { piePresentationType } from "./internal/pie.js";

interface ChartSpec {
  query?: { source: string; language: string; statement: string };
  dataset?: { fields: Record<string, { type: string }> };
  transforms?: { type: string; [key: string]: unknown }[];
  presentation?: { type: string; [key: string]: unknown };
}

interface ChartManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: ChartSpec;
}

function chartManifest(overrides: Partial<ChartSpec> = {}): ChartManifest {
  return {
    apiVersion: QSPEC_V1,
    kind: "Chart",
    metadata: { name: "monthly-revenue" },
    spec: {
      query: { source: "monthly", language: "memory", statement: "monthly" },
      dataset: {
        fields: { month: { type: "datetime" }, revenue: { type: "number" } },
      },
      presentation: { type: "line", x: { field: "month" }, series: [{ field: "revenue" }] },
      ...overrides,
    },
  };
}

/** A runtime with the plugin under test plus an in-memory query source. */
function runtime() {
  return createQSpec()
    .use(charts())
    .use(
      memory({
        tables: {
          monthly: {
            columns: ["month", "revenue"],
            rows: [
              ["2026-01", 10],
              ["2026-02", 25],
            ],
          },
        },
      }),
    );
}

describe("charts()", () => {
  it("registers all five presentation types and the Chart resource kind", async () => {
    let presentationNames: readonly string[] = [];
    let resourceNames: readonly string[] = [];
    const qspec = createQSpec()
      .use(charts())
      .use(
        definePlugin({
          name: "inspect-charts",
          setup(api) {
            presentationNames = api.presentations.list();
            resourceNames = api.resources.list();
          },
        }),
      );
    await qspec.ready();
    expect(presentationNames).toEqual(["area", "bar", "line", "pie", "scatter"]);
    // "Dataset" is core's own kind, registered unconditionally by createQSpec().
    expect(resourceNames).toEqual(["Chart", "Dataset"]);
  });

  it("prepares a valid Chart manifest", async () => {
    const prepared = await runtime().prepare(chartManifest());
    expect(prepared.kind).toBe("Chart");
    expect(prepared.projectedFields).toEqual(["month", "revenue"]);
  });

  it("fails prepare() when spec.query is missing", async () => {
    const manifest = chartManifest();
    delete manifest.spec.query;
    await expect(runtime().prepare(manifest)).rejects.toThrow(ManifestValidationError);
    await expect(runtime().prepare(manifest)).rejects.toThrow(/query/);
  });

  it("fails prepare() when spec.presentation is missing", async () => {
    const manifest = chartManifest();
    delete manifest.spec.presentation;
    await expect(runtime().prepare(manifest)).rejects.toThrow(ManifestValidationError);
    await expect(runtime().prepare(manifest)).rejects.toThrow(/presentation/);
  });

  it("fails prepare() with the SPEC.md §86 diagnostic for a misspelled series field", async () => {
    const manifest = chartManifest();
    manifest.spec.presentation = {
      type: "line",
      x: { field: "month" },
      series: [{ field: "reveneu" }],
    };
    try {
      await runtime().prepare(manifest);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationError);
      const issues = (error as PresentationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toMatch(/Unknown dataset field "reveneu"/);
      expect(issues[0]?.suggestion).toBe("revenue");
      expect(formatPath(issues[0]?.path ?? [])).toBe("spec.presentation.series[0].field");
    }
  });
});

const cartesianFields = [
  { name: "month", type: "datetime" as const },
  { name: "revenue", type: "number" as const },
];

for (const type of ["line", "bar", "area", "scatter"] as const) {
  runPresentationContractTests(type, cartesianPresentationType as PresentationType, {
    definition: { type, x: { field: "month" }, series: [{ field: "revenue" }] },
    fields: cartesianFields,
    expectedReferences: ["month", "revenue"],
  });
}

// Grouped series get their own run: `groupBy` is a dataset reference the
// array form has no equivalent for, and it is the one core would stop
// checking if `fieldReferences` ever forgot it.
runPresentationContractTests(
  "line (grouped series)",
  cartesianPresentationType as PresentationType,
  {
    definition: {
      type: "line",
      x: { field: "month" },
      series: { field: "revenue", groupBy: "region" },
    },
    fields: [...cartesianFields, { name: "region", type: "string" as const }],
    expectedReferences: ["month", "revenue", "region"],
  },
);

runPresentationContractTests("pie", piePresentationType as PresentationType, {
  definition: {
    type: "pie",
    category: { field: "month" },
    value: { field: "revenue" },
  },
  fields: cartesianFields,
  expectedReferences: ["month", "revenue"],
});
