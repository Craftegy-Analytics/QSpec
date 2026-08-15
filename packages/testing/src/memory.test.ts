import { describe, expect, it } from "vitest";
import { QSpecAbortError, createQSpec, type DataSourceContext } from "@qspecs/core";
import { memory } from "./memory.js";

const manifest = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "example" },
  spec: {
    parameters: { from: { type: "date", required: true } },
    query: {
      source: "analytics",
      language: "memory",
      statement: "analytics",
      bindings: { from: "$parameters.from" },
    },
  },
};

function build(delayMs?: number) {
  const plugin = memory({
    tables: {
      analytics: {
        columns: ["month", "revenue"],
        rows: [
          ["2026-01-01T00:00:00Z", 10],
          ["2026-02-01T00:00:00Z", 0],
        ],
        ...(delayMs === undefined ? {} : { delayMs }),
      },
    },
  });
  return { plugin, qspec: createQSpec().use(plugin) };
}

/** Minimal context for calling a `plugin.sources[...]` instance directly. */
function directContext(signal?: AbortSignal): DataSourceContext {
  return { executionId: "direct-call-test", logger: {}, signal };
}

describe("memory", () => {
  it("registers a data source per table and a pass-through query language", async () => {
    const { qspec } = build();
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.fields.map((f) => f.name)).toEqual(["month", "revenue"]);
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.rows[0]?.["revenue"]).toBe(10);
  });

  it("records each call with the compiled statement and resolved bindings", async () => {
    const { plugin, qspec } = build();
    await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(plugin.calls).toHaveLength(1);
    expect(plugin.calls[0]?.source).toBe("analytics");
    expect(plugin.calls[0]?.statement).toBe("analytics");
    expect(plugin.calls[0]?.bindings).toEqual({ from: "2026-01-01" });
  });

  it("accepts explicit column descriptors alongside bare names", async () => {
    const plugin = memory({
      tables: {
        analytics: {
          columns: [{ name: "month" }, { name: "revenue", nativeType: "numeric" }],
          rows: [["2026-01-01T00:00:00Z", 10]],
        },
      },
    });
    const result = await createQSpec()
      .use(plugin)
      .execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.fields[1]?.format).toMatchObject({ nativeType: "numeric" });
  });

  it("propagates cancellation from the caller's signal while the source is in flight", async () => {
    const { qspec } = build(300);
    const controller = new AbortController();
    const started = performance.now();
    const promise = qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    // Abort after the adapter is genuinely in flight, not before it starts —
    // aborting synchronously would be caught by the pre-execution guard and
    // would prove nothing about the source's own signal handling.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(promise).rejects.toThrow(QSpecAbortError);
    // Without the timing bound this test passes even with the source's abort
    // listener deleted: the delay simply runs to completion and the post-delay
    // guard throws. Rejecting well inside the 300ms delay is the only evidence
    // that the listener did the work. 300/100 (rather than the previous
    // 50/40) matches the sibling test below's 300ms fixture delay (though not
    // its tighter 50ms bound) and has never flaked: it excludes far more of
    // the "waited out the delay" space while leaving ~94ms of slack instead
    // of ~10ms.
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("honors an already-aborted signal on a delayed table without waiting out the delay", async () => {
    // Regression pin for a bug the data-source contract suite caught: adding
    // an "abort" listener never fires for a signal that was already aborted
    // before the listener was attached (the event fired in the past), so a
    // pre-aborted signal used to run the full delay before the post-delay
    // guard caught it. This pins the fix directly against the delayed table,
    // independent of the contract suite (which self-skips whenever a fixture
    // omits `slowQuery`).
    const { plugin } = build(300);
    const source = plugin.sources["analytics"];
    if (source === undefined) throw new Error("expected an analytics source to be registered");
    const compiled = { source: "analytics", statement: "analytics", bindings: {} };
    const controller = new AbortController();
    controller.abort();

    const started = performance.now();
    await expect(source.execute(compiled, directContext(controller.signal))).rejects.toThrow(
      QSpecAbortError,
    );
    // 50ms leaves generous margin below the 300ms delay: without the fix
    // this would take the full 300ms, so any bound comfortably under that
    // distinguishes "rejected up front" from "waited out the delay".
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("rejects a statement naming no configured table", async () => {
    const { qspec } = build();
    const bad = {
      ...manifest,
      spec: { ...manifest.spec, query: { ...manifest.spec.query, statement: "nope" } },
    };
    await expect(qspec.execute(bad, { parameters: { from: "2026-01-01" } })).rejects.toThrow(
      /nope/,
    );
  });

  it("reports a shape problem distinctly when the statement is not a string", async () => {
    const { qspec } = build();
    const bad = {
      ...manifest,
      spec: {
        ...manifest.spec,
        query: { ...manifest.spec.query, statement: { table: "analytics" } },
      },
    };
    await expect(qspec.execute(bad, { parameters: { from: "2026-01-01" } })).rejects.toThrow(
      /requires a string statement/,
    );
  });

  it("returns an independent row array on each call, so a transform cannot corrupt the fixture", async () => {
    const { plugin } = build();
    const source = plugin.sources["analytics"];
    if (source === undefined) throw new Error("expected an analytics source to be registered");
    const compiled = { source: "analytics", statement: "analytics", bindings: {} };

    const first = await source.execute(compiled, directContext());
    expect(first.rows).toHaveLength(2);
    const firstRow = first.rows[0];
    if (firstRow === undefined) throw new Error("expected a first row");

    // Mutate what the first call returned. If the source's copy were only at
    // the outer array level (or absent), this would corrupt the fixture and
    // the second call would see it.
    (firstRow as unknown[])[0] = "mutated";

    const second = await source.execute(compiled, directContext());
    expect(second.rows).toHaveLength(2);
    expect(second.rows[0]?.[0]).toBe("2026-01-01T00:00:00Z");
  });

  it("deep-clones composite cell values, so mutating a returned cell cannot corrupt the fixture", async () => {
    const plugin = memory({
      tables: {
        composite: {
          columns: ["id", "payload"],
          rows: [[1, { region: "west" }]],
        },
      },
    });
    const source = plugin.sources["composite"];
    if (source === undefined) throw new Error("expected a composite source to be registered");
    const compiled = { source: "composite", statement: "composite", bindings: {} };

    const first = await source.execute(compiled, directContext());
    const cell = first.rows[0]?.[1];
    if (typeof cell !== "object" || cell === null) throw new Error("expected an object cell");
    // A shallow `[...row]` copy would leave this object shared with the
    // fixture; mutating it here must not be visible from a later call.
    Object.assign(cell, { region: "mutated" });

    const second = await source.execute(compiled, directContext());
    expect(second.rows[0]?.[1]).toEqual({ region: "west" });
  });
});
