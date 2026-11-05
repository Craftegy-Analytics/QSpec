import { describe, expect, it } from "vitest";
import {
  ExecutionDeniedError,
  createQSpec,
  definePlugin,
  type ExecutionPolicy,
  type ExecutionPolicyInput,
  type QSpec,
  type QSpecPlugin,
} from "@qspecs/core";

/** One execution the suite runs: a manifest and what to execute it with. */
export interface ExecutionPolicyCase {
  readonly manifest: unknown;
  readonly parameters?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface ExecutionPolicyContractFixture {
  /** A fresh policy per test. */
  readonly create: () => ExecutionPolicy | Promise<ExecutionPolicy>;
  /** Plugins the cases need besides the policy, for example sql() and memory(). Fresh per test. */
  readonly plugins: () => readonly QSpecPlugin[];
  /** How many times the data source ran, read from the plugins created for the current test. */
  readonly sourceCalls: () => number;
  /** A case the policy allows. It must reach a data source and return data. */
  readonly allowed: ExecutionPolicyCase;
  /** A case the policy denies. */
  readonly denied: ExecutionPolicyCase;
  /** Rejection deadline for a check started with an aborted signal. Default 150 ms. */
  readonly abortBoundMs?: number;
  /**
   * Metadata keys the policy reads whose value may be any string in the denied case without
   * changing the outcome (a tenant, a viewer or a request id, typically). The metadata check runs
   * the denied case with each of these set to its own sentinel string, and fails if any sentinel
   * appears in what the denial reports: a sentinel under a key nobody reads (which the suite
   * always adds too) cannot catch a policy that echoes the value it actually reads. Optional;
   * omit it only when the policy reads no such key.
   */
  readonly metadataKeys?: readonly string[];
}

/** The name the suite registers the policy under; a denial must carry exactly this name. */
export const CONTRACT_POLICY_NAME = "policy-under-contract";

/** Default for `ExecutionPolicyContractFixture.abortBoundMs`. */
const DEFAULT_ABORT_BOUND_MS = 150;

interface ContractRuntime {
  readonly qspec: QSpec;
  readonly policy: ExecutionPolicy;
  /** Every input the policy was handed through the runtime, in order. */
  readonly inputs: readonly ExecutionPolicyInput[];
}

/**
 * A real runtime: the fixture's plugins first, then the policy under test registered under
 * `CONTRACT_POLICY_NAME`, wrapped only to record the inputs core hands it.
 */
async function contractRuntime(fixture: ExecutionPolicyContractFixture): Promise<ContractRuntime> {
  const policy = await fixture.create();
  const inputs: ExecutionPolicyInput[] = [];
  const qspec = createQSpec();
  for (const plugin of fixture.plugins()) qspec.use(plugin);
  qspec.use(
    definePlugin({
      name: "@qspecs/testing/execution-policy-contract",
      setup(api) {
        api.policies.register(CONTRACT_POLICY_NAME, {
          check(input) {
            inputs.push(input);
            return policy.check(input);
          },
        });
      },
    }),
  );
  await qspec.ready();
  return { qspec, policy, inputs };
}

function run(qspec: QSpec, testCase: ExecutionPolicyCase, metadata = testCase.metadata) {
  return qspec.execute(testCase.manifest, {
    ...(testCase.parameters === undefined ? {} : { parameters: testCase.parameters }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

/** Runs `denied` and returns what it threw, failing with a specific message if it did not deny. */
async function deny(qspec: QSpec, testCase: ExecutionPolicyCase, metadata = testCase.metadata) {
  const thrown: unknown = await run(qspec, testCase, metadata).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(
    thrown instanceof ExecutionDeniedError,
    `the denied case did not reject with ExecutionDeniedError (got ${
      thrown === undefined ? "a result" : String(thrown)
    })`,
  ).toBe(true);
  return thrown as ExecutionDeniedError;
}

// --- Individual assertions -------------------------------------------------
//
// Exported so this package's own `execution-policy.test.ts` can pin each one
// against a planted defect without duplicating its logic. Only
// `runExecutionPolicyContractTests` and its fixture types are re-exported from
// `index.ts`. Each throws (via `expect`) on failure.

/** The allowed case reaches the data source exactly once and returns data. */
export async function assertAllowedReachesSource(
  fixture: ExecutionPolicyContractFixture,
): Promise<void> {
  const { qspec } = await contractRuntime(fixture);
  const before = fixture.sourceCalls();
  const result = await run(qspec, fixture.allowed);
  expect(Array.isArray(result.data.rows), "the allowed case did not return a dataset").toBe(true);
  expect(
    fixture.sourceCalls() - before,
    "the allowed case did not reach the data source exactly once",
  ).toBe(1);
}

/**
 * The denied case rejects with `ExecutionDeniedError` naming the registered policy, with at
 * least one issue, each with a string `code`, a string `message` and an array `path`.
 */
export async function assertDeniedIsWellFormed(
  fixture: ExecutionPolicyContractFixture,
): Promise<void> {
  const { qspec } = await contractRuntime(fixture);
  const error = await deny(qspec, fixture.denied);
  expect(error.policy, "the denial does not name the registered policy").toBe(CONTRACT_POLICY_NAME);
  expect(error.issues.length, "the denial carries no issue").toBeGreaterThan(0);
  for (const issue of error.issues) {
    expect(typeof issue.code, "an issue's code is not a string").toBe("string");
    expect(typeof issue.message, "an issue's message is not a string").toBe("string");
    expect(Array.isArray(issue.path), "an issue's path is not an array").toBe(true);
  }
}

/** A denied execution never reaches the data source. */
export async function assertDeniedDoesNotReachSource(
  fixture: ExecutionPolicyContractFixture,
): Promise<void> {
  const { qspec } = await contractRuntime(fixture);
  const before = fixture.sourceCalls();
  await deny(qspec, fixture.denied);
  expect(fixture.sourceCalls(), "the denied case reached the data source").toBe(before);
}

/**
 * The same denied execution, twice on the same policy instance, reports the same issue codes:
 * audit and admission tooling key on them.
 */
export async function assertDenialIsDeterministic(
  fixture: ExecutionPolicyContractFixture,
): Promise<void> {
  const { qspec } = await contractRuntime(fixture);
  const first = (await deny(qspec, fixture.denied)).issues.map((issue) => issue.code);
  const second = (await deny(qspec, fixture.denied)).issues.map((issue) => issue.code);
  expect(second, "the denied case reported different issue codes on a second run").toEqual(first);
}

/**
 * A metadata value never appears in what a denial reports. Sentinels go under an unread
 * `contractSentinel` key and under every key in `fixture.metadataKeys`, the ones the policy reads.
 */
export async function assertMetadataNotEchoed(
  fixture: ExecutionPolicyContractFixture,
): Promise<void> {
  const { qspec } = await contractRuntime(fixture);
  const sentinels: Record<string, string> = {};
  for (const key of ["contractSentinel", ...(fixture.metadataKeys ?? [])]) {
    sentinels[key] = `contract-sentinel-${crypto.randomUUID()}`;
  }
  const error = await deny(qspec, fixture.denied, { ...fixture.denied.metadata, ...sentinels });
  const reported = JSON.stringify(error.issues) + error.message;
  for (const [key, sentinel] of Object.entries(sentinels)) {
    expect(
      reported.includes(sentinel),
      `a metadata value appeared in the denial's issues (the sentinel under "${key}")`,
    ).toBe(false);
  }
}

/**
 * A check started with an already-aborted signal settles, allowing, denying or throwing, within
 * `abortBoundMs`. Core checks the signal itself before each policy, so the check is called
 * directly, with the input core handed it for the allowed case and an aborted signal: a policy
 * that waits on something slow must not ignore its caller's cancellation.
 */
export async function assertSettlesWhenAborted(
  fixture: ExecutionPolicyContractFixture,
): Promise<void> {
  const boundMs = fixture.abortBoundMs ?? DEFAULT_ABORT_BOUND_MS;
  const { qspec, policy, inputs } = await contractRuntime(fixture);
  await run(qspec, fixture.allowed);
  const input = inputs[0];
  if (input === undefined) throw new Error("the allowed case never reached the policy");

  const controller = new AbortController();
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  const outcome = await Promise.race([
    Promise.resolve()
      .then(() => policy.check({ ...input, signal: controller.signal }))
      .then(
        () => "settled" as const,
        () => "settled" as const,
      ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundMs);
    }),
  ]);
  clearTimeout(timer);
  expect(outcome, `a check started with an aborted signal did not settle within ${boundMs}ms`).toBe(
    "settled",
  );
  expect(performance.now() - started).toBeLessThan(boundMs);
}

/**
 * Invariants every `ExecutionPolicy` must satisfy, through a real runtime (SPEC.md §89, §110).
 * Call this from a policy package's own test file. The fixture supplies the policy, the plugins
 * its cases need, an allowed case and a denied case, and a data source call counter.
 */
export function runExecutionPolicyContractTests(
  name: string,
  fixture: ExecutionPolicyContractFixture,
): void {
  describe(`${name}: ExecutionPolicy contract`, () => {
    it("the allowed case reaches the data source exactly once and returns data", async () => {
      await assertAllowedReachesSource(fixture);
    });

    it("the denied case rejects with ExecutionDeniedError naming the policy, with well-formed issues", async () => {
      await assertDeniedIsWellFormed(fixture);
    });

    it("the denied case never reaches the data source", async () => {
      await assertDeniedDoesNotReachSource(fixture);
    });

    it("the denied case reports the same issue codes on a second run", async () => {
      await assertDenialIsDeterministic(fixture);
    });

    it("never echoes a metadata value into a denial", async () => {
      await assertMetadataNotEchoed(fixture);
    });

    it("settles promptly when started with an already-aborted signal", async () => {
      await assertSettlesWhenAborted(fixture);
    });
  });
}
