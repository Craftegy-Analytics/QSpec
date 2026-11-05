import { describe, expect, it } from "vitest";
import { isPlainObject, type ExecutionPolicy, type QSpecIssue } from "@qspecs/core";
import { memory, type MemoryPlugin } from "../memory.js";
import {
  assertDenialIsDeterministic,
  assertDeniedIsWellFormed,
  assertMetadataNotEchoed,
  assertSettlesWhenAborted,
  runExecutionPolicyContractTests,
  type ExecutionPolicyContractFixture,
} from "./execution-policy.js";

/** `memory()`'s statement names the table it returns; its policy view carries that statement. */
function manifest(table: string) {
  return {
    apiVersion: "qspec.dev/v1",
    kind: "Dataset",
    metadata: { name: `read-${table}` },
    spec: { query: { source: "warehouse", language: "memory", statement: table } },
  };
}

const TABLE_ISSUE: QSpecIssue = {
  code: "toy.table",
  message: "Only table t may be read.",
  path: ["spec", "query", "statement"],
};

/** The toy policy: a statement must name table `t`. Executions without a query are allowed. */
function viewStatement(view: unknown): unknown {
  return isPlainObject(view) ? view["statement"] : undefined;
}

const toyPolicy: ExecutionPolicy = {
  check({ query }) {
    if (query === undefined || viewStatement(query.view) === "t") return { outcome: "allow" };
    return { outcome: "deny", issues: [TABLE_ISSUE] };
  },
};

/** A fixture around `policy`, with fresh `memory()` plugins per test and a call counter. */
function fixtureFor(create: () => ExecutionPolicy): ExecutionPolicyContractFixture {
  let current: MemoryPlugin | undefined;
  return {
    create,
    plugins: () => {
      current = memory({
        tables: {
          warehouse: { columns: ["id"], rows: [[1]] },
          t: { columns: ["id"], rows: [[1]] },
          u: { columns: ["id"], rows: [[2]] },
        },
      });
      return [current];
    },
    sourceCalls: () => current?.calls.length ?? 0,
    allowed: { manifest: manifest("t"), metadata: { tenant: "t1" } },
    denied: { manifest: manifest("u"), metadata: { tenant: "t1" } },
  };
}

runExecutionPolicyContractTests("toy table policy", {
  ...fixtureFor(() => toyPolicy),
  metadataKeys: ["tenant"],
});

/**
 * Pins that the suite rejects known-wrong policies rather than merely passing a well-behaved one.
 * Each planted defect breaks exactly one invariant, and each test names the assertion that must
 * catch it, so a failure here points at the assertion that lost its teeth.
 */
describe("ExecutionPolicy contract assertions: regression against planted defects", () => {
  it("rejects a policy that always allows", async () => {
    const fixture = fixtureFor(() => ({ check: () => ({ outcome: "allow" }) }));
    await expect(assertDeniedIsWellFormed(fixture)).rejects.toThrow(
      /did not reject with ExecutionDeniedError/,
    );
  });

  it("rejects a policy whose denial issues have numeric codes", async () => {
    // Core turns a malformed decision into ExecutionPolicyError (fail closed), so the denied
    // case does not surface as a denial at all.
    const fixture = fixtureFor(() => ({
      check: ({ query }) =>
        viewStatement(query?.view) === "t"
          ? { outcome: "allow" }
          : {
              outcome: "deny",
              issues: [{ code: 7, message: "bad", path: [] } as unknown as QSpecIssue],
            },
    }));
    await expect(assertDeniedIsWellFormed(fixture)).rejects.toThrow(
      /did not reject with ExecutionDeniedError/,
    );
  });

  it("rejects a policy that echoes metadata into its message", async () => {
    const fixture = fixtureFor(() => ({
      check: ({ query, metadata }) =>
        viewStatement(query?.view) === "t"
          ? { outcome: "allow" }
          : {
              outcome: "deny",
              issues: [{ ...TABLE_ISSUE, message: `Denied for ${JSON.stringify(metadata)}.` }],
            },
    }));
    await expect(assertMetadataNotEchoed(fixture)).rejects.toThrow(/metadata value appeared/);
  });

  it("rejects a policy that echoes a metadata value it reads, when the fixture names the key", async () => {
    // The unread `contractSentinel` key alone cannot catch this: the policy only echoes the
    // key it actually reads. Naming it in `metadataKeys` puts a sentinel there.
    const fixture: ExecutionPolicyContractFixture = {
      ...fixtureFor(() => ({
        check: ({ query, metadata }) =>
          viewStatement(query?.view) === "t"
            ? { outcome: "allow" }
            : {
                outcome: "deny",
                issues: [
                  { ...TABLE_ISSUE, message: `Tenant ${String(metadata?.["tenant"])} may not.` },
                ],
              },
      })),
      metadataKeys: ["tenant"],
    };
    await expect(assertMetadataNotEchoed(fixture)).rejects.toThrow(/metadata value appeared/);
  });

  it("rejects a policy whose codes depend on a counter", async () => {
    const fixture = fixtureFor(() => {
      let calls = 0;
      return {
        check: ({ query }) => {
          if (viewStatement(query?.view) === "t") return { outcome: "allow" };
          calls += 1;
          return { outcome: "deny", issues: [{ ...TABLE_ISSUE, code: `toy.table.${calls}` }] };
        },
      };
    });
    await expect(assertDenialIsDeterministic(fixture)).rejects.toThrow(/different issue codes/);
  });

  it("rejects a policy that ignores an aborted signal and keeps waiting", async () => {
    const fixture: ExecutionPolicyContractFixture = {
      ...fixtureFor(() => ({
        check: async ({ signal }) => {
          // Waits regardless of the signal on any call after the first.
          if (signal?.aborted === true) await new Promise((resolve) => setTimeout(resolve, 400));
          return { outcome: "allow" };
        },
      })),
      abortBoundMs: 100,
    };
    await expect(assertSettlesWhenAborted(fixture)).rejects.toThrow(/did not settle within 100ms/);
  });
});
