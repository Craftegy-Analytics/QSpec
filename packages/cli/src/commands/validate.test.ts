import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  UnknownDataSourceError,
  UnknownQueryLanguageError,
  UnknownResourceKindError,
} from "@qspecs/core";
import { STUB_SOURCE_EXECUTE_MESSAGE } from "../internal/stub-source.js";
import { runValidate, toIssues } from "./validate.js";

async function fileWith(content: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qspec-cli-"));
  const path = join(directory, "manifest.qspec.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function capture() {
  const lines: string[] = [];
  return {
    io: {
      out: (text: string) => lines.push(text),
      err: (text: string) => lines.push(text),
      color: false,
    },
    text: () => lines.join("\n"),
  };
}

const valid = {
  apiVersion: "qspec.dev/v1",
  kind: "Chart",
  metadata: { name: "monthly-revenue" },
  spec: {},
};

describe("runValidate", () => {
  it("exits 0 and reports the resource for a valid manifest", async () => {
    const { io, text } = capture();
    expect(await runValidate([await fileWith(valid)], io)).toBe(0);
    expect(text()).toContain("Valid QSpec manifest");
    expect(text()).toContain("API version: qspec.dev/v1");
    expect(text()).toContain("Kind: Chart");
    expect(text()).toContain("Name: monthly-revenue");
  });

  it("exits 1 and prints the path and message for an invalid manifest", async () => {
    const { io, text } = capture();
    const path = await fileWith({ ...valid, metadata: { name: "Monthly Revenue" } });
    expect(await runValidate([path], io)).toBe(1);
    expect(text()).toContain("Invalid QSpec manifest");
    expect(text()).toContain("metadata.name");
  });

  it("prints a did-you-mean line when a suggestion exists", async () => {
    const { io, text } = capture();
    const path = await fileWith({ ...valid, metadata: { name: "Monthly Revenue" } });
    await runValidate([path], io);
    expect(text()).toMatch(/Did you mean "monthly-revenue"\?/);
  });

  it("emits no ANSI escapes when color is disabled", async () => {
    const { io, text } = capture();
    await runValidate([await fileWith(valid)], io);
    expect(text()).not.toContain("\u001B[");
  });

  it("exits 1 for malformed JSON without throwing", async () => {
    const { io, text } = capture();
    expect(await runValidate([await fileWith("{ not json")], io)).toBe(1);
    expect(text()).toContain("not valid JSON");
  });

  it("exits 1 for a missing file and names it", async () => {
    const { io, text } = capture();
    expect(await runValidate(["/no/such/file.json"], io)).toBe(1);
    expect(text()).toContain("/no/such/file.json");
  });

  it("validates several files and fails if any fails", async () => {
    const { io } = capture();
    const good = await fileWith(valid);
    const bad = await fileWith({ ...valid, metadata: {} });
    expect(await runValidate([good, bad], io)).toBe(1);
  });

  it("still reports the valid file when a sibling is invalid", async () => {
    const { io, text } = capture();
    await runValidate([await fileWith(valid), await fileWith({ ...valid, metadata: {} })], io);
    expect(text()).toContain("Valid QSpec manifest");
    expect(text()).toContain("Invalid QSpec manifest");
  });

  it("requires at least one path", async () => {
    const { io, text } = capture();
    expect(await runValidate([], io)).toBe(2);
    expect(text()).toContain("Usage");
  });

  it("does not report a validator mismatch for a manifest both validators accept", async () => {
    const { io, text } = capture();
    await runValidate([await fileWith(valid)], io);
    expect(text()).not.toContain("validator mismatch");
  });
});

/**
 * The gap `docs/known-gaps.md` named: `validateManifestStructure` is
 * registry-free by design, so it cannot see a malformed `filter.where`, an
 * unknown transform operator, or a typo'd SQL binding — that validation
 * lives in plugin `validate()` hooks and only runs during `prepare()`. With
 * `--config`, `runValidate` loads plugins and calls `prepare()` (against a
 * stub data source, never a real one) so those defects surface too.
 *
 * `@qspecs/sql`, `@qspecs/transforms`, and `@qspecs/charts` are devDependencies
 * of `@qspecs/cli` (see package.json) — never runtime `dependencies` — for
 * exactly this reason: a *test* may load them to build a `--config` module,
 * but the CLI itself must not carry a runtime dependency on any plugin
 * package. The config module below is real, on-disk, dynamically imported
 * `loadConfig` code — the same path a real user's `--config` file takes.
 */
describe("runValidate — plugin-aware (--config)", () => {
  // The exact message `createStubSource`'s execute() throws, imported rather
  // than hand-copied so this can never silently drift from the real string
  // stub-source.test.ts pins independently. Its presence anywhere in captured
  // output is proof the stub was actually invoked — plugin-aware validation
  // must call prepare() only, never execute().
  const STUB_EXECUTED = STUB_SOURCE_EXECUTE_MESSAGE;

  async function configModulePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "qspec-cli-config-"));
    const path = join(directory, "qspec.config.mjs");
    await writeFile(
      path,
      [
        'import { sql } from "@qspecs/sql";',
        'import { transforms } from "@qspecs/transforms";',
        'import { charts } from "@qspecs/charts";',
        "export const plugins = [sql(), transforms(), charts()];",
      ].join("\n"),
    );
    return path;
  }

  const datasetSchema = {
    fields: {
      amount: { type: "number" },
      region: { type: "string" },
    },
  };

  const validPluginManifest = {
    apiVersion: "qspec.dev/v1",
    kind: "Chart",
    metadata: { name: "valid-plugin-chart" },
    spec: {
      query: {
        source: "analytics",
        language: "sql",
        statement: "select region, amount from orders",
      },
      dataset: datasetSchema,
      presentation: {
        type: "bar",
        x: { field: "region" },
        series: [{ field: "amount" }],
      },
    },
  };

  const structurallyInvalid = { ...valid, metadata: { name: "Monthly Revenue" } };

  function nestedNot(levels: number): unknown {
    let expression: unknown = { field: "amount" };
    for (let i = 0; i < levels; i++) expression = { operator: "not", arguments: [expression] };
    return expression;
  }

  const filterUnknownOperator = {
    apiVersion: "qspec.dev/v1",
    kind: "Dataset",
    metadata: { name: "filter-unknown-operator" },
    spec: {
      dataset: datasetSchema,
      transforms: [{ type: "filter", where: { field: "amount", operator: "btwn", value: 5 } }],
    },
  };

  const filterTooDeep = {
    apiVersion: "qspec.dev/v1",
    kind: "Dataset",
    metadata: { name: "filter-too-deep" },
    spec: {
      dataset: datasetSchema,
      transforms: [{ type: "filter", where: nestedNot(40) }],
    },
  };

  const sqlTypoBinding = {
    apiVersion: "qspec.dev/v1",
    kind: "Dataset",
    metadata: { name: "sql-typo-binding" },
    spec: {
      query: {
        source: "analytics",
        language: "sql",
        statement: "select * from orders where created_at > :form",
        bindings: { from: { literal: "2024-01-01" } },
      },
    },
  };

  const deriveUnknownField = {
    apiVersion: "qspec.dev/v1",
    kind: "Dataset",
    metadata: { name: "derive-unknown-field" },
    spec: {
      dataset: datasetSchema,
      transforms: [
        {
          type: "derive",
          field: "amountDoubled",
          fieldType: "number",
          expression: {
            operator: "multiply",
            arguments: [{ field: "amount_typo" }, { literal: 2 }],
          },
        },
      ],
    },
  };

  const chartSeriesProjectedAway = {
    apiVersion: "qspec.dev/v1",
    kind: "Chart",
    metadata: { name: "chart-series-projected-away" },
    spec: {
      query: {
        source: "analytics",
        language: "sql",
        statement: "select region, amount from orders",
      },
      dataset: datasetSchema,
      transforms: [{ type: "select", fields: ["amount"] }],
      presentation: {
        type: "bar",
        x: { field: "amount" },
        series: [{ field: "region" }],
      },
    },
  };

  const gapCases: ReadonlyArray<{
    readonly name: string;
    readonly manifest: unknown;
    readonly failureText: string;
  }> = [
    {
      name: "filter transform with an unknown operator",
      manifest: filterUnknownOperator,
      failureText: 'Unknown operator "btwn"',
    },
    {
      name: "filter expression nested past maxExpressionDepth",
      manifest: filterTooDeep,
      failureText: "exceeds the configured maximum depth",
    },
    {
      name: "SQL statement with a typo'd binding",
      manifest: sqlTypoBinding,
      failureText: 'references parameter ":form"',
    },
    {
      name: "derive transform referencing a nonexistent dataset field",
      manifest: deriveUnknownField,
      failureText: "amount_typo",
    },
    {
      name: "chart series naming a field the transforms project away",
      manifest: chartSeriesProjectedAway,
      failureText: 'Unknown dataset field "region"',
    },
  ];

  describe.each(gapCases)("$name", ({ manifest, failureText }) => {
    it("passes qspec validate without --config (the gap was real)", async () => {
      const { io, text } = capture();
      const path = await fileWith(manifest);
      expect(await runValidate([path], io)).toBe(0);
      expect(text()).toContain("Valid QSpec manifest");
      expect(text()).not.toContain(STUB_EXECUTED);
    });

    it("fails qspec validate --config <path> (the gap is closed)", async () => {
      const { io, text } = capture();
      const path = await fileWith(manifest);
      const configPath = await configModulePath();
      expect(await runValidate([path], io, { configPath })).toBe(1);
      expect(text()).toContain("Invalid QSpec manifest");
      expect(text()).toContain(failureText);
      expect(text()).not.toContain(STUB_EXECUTED);
    });
  });

  it("a valid manifest passes both without and with --config", async () => {
    const withoutConfig = capture();
    const pathA = await fileWith(validPluginManifest);
    const withoutConfigExitCode = await runValidate([pathA], withoutConfig.io);
    expect(withoutConfig.text()).toContain("Valid QSpec manifest");
    expect(withoutConfigExitCode).toBe(0);

    const withConfig = capture();
    const pathB = await fileWith(validPluginManifest);
    const configPath = await configModulePath();
    // The stub-execute check runs before the exit-code check: this is the
    // manifest that fully clears prepare(), so it is one of the only two
    // tests in this file where a stray execute() call would actually have
    // something to be caught by. Asserting the exit code first would let a
    // regression here fail on "expected 1 to be 0" instead — a real failure,
    // but one that would never prove this specific assertion has teeth.
    const withConfigExitCode = await runValidate([pathB], withConfig.io, { configPath });
    expect(withConfig.text()).not.toContain(STUB_EXECUTED);
    expect(withConfig.text()).toContain("Valid QSpec manifest");
    expect(withConfigExitCode).toBe(0);
  });

  it("a structural failure produces the same diagnostic with or without --config, not a doubled one", async () => {
    // Same path in both calls, so the only variable between the two captured
    // outputs is whether --config was passed.
    const path = await fileWith(structurallyInvalid);

    const withoutConfig = capture();
    expect(await runValidate([path], withoutConfig.io)).toBe(1);

    const withConfig = capture();
    const configPath = await configModulePath();
    expect(await runValidate([path], withConfig.io, { configPath })).toBe(1);

    // Same single diagnostic in both modes: prepare() never runs for a
    // manifest that already failed structural validation, so there is
    // nothing for a second failure to pile onto.
    expect(withConfig.text()).toBe(withoutConfig.text());
    expect(withoutConfig.text().match(/Invalid QSpec manifest/g)).toHaveLength(1);
    expect(withConfig.text()).not.toContain(STUB_EXECUTED);
  });

  it("loading several manifests that share one source name registers the stub only once", async () => {
    const { io, text } = capture();
    const pathA = await fileWith(validPluginManifest);
    const pathB = await fileWith({
      ...validPluginManifest,
      metadata: { name: "valid-plugin-chart-2" },
    });
    const configPath = await configModulePath();
    // Same ordering rationale as above: both manifests here fully clear
    // prepare(), so this is the other of the two tests where the stub-execute
    // assertion is actually load-bearing rather than unreachable.
    const exitCode = await runValidate([pathA, pathB], io, { configPath });
    expect(text()).not.toContain(STUB_EXECUTED);
    expect(text().match(/Valid QSpec manifest/g)).toHaveLength(2);
    expect(exitCode).toBe(0);
  });

  it("fails with a clear diagnostic when --config points at a missing file", async () => {
    const { io, text } = capture();
    const path = await fileWith(validPluginManifest);
    expect(await runValidate([path], io, { configPath: "/no/such/qspec.config.mjs" })).toBe(1);
    expect(text()).toContain("Cannot load config");
    expect(text()).toContain("/no/such/qspec.config.mjs");
  });
});

describe("toIssues", () => {
  // These three errors keep their hint in `details.suggestion` rather than in a
  // QSpecIssue, so a renderer that reads only `issue.suggestion` never shows
  // them. Each case asserts the hint and the error's own path survive.
  it("lifts the hint and path off an unknown resource kind", () => {
    const error = new UnknownResourceKindError('Unknown resource kind "Chrat".', {
      suggestion: "Chart",
    });
    expect(toIssues(error)).toEqual([
      {
        code: "QSPEC_RESOURCE_KIND_UNKNOWN",
        message: 'Unknown resource kind "Chrat".',
        path: ["kind"],
        suggestion: "Chart",
      },
    ]);
  });

  it("lifts the hint and path off an unknown query language", () => {
    const error = new UnknownQueryLanguageError('Unknown query language "sqll".', {
      suggestion: "sql",
    });
    expect(toIssues(error)[0]).toMatchObject({
      path: ["spec", "query", "language"],
      suggestion: "sql",
    });
  });

  it("lifts the hint and path off an unknown data source", () => {
    const error = new UnknownDataSourceError('Unknown data source "analitycs".', {
      suggestion: "analytics",
    });
    expect(toIssues(error)[0]).toMatchObject({
      path: ["spec", "query", "source"],
      suggestion: "analytics",
    });
  });

  it("omits the suggestion when the error carries no hint", () => {
    const issue = toIssues(new UnknownResourceKindError('Unknown resource kind "Zzz".'))[0];
    expect(issue).toBeDefined();
    expect(issue).not.toHaveProperty("suggestion");
  });

  it("passes an aggregate error's own issues through untouched", () => {
    const issues = [{ code: "X", message: "m", path: ["a", 0] }];
    expect(toIssues(new ManifestValidationError("bad", { issues }))).toBe(issues);
  });

  it("falls back to a root-path issue for a non-QSpec error", () => {
    expect(toIssues(new Error("boom"))).toEqual([
      { code: "QSPEC_MANIFEST_INVALID", message: "boom", path: [] },
    ]);
  });
});
