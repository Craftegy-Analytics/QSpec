import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { PgArrayModeQueryResult } from "./normalize.js";
import {
  backendPid,
  createNodePostgresDriver,
  driverQuery,
  type PgClientOptions,
  type PgPoolOptions,
  type RawPoolClient,
  type RawQueryConfig,
} from "./driver.js";

const OPTIONS: PgPoolOptions = { connectionString: "postgres://qspec@localhost/analytics" };

const RESULT: PgArrayModeQueryResult = {
  fields: [{ name: "id", dataTypeID: 23 }],
  rows: [[1]],
};

/**
 * Fakes for `pg.Pool` / `pg.Client` that are real `EventEmitter`s, because
 * the behavior under test is an EventEmitter behavior: Node throws an
 * unhandled `'error'`, and only an attached listener stops that.
 */
class FakeRawPoolClient {
  readonly configs: RawQueryConfig[] = [];
  released = 0;
  readonly processID: unknown;

  constructor(processID: unknown) {
    this.processID = processID;
  }

  async query(config: RawQueryConfig): Promise<PgArrayModeQueryResult> {
    this.configs.push(config);
    return RESULT;
  }

  release(): void {
    this.released += 1;
  }
}

class FakeRawPool extends EventEmitter {
  readonly clients: FakeRawPoolClient[] = [];
  ended = 0;
  /** What each client it hands out reports, so a test can withhold it. */
  nextProcessID: unknown = 4242;

  async connect(): Promise<RawPoolClient> {
    const client = new FakeRawPoolClient(this.nextProcessID);
    this.clients.push(client);
    return client;
  }

  async end(): Promise<void> {
    this.ended += 1;
  }
}

class FakeRawClient extends EventEmitter {
  readonly configs: RawQueryConfig[] = [];
  connected = 0;
  ended = 0;

  async connect(): Promise<unknown> {
    this.connected += 1;
    return this;
  }

  async query(config: RawQueryConfig): Promise<PgArrayModeQueryResult> {
    this.configs.push(config);
    return RESULT;
  }

  async end(): Promise<unknown> {
    this.ended += 1;
    return undefined;
  }
}

function createDriver(): {
  pool: FakeRawPool;
  client: FakeRawClient;
  driver: ReturnType<typeof createNodePostgresDriver>;
} {
  const pool = new FakeRawPool();
  const client = new FakeRawClient();
  const driver = createNodePostgresDriver({
    createPool: (_options: PgPoolOptions) => pool,
    createClient: (_options: PgClientOptions) => client,
  });
  return { pool, client, driver };
}

describe("backendPid", () => {
  it("reads the PID `pg` sets but `@types/pg` does not declare", () => {
    expect(backendPid({ processID: 4242 })).toBe(4242);
  });

  it("returns null when the driver reports no PID at all", () => {
    expect(backendPid({})).toBeNull();
  });

  it.each([
    ["a string", "4242"],
    ["null", null],
    ["undefined", undefined],
    // 0, negatives and non-integers are not backend PIDs. Passing one on
    // would make `pg_cancel_backend` return false while the source logged
    // that it had cancelled something — a silent no-op.
    ["zero", 0],
    ["a negative", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("returns null for %s", (_label, processID) => {
    expect(backendPid({ processID })).toBeNull();
  });
});

describe("driverQuery", () => {
  it('always sets rowMode: "array"', () => {
    expect(driverQuery({ text: "SELECT 1", values: [], rowMode: "array" })).toEqual({
      text: "SELECT 1",
      values: [],
      rowMode: "array",
    });
  });

  it("copies values into a mutable array `pg` will accept", () => {
    const values: readonly unknown[] = [1, "two"];

    const config = driverQuery({ text: "SELECT $1, $2", values, rowMode: "array" });

    expect(config.values).toEqual([1, "two"]);
    expect(config.values).not.toBe(values);
  });
});

describe("createNodePostgresDriver", () => {
  it("throws an unhandled 'error' when nothing listens — the hazard being guarded", () => {
    // Pins the premise the two tests below rest on: these fakes are real
    // EventEmitters, so an unlistened 'error' genuinely takes the process
    // down, exactly as `pg.Pool` and `pg.Client` do.
    expect(() => new FakeRawPool().emit("error", new Error("connection terminated"))).toThrow(
      "connection terminated",
    );
    expect(() => new FakeRawClient().emit("error", new Error("connection terminated"))).toThrow(
      "connection terminated",
    );
  });

  it("reports a pool 'error' instead of letting it crash the process", () => {
    const { pool, driver } = createDriver();
    let reported = 0;

    driver.createPool(OPTIONS, () => {
      reported += 1;
    });

    expect(() => pool.emit("error", new Error("connection terminated unexpectedly"))).not.toThrow();
    expect(reported).toBe(1);
  });

  it("reports a cancel-client 'error' instead of letting it crash the process", () => {
    const { client, driver } = createDriver();
    let reported = 0;

    driver.createClient(OPTIONS, () => {
      reported += 1;
    });

    expect(() =>
      client.emit("error", new Error("connection terminated unexpectedly")),
    ).not.toThrow();
    expect(reported).toBe(1);
  });

  it("forwards to the handler unguarded, so a throwing handler still crashes — where the guard has to live", () => {
    // Pins where responsibility for a throwing handler sits. The driver
    // attaches `onError` directly to the emitter, so it adds no protection of
    // its own: a handler that throws propagates straight back out of `emit`
    // and takes the process down. That is why `createPostgresSource`'s
    // `onConnectionError` — the only handler in this package, and the only
    // thing here that calls a *host* logger — wraps its body in try/catch.
    //
    // If this test ever starts failing because the driver began swallowing
    // handler errors, the source's guard has become redundant rather than
    // wrong; delete one of the two deliberately, do not adjust this test.
    const { pool, client, driver } = createDriver();
    const boom = (): never => {
      throw new Error("the host logger is broken");
    };

    driver.createPool(OPTIONS, boom);
    driver.createClient(OPTIONS, boom);

    expect(() => pool.emit("error", new Error("connection terminated unexpectedly"))).toThrow(
      "the host logger is broken",
    );
    expect(() => client.emit("error", new Error("connection terminated unexpectedly"))).toThrow(
      "the host logger is broken",
    );
  });

  it("captures the backend PID, forwards the query, and releases the client", async () => {
    const { pool, driver } = createDriver();
    const wrapped = driver.createPool(OPTIONS, () => undefined);

    const client = await wrapped.connect();
    const result = await client.query({ text: "SELECT 1", values: [7], rowMode: "array" });
    client.release();
    await wrapped.end();

    const raw = pool.clients[0];
    expect(client.processID).toBe(4242);
    expect(result).toEqual(RESULT);
    expect(raw?.configs).toEqual([{ text: "SELECT 1", values: [7], rowMode: "array" }]);
    expect(raw?.released).toBe(1);
    expect(pool.ended).toBe(1);
  });

  it("reports no PID rather than a wrong one when the driver exposes none", async () => {
    // The shape a "simplification" to `client.processID ?? 0` would turn into
    // a cancel of backend 0: a call that succeeds and stops nothing. `null`
    // makes the source say it cannot cancel instead.
    const { pool, driver } = createDriver();
    pool.nextProcessID = undefined;
    const wrapped = driver.createPool(OPTIONS, () => undefined);

    const client = await wrapped.connect();

    expect(client.processID).toBeNull();
  });

  it("connects, queries, and ends the cancel client", async () => {
    const { client, driver } = createDriver();
    const wrapped = driver.createClient(OPTIONS, () => undefined);

    await wrapped.connect();
    await wrapped.query({ text: "SELECT pg_cancel_backend($1)", values: [4242], rowMode: "array" });
    await wrapped.end();

    expect(client.connected).toBe(1);
    expect(client.configs).toEqual([
      { text: "SELECT pg_cancel_backend($1)", values: [4242], rowMode: "array" },
    ]);
    expect(client.ended).toBe(1);
  });
});
