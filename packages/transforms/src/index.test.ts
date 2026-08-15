import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  PluginRegistrationError,
  QSPEC_V1,
  createQSpec,
  definePlugin,
  type Dataset,
  type Field,
} from "@qspecs/core";
import { runTransformContractTests } from "@qspecs/testing";
import { transforms } from "./index.js";
import { createDeriveTransform } from "./internal/derive.js";
import { createFilterTransform } from "./internal/filter.js";
import { limitTransform } from "./internal/limit.js";
import { renameTransform } from "./internal/rename.js";
import { emptyRow, setCell } from "./internal/rows.js";
import { selectTransform } from "./internal/select.js";
import { sortTransform } from "./internal/sort.js";

const fields: readonly Field[] = [
  { name: "month", type: "datetime" },
  { name: "revenue", type: "number" },
];

function fixtureDataset(): Dataset {
  const rows: Record<string, unknown>[] = [
    { month: "2026-01", revenue: 10 },
    { month: "2026-02", revenue: 0 },
    { month: "2026-03", revenue: 25 },
  ];
  return {
    fields,
    rows: rows.map((source) => {
      const row = emptyRow();
      for (const [key, value] of Object.entries(source)) setCell(row, key, value);
      return row;
    }),
  };
}

/** N levels of `not` wrapping a field reference, for exercising the expression depth limit. */
function deeplyNestedExpression(depth: number): unknown {
  let nested: unknown = { field: "revenue" };
  for (let i = 0; i < depth; i += 1) nested = { operator: "not", arguments: [nested] };
  return nested;
}

/** Asserts `promise` rejects with a `ManifestValidationError` reporting a depth issue. */
async function expectDepthRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.unreachable("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestValidationError);
    const issues = (error as ManifestValidationError).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toMatch(/depth/i);
  }
}

describe("transforms()", () => {
  it("registers all six transform names", async () => {
    let names: readonly string[] = [];
    const qspec = createQSpec()
      .use(transforms())
      .use(
        definePlugin({
          name: "inspect-transforms",
          setup(api) {
            names = api.transforms.list();
          },
        }),
      );
    await qspec.ready();
    expect(names).toEqual(["derive", "filter", "limit", "rename", "select", "sort"]);
  });

  it("rejects installing the same plugin twice", async () => {
    // Reaches runtime.ts's plugin-name guard, keyed on the fixed name
    // "@qspecs/transforms" — the second setup() never runs, so this says
    // nothing about the transform registry's own duplicate protection.
    const qspec = createQSpec().use(transforms()).use(transforms());
    await expect(qspec.ready()).rejects.toThrow(PluginRegistrationError);
  });

  it("rejects a transform name already registered by another plugin", async () => {
    // Reaches registry.ts's duplicate guard instead: a different plugin name
    // ("conflicting") so runtime.ts's plugin-name check never fires, and
    // transforms()'s own setup() runs and collides on the transform name.
    const conflicting = definePlugin({
      name: "conflicting",
      setup: (api) => api.transforms.register("filter", { execute: (dataset) => dataset }),
    });
    const qspec = createQSpec().use(conflicting).use(transforms());
    try {
      await qspec.ready();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginRegistrationError);
      const message = (error as PluginRegistrationError).message;
      // Confirms the error genuinely originates from the registry's own
      // duplicate check (which names the transform), not from runtime.ts's
      // "already installed" plugin-name check (which never fires here).
      expect(message).toMatch(/transform named "filter"/i);
      expect(message).not.toMatch(/already installed/i);
    }
  });

  it("enforces api.limits.maxExpressionDepth end-to-end through prepare() for filter", async () => {
    // SPEC.md §72.5's maxExpressionDepth is configured on the runtime but only
    // the plugin that captures api.limits.maxExpressionDepth at setup can make
    // it bite. This is the end-to-end proof that it does for `filter`.
    const qspec = createQSpec({ limits: { maxExpressionDepth: 2 } }).use(transforms());
    const manifest = {
      apiVersion: QSPEC_V1,
      kind: "Dataset",
      metadata: { name: "depth-check-filter" },
      spec: {
        dataset: { fields: { revenue: { type: "number" } } },
        transforms: [{ type: "filter", where: deeplyNestedExpression(5) }],
      },
    };
    await expectDepthRejection(qspec.prepare(manifest));
  });

  it("enforces api.limits.maxExpressionDepth end-to-end through prepare() for derive", async () => {
    // The mirror of the filter proof above: createDeriveTransform(N) working in
    // isolation (Task 3, derive.test.ts) proves the factory enforces its own
    // depth argument, not that transforms() actually threads
    // api.limits.maxExpressionDepth into it. Only a prepare() through the
    // plugin proves that.
    const qspec = createQSpec({ limits: { maxExpressionDepth: 2 } }).use(transforms());
    const manifest = {
      apiVersion: QSPEC_V1,
      kind: "Dataset",
      metadata: { name: "depth-check-derive" },
      spec: {
        dataset: { fields: { revenue: { type: "number" } } },
        transforms: [
          {
            type: "derive",
            field: "flag",
            fieldType: "boolean",
            expression: deeplyNestedExpression(5),
          },
        ],
      },
    };
    await expectDepthRejection(qspec.prepare(manifest));
  });
});

describe("unknown dataset field diagnostics", () => {
  it("read identically whichever transform raises them", () => {
    // One `unknownFieldIssue` helper backs all five sites, and its
    // did-you-mean hint comes from core's `suggest` rather than a copy. Five
    // copies of the string was the drift class docs/known-gaps.md recorded;
    // this pins that they cannot silently re-diverge.
    const messages = [
      selectTransform.validate?.({ fields: ["reveneu"] }, fields),
      sortTransform.validate?.({ field: "reveneu" }, fields),
      renameTransform.validate?.({ fields: { reveneu: "amount" } }, fields),
      createFilterTransform(32).validate?.(
        { where: { field: "reveneu", operator: "gt", value: 0 } },
        fields,
      ),
      createDeriveTransform(32).validate?.(
        { field: "bonus", fieldType: "number", expression: { field: "reveneu" } },
        fields,
      ),
    ].map((issues) => (issues ?? []).map((entry) => [entry.message, entry.suggestion]));

    const expected = [
      ['Unknown dataset field "reveneu". Available fields: month, revenue.', "revenue"],
    ];
    for (const perTransform of messages) expect(perTransform).toEqual(expected);
  });
});

runTransformContractTests("filter", createFilterTransform(32), {
  dataset: fixtureDataset(),
  spec: { where: { field: "revenue", operator: "gt", value: 0 } },
});

runTransformContractTests("derive", createDeriveTransform(32), {
  dataset: fixtureDataset(),
  spec: { field: "bonus", fieldType: "number", expression: { literal: 1 } },
});

runTransformContractTests("sort", sortTransform, {
  dataset: fixtureDataset(),
  spec: { field: "revenue" },
});

runTransformContractTests("limit", limitTransform, {
  dataset: fixtureDataset(),
  spec: { count: 2 },
});

runTransformContractTests("select", selectTransform, {
  dataset: fixtureDataset(),
  spec: { fields: ["revenue"] },
});

runTransformContractTests("rename", renameTransform, {
  dataset: fixtureDataset(),
  spec: { fields: { revenue: "amount" } },
});
