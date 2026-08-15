// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Dataset,
  Field,
  PresentationDefinition,
  PresentationType,
  Registry,
} from "@qspecs/core";
import { DEFAULT_LIMITS } from "@qspecs/core";
import type { QSpecPluginAPI } from "@qspecs/core";
import { charts } from "@qspecs/charts";
import { QSpecChart } from "./qspec-chart.js";

// See cartesian.test.tsx for why no act(async () => ...) / controlled
// executor / error boundary is needed here.
afterEach(cleanup);

/**
 * A minimal `Registry<T>` double. `@qspecs/core`'s real implementation
 * (`createRegistry`) is internal and not exported — this conforms to the
 * same public `Registry<T>` contract `charts()`'s `setup()` is written
 * against, which is all a spy needs. `list()` sorts, matching `Registry`'s
 * documented "sorted, for deterministic diagnostics" contract.
 */
function fakeRegistry<T>(): Registry<T> {
  const entries = new Map<string, T>();
  return {
    register(name, implementation) {
      entries.set(name, implementation);
    },
    replace(name, implementation) {
      entries.set(name, implementation);
    },
    get(name) {
      return entries.get(name);
    },
    has(name) {
      return entries.has(name);
    },
    list() {
      return [...entries.keys()].sort();
    },
  };
}

/**
 * Every presentation type `charts()` registers, derived by actually running
 * its `setup()` against a spy `QSpecPluginAPI` and reading back what landed
 * in the presentations registry — not a second, hand-maintained copy of
 * `["line", "bar", "area", "scatter", "pie"]`. `createQSpec()` + `.use()` +
 * `.ready()` was the other candidate here, but the public `QSpec` interface
 * (`on`/`use`/`ready`/`prepare`/`execute`/`dispose`) never hands the
 * installed registries back out, so there would be no way to read this list
 * off a real runtime without a third mechanism anyway (e.g. attempting to
 * `prepare()` a manifest per type and reading the failure/success). Calling
 * `setup()` directly against a spy registry is the more direct route to the
 * same fact: "what did charts() register?"
 */
async function registeredPresentationTypes(): Promise<readonly string[]> {
  const presentations = fakeRegistry<PresentationType>();
  const api: QSpecPluginAPI = {
    queryLanguages: fakeRegistry(),
    sources: fakeRegistry(),
    transforms: fakeRegistry(),
    semanticTypes: fakeRegistry(),
    resources: fakeRegistry(),
    presentations,
    renderers: fakeRegistry(),
    hooks: { on: () => () => {} },
    logger: {},
    limits: DEFAULT_LIMITS,
  };
  await charts().setup(api);
  return presentations.list();
}

const fields: Field[] = [
  { name: "month", type: "string" },
  { name: "revenue", type: "number" },
  { name: "cost", type: "number" },
];

function dataset(rows: Record<string, unknown>[]): Dataset {
  return { fields: fields.map((f) => ({ ...f })), rows };
}

interface Fixture {
  readonly dataset: Dataset;
  readonly presentation: PresentationDefinition;
}

/**
 * One renderable fixture per presentation type this package knows how to
 * render. Necessarily hand-maintained — there is no way to derive a VALID
 * example presentation for an arbitrary registered type without knowing its
 * shape — but its staleness IS detectable: the sweep test below fails
 * loudly, naming the type, the moment `registeredPresentationTypes()`
 * returns a type this map has no entry for. See the task report for the
 * falsification that proves this (a type registered with neither a fixture
 * here nor a case in `QSpecChart`'s switch fails this test, rather than
 * being silently skipped).
 */
const FIXTURES = new Map<string, Fixture>([
  [
    "line",
    {
      dataset: dataset([{ month: "Jan", revenue: 10, cost: 5 }]),
      presentation: { type: "line", x: { field: "month" }, series: [{ field: "revenue" }] },
    },
  ],
  [
    "bar",
    {
      dataset: dataset([{ month: "Jan", revenue: 10, cost: 5 }]),
      presentation: { type: "bar", x: { field: "month" }, series: [{ field: "revenue" }] },
    },
  ],
  [
    "area",
    {
      dataset: dataset([{ month: "Jan", revenue: 10, cost: 5 }]),
      presentation: { type: "area", x: { field: "month" }, series: [{ field: "revenue" }] },
    },
  ],
  [
    "scatter",
    {
      dataset: dataset([{ month: "Jan", revenue: 10, cost: 5 }]),
      presentation: { type: "scatter", x: { field: "revenue" }, series: [{ field: "cost" }] },
    },
  ],
  [
    "pie",
    {
      dataset: dataset([{ month: "Jan", revenue: 10, cost: 5 }]),
      presentation: { type: "pie", category: { field: "month" }, value: { field: "revenue" } },
    },
  ],
]);

describe("QSpecChart — presentation-type completeness sweep", () => {
  it("renders every presentation type charts() registers, deriving the list from the registry itself", async () => {
    const types = await registeredPresentationTypes();

    // Guards the sweep itself against a broken spy silently turning this
    // into a vacuous pass over zero types.
    expect(types.length).toBeGreaterThan(0);

    for (const type of types) {
      const fixture = FIXTURES.get(type);
      expect(
        fixture,
        `charts() registers presentation type "${type}" but @qspecs/recharts has no test fixture (and, if this is genuinely new, likely no QSpecChart case) for it.`,
      ).toBeDefined();
      if (fixture === undefined) continue; // Unreachable given the assertion above; narrows for TS.

      const { container } = render(
        <QSpecChart
          dataset={fixture.dataset}
          presentation={fixture.presentation}
          width={300}
          height={300}
        />,
      );
      expect(
        container.querySelector("svg"),
        `presentation type "${type}" rendered no svg`,
      ).not.toBeNull();
      cleanup();
    }
  });
});

describe("QSpecChart — unrecognized presentation type", () => {
  it("throws a loud, named error rather than rendering nothing", () => {
    const data = dataset([{ month: "Jan", revenue: 10, cost: 5 }]);
    const unknownPresentation: PresentationDefinition = { type: "donut" };

    expect(() =>
      render(
        <QSpecChart dataset={data} presentation={unknownPresentation} width={300} height={300} />,
      ),
    ).toThrow(/donut/);
  });
});
