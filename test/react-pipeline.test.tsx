// @vitest-environment jsdom
import { Suspense, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import {
  QSPEC_V1,
  createQSpec,
  type PresentationDefinition,
  type QSpec,
  type QSpecResult,
} from "@qspecs/core";
import { sql } from "@qspecs/sql";
import { postgres } from "@qspecs/postgres";
import { transforms } from "@qspecs/transforms";
import { charts } from "@qspecs/charts";
import { createHttpExecutor, createQSpecHandler, type QSpecExecutor } from "@qspecs/http";
import { QSpecProvider, QSpecResource } from "@qspecs/react";
import { QSpecChart } from "@qspecs/recharts";

/**
 * The whole loop, end to end, for the first time: a manifest held by a
 * server whose runtime talks to a real PostgreSQL, behind
 * `createQSpecHandler`; a `createHttpExecutor` client in a jsdom "browser"
 * that knows nothing but a resource name and two parameter values; React
 * suspending on that query; and a Recharts SVG in the DOM carrying the rows
 * PostgreSQL returned, after the manifest's transform chain ran.
 *
 *   manifest + PostgreSQL (server) -> createQSpecHandler -> HTTP wire ->
 *   createHttpExecutor -> QSpecProvider -> QSpecResource (Suspense) ->
 *   QSpecChart -> SVG in the DOM
 *
 * `test/postgres-pipeline.test.ts` already proves the server half of that
 * chain against a container; this file is about the arrow that test
 * explicitly does not cover ("React/Recharts rendering, the flow's final
 * arrow, is Plan 4 and is not exercised here") plus the HTTP boundary in
 * between. The central claim it exists to prove is the security one: the
 * client half of this file — the executor, the provider, the component
 * tree, and every byte on the wire — never sees the SQL statement, the
 * table name, the connection string, or the password. See the
 * "carries no SQL, connection string, or password to the client" test,
 * which asserts that on the serialized request body, on the serialized
 * response body, AND on the rendered DOM.
 *
 * Container setup, skip detection, and timeouts follow
 * `packages/postgres/test/integration.test.ts` and
 * `test/postgres-pipeline.test.ts` exactly — this file adds no new
 * conventions of its own. The React rendering conventions
 * (`// @vitest-environment jsdom` as the first line, `renderSuspended` /
 * `rerenderSuspended`, `afterEach(cleanup)`) come from
 * `packages/react/src/internal/use-qspec-query.test.tsx`, and the explicit
 * chart `width`/`height` (never `<ResponsiveContainer>`, which measures a
 * zero-sized parent under jsdom and renders nothing) from
 * `packages/recharts/src/internal/cartesian.test.tsx`.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

/** Pinned for the same reason as the postgres package's own integration suite: reproducibility. */
const POSTGRES_IMAGE = "postgres:16-alpine";

const DB_PASSWORD = "qspec-react-pw-4f1c8e";
const DB_USER = "qspec_react";
const DB_NAME = "qspec_react_e2e";

/** The logical source name the manifest queries — never a connection string. */
const SOURCE = "analytics";
/** The one name the browser is allowed to know. */
const RESOURCE = "monthly-bonus";
/** Where the handler is "mounted"; only the client's `fetch` double ever sees it. */
const ENDPOINT = "https://qspec.test/api/qspec";

const CHART_WIDTH = 600;
const CHART_HEIGHT = 400;

// --- Docker detection -------------------------------------------------------
// Identical approach to packages/postgres/test/integration.test.ts: ask
// testcontainers' own runtime discovery rather than probing a socket path, so
// this can never disagree with what `PostgreSqlContainer.start()` would find.

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
  "the full browser loop: a manifest on a server with a real PostgreSQL -> " +
    "createQSpecHandler -> the HTTP wire -> createHttpExecutor -> QSpecProvider -> " +
    "QSpecResource suspending -> QSpecChart's SVG in the DOM",
  "one Recharts mark per row PostgreSQL actually returned, carrying the values " +
    "the manifest's filter/derive/sort/limit chain produced",
  "that no SQL statement, table name, connection string, or password reaches the " +
    "request body, the response body, or the rendered DOM",
  "that changing a parameter re-executes against PostgreSQL and updates the chart",
].join("; ");

const suiteName =
  runtimeUnavailable === undefined
    ? "the full browser loop (testcontainers PostgreSQL -> HTTP -> React -> Recharts)"
    : `the full browser loop — SKIPPED, no container runtime ` +
      `(${runtimeUnavailable}). UNVERIFIED: ${UNVERIFIED}`;

const describeIntegration = runtimeUnavailable === undefined ? describe : describe.skip;

if (runtimeUnavailable !== undefined) console.warn(suiteName);

// @testing-library/react does not auto-detect vitest's global `afterEach` —
// see packages/react/src/internal/use-qspec-query.test.tsx. Without this,
// each test's tree accumulates in `document.body` and `screen` queries start
// matching nodes left over from earlier tests.
afterEach(cleanup);

// --- Shared state, all created in beforeAll --------------------------------

let container: StartedPostgreSqlContainer | undefined;
let admin: Client | undefined;
let runtime: QSpec | undefined;
let executor: QSpecExecutor | undefined;

/** Reset and reassigned in `beforeEach`; see that hook and the paired `afterEach`. */
const consoleErrorCalls: string[] = [];
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

function connectionUri(): string {
  if (container === undefined) throw new Error("the PostgreSQL container has not been started");
  return container.getConnectionUri();
}

/**
 * The client's executor, created ONCE in `beforeAll` and read through this
 * getter on every render. Not rebuilt per render: `QSpecProvider` captures
 * its `executor` prop on first render and warns if the prop's identity later
 * diverges (see that component's doc comment), so a fresh
 * `createHttpExecutor(...)` inline in the JSX would make this file's own
 * output noisy for reasons that have nothing to do with what it proves.
 */
function httpExecutor(): QSpecExecutor {
  if (executor === undefined) throw new Error("the HTTP executor has not been created");
  return executor;
}

/**
 * Rows 2-7 are the same shape as `test/postgres-pipeline.test.ts`'s, so a
 * reader who already trusts the numbers there can trust them here: filter
 * (revenue > 0) drops the zero-revenue January row, derive adds a 10% bonus,
 * sort orders by bonus descending, and limit keeps the top three. Every
 * `revenue * 0.1` below is exact in binary floating point (90, 10, 5, 3, 2,
 * 20, 40), so no assertion in this file has to reason about float noise.
 *
 * Rows 1 and 8 exist to make the bound `:from`/`:to` range falsifiable
 * rather than merely non-erroring, and row 8 does double duty:
 *
 * - Row 1 (2025-12, revenue 900 -> bonus 90) sits BEFORE `from` in both
 *   ranges this file queries. Its bonus dominates every other row's, so it
 *   would win a `limit(3)` slot — and appear first on the x axis — the
 *   moment an adapter ignored the lower bound. It must never appear.
 * - Row 8 (2026-04, revenue 400 -> bonus 40) sits outside the FIRST range
 *   and inside the SECOND. That is what makes the parameter-change test
 *   assert something a stale render could not fake: the new upper bound
 *   pulls a genuinely new month into the chart, at the top of the sort.
 */
const SALES_ROWS: readonly [id: number, month: string, occurredOn: string, revenue: number][] = [
  [1, "2025-12", "2025-12-15", 900], // before `from` in both ranges: must never appear
  [2, "2026-01", "2026-01-05", 100],
  [3, "2026-01", "2026-01-20", 0],
  [4, "2026-02", "2026-02-05", 50],
  [5, "2026-02", "2026-02-20", 30],
  [6, "2026-03", "2026-03-05", 20],
  [7, "2026-03", "2026-03-20", 200],
  [8, "2026-04", "2026-04-05", 400], // outside the first range, inside the second
];

/** The narrower range: rows 2-7, i.e. everything but the two falsifier rows. */
const FIRST_RANGE = { from: "2026-01-01", to: "2026-03-31" } as const;
/** The wider range: FIRST_RANGE plus row 8, and still not row 1. */
const SECOND_RANGE = { from: "2026-01-01", to: "2026-04-30" } as const;

/**
 * The server's only manifest. It holds the SQL, the table name, and the
 * `:from`/`:to` bindings; it holds NO credentials — the container's
 * connection string is host configuration handed to `postgres({ sources })`
 * in `beforeAll` (SPEC.md §9, §72.1). Nothing in this string ever crosses
 * the wire: `createQSpecHandler` resolves a resource NAME against the
 * registry it was constructed with, and the browser only ever sends that
 * name.
 */
function manifestJson(): string {
  return JSON.stringify({
    apiVersion: QSPEC_V1,
    kind: "Chart",
    metadata: { name: RESOURCE },
    spec: {
      parameters: {
        from: { type: "date", required: true },
        to: { type: "date", required: true },
      },
      query: {
        source: SOURCE,
        language: "sql",
        statement:
          "SELECT month, revenue FROM sales WHERE occurred_on BETWEEN :from AND :to ORDER BY id",
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
  });
}

// --- The client's transport -------------------------------------------------

/**
 * Every request body and every response body that crossed the wire, in
 * order. These are the two halves of the security assertion that a reader
 * can check without trusting anything about the implementation: whatever the
 * browser sent, and whatever it was told, verbatim as JSON text.
 */
const requestBodies: string[] = [];
const responseBodies: string[] = [];

/**
 * The client's `fetch`, built directly from the server's handler — the same
 * shape `packages/http/src/internal/executor.test.ts` uses, and deliberately
 * not a hand-written stub returning a literal. Going through a real
 * `Request` and a real `Response` is what makes the recorded bodies below
 * genuine wire bytes: the request body is JSON text `createHttpExecutor`
 * serialized and a `Request` accepted, and the response body is JSON text
 * `createQSpecHandler` serialized, not two in-process objects passed by
 * reference with no serialization step to inspect.
 */
function fetchViaHandler(
  handler: (request: Request) => Promise<Response>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    requestBodies.push(await request.clone().text());
    const response = await handler(request);
    responseBodies.push(await response.clone().text());
    return response;
  };
}

// --- The client's component tree -------------------------------------------

/**
 * Narrows `QSpecResult["presentation"]` (`PresentationDefinition |
 * undefined`) without a cast. A `Chart`-kind manifest always carries one, so
 * the `undefined` branch is unreachable here — but it is reachable in the
 * type, and throwing is the only way to rule it out that cannot also hide a
 * real regression: a `QSpecChart` quietly skipped because no presentation
 * arrived would leave a chartless DOM that every "no SQL in the DOM"
 * assertion below still passes.
 */
function presentationOf(result: QSpecResult): PresentationDefinition {
  const { presentation } = result;
  if (presentation === undefined) {
    throw new Error("the executed resource returned no presentation to render");
  }
  return presentation;
}

/**
 * The whole client. Note what it is given: an executor pointed at a URL, a
 * resource name, and two date strings. There is no manifest here, no
 * `spec.query`, no source configuration — the browser cannot name a table or
 * a statement even if it wanted to, because `QSpecExecuteRequest` has no
 * field for one (`packages/http/src/internal/protocol.ts`).
 */
function Dashboard({ from, to }: { from: string; to: string }): ReactNode {
  return (
    <QSpecProvider executor={httpExecutor()}>
      <Suspense fallback={<div data-testid="fallback" />}>
        <QSpecResource resource={RESOURCE} parameters={{ from, to }}>
          {(result) => (
            <div data-testid="chart">
              <QSpecChart
                dataset={result.data}
                presentation={presentationOf(result)}
                width={CHART_WIDTH}
                height={CHART_HEIGHT}
              />
            </div>
          )}
        </QSpecResource>
      </Suspense>
    </QSpecProvider>
  );
}

// --- Rendering helpers (see use-qspec-query.test.tsx for why act is awaited) -

/**
 * `render()` itself, awaited inside `act()`. React 19 warns — and the retry
 * this file depends on silently never fires, producing a HANG rather than a
 * failure — when a component suspends during a `render()` call that was not
 * itself awaited inside `act(async () => ...)`. Every render here mounts a
 * tree that suspends immediately (the query has to reach PostgreSQL first),
 * so every render here goes through this helper.
 */
async function renderSuspended(ui: ReactNode): Promise<ReturnType<typeof render>> {
  let utils: ReturnType<typeof render> | undefined;
  await act(async () => {
    utils = render(ui);
  });
  if (utils === undefined) throw new Error("render() did not run inside act()");
  return utils;
}

/** `rerender()`, awaited inside `act()` — the same requirement as `renderSuspended`, for updates. */
async function rerenderSuspended(rerender: (ui: ReactNode) => void, ui: ReactNode): Promise<void> {
  await act(async () => {
    rerender(ui);
  });
}

// --- SVG readers ------------------------------------------------------------

/**
 * The text Recharts renders for each tick on one axis, in DOM order. Reads
 * `textContent` off the tick `<text>` elements rather than their `<tspan>`
 * children so it does not depend on how Recharts nests them.
 *
 * Scoped to `.recharts-{x,y}Axis-tick-labels`, NOT to `.recharts-{x,y}Axis`:
 * Recharts renders an axis's tick LINES inside the axis group but hoists its
 * tick LABELS into a separate z-index layer near the end of the `<svg>`, so
 * a query rooted at the axis group finds every tick line and not one label.
 * Both throws below exist because of that: an empty result from a wrong
 * selector is indistinguishable from an axis that genuinely rendered
 * nothing, and this file's assertions are only meaningful if the labels were
 * actually found.
 */
function axisTickTexts(root: ParentNode, axis: "xAxis" | "yAxis"): string[] {
  const labels = root.querySelector(`.recharts-${axis}-tick-labels`);
  if (labels === null) throw new Error(`the chart rendered no .recharts-${axis}-tick-labels`);
  // `Array.from`, not a spread: this repo's test tsconfig declares
  // `lib: ["ES2022", "DOM"]` with no `DOM.Iterable`, so a `NodeList` is
  // ArrayLike but not iterable as far as the typechecker is concerned.
  const ticks = Array.from(labels.querySelectorAll(".recharts-cartesian-axis-tick-value"));
  if (ticks.length === 0) throw new Error(`the chart's ${axis} rendered no tick labels`);
  return ticks.map((tick) => tick.textContent ?? "");
}

/** One `<circle class="recharts-line-dot">` per plotted point — the "mark per row" this file counts. */
function lineDots(root: ParentNode): readonly Element[] {
  return Array.from(root.querySelectorAll(".recharts-line-dot"));
}

/** Each dot's vertical pixel position, which is the only place a point's y VALUE shows up in the SVG. */
function dotCentreYs(root: ParentNode): number[] {
  return lineDots(root).map((dot) => Number(dot.getAttribute("cy")));
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

    // Interpolated into SQL text -- ordinarily forbidden in this codebase
    // (SPEC.md §72.2), but acceptable here specifically because every value
    // is a fixed literal this file authored, not manifest- or caller-supplied
    // data. Fixture setup, not the pipeline under test.
    const values = SALES_ROWS.map(
      ([id, month, occurredOn, revenue]) => `(${id}, '${month}', DATE '${occurredOn}', ${revenue})`,
    ).join(",\n        ");
    await admin.query(`
      CREATE TABLE sales (
        id          bigint PRIMARY KEY,
        month       text NOT NULL,
        occurred_on date NOT NULL,
        revenue     integer NOT NULL
      );
      INSERT INTO sales (id, month, occurred_on, revenue) VALUES
        ${values};
    `);

    // The server: its own runtime, holding its own credentials, and the one
    // manifest it is willing to execute.
    runtime = createQSpec()
      .use(sql())
      .use(postgres({ sources: { [SOURCE]: { connectionString: connectionUri() } } }))
      .use(transforms())
      .use(charts());
    await runtime.ready();

    const handler = createQSpecHandler({ runtime, manifests: { [RESOURCE]: manifestJson() } });

    // The client: a URL and nothing else. `fetchViaHandler` stands in for
    // the network between them.
    executor = createHttpExecutor({ url: ENDPOINT, fetch: fetchViaHandler(handler) });
  });

  afterAll(async () => {
    try {
      await runtime?.dispose();
    } finally {
      try {
        await admin?.end();
      } finally {
        await container?.stop();
      }
    }
  });

  // Each test mounts its own provider (and therefore its own query cache),
  // so each starts from an empty wire log rather than counting round trips
  // relative to whatever ran before it.
  beforeEach(() => {
    requestBodies.length = 0;
    responseBodies.length = 0;
    consoleErrorCalls.length = 0;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      // Record, never throw -- React invokes `console.error` from deep
      // inside its own commit-phase internals, and a throw from inside this
      // mock does not propagate through the test's `await act(...)` the way
      // a normal synchronous throw would. It instead surfaces as vitest's
      // own "Unhandled Errors" for the whole run, detached from whichever
      // `it(...)` was running (see packages/react/src/internal/
      // use-qspec-query.test.tsx's `mockConsoleError` for the same finding).
      // Asserting on the recording afterward, in `afterEach` below, produces
      // a normal, attributable `AssertionError` on the right test instead.
      consoleErrorCalls.push(
        args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "),
      );
    });
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
    // None of this file's three tests exercises a caught-error path (that is
    // packages/react/src/internal/use-qspec-query.test.tsx's job) -- every
    // render here either suspends to a settled DOM or re-fetches cleanly. So
    // unlike that file's `mockConsoleError`, which asserts every call
    // contains an *expected* fragment, this asserts there were no calls at
    // all: the "pristine output" this suite's tests rely on (no stray React
    // warning, no swallowed rejection) is a real, checked claim here, not a
    // one-time observation from when this file was written.
    expect(consoleErrorCalls, "unexpected console.error call(s)").toEqual([]);
  });

  it("suspends, then renders one Recharts mark per row PostgreSQL returned, after the transforms", async () => {
    await renderSuspended(<Dashboard from={FIRST_RANGE.from} to={FIRST_RANGE.to} />);

    // The query really is in flight: `getByTestId` throws if the fallback is
    // missing, and the chart genuinely is not in the DOM yet. Asserting the
    // fallback appeared is NOT the point of this test (a broken promise
    // cache suspends forever and would pass such a test) -- the settled DOM
    // below is.
    screen.getByTestId("fallback");
    expect(screen.queryByTestId("chart")).toBeNull();

    const chart = await screen.findByTestId("chart");

    // Three marks: one per row that survived filter (revenue > 0) and
    // limit(3) -- not the eight rows in `sales`, and not the six inside the
    // queried date range before the transforms ran.
    //
    // This "3" is pinned by the manifest's `limit(3)` transform, not by how
    // many rows PostgreSQL actually returned for this date range (six, once
    // the zero-revenue row is filtered out). It would read 3 even if the
    // `:from`/`:to` bindings were silently ignored and every row in `sales`
    // matched -- `limit(3)` still caps the output the same way. Row
    // provenance -- that these are genuinely PostgreSQL's rows, correctly
    // filtered, derived, and sorted -- is what the x-axis assertion below
    // proves, not this count. Do not weaken that x-axis assertion under the
    // assumption that this length check already guards it.
    expect(lineDots(chart)).toHaveLength(3);

    // The x axis carries the month values PostgreSQL stored, in the order
    // the SORT transform produced (bonus descending: 20, 10, 5) -- NOT the
    // `ORDER BY id` order the statement asked PostgreSQL for, which would
    // read 2026-01, 2026-02, 2026-03. This assertion therefore fails if the
    // sort transform is skipped, and it fails if the filter or the limit is,
    // since either would put a different month in a different slot.
    expect(axisTickTexts(chart, "xAxis")).toEqual(["2026-03", "2026-01", "2026-02"]);

    // The y axis is scaled to the DERIVED field, not the queried one: the
    // top of the domain is around 20 (bonus), not 200 (revenue). A range,
    // not an exact tick value -- asserting Recharts "nices" a [0, 20] domain
    // to a tick landing on exactly 20 pins a tick-algorithm detail this test
    // has no stake in and would break on a harmless Recharts upgrade. What
    // this test actually cares about -- the derive transform ran, and it
    // produced bonus rather than raw revenue -- is captured just as
    // precisely by a range: >= 20 (the real top bonus value; a lower top
    // would mean derive didn't run or ran on the wrong field) and < 200 (if
    // the derive multiplier were dropped or inverted, the axis would scale
    // to raw revenue and top out at 200).
    const yTicks = axisTickTexts(chart, "yAxis");
    const topYTick = Number(yTicks.at(-1));
    expect(topYTick).toBeGreaterThanOrEqual(20);
    expect(topYTick).toBeLessThan(200);

    // The three marks sit at three distinct heights, descending in value
    // (20 > 10 > 5) and therefore ascending in SVG y pixels -- so the marks
    // carry per-row values, rather than three points flattened onto one
    // line by a dataKey that resolved to `undefined`.
    const ys = dotCentreYs(chart);
    expect(ys).toHaveLength(3);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(3);

    // Exactly one round trip for one mounted query.
    expect(requestBodies).toHaveLength(1);
  });

  it("carries no SQL, connection string, or password to the client", async () => {
    await renderSuspended(<Dashboard from={FIRST_RANGE.from} to={FIRST_RANGE.to} />);
    await screen.findByTestId("chart");

    const sent = requestBodies.at(-1);
    const received = responseBodies.at(-1);
    if (sent === undefined || received === undefined) {
      throw new Error("no request/response pair was recorded");
    }

    // What the browser sent, in full. Not "contains a resource" -- exactly
    // this and nothing else, so a future field carrying a statement, a
    // source configuration, or anything else would fail here rather than
    // slip past a looser check.
    // The exact `toEqual` above already fails on any extra key -- Vitest's
    // `toEqual` rejects an object with additional own properties, not just
    // mismatched values on the keys it names -- so a separate sorted-keys
    // check here could never fail without that assertion having failed
    // first. Omitted rather than kept as inert ceremony.
    expect(JSON.parse(sent)).toEqual({
      resource: RESOURCE,
      parameters: { from: FIRST_RANGE.from, to: FIRST_RANGE.to },
    });

    // Everything the server-side manifest and configuration contain that the
    // client must never learn. Checked against the request body (what the
    // browser sends), the response body (what the browser is told), and the
    // rendered DOM (what a user, or anything reading `document.body`, can
    // see) -- all three, because a leak on any one of them is a leak.
    const secrets = [
      DB_PASSWORD,
      DB_USER,
      DB_NAME,
      connectionUri(),
      "SELECT",
      "FROM sales",
      "occurred_on",
      ":from",
      "$parameters.from",
    ];
    const dom = document.body.innerHTML;
    for (const secret of secrets) {
      expect(sent, `request body leaked ${secret}`).not.toContain(secret);
      expect(received, `response body leaked ${secret}`).not.toContain(secret);
      expect(dom, `rendered DOM leaked ${secret}`).not.toContain(secret);
    }

    // The response is not empty of everything -- it carries the rows, so the
    // negatives above are about what is absent from a real payload, not
    // about an empty one. `meta.query` names the source and the language
    // and nothing else (see test/postgres-pipeline.test.ts).
    expect(received).toContain("2026-03");
    expect(JSON.parse(received)).toMatchObject({
      ok: true,
      result: { meta: { query: { source: SOURCE, language: "sql" } } },
    });
  });

  it("changing a parameter re-executes against PostgreSQL and updates the chart", async () => {
    const { rerender } = await renderSuspended(
      <Dashboard from={FIRST_RANGE.from} to={FIRST_RANGE.to} />,
    );
    const first = await screen.findByTestId("chart");
    expect(axisTickTexts(first, "xAxis")).toEqual(["2026-03", "2026-01", "2026-02"]);
    const callsAfterFirst = requestBodies.length;

    await rerenderSuspended(rerender, <Dashboard from={SECOND_RANGE.from} to={SECOND_RANGE.to} />);

    // `waitFor` on the NEW axis values, not `findByTestId` on the chart:
    // React 19 hides an already-committed suspended subtree with
    // `display: none` rather than unmounting it, so a `findBy*` query
    // resolves instantly against the STALE node and would happily assert
    // the pre-change chart. Retrying until the axis itself reads the new
    // months is the only form of this assertion that cannot pass on stale
    // DOM.
    //
    // Left at `waitFor`'s default 1s polling timeout, deliberately not
    // raised to match this file's 120s per-test timeout (set for container
    // startup, not for a single query): a parameter-change round trip
    // against a local PostgreSQL container settles in well under a second in
    // practice, so a genuine failure to re-fetch (a broken cache key, a
    // refetch that never fires) should fail this test in about a second, not
    // block the run for two minutes waiting out a timeout sized for
    // something else entirely.
    await waitFor(() => {
      expect(axisTickTexts(screen.getByTestId("chart"), "xAxis")).toEqual([
        "2026-04",
        "2026-03",
        "2026-01",
      ]);
    });

    // Row 8 (2026-04, revenue 400) is inside the widened range and its
    // bonus, 40, tops the sort -- so the y domain grew with it. Row 1
    // (2025-12, bonus 90) is still outside the range at the other end and
    // still absent, which is what rules out "the widened range simply
    // matched everything".
    // The exact-array assertion inside `waitFor` above already pins the
    // x axis to `["2026-04", "2026-03", "2026-01"]`, which by construction
    // excludes "2025-12" -- a separate `not.toContain` here could not fail
    // without that assertion having failed first, so it is omitted rather
    // than kept as inert ceremony.
    const updated = screen.getByTestId("chart");
    expect(lineDots(updated)).toHaveLength(3);
    // A range, not an exact tick value -- the same reasoning as the first
    // test's y-tick assertion above: >= 40 (the real top bonus value, from
    // row 8) and < 400 (where the axis would top out if the derive
    // transform's 0.1 multiplier were dropped or inverted and the chart
    // scaled to raw revenue instead). An exact `toBe("40")` here would pin a
    // Recharts tick-nicing detail this test has no stake in, and would
    // undermine the point of the first fix by leaving the exact same
    // fragility three tests later.
    const yTicks = axisTickTexts(updated, "yAxis");
    const topYTick = Number(yTicks.at(-1));
    expect(topYTick).toBeGreaterThanOrEqual(40);
    expect(topYTick).toBeLessThan(400);

    // A second round trip actually happened -- the new chart came from
    // PostgreSQL, not from the cache re-rendering the first result.
    expect(requestBodies).toHaveLength(callsAfterFirst + 1);
    const secondRequest = requestBodies.at(-1);
    if (secondRequest === undefined) throw new Error("no second request was recorded");
    expect(JSON.parse(secondRequest)).toEqual({
      resource: RESOURCE,
      parameters: { from: SECOND_RANGE.from, to: SECOND_RANGE.to },
    });
  });
});
