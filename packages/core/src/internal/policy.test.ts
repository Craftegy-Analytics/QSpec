import { describe, expect, it, vi } from "vitest";
import {
  ExecutionDeniedError,
  ExecutionPolicyError,
  ParameterValidationError,
  PluginRegistrationError,
  QSpecAbortError,
  QSpecError,
  QueryCompilationError,
  type QSpecIssue,
} from "../errors.js";
import { definePlugin } from "../define.js";
import type { Dataset, RawQueryResult } from "../types/dataset.js";
import type { QSpecEventMap } from "../types/events.js";
import type { DataSourceContext, QueryLanguage } from "../types/plugin.js";
import type { ExecutionPolicy, ExecutionPolicyInput } from "../types/policy.js";
import type { ExecutionContext, QSpec } from "../types/runtime.js";
import { createQSpec } from "./runtime.js";

/** What the local test language compiles to. Its policy view drops `bindings` (the values). */
interface Compiled {
  readonly statement: unknown;
  readonly bindings: Record<string, unknown>;
}

const rows: RawQueryResult = {
  columns: [{ name: "id" }, { name: "label" }],
  rows: [
    [1, "one"],
    [2, "two"],
  ],
};

const manifest = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "orders" },
  spec: {
    parameters: {
      from: { type: "string", required: true },
      to: { type: "string" },
    },
    query: {
      source: "analytics",
      language: "test",
      statement: "SELECT_STATEMENT",
      bindings: {
        from: "$parameters.from",
        to: { parameter: "to" },
        region: { literal: "SENTINEL_LITERAL" },
      },
    },
  },
};

/** A resource with no `spec.query`, so no data source is reached. */
const queryless = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "static" },
  spec: {
    parameters: { from: { type: "string", required: true } },
    transforms: [{ type: "spy" }],
  },
};

const parameters = { from: "SENTINEL_A", to: "SENTINEL_B" };

interface HarnessOptions {
  readonly policies?: readonly (readonly [string, ExecutionPolicy])[];
  /** `null` registers a language with no `policyView`. */
  readonly view?: ((compiled: Compiled) => unknown) | null;
  readonly compile?: (statement: unknown, bindings: Record<string, unknown>) => Compiled;
}

function harness(options: HarnessOptions = {}) {
  const sourceContexts: DataSourceContext[] = [];
  const sourceQueries: unknown[] = [];
  const policyView = vi.fn(
    options.view === undefined || options.view === null
      ? (compiled: Compiled): unknown => ({ statement: compiled.statement })
      : options.view,
  );
  const compileImpl =
    options.compile ??
    ((statement: unknown, bindings: Record<string, unknown>): Compiled => ({
      statement,
      bindings,
    }));
  const language: QueryLanguage<unknown, Compiled> = {
    compile: (query, context) => compileImpl(query.statement, context.bindings),
    ...(options.view === null ? {} : { policyView }),
  };
  const transform = vi.fn((dataset: Dataset): Dataset => dataset);

  const qspec = createQSpec().use(
    definePlugin({
      name: "policy-harness",
      setup(api) {
        api.queryLanguages.register("test", language as QueryLanguage);
        api.sources.register("analytics", {
          execute: async (query, context) => {
            sourceQueries.push(query);
            sourceContexts.push(context);
            return rows;
          },
        });
        api.transforms.register("spy", { execute: transform, describe: (fields) => fields });
        for (const [name, policy] of options.policies ?? []) api.policies.register(name, policy);
      },
    }),
  );

  const decisions: QSpecEventMap["policy:decision"][] = [];
  const failures: QSpecEventMap["execution:error"][] = [];
  const compileStarts: QSpecEventMap["query:compile:start"][] = [];
  qspec.on("policy:decision", (payload) => void decisions.push(payload));
  qspec.on("execution:error", (payload) => void failures.push(payload));
  qspec.on("query:compile:start", (payload) => void compileStarts.push(payload));

  return {
    qspec,
    policyView,
    transform,
    decisions,
    failures,
    compileStarts,
    sourceContexts,
    sourceQueries,
    sourceCalls: () => sourceContexts.length,
  };
}

/** A policy that records every input it was handed and answers with `decide`. */
function recordingPolicy(
  decide: (input: ExecutionPolicyInput) => ReturnType<ExecutionPolicy["check"]> = () => ({
    outcome: "allow",
  }),
) {
  const inputs: ExecutionPolicyInput[] = [];
  const policy: ExecutionPolicy = {
    check(input) {
      inputs.push(input);
      return decide(input);
    },
  };
  return { policy, inputs };
}

async function failure(
  qspec: QSpec,
  target: unknown = manifest,
  context: ExecutionContext = { parameters },
): Promise<unknown> {
  return qspec.execute(target, context).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

const twoIssues: readonly QSpecIssue[] = [
  {
    code: "shape.select-only",
    message: "Relation SECRET_TABLE is not readable.",
    path: ["spec", "query", "statement"],
  },
  {
    code: "params.required",
    message: "Parameter to must be required.",
    path: ["spec", "parameters", "to"],
    suggestion: "required: true",
  },
];

describe("execution policies: allow and deny", () => {
  it("allows: the source runs once and the result matches a runtime with no policy", async () => {
    const plain = harness();
    const guarded = harness({ policies: [["allow-all", recordingPolicy().policy]] });
    const expected = await plain.qspec.execute(manifest, { parameters });
    const actual = await guarded.qspec.execute(manifest, { parameters });
    expect(guarded.sourceCalls()).toBe(1);
    expect(actual.data).toEqual(expected.data);
    expect(actual.meta.rowCount).toBe(expected.meta.rowCount);
    expect(actual.meta.query?.source).toBe(expected.meta.query?.source);
    expect(actual.meta.query?.language).toBe(expected.meta.query?.language);
    // The source receives the very compiled object the language produced.
    expect(guarded.sourceQueries[0]).toEqual({
      statement: "SELECT_STATEMENT",
      bindings: { from: "SENTINEL_A", to: "SENTINEL_B", region: "SENTINEL_LITERAL" },
    });
  });

  it("denies: ExecutionDeniedError with the registered name and the issues verbatim, and no source call", async () => {
    const { policy } = recordingPolicy(() => ({ outcome: "deny", issues: twoIssues }));
    const run = harness({ policies: [["sql-guard", policy]] });
    const error = await failure(run.qspec);
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    const denied = error as ExecutionDeniedError;
    expect(denied.policy).toBe("sql-guard");
    expect(denied.code).toBe("QSPEC_EXECUTION_DENIED");
    // Absolute manifest paths: not rebased the way validate-hook issues are.
    expect(denied.issues).toEqual(twoIssues);
    expect(denied.message).toBe('Execution policy "sql-guard" denied the execution (2 problems).');
    expect(denied.message).not.toContain("SECRET_TABLE");
    expect(run.sourceCalls()).toBe(0);
  });

  it("copies the denial's issues, so a policy that later mutates its array cannot rewrite the error", async () => {
    const issues: QSpecIssue[] = [{ code: "a", message: "m", path: ["spec"] }];
    const run = harness({
      policies: [["guard", { check: () => ({ outcome: "deny", issues }) }]],
    });
    const error = (await failure(run.qspec)) as ExecutionDeniedError;
    issues.push({ code: "b", message: "late", path: [] });
    expect(error.issues).toEqual([{ code: "a", message: "m", path: ["spec"] }]);
  });

  it("does not run policies during prepare()", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    await run.qspec.prepare(manifest);
    expect(inputs).toHaveLength(0);
    expect(run.policyView).not.toHaveBeenCalled();
    expect(run.decisions).toHaveLength(0);
  });

  it("runs policies on every execution of one prepared resource", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    const prepared = await run.qspec.prepare(manifest);
    await prepared.execute({ parameters });
    await prepared.execute({ parameters });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.executionId).not.toBe(inputs[1]?.executionId);
  });
});

describe("execution policies: what a policy sees", () => {
  it("sees the resource, the execution id, and the frozen prepared manifest", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    const prepared = await run.qspec.prepare(manifest);
    await prepared.execute({ parameters });
    const input = inputs[0];
    expect(input?.resource).toEqual({ kind: "Dataset", name: "orders" });
    expect(input?.executionId).toBe(run.compileStarts[0]?.executionId);
    expect(input?.manifest).toBe(prepared.manifest);
    expect(Object.isFrozen(input?.manifest)).toBe(true);
    expect(Object.isFrozen(input)).toBe(true);
  });

  it("sees the language, the source, and every binding resolved to what it reads", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    await run.qspec.execute(manifest, { parameters });
    const query = inputs[0]?.query;
    expect(query?.language).toBe("test");
    expect(query?.source).toBe("analytics");
    expect({ ...query?.bindings }).toEqual({
      from: { kind: "parameter", parameter: "from" },
      to: { kind: "parameter", parameter: "to" },
      region: { kind: "literal" },
    });
    expect(Object.isFrozen(query?.bindings)).toBe(true);
  });

  it("sees the language's policy view, deep-frozen", async () => {
    const view = { statement: "SELECT_STATEMENT", parts: [["a"], ["b"]] };
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]], view: () => view });
    await run.qspec.execute(manifest, { parameters });
    expect(inputs[0]?.query?.view).toBe(view);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.parts)).toBe(true);
    expect(Object.isFrozen(view.parts[0])).toBe(true);
    expect(run.policyView).toHaveBeenCalledOnce();
  });

  it("sees view undefined when the language defines no policyView", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]], view: null });
    await run.qspec.execute(manifest, { parameters });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.query?.view).toBeUndefined();
  });

  it("never sees a bound value: not a parameter value and not a literal's value", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    await run.qspec.execute(manifest, { parameters, metadata: { tenant: "t1" } });
    const input = inputs[0];
    expect(input).toBeDefined();
    // Every field except `manifest`, where the literal legitimately sits as declared.
    const seen = JSON.stringify({
      executionId: input?.executionId,
      resource: input?.resource,
      query: input?.query,
      metadata: input?.metadata,
    });
    expect(seen).toContain("SELECT_STATEMENT");
    for (const sentinel of ["SENTINEL_A", "SENTINEL_B", "SENTINEL_LITERAL"]) {
      expect(seen).not.toContain(sentinel);
    }
  });

  it("sees the same frozen metadata object the source later receives", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    const tx = { live: true };
    await run.qspec.execute(manifest, { parameters, metadata: { tx } });
    const seen = inputs[0]?.metadata;
    expect(seen).toBe(run.sourceContexts[0]?.metadata);
    expect(seen?.["tx"]).toBe(tx);
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it("sees metadata undefined when the caller passed none", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    await run.qspec.execute(manifest, { parameters });
    expect(inputs[0]?.metadata).toBeUndefined();
  });

  it("sees the caller's own signal", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    const controller = new AbortController();
    await run.qspec.execute(manifest, { parameters, signal: controller.signal });
    expect(inputs[0]?.signal).toBe(controller.signal);
  });
});

describe("execution policies: fail closed", () => {
  /** Runs one policy and returns the error, the source call count, and the decision events. */
  async function failClosed(check: ExecutionPolicy["check"], context?: ExecutionContext) {
    const run = harness({ policies: [["guard", { check }]] });
    const error = await failure(run.qspec, manifest, context);
    return { error, run };
  }

  it("a denial with no issues reports one core issue", async () => {
    const { error, run } = await failClosed(() => ({ outcome: "deny", issues: [] }));
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    const issues = (error as ExecutionDeniedError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("QSPEC_EXECUTION_DENIED");
    expect(issues[0]?.path).toEqual([]);
    expect(run.sourceCalls()).toBe(0);
    expect(run.decisions.map((event) => event.outcome)).toEqual(["deny"]);
  });

  it("a thrown ExecutionDeniedError is rebuilt under the registered name", async () => {
    const { error, run } = await failClosed(() => {
      throw new ExecutionDeniedError({ policy: "someone-else", issues: twoIssues });
    });
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    expect((error as ExecutionDeniedError).policy).toBe("guard");
    expect((error as ExecutionDeniedError).issues).toEqual(twoIssues);
    expect(run.sourceCalls()).toBe(0);
    expect(run.decisions.map((event) => event.outcome)).toEqual(["deny"]);
  });

  it("a thrown QSpecError of another class becomes ExecutionPolicyError, not a validation error", async () => {
    const thrown = new ParameterValidationError("nope", {
      issues: [{ code: "QSPEC_PARAMETER_INVALID", message: "x", path: [] }],
    });
    const { error, run } = await failClosed(() => {
      throw thrown;
    });
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect(error).not.toBeInstanceOf(ParameterValidationError);
    expect((error as ExecutionPolicyError).cause).toBe(thrown);
    expect((error as ExecutionPolicyError).policy).toBe("guard");
    expect(run.sourceCalls()).toBe(0);
    expect(run.decisions.map((event) => event.outcome)).toEqual(["error"]);
  });

  it("a thrown plain Error becomes ExecutionPolicyError whose message names the policy, not the throw", async () => {
    const { error, run } = await failClosed(() => {
      throw new Error("THROWN_MESSAGE_WITH_ANYTHING_IN_IT");
    });
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect((error as ExecutionPolicyError).message).toContain('"guard"');
    expect((error as ExecutionPolicyError).message).not.toContain("THROWN_MESSAGE");
    expect(run.sourceCalls()).toBe(0);
    expect(run.decisions.map((event) => event.outcome)).toEqual(["error"]);
  });

  it("a rejected promise is handled like a throw", async () => {
    const { error, run } = await failClosed(() => Promise.reject(new Error("async failure")));
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect(run.sourceCalls()).toBe(0);
  });

  it.each<{ readonly label: string; readonly decision: unknown }>([
    { label: "undefined", decision: undefined },
    { label: "null", decision: null },
    { label: "an unknown outcome", decision: { outcome: "maybe" } },
    {
      label: "a deny with a malformed issue",
      decision: { outcome: "deny", issues: [{ code: 1 }] },
    },
    { label: "a deny without issues", decision: { outcome: "deny" } },
    {
      label: "a deny whose issue path is not an array",
      decision: { outcome: "deny", issues: [{ code: "a", message: "m", path: "spec" }] },
    },
    { label: "a string", decision: "allow" },
  ])("returning $label fails closed as ExecutionPolicyError", async ({ decision }) => {
    const { error, run } = await failClosed(() => decision as ReturnType<ExecutionPolicy["check"]>);
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect(run.sourceCalls()).toBe(0);
    expect(run.decisions.map((event) => event.outcome)).toEqual(["error"]);
  });

  it("a thrown ExecutionDeniedError with malformed issues fails closed as ExecutionPolicyError", async () => {
    const { error, run } = await failClosed(() => {
      throw new ExecutionDeniedError({
        policy: "guard",
        issues: [{ code: 1 } as unknown as QSpecIssue],
      });
    });
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect(run.sourceCalls()).toBe(0);
  });

  it("a policy that throws after the caller aborted surfaces as QSpecAbortError", async () => {
    const controller = new AbortController();
    const { error, run } = await failClosed(
      () => {
        controller.abort();
        throw new Error("gave up");
      },
      { parameters, signal: controller.signal },
    );
    expect(error).toBeInstanceOf(QSpecAbortError);
    expect(run.sourceCalls()).toBe(0);
    expect(run.decisions.map((event) => event.outcome)).toEqual(["error"]);
    expect(run.decisions[0]?.codes).toEqual(["QSPEC_EXECUTION_ABORTED"]);
  });

  it.each<{ readonly label: string; readonly thrown: () => unknown }>([
    { label: "an AbortError", thrown: () => new DOMException("Aborted", "AbortError") },
    {
      label: "a TimeoutError",
      thrown: () => new DOMException("backend timed out", "TimeoutError"),
    },
    { label: "a QSpecAbortError", thrown: () => new QSpecAbortError("the policy's own abort") },
  ])(
    "$label thrown while the caller's signal is live is the policy's own failure, not an abort",
    async ({ thrown }) => {
      const controller = new AbortController();
      const { error, run } = await failClosed(
        () => {
          throw thrown();
        },
        { parameters, signal: controller.signal },
      );
      expect(error).toBeInstanceOf(ExecutionPolicyError);
      expect(error).not.toBeInstanceOf(QSpecAbortError);
      expect((error as ExecutionPolicyError).code).toBe("QSPEC_POLICY_FAILED");
      expect(run.decisions[0]?.codes).toEqual(["QSPEC_POLICY_FAILED"]);
      expect(run.sourceCalls()).toBe(0);
    },
  );

  it("a throw from policyView is a compile-boundary failure: QueryCompilationError, no policy, no source", async () => {
    const boom = new Error("view exploded");
    const { policy, inputs } = recordingPolicy();
    const run = harness({
      policies: [["guard", policy]],
      view: () => {
        throw boom;
      },
    });
    const error = await failure(run.qspec);
    expect(error).toBeInstanceOf(QueryCompilationError);
    // The view is built from a compiled query that holds bound values, so nothing the throw
    // carried is kept: not its message, and not the error itself as `cause`.
    expect((error as QueryCompilationError).cause).toBeUndefined();
    expect((error as QueryCompilationError).message).not.toContain("view exploded");
    expect(inputs).toHaveLength(0);
    expect(run.sourceCalls()).toBe(0);
  });

  it("a QSpecError thrown by policyView is wrapped too, never passed through", async () => {
    const thrown = new ParameterValidationError("SENTINEL_A leaked", {
      issues: [{ code: "x", message: "SENTINEL_A", path: [] }],
    });
    const run = harness({
      policies: [["guard", recordingPolicy().policy]],
      view: () => {
        throw thrown;
      },
    });
    const error = await failure(run.qspec);
    expect(error).toBeInstanceOf(QueryCompilationError);
    expect((error as QueryCompilationError).cause).toBeUndefined();
    expect(JSON.stringify({ message: (error as Error).message })).not.toContain("SENTINEL_A");
  });
});

describe("execution policies: order", () => {
  it("evaluates in registration order and stops at the first denial", async () => {
    const order: string[] = [];
    const p3 = vi.fn(() => ({ outcome: "allow" as const }));
    const run = harness({
      policies: [
        ["p1", { check: () => (order.push("p1"), { outcome: "allow" }) }],
        [
          "p2",
          {
            check: () => (
              order.push("p2"),
              { outcome: "deny", issues: [{ code: "no", message: "no", path: [] }] }
            ),
          },
        ],
        ["p3", { check: p3 }],
      ],
    });
    const error = await failure(run.qspec);
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    expect((error as ExecutionDeniedError).policy).toBe("p2");
    expect(order).toEqual(["p1", "p2"]);
    expect(p3).not.toHaveBeenCalled();
    expect(run.decisions.map((event) => [event.policy, event.outcome])).toEqual([
      ["p1", "allow"],
      ["p2", "deny"],
    ]);
  });

  it("evaluates by plugin installation order, not by name", async () => {
    const order: string[] = [];
    const named = (name: string): ExecutionPolicy => ({
      check: () => (order.push(name), { outcome: "allow" }),
    });
    const run = harness();
    run.qspec
      .use(
        definePlugin({
          name: "first",
          setup: (api) => api.policies.register("zeta", named("zeta")),
        }),
      )
      .use(
        definePlugin({
          name: "second",
          setup: (api) => api.policies.register("alpha", named("alpha")),
        }),
      );
    await run.qspec.execute(manifest, { parameters });
    expect(order).toEqual(["zeta", "alpha"]);
  });

  it("replace() keeps a policy's position", async () => {
    const order: string[] = [];
    const named = (label: string): ExecutionPolicy => ({
      check: () => (order.push(label), { outcome: "allow" }),
    });
    const run = harness({
      policies: [
        ["a", named("a")],
        ["b", named("b")],
        ["c", named("c")],
      ],
    });
    run.qspec.use(
      definePlugin({ name: "override", setup: (api) => api.policies.replace("b", named("b2")) }),
    );
    await run.qspec.execute(manifest, { parameters });
    expect(order).toEqual(["a", "b2", "c"]);
  });
});

describe("execution policies: async and abort", () => {
  it("awaits an asynchronous policy before calling the source", async () => {
    let settled = false;
    const run = harness({
      policies: [
        [
          "slow",
          {
            check: async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              settled = true;
              return { outcome: "allow" };
            },
          },
        ],
      ],
    });
    await run.qspec.execute(manifest, { parameters });
    expect(settled).toBe(true);
    expect(run.sourceCalls()).toBe(1);
  });

  it("a policy that allows after the caller aborted mid-check yields QSpecAbortError and no source call", async () => {
    const controller = new AbortController();
    const run = harness({
      policies: [
        [
          "slow",
          {
            check: async () => {
              controller.abort();
              await Promise.resolve();
              return { outcome: "allow" };
            },
          },
        ],
      ],
    });
    const error = await failure(run.qspec, manifest, { parameters, signal: controller.signal });
    expect(error).toBeInstanceOf(QSpecAbortError);
    expect(run.sourceCalls()).toBe(0);
    // The abort wins the race against the check, so the late "allow" is ignored and the
    // decision is recorded as the cancellation it was.
    expect(run.decisions.map((event) => [event.outcome, event.codes])).toEqual([
      ["error", ["QSPEC_EXECUTION_ABORTED"]],
    ]);
  });

  it("a signal aborted before the policy step runs no policy at all", async () => {
    const controller = new AbortController();
    const spy = vi.fn(() => ({ outcome: "allow" as const }));
    const run = harness({
      policies: [["spy", { check: spy }]],
      compile: (statement, bindings) => {
        // Aborts after the pre-flight check, while the query is being compiled.
        controller.abort();
        return { statement, bindings };
      },
    });
    const error = await failure(run.qspec, manifest, { parameters, signal: controller.signal });
    expect(error).toBeInstanceOf(QSpecAbortError);
    expect(spy).not.toHaveBeenCalled();
    expect(run.sourceCalls()).toBe(0);
  });

  it("an already-aborted signal stops the execution before any policy", async () => {
    const controller = new AbortController();
    controller.abort();
    const spy = vi.fn(() => ({ outcome: "allow" as const }));
    const run = harness({ policies: [["spy", { check: spy }]] });
    const error = await failure(run.qspec, manifest, { parameters, signal: controller.signal });
    expect(error).toBeInstanceOf(QSpecAbortError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("execution policies: immutability", () => {
  it("a policy that writes to the view fails closed, and the source never runs", async () => {
    const run = harness({
      policies: [
        [
          "vandal",
          {
            check: (input) => {
              (input.query?.view as { statement: string }).statement = "DROP";
              return { outcome: "allow" };
            },
          },
        ],
      ],
    });
    const error = await failure(run.qspec);
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect((error as ExecutionPolicyError).cause).toBeInstanceOf(TypeError);
    expect(run.sourceCalls()).toBe(0);
  });

  it("a policy that writes to metadata fails closed, and the source never runs", async () => {
    const run = harness({
      policies: [
        [
          "vandal",
          {
            check: (input) => {
              (input.metadata as Record<string, unknown>)["x"] = 1;
              return { outcome: "allow" };
            },
          },
        ],
      ],
    });
    const error = await failure(run.qspec, manifest, { parameters, metadata: { tenant: "t1" } });
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect((error as ExecutionPolicyError).cause).toBeInstanceOf(TypeError);
    expect(run.sourceCalls()).toBe(0);
  });

  it("a policy cannot change the statement the source receives through the view", async () => {
    // A language whose view aliases the compiled object's array: the freeze then also
    // protects what the source receives.
    const run = harness({
      policies: [
        [
          "vandal",
          {
            check: (input) => {
              try {
                (input.query?.view as { parts: string[] }).parts.push("; DROP");
              } catch {
                // Frozen: the push is refused. Allow, to prove the source sees the original.
              }
              return { outcome: "allow" };
            },
          },
        ],
      ],
      compile: (statement, bindings) => ({ statement, bindings, parts: ["SELECT"] }) as Compiled,
      view: (compiled) => ({ parts: (compiled as Compiled & { parts: string[] }).parts }),
    });
    await run.qspec.execute(manifest, { parameters });
    expect((run.sourceQueries[0] as { parts: string[] }).parts).toEqual(["SELECT"]);
  });
});

describe("execution policies: resources without a query", () => {
  it("run after stage 3 with query undefined", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    const result = await run.qspec.execute(queryless, { parameters: { from: "x" } });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.query).toBeUndefined();
    expect(inputs[0]?.resource).toEqual({ kind: "Dataset", name: "static" });
    expect(run.transform).toHaveBeenCalledOnce();
    expect(result.data.rows).toEqual([]);
  });

  it("do not run when stage 3 fails", async () => {
    const { policy, inputs } = recordingPolicy();
    const run = harness({ policies: [["guard", policy]] });
    const error = await failure(run.qspec, queryless, { parameters: {} });
    expect(error).toBeInstanceOf(ParameterValidationError);
    expect(inputs).toHaveLength(0);
  });

  it("a denial stops the transform pipeline", async () => {
    const run = harness({
      policies: [
        [
          "guard",
          { check: () => ({ outcome: "deny", issues: [{ code: "x", message: "x", path: [] }] }) },
        ],
      ],
    });
    const error = await failure(run.qspec, queryless, { parameters: { from: "x" } });
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    expect(run.transform).not.toHaveBeenCalled();
  });
});

describe("execution policies: none registered", () => {
  it("never calls policyView and emits no policy:decision", async () => {
    const run = harness();
    await run.qspec.execute(manifest, { parameters });
    await run.qspec.execute(queryless, { parameters: { from: "x" } });
    expect(run.policyView).not.toHaveBeenCalled();
    expect(run.decisions).toHaveLength(0);
    expect(run.sourceCalls()).toBe(1);
  });
});

describe("execution policies: the policy:decision event", () => {
  it("carries exactly executionId, resource, policy, outcome, codes and durationMs", async () => {
    const run = harness({ policies: [["guard", recordingPolicy().policy]] });
    await run.qspec.execute(manifest, { parameters });
    const event = run.decisions[0];
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ["codes", "durationMs", "executionId", "outcome", "policy", "resource"].sort(),
    );
    expect(event).toMatchObject({
      resource: "orders",
      policy: "guard",
      outcome: "allow",
      codes: [],
    });
    expect(event?.executionId).toBe(run.compileStarts[0]?.executionId);
    expect(typeof event?.durationMs).toBe("number");
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("carries the issue codes of a denial, never their messages", async () => {
    const run = harness({
      policies: [["guard", { check: () => ({ outcome: "deny", issues: twoIssues }) }]],
    });
    const error = await failure(run.qspec);
    expect(run.decisions[0]?.codes).toEqual(["shape.select-only", "params.required"]);
    expect(JSON.stringify(run.decisions)).not.toContain("SECRET_TABLE");
    expect(run.failures[0]?.code).toBe((error as QSpecError).code);
    expect(run.failures[0]?.code).toBe("QSPEC_EXECUTION_DENIED");
  });

  it("carries the failure code when a policy fails", async () => {
    const run = harness({
      policies: [
        [
          "guard",
          {
            check: () => {
              throw new Error("boom");
            },
          },
        ],
      ],
    });
    const error = await failure(run.qspec);
    expect(run.decisions[0]?.codes).toEqual(["QSPEC_POLICY_FAILED"]);
    expect(run.failures[0]?.code).toBe((error as QSpecError).code);
    expect(run.failures[0]?.code).toBe("QSPEC_POLICY_FAILED");
  });
});

describe("execution policies: plugin setup is settled before a prepared resource executes", () => {
  const denyAll = definePlugin({
    name: "test/deny-all",
    setup(api) {
      api.policies.register("deny-all", {
        check: () => ({ outcome: "deny", issues: [{ code: "no", message: "no", path: [] }] }),
      });
    },
  });

  it("a policy plugin installed after prepare() still guards the prepared resource", async () => {
    const run = harness();
    const prepared = await run.qspec.prepare(manifest);
    run.qspec.use(denyAll);
    const error = await prepared.execute({ parameters }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    expect((error as ExecutionDeniedError).policy).toBe("deny-all");
    expect(run.sourceCalls()).toBe(0);
  });

  it("a policy plugin whose setup failed stops every prepared resource, before its source", async () => {
    const run = harness();
    const prepared = await run.qspec.prepare(manifest);
    run.qspec.use(
      definePlugin({
        name: "test/broken-guard",
        setup() {
          throw new Error("could not load the parser");
        },
      }),
    );
    const first = await prepared.execute({ parameters }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(first).toBeInstanceOf(PluginRegistrationError);
    // The runtime stays poisoned: a later execution fails the same way, still before the source.
    const second = await prepared.execute({ parameters }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(second).toBe(first);
    expect(run.sourceCalls()).toBe(0);
    expect(run.failures.map((event) => event.code)).toEqual([
      "QSPEC_PLUGIN_REGISTRATION_FAILED",
      "QSPEC_PLUGIN_REGISTRATION_FAILED",
    ]);
  });

  it("a setup failure that poisoned the runtime elsewhere stops a resource prepared earlier", async () => {
    const run = harness();
    const prepared = await run.qspec.prepare(manifest);
    run.qspec.use(
      definePlugin({
        name: "test/broken-guard",
        setup: async () => {
          await Promise.resolve();
          throw new Error("could not load the parser");
        },
      }),
    );
    await expect(run.qspec.ready()).rejects.toThrow(PluginRegistrationError);
    await expect(prepared.execute({ parameters })).rejects.toThrow(PluginRegistrationError);
    expect(run.sourceCalls()).toBe(0);
  });
});

describe("execution policies: issues are rebuilt, not copied", () => {
  it("reads each issue field once, so a getter cannot pass the check and then change", async () => {
    let reads = 0;
    const issue = {
      get code(): unknown {
        reads += 1;
        return reads === 1 ? "ok" : { smuggled: true };
      },
      message: "m",
      path: [],
    };
    const run = harness({
      policies: [
        ["guard", { check: () => ({ outcome: "deny", issues: [issue as unknown as QSpecIssue] }) }],
      ],
    });
    const error = (await failure(run.qspec)) as ExecutionDeniedError;
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    expect(error.issues[0]?.code).toBe("ok");
    expect(run.decisions[0]?.codes).toEqual(["ok"]);
    expect(reads).toBe(1);
  });

  it("keeps only code, message, path and suggestion, dropping anything else", async () => {
    const run = harness({
      policies: [
        [
          "guard",
          {
            check: ({ metadata }) => ({
              outcome: "deny",
              issues: [
                {
                  code: "a",
                  message: "m",
                  path: ["spec", 0],
                  suggestion: "s",
                  extra: metadata,
                } as unknown as QSpecIssue,
                { code: "b", message: "n", path: [] },
              ],
            }),
          },
        ],
      ],
    });
    const error = (await failure(run.qspec, manifest, {
      parameters,
      metadata: { tenant: "SENTINEL_TENANT" },
    })) as ExecutionDeniedError;
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    expect(error.issues).toEqual([
      { code: "a", message: "m", path: ["spec", 0], suggestion: "s" },
      { code: "b", message: "n", path: [] },
    ]);
    expect(Object.keys(error.issues[0] ?? {}).sort()).toEqual([
      "code",
      "message",
      "path",
      "suggestion",
    ]);
    expect(Object.keys(error.issues[1] ?? {}).sort()).toEqual(["code", "message", "path"]);
    expect(JSON.stringify(error.issues)).not.toContain("SENTINEL_TENANT");
  });

  it.each<{ readonly label: string; readonly segment: unknown }>([
    { label: "an object", segment: { obj: "metadata" } },
    { label: "NaN", segment: Number.NaN },
    { label: "Infinity", segment: Number.POSITIVE_INFINITY },
    { label: "null", segment: null },
    { label: "a boolean", segment: true },
  ])("a path segment that is $label fails closed", async ({ segment }) => {
    const run = harness({
      policies: [
        [
          "guard",
          {
            check: () => ({
              outcome: "deny",
              issues: [
                { code: "a", message: "m", path: ["spec", segment] } as unknown as QSpecIssue,
              ],
            }),
          },
        ],
      ],
    });
    const error = await failure(run.qspec);
    expect(error).toBeInstanceOf(ExecutionPolicyError);
    expect(run.sourceCalls()).toBe(0);
  });

  it("a non-string suggestion fails closed", async () => {
    const run = harness({
      policies: [
        [
          "guard",
          {
            check: () => ({
              outcome: "deny",
              issues: [
                { code: "a", message: "m", path: [], suggestion: 1 } as unknown as QSpecIssue,
              ],
            }),
          },
        ],
      ],
    });
    expect(await failure(run.qspec)).toBeInstanceOf(ExecutionPolicyError);
  });

  it("freezes the issues it reports", async () => {
    const run = harness({
      policies: [["guard", { check: () => ({ outcome: "deny", issues: twoIssues }) }]],
    });
    const error = (await failure(run.qspec)) as ExecutionDeniedError;
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
    expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
  });
});

describe("execution policies: an abort releases a policy that never settles", () => {
  it("rejects with QSpecAbortError promptly and never calls the source", async () => {
    const controller = new AbortController();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = harness({
      policies: [
        [
          "hung",
          {
            check: () => {
              entered();
              return new Promise(() => {});
            },
          },
        ],
      ],
    });
    const pending = failure(run.qspec, manifest, { parameters, signal: controller.signal });
    await started;
    const abortedAt = performance.now();
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(QSpecAbortError);
    expect(performance.now() - abortedAt).toBeLessThan(100);
    expect(run.sourceCalls()).toBe(0);
    expect(run.decisions.map((event) => [event.outcome, event.codes])).toEqual([
      ["error", ["QSPEC_EXECUTION_ABORTED"]],
    ]);
  });

  it("ignores a late rejection after the abort, without an unhandled rejection", async () => {
    const controller = new AbortController();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = harness({
      policies: [
        [
          "late",
          {
            check: () => {
              entered();
              return new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error("late failure")), 20);
              });
            },
          },
        ],
      ],
    });
    const pending = failure(run.qspec, manifest, { parameters, signal: controller.signal });
    await started;
    controller.abort();
    expect(await pending).toBeInstanceOf(QSpecAbortError);
    // Give the late rejection time to land; vitest fails the run on an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(run.decisions).toHaveLength(1);
    expect(run.sourceCalls()).toBe(0);
  });
});
