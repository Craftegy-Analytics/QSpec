import { describe, expect, it } from "vitest";
import { PresentationError, QSPEC_V1, createQSpec } from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { transforms } from "@qspecs/transforms";
import { charts, resolveSeries, type CartesianPresentation } from "@qspecs/charts";

/**
 * Proves the three plugins added by this plan — @qspecs/transforms,
 * @qspecs/charts, and the in-memory test source from @qspecs/testing — compose
 * into a single working pipeline. Every earlier task tested one piece in
 * isolation; this is the only place all of them run together end to end.
 */

const ORDERS_TABLE = {
  columns: ["month", "revenue"],
  rows: [
    ["2026-01", 100],
    ["2026-01", 0], // filtered out below: revenue is not > 0
    ["2026-02", 50],
    ["2026-02", 30],
    ["2026-03", 20],
    ["2026-03", 200],
  ],
};

/** Two required parameters, a memory query with bindings, and a declared dataset schema. */
function pipelineManifest() {
  return {
    apiVersion: QSPEC_V1,
    kind: "Chart",
    metadata: { name: "pipeline-e2e" },
    spec: {
      parameters: {
        from: { type: "date", required: true },
        to: { type: "date", required: true },
      },
      query: {
        source: "orders",
        language: "memory",
        statement: "orders",
        bindings: { from: "$parameters.from", to: "$parameters.to" },
      },
      dataset: {
        fields: {
          month: { type: "string", nullable: false },
          revenue: { type: "number", nullable: false },
        },
      },
      transforms: [
        { type: "filter", where: { field: "revenue", operator: "gt", value: 0 } },
        {
          type: "derive",
          field: "bonus",
          fieldType: "number",
          expression: { operator: "multiply", arguments: [{ field: "revenue" }, { literal: 0.1 }] },
        },
        { type: "sort", field: "bonus", direction: "desc" },
        { type: "limit", count: 3 },
      ],
      presentation: {
        type: "line",
        x: { field: "month" },
        series: [{ field: "bonus", label: "Bonus" }],
      },
    },
  };
}

describe("end-to-end pipeline (memory source + transforms + charts)", () => {
  it("runs filter -> derive -> sort -> limit and produces the expected dataset, presentation, series, and row count", async () => {
    const qspec = createQSpec()
      .use(memory({ tables: { orders: ORDERS_TABLE } }))
      .use(transforms())
      .use(charts());

    const manifest = pipelineManifest();
    const prepared = await qspec.prepare(manifest);

    expect(prepared.kind).toBe("Chart");
    // Static projection through filter (identity) -> derive (adds "bonus") ->
    // sort/limit (identity): the schema the pipeline will produce, computed
    // with zero rows of real data.
    expect(prepared.projectedFields).toEqual(["month", "revenue", "bonus"]);

    const result = await prepared.execute({
      parameters: { from: "2026-01-01", to: "2026-12-31" },
    });

    // Rows in the order sort -> limit produced them, with the derived field
    // present and the zero-revenue row (row 2 of the fixture) gone.
    expect(result.data.rows.map((row) => ({ ...row }))).toEqual([
      { month: "2026-03", revenue: 200, bonus: 20 },
      { month: "2026-01", revenue: 100, bonus: 10 },
      { month: "2026-02", revenue: 50, bonus: 5 },
    ]);

    // The presentation model is exactly the manifest's presentation object,
    // untouched -- QSpec describes presentation, it does not render it.
    expect(result.presentation).toEqual(manifest.spec.presentation);

    // meta.rowCount reflects the post-transform row count (3), not the six
    // raw rows the memory source actually returned.
    expect(result.meta.rowCount).toBe(3);

    const presentation = result.presentation;
    if (presentation === undefined) throw new Error("expected a presentation in the result");
    const series = resolveSeries(result.data, presentation as CartesianPresentation);
    expect(series).toEqual([
      {
        key: "bonus",
        label: "Bonus",
        field: "bonus",
        points: [
          { x: "2026-03", y: 20, index: 0 },
          { x: "2026-01", y: 10, index: 1 },
          { x: "2026-02", y: 5, index: 2 },
        ],
      },
    ]);
  });

  it("fails at prepare() -- before the memory source is ever called -- when a presentation field is misspelled", async () => {
    // A dedicated plugin instance, used for nothing else in this test, so
    // `calls` starting and staying empty is unambiguous: nothing else in this
    // test could have populated it.
    const plugin = memory({ tables: { orders: ORDERS_TABLE } });
    const qspec = createQSpec().use(plugin).use(transforms()).use(charts());

    const manifest = pipelineManifest();
    const seriesEntry = manifest.spec.presentation.series[0];
    if (seriesEntry === undefined) throw new Error("expected a series entry");
    // "boonus" is not a field the pipeline will ever produce -- the correct
    // name, established by the projection above, is "bonus".
    seriesEntry.field = "boonus";

    // This is SPEC.md §81's static-validation guarantee: an unrenderable
    // manifest fails before a single row is fetched. If presentation
    // validation regressed to run only after (or during) execution, this
    // would reject with a different error, or not reject at all before a
    // call was recorded.
    await expect(qspec.prepare(manifest)).rejects.toThrow(PresentationError);

    // The clearest possible proof that prepare() never touched the data
    // source: not "the query returned nothing", but "the query was never
    // issued". Falsifiable independently of the rejection above -- see the
    // sibling test proving this same plugin type does record a call when
    // execute() actually runs.
    expect(plugin.calls).toEqual([]);
  });

  it("sanity check: the same memory plugin type does record a call when execute() actually runs", async () => {
    // Exists so the previous test's `expect(plugin.calls).toEqual([])` means
    // something: without this, an empty `calls` array would be equally
    // consistent with a plugin that never records calls at all.
    const plugin = memory({ tables: { orders: ORDERS_TABLE } });
    const qspec = createQSpec().use(plugin).use(transforms()).use(charts());
    await qspec.execute(pipelineManifest(), {
      parameters: { from: "2026-01-01", to: "2026-12-31" },
    });
    expect(plugin.calls).toHaveLength(1);
    expect(plugin.calls[0]?.statement).toBe("orders");
  });
});

describe("a rename in the transform chain projects through to presentation validation", () => {
  const SALES_TABLE = {
    columns: ["month", "revenue"],
    rows: [
      ["2026-01", 10],
      ["2026-02", 20],
    ],
  };

  function renameBaseManifest() {
    return {
      apiVersion: QSPEC_V1,
      kind: "Chart",
      metadata: { name: "rename-projection" },
      spec: {
        query: { source: "sales", language: "memory", statement: "sales" },
        dataset: {
          fields: {
            month: { type: "string" },
            revenue: { type: "number" },
          },
        },
        transforms: [{ type: "rename", fields: { revenue: "amount" } }],
      },
    };
  }

  function withPresentation(seriesField: string) {
    const manifest = renameBaseManifest();
    return {
      ...manifest,
      spec: {
        ...manifest.spec,
        presentation: {
          type: "line",
          x: { field: "month" },
          series: [{ field: seriesField }],
        },
      },
    };
  }

  it("succeeds when charting the renamed field", async () => {
    const qspec = createQSpec()
      .use(memory({ tables: { sales: SALES_TABLE } }))
      .use(transforms())
      .use(charts());

    const prepared = await qspec.prepare(withPresentation("amount"));
    // "amount" only exists because rename's describe() projected it -- the
    // raw dataset never had a field by that name.
    expect(prepared.projectedFields).toEqual(["month", "amount"]);
  });

  it("fails when charting the pre-rename field, because it no longer exists after the rename", async () => {
    const qspec = createQSpec()
      .use(memory({ tables: { sales: SALES_TABLE } }))
      .use(transforms())
      .use(charts());

    // "revenue" was renamed away by the transform chain; charting it is
    // exactly the SPEC.md §81 case this whole pipeline exists to catch.
    await expect(qspec.prepare(withPresentation("revenue"))).rejects.toThrow(PresentationError);
  });
});
