import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import {
  ExecutionDeniedError,
  QSPEC_V1,
  createQSpec,
  definePlugin,
  type DataSource,
  type ExecutionPolicy,
  type QSpec,
  type QSpecPlugin,
} from "@qspecs/core";
import { isSqlPolicyView, sql } from "@qspecs/sql";
import { postgres } from "@qspecs/postgres";

/**
 * Execution policies against a real PostgreSQL server.
 *
 * The core unit tests prove a denied execution never calls `DataSource.execute`. This file proves
 * the stronger claim a host's auditor cares about: the database never saw the statement. The
 * probe is a sequence. `SELECT nextval(...)` advances it as a side effect of running at all, so
 * reading the sequence's own state afterwards (`last_value`, `is_called`), on a separate admin
 * connection, shows whether the statement reached the server, independently of what QSpec threw.
 *
 * Container setup, skip detection, and timeouts follow `test/postgres-pipeline.test.ts` exactly.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

/** Pinned for the same reason as the postgres package's own integration suite: reproducibility. */
const POSTGRES_IMAGE = "postgres:16-alpine";

const DB_PASSWORD = "qspec-policy-pw-5e7a1c";
const DB_USER = "qspec_policy";
const DB_NAME = "qspec_policy_e2e";

const SOURCE = "analytics";

async function containerRuntimeUnavailableReason(): Promise<string | undefined> {
  try {
    await getContainerRuntimeClient();
    return undefined;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const firstLine = message.split("\n")[0] ?? message;
    return firstLine.slice(0, 200);
  }
}

const runtimeUnavailable = await containerRuntimeUnavailableReason();

const UNVERIFIED = [
  "that a statement an execution policy denies never reaches PostgreSQL",
  "that the same statement under an allowing policy does reach it",
  "that ExecutionContext.metadata reaches a real data source as the object the policy saw",
].join("; ");

const suiteName =
  runtimeUnavailable === undefined
    ? "execution policies against a real PostgreSQL (testcontainers)"
    : `execution policies against a real PostgreSQL: SKIPPED, no container runtime ` +
      `(${runtimeUnavailable}). UNVERIFIED: ${UNVERIFIED}`;

const describeIntegration = runtimeUnavailable === undefined ? describe : describe.skip;

if (runtimeUnavailable !== undefined) console.warn(suiteName);

let container: StartedPostgreSqlContainer | undefined;
let admin: Client | undefined;
const runtimes: QSpec[] = [];

function connectionUri(): string {
  if (container === undefined) throw new Error("the PostgreSQL container has not been started");
  return container.getConnectionUri();
}

function adminClient(): Client {
  if (admin === undefined) throw new Error("the admin client has not been connected");
  return admin;
}

/**
 * A fresh sequence per test, so no test depends on another's side effects. The name is a fixed
 * literal this file authored, which is the only reason interpolating it into SQL is acceptable
 * (SPEC.md §72.2 forbids it for anything manifest- or caller-supplied).
 */
async function createProbe(name: string): Promise<void> {
  await adminClient().query(`CREATE SEQUENCE ${name}`);
}

/** The sequence's own state, read on the admin connection, never through QSpec. */
async function probeState(name: string): Promise<{ lastValue: string; isCalled: boolean }> {
  const result = await adminClient().query<{ last_value: string; is_called: boolean }>(
    `SELECT last_value, is_called FROM ${name}`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`sequence ${name} returned no state row`);
  return { lastValue: String(row.last_value), isCalled: row.is_called };
}

function probeManifest(sequence: string) {
  return {
    apiVersion: QSPEC_V1,
    kind: "Dataset",
    metadata: { name: "policy-probe" },
    spec: {
      query: {
        source: SOURCE,
        language: "sql",
        statement: `SELECT nextval('${sequence}') AS n`,
      },
    },
  };
}

/** Denies any statement whose literal SQL calls `nextval`, the way a read-only guard would. */
const denyNextval: ExecutionPolicy = {
  check({ query }) {
    if (query === undefined) return { outcome: "allow" };
    if (!isSqlPolicyView(query.view)) {
      return {
        outcome: "deny",
        issues: [{ code: "language", message: "Only SQL is allowed.", path: ["spec", "query"] }],
      };
    }
    const writes = query.view.segments.some((segment) => /\bnextval\s*\(/i.test(segment));
    return writes
      ? {
          outcome: "deny",
          issues: [
            {
              code: "shape.no-side-effects",
              message: "The statement calls nextval, which writes.",
              path: ["spec", "query", "statement"],
            },
          ],
        }
      : { outcome: "allow" };
  },
};

const allowAll: ExecutionPolicy = { check: () => ({ outcome: "allow" }) };

/** A runtime with sql(), postgres() against the container, and the given policy. */
async function runtimeWith(policy: ExecutionPolicy, ...extra: QSpecPlugin[]) {
  const qspec = createQSpec()
    .use(sql())
    .use(postgres({ sources: { [SOURCE]: { connectionString: connectionUri() } } }));
  for (const plugin of extra) qspec.use(plugin);
  qspec.use(
    definePlugin({
      name: "test/policy",
      setup(api) {
        api.policies.register("probe-guard", policy);
      },
    }),
  );
  await qspec.ready();
  runtimes.push(qspec);
  return qspec;
}

describeIntegration(suiteName, () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(DB_NAME)
      .withUsername(DB_USER)
      .withPassword(DB_PASSWORD)
      .start();
    admin = new Client({ connectionString: connectionUri() });
    admin.on("error", () => undefined);
    await admin.connect();
  });

  afterAll(async () => {
    try {
      for (const qspec of runtimes) await qspec.dispose();
    } finally {
      try {
        await admin?.end();
      } finally {
        await container?.stop();
      }
    }
  });

  it("a denied statement never reaches PostgreSQL: the sequence does not move", async () => {
    await createProbe("qspec_policy_probe_denied");
    expect(await probeState("qspec_policy_probe_denied")).toEqual({
      lastValue: "1",
      isCalled: false,
    });

    const qspec = await runtimeWith(denyNextval);
    const error: unknown = await qspec
      .execute(probeManifest("qspec_policy_probe_denied"))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ExecutionDeniedError);
    expect((error as ExecutionDeniedError).policy).toBe("probe-guard");
    expect((error as ExecutionDeniedError).issues.map((issue) => issue.code)).toEqual([
      "shape.no-side-effects",
    ]);

    // Unchanged: `nextval` never ran, so the statement never reached the server.
    expect(await probeState("qspec_policy_probe_denied")).toEqual({
      lastValue: "1",
      isCalled: false,
    });
  });

  it("the same statement under an allowing policy reaches PostgreSQL and advances the sequence", async () => {
    await createProbe("qspec_policy_probe_allowed");
    const qspec = await runtimeWith(allowAll);
    const result = await qspec.execute(probeManifest("qspec_policy_probe_allowed"));
    // `nextval` returns bigint, which pg hands back as a string.
    expect(result.data.rows.map((row) => row["n"])).toEqual(["1"]);
    expect(await probeState("qspec_policy_probe_allowed")).toEqual({
      lastValue: "1",
      isCalled: true,
    });
  });

  it("hands a real data source the same metadata object the policy saw", async () => {
    const seenByPolicy: unknown[] = [];
    const seenBySource: unknown[] = [];
    const tenantPolicy: ExecutionPolicy = {
      check({ metadata }) {
        seenByPolicy.push(metadata);
        return metadata?.["tenant"] === "t1"
          ? { outcome: "allow" }
          : {
              outcome: "deny",
              issues: [{ code: "tenant", message: "Unknown tenant.", path: ["metadata"] }],
            };
      },
    };
    // Wraps the postgres source registered before it, recording what it receives.
    const recordingSource = definePlugin({
      name: "test/recording-source",
      setup(api) {
        const inner = api.sources.get(SOURCE);
        if (inner === undefined) throw new Error("postgres() registered no source to wrap");
        const wrapper: DataSource = {
          ...(inner.supportedLanguages === undefined
            ? {}
            : { supportedLanguages: inner.supportedLanguages }),
          async execute(query, context) {
            seenBySource.push(context.metadata);
            return inner.execute(query, context);
          },
          dispose: () => inner.dispose?.(),
        };
        api.sources.replace(SOURCE, wrapper);
      },
    });
    await createProbe("qspec_policy_probe_metadata");
    const qspec = await runtimeWith(tenantPolicy, recordingSource);
    const handle = { live: true };
    const result = await qspec.execute(probeManifest("qspec_policy_probe_metadata"), {
      metadata: { tenant: "t1", handle },
    });

    expect(result.data.rows.map((row) => row["n"])).toEqual(["1"]);
    expect(seenByPolicy).toHaveLength(1);
    expect(seenBySource).toHaveLength(1);
    expect(seenBySource[0]).toBe(seenByPolicy[0]);
    expect((seenBySource[0] as Record<string, unknown>)["handle"]).toBe(handle);

    // A different tenant is refused before the server is reached.
    const denied: unknown = await qspec
      .execute(probeManifest("qspec_policy_probe_metadata"), { metadata: { tenant: "t2" } })
      .catch((thrown: unknown) => thrown);
    expect(denied).toBeInstanceOf(ExecutionDeniedError);
    expect(seenBySource).toHaveLength(1);
    expect(await probeState("qspec_policy_probe_metadata")).toEqual({
      lastValue: "1",
      isCalled: true,
    });
  });
});
