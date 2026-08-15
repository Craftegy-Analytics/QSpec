import { describe, expect, it } from "vitest";
import { createQSpec, QSpecError, type QSpecManifest, type QSpecResourceSpec } from "@qspecs/core";
import { memory } from "@qspecs/testing";
import { createQSpecHandler, type QSpecErrorBody, type QSpecExecuteResponse } from "@qspecs/http";
import { createLocalExecutor, type LocalExecutorManifests } from "@qspecs/react";

/**
 * `@qspecs/react`'s `createLocalExecutor` and `@qspecs/http`'s
 * `createQSpecHandler` are independent, textually duplicated implementations
 * of the same rule: resolve a caller-supplied resource NAME against a fixed
 * registry with `Object.hasOwn`, and reject an unknown one generically — no
 * enumeration of what else is registered. `@qspecs/react` cannot depend on
 * `@qspecs/http` (binding constraint: it depends on `@qspecs/core` and `react`
 * only), so that duplication can't be collapsed into one shared function —
 * but nothing stops the two error messages from drifting apart silently,
 * since neither package's own test suite can see the other's assertions.
 * This is the one place both are visible at once (a root-level test, not
 * scoped to either package), and the one test that would actually catch
 * that drift: both must reject the same unregistered name with the exact
 * same code and the exact same message.
 *
 * Falsified by editing either message string (in
 * packages/react/src/internal/local-executor.ts or
 * packages/http/src/internal/handler.ts) and confirming this test fails —
 * see the fix report for the exact output.
 */

const ORDERS_MANIFEST: QSpecManifest<QSpecResourceSpec> = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders" },
  spec: {
    query: { source: "analytics", language: "memory", statement: "analytics" },
  },
};

function buildRuntime() {
  const plugin = memory({
    tables: { analytics: { columns: ["month", "revenue"], rows: [["2026-01-01", 10]] } },
  });
  return createQSpec().use(plugin);
}

/** Narrows a `QSpecExecuteResponse` to its error half, or fails the test. */
function expectError(body: QSpecExecuteResponse): QSpecErrorBody {
  if (body.ok) throw new Error("expected an error response, got ok:true");
  return body.error;
}

describe("createLocalExecutor / createQSpecHandler parity", () => {
  it("reject an unknown resource name with the same code and the same message", async () => {
    const manifests: LocalExecutorManifests = { orders: ORDERS_MANIFEST };

    const localExecutor = createLocalExecutor(buildRuntime(), manifests);
    let localError: unknown;
    try {
      await localExecutor.execute("does-not-exist");
    } catch (error) {
      localError = error;
    }
    if (!(localError instanceof QSpecError)) {
      throw new Error("expected createLocalExecutor to reject with a QSpecError");
    }

    const handler = createQSpecHandler({ runtime: buildRuntime(), manifests });
    const response = await handler(
      new Request("http://parity.test/execute", {
        method: "POST",
        body: JSON.stringify({ resource: "does-not-exist" }),
      }),
    );
    const httpError = expectError((await response.json()) as QSpecExecuteResponse);

    expect(localError.code).toBe(httpError.code);
    expect(localError.message).toBe(httpError.message);
  });
});
