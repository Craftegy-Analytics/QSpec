import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  createQSpec,
  type QSpecManifest,
  type QSpecResourceSpec,
} from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { createHttpExecutor, createQSpecHandler } from "./index.js";

/**
 * A thin smoke test of `index.ts`'s public export surface: the handler and
 * the executor, wired together through nothing but what a real consumer of
 * this package could import, exercising one success and one error path. The
 * exhaustive matrix of both halves lives in `internal/handler.test.ts` and
 * `internal/executor.test.ts`; this file exists only to catch a broken or
 * missing re-export.
 */
const ORDERS_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders" },
  spec: {
    query: { source: "analytics", language: "memory", statement: "analytics" },
  },
};

// Present but invalid `spec.query` (empty source/language), not an absent
// one — core's built-in `Dataset` kind does not require a query at all (see
// executor.test.ts's BROKEN_MANIFEST comment for why), so `spec: {}` alone
// would not fail.
const BROKEN_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "broken" },
  spec: { query: { source: "", language: "", statement: "" } },
};

function buildRuntime() {
  const plugin = memory({
    tables: { analytics: { columns: ["month", "revenue"], rows: [["2026-01-01", 10]] } },
  });
  return createQSpec().use(plugin);
}

describe("@qspecs/http public exports", () => {
  it("runs a resource end to end through createQSpecHandler and createHttpExecutor", async () => {
    const runtime = buildRuntime();
    const handler = createQSpecHandler({
      runtime,
      manifests: { orders: ORDERS_MANIFEST, broken: BROKEN_MANIFEST },
    });
    const executor = createHttpExecutor({
      url: "http://index.test/execute",
      fetch: async (input, init) => handler(new Request(input, init)),
    });

    const result = await executor.execute("orders");
    expect(result.data.rows).toEqual([{ month: "2026-01-01", revenue: 10 }]);

    const error = await executor.execute("broken").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof ManifestValidationError)) {
      throw new Error(`expected a ManifestValidationError, got ${String(error)}`);
    }
    // Not just the class: `reconstructError` dispatches on `error.code`
    // before checking `status >= 500`, so a hypothetical regression that
    // dropped handler.ts's ManifestValidationError-specific 400 branch would
    // fall through to the generic 500 mapping — reconstructed as
    // `QueryExecutionError`, not `ManifestValidationError` — and this test
    // would already have failed the `instanceof` check above. But if that
    // regression instead mapped it to a 500 carrying the SAME code
    // (`QSPEC_MANIFEST_INVALID`), `reconstructError`'s manifest branch would
    // still fire and reconstruct the same class with empty `issues` —
    // `toBeInstanceOf` alone stays green. Asserting `issues` is non-empty
    // catches that narrower regression too.
    expect(error.issues.length).toBeGreaterThan(0);
  });
});
