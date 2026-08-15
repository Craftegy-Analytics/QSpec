import { describe, expect, it } from "vitest";
import { createQSpec, QSpecError, type QSpecManifest, type QSpecResourceSpec } from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { createLocalExecutor, type LocalExecutorManifests } from "./local-executor.js";

/** A minimal `Dataset`-kind manifest querying the memory source's `analytics` table. */
const ORDERS_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders" },
  spec: {
    query: { source: "analytics", language: "memory", statement: "analytics" },
  },
};

/** A second, distinct resource, only used to prove an unknown-name error doesn't leak it. */
const CUSTOMERS_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "customers" },
  spec: {
    query: { source: "customers", language: "memory", statement: "customers" },
  },
};

/** Same shape as ORDERS_MANIFEST, plus one required, bound parameter — for proving `context` reaches the runtime. */
const PARAMETERIZED_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders-by-id" },
  spec: {
    parameters: { id: { type: "number", required: true } },
    query: {
      source: "analytics",
      language: "memory",
      statement: "analytics",
      bindings: { id: "$parameters.id" },
    },
  },
};

function buildRuntime() {
  const plugin = memory({
    tables: {
      analytics: { columns: ["month", "revenue"], rows: [["2026-01-01", 10]] },
      customers: { columns: ["id", "name"], rows: [["1", "Ada"]] },
    },
  });
  return { plugin, runtime: createQSpec().use(plugin) };
}

describe("createLocalExecutor", () => {
  it("executes the manifest registered under the requested resource name", async () => {
    const { runtime } = buildRuntime();
    const executor = createLocalExecutor(runtime, { orders: ORDERS_MANIFEST });

    const result = await executor.execute("orders");

    expect(result.data.fields.map((f) => f.name)).toEqual(["month", "revenue"]);
  });

  it("passes the execution context through to the runtime", async () => {
    const { runtime, plugin } = buildRuntime();
    const executor = createLocalExecutor(runtime, { "orders-by-id": PARAMETERIZED_MANIFEST });

    await executor.execute("orders-by-id", { parameters: { id: 1 } });

    // `MemoryCall` records the compiled statement and resolved bindings —
    // not `context.metadata`, which the memory plugin never observes at
    // all. Asserting on `bindings` (the pattern packages/testing's own
    // memory.test.ts:56 uses) is what actually proves `context` reached
    // the runtime; a call-count-only assertion here would stay green even
    // if `createLocalExecutor` silently dropped `context` and called
    // `runtime.execute(manifest)` with no second argument.
    expect(plugin.calls).toHaveLength(1);
    expect(plugin.calls[0]?.bindings).toEqual({ id: 1 });
  });

  /**
   * The one test this task's brief asks for over two separate ones: a
   * genuinely-unregistered resource name and a name that resolves to
   * nothing but an *inherited* `Object.prototype` property (never an own
   * property of `manifests`) must be rejected identically — same error
   * class, same code, same generic message that names neither the
   * requested name nor any registered one. If `resolveManifest` used a bare
   * `manifests[resource]` instead of `Object.hasOwn`, the `"toString"` case
   * would resolve to `Object.prototype.toString` (a function, not
   * `undefined`) and diverge from the genuinely-unknown case — this test
   * would then fail on the second assertion group below, not the first.
   */
  it("rejects a genuinely unknown resource and an inherited-only name identically", async () => {
    const { runtime } = buildRuntime();
    const manifests: LocalExecutorManifests = {
      orders: ORDERS_MANIFEST,
      customers: CUSTOMERS_MANIFEST,
    };
    const executor = createLocalExecutor(runtime, manifests);

    const unknownName = executor.execute("does-not-exist");
    await expect(unknownName).rejects.toBeInstanceOf(QSpecError);
    await expect(unknownName).rejects.toMatchObject({ code: "QSPEC_RESOURCE_NOT_FOUND" });

    const inheritedName = executor.execute("toString");
    await expect(inheritedName).rejects.toBeInstanceOf(QSpecError);
    await expect(inheritedName).rejects.toMatchObject({ code: "QSPEC_RESOURCE_NOT_FOUND" });

    const [unknownError, inheritedError] = await Promise.all([
      unknownName.catch((error: unknown) => error),
      inheritedName.catch((error: unknown) => error),
    ]);
    const unknownMessage = unknownError instanceof Error ? unknownError.message : "";
    const inheritedMessage = inheritedError instanceof Error ? inheritedError.message : "";
    expect(unknownMessage).toBe(inheritedMessage);

    // Neither message discloses a registered name — the same non-disclosure
    // property handler.test.ts asserts for the HTTP path.
    expect(unknownMessage).not.toContain("orders");
    expect(unknownMessage).not.toContain("customers");
    expect(unknownMessage).not.toContain("does-not-exist");
    expect(unknownMessage).not.toContain("toString");
  });
});
