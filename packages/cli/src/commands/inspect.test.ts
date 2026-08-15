import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInspect } from "./inspect.js";
import type { CliIo } from "./validate.js";

async function fileWith(content: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qspec-cli-inspect-"));
  const path = join(directory, "manifest.qspec.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function capture(json = false) {
  const lines: string[] = [];
  return {
    io: {
      out: (text: string) => lines.push(text),
      err: (text: string) => lines.push(text),
      color: false,
      json,
    } satisfies CliIo,
    text: () => lines.join("\n"),
  };
}

/** The exact manifest behind SPEC.md §87's example output. */
const complete = {
  apiVersion: "qspec.dev/v1",
  kind: "Chart",
  metadata: { name: "monthly-revenue" },
  spec: {
    parameters: {
      from: { type: "date", required: true },
      to: { type: "date", required: true },
      country: { type: "string", required: false },
    },
    query: {
      source: "analytics",
      language: "sql",
      statement: "select month, revenue from monthly_revenue",
    },
    dataset: {
      fields: {
        month: { type: "datetime" },
        revenue: { type: "number", semanticType: "currency" },
      },
    },
    presentation: {
      type: "line",
      x: { field: "month" },
      series: [{ field: "revenue" }],
    },
  },
};

const EXPECTED_TEXT = [
  "Resource",
  "  Name: monthly-revenue",
  "  Kind: Chart",
  "  API: qspec.dev/v1",
  "",
  "Parameters",
  "  from       date      required",
  "  to         date      required",
  "  country    string    optional",
  "",
  "Query",
  "  Source: analytics",
  "  Language: sql",
  "",
  "Dataset",
  "  month      datetime",
  "  revenue    number/currency",
  "",
  "Presentation",
  "  Type: line",
  "  X: month",
  "  Series: revenue",
].join("\n");

describe("runInspect", () => {
  it("renders every section, with alignment, for a complete manifest (SPEC.md §87)", async () => {
    const { io, text } = capture();
    const path = await fileWith(complete);
    expect(await runInspect([path], io)).toBe(0);
    // Preceded by a per-file header (validate.ts's own convention); the
    // SPEC.md §87 block itself must still follow it verbatim.
    expect(text()).toBe(`✓ Valid QSpec manifest ${path}\n\n${EXPECTED_TEXT}`);
  });

  it("labels each block with its own file when inspecting several manifests", async () => {
    const other = {
      apiVersion: "qspec.dev/v1",
      kind: "Dataset",
      metadata: { name: "other-resource" },
      spec: { dataset: complete.spec.dataset },
    };
    const pathA = await fileWith(complete);
    const pathB = await fileWith(other);
    const { io, text } = capture();
    expect(await runInspect([pathA, pathB], io)).toBe(0);
    const output = text();
    expect(output).toContain(`Valid QSpec manifest ${pathA}`);
    expect(output).toContain(`Valid QSpec manifest ${pathB}`);
    expect(output).toContain("Name: monthly-revenue");
    expect(output).toContain("Name: other-resource");
    // The first file's header comes before its own Resource block, which
    // comes before the second file's header — i.e. blocks are not interleaved.
    expect(output.indexOf(pathA)).toBeLessThan(output.indexOf("Name: monthly-revenue"));
    expect(output.indexOf("Name: monthly-revenue")).toBeLessThan(output.indexOf(pathB));
  });

  it("omits the Parameters section, not an empty heading, when there are no parameters", async () => {
    const manifest = {
      ...complete,
      spec: { ...complete.spec, parameters: undefined },
    };
    const { io, text } = capture();
    await runInspect([await fileWith(manifest)], io);
    expect(text()).not.toContain("Parameters");
  });

  it("omits the Presentation section for a Dataset-kind manifest with no presentation", async () => {
    const manifest = {
      apiVersion: "qspec.dev/v1",
      kind: "Dataset",
      metadata: { name: "monthly-revenue" },
      spec: {
        query: complete.spec.query,
        dataset: complete.spec.dataset,
      },
    };
    const { io, text } = capture();
    expect(await runInspect([await fileWith(manifest)], io)).toBe(0);
    expect(text()).toContain("Dataset");
    expect(text()).not.toContain("Presentation");
  });

  it("renders a required parameter as required and an optional one as optional", async () => {
    const { io, text } = capture();
    await runInspect([await fileWith(complete)], io);
    expect(text()).toContain("from       date      required");
    expect(text()).toContain("country    string    optional");
  });

  it("renders a field's semanticType as type/semanticType, and a plain type without it", async () => {
    const { io, text } = capture();
    await runInspect([await fileWith(complete)], io);
    expect(text()).toContain("revenue    number/currency");
    expect(text()).toContain("month      datetime");
    expect(text()).not.toContain("month      datetime/");
  });

  it("--json emits a one-element array whose values match the human output for the same manifest", async () => {
    const { io, text } = capture(true);
    const path = await fileWith(complete);
    expect(await runInspect([path], io)).toBe(0);
    const result: unknown = JSON.parse(text());
    expect(result).toEqual([
      {
        path,
        resource: { name: "monthly-revenue", kind: "Chart", apiVersion: "qspec.dev/v1" },
        parameters: [
          { name: "from", type: "date", required: true },
          { name: "to", type: "date", required: true },
          { name: "country", type: "string", required: false },
        ],
        query: { source: "analytics", language: "sql" },
        dataset: [
          { name: "month", type: "datetime" },
          { name: "revenue", type: "number", semanticType: "currency" },
        ],
        presentation: {
          type: "line",
          fieldReferences: [
            { path: ["x", "field"], field: "month" },
            { path: ["series", 0, "field"], field: "revenue" },
          ],
        },
      },
    ]);
  });

  it("--json emits a JSON array for multiple paths, one entry per manifest, in order", async () => {
    const other = {
      apiVersion: "qspec.dev/v1",
      kind: "Dataset",
      metadata: { name: "other-resource" },
      spec: { dataset: complete.spec.dataset },
    };
    const pathA = await fileWith(complete);
    const pathB = await fileWith(other);
    const { io, text } = capture(true);
    expect(await runInspect([pathA, pathB], io)).toBe(0);
    const result: unknown = JSON.parse(text());
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      {
        path: pathA,
        resource: { name: "monthly-revenue", kind: "Chart", apiVersion: "qspec.dev/v1" },
        parameters: [
          { name: "from", type: "date", required: true },
          { name: "to", type: "date", required: true },
          { name: "country", type: "string", required: false },
        ],
        query: { source: "analytics", language: "sql" },
        dataset: [
          { name: "month", type: "datetime" },
          { name: "revenue", type: "number", semanticType: "currency" },
        ],
        presentation: {
          type: "line",
          fieldReferences: [
            { path: ["x", "field"], field: "month" },
            { path: ["series", 0, "field"], field: "revenue" },
          ],
        },
      },
      {
        path: pathB,
        resource: { name: "other-resource", kind: "Dataset", apiVersion: "qspec.dev/v1" },
        parameters: [],
        dataset: [
          { name: "month", type: "datetime" },
          { name: "revenue", type: "number", semanticType: "currency" },
        ],
      },
    ]);
  });

  it("surfaces a grouped series' groupBy alongside its field, in both text and --json", async () => {
    // (SPEC.md §47; falsifies against the walker only recognizing `field`.)
    const manifest = {
      ...complete,
      spec: {
        ...complete.spec,
        presentation: {
          type: "line",
          x: { field: "month" },
          series: { field: "revenue", groupBy: "region" },
        },
      },
    };
    const path = await fileWith(manifest);

    const { io: textIo, text: textOut } = capture();
    await runInspect([path], textIo);
    expect(textOut()).toContain("Series: revenue, region");

    const { io: jsonIo, text: jsonOut } = capture(true);
    await runInspect([path], jsonIo);
    const result: unknown = JSON.parse(jsonOut());
    expect(result).toEqual([
      {
        path,
        resource: { name: "monthly-revenue", kind: "Chart", apiVersion: "qspec.dev/v1" },
        parameters: [
          { name: "from", type: "date", required: true },
          { name: "to", type: "date", required: true },
          { name: "country", type: "string", required: false },
        ],
        query: { source: "analytics", language: "sql" },
        dataset: [
          { name: "month", type: "datetime" },
          { name: "revenue", type: "number", semanticType: "currency" },
        ],
        presentation: {
          type: "line",
          fieldReferences: [
            { path: ["x", "field"], field: "month" },
            { path: ["series", "field"], field: "revenue" },
            { path: ["series", "groupBy"], field: "region" },
          ],
        },
      },
    ]);
  });

  it("exits non-zero with a diagnostic, not a stack trace, for a malformed manifest", async () => {
    const { io, text } = capture();
    const path = await fileWith({});
    const code = await runInspect([path], io);
    expect(code).not.toBe(0);
    expect(text()).not.toContain("TypeError");
    expect(text()).not.toContain("at ");
    expect(text()).toContain("metadata");
  });

  it("--json still exits non-zero for a manifest that fails structural validation, contributing no array entry", async () => {
    const { io, text } = capture(true);
    const path = await fileWith({});
    const code = await runInspect([path], io);
    expect(code).toBe(1);
    const lines = text().split("\n");
    const jsonStart = lines.findIndex((line) => line.startsWith("["));
    expect(JSON.parse(lines.slice(jsonStart).join("\n"))).toEqual([]);
    expect(lines.slice(0, jsonStart).join("\n")).toContain("metadata");
  });

  it("exits non-zero with a diagnostic for malformed JSON, not a stack trace", async () => {
    const { io, text } = capture();
    const code = await runInspect([await fileWith("{ not json")], io);
    expect(code).not.toBe(0);
    expect(text()).not.toContain("SyntaxError:");
    expect(text()).toContain("not valid JSON");
  });

  it("never loads a plugin or calls prepare(): succeeds inspecting a manifest whose transform references an uninstalled plugin", async () => {
    // @qspecs/transforms is not a dependency of @qspecs/cli (see package.json).
    // `filter` here names a transform type that plugin would provide; nothing
    // in this process can resolve it against a registry.
    const manifest = {
      ...complete,
      spec: {
        ...complete.spec,
        transforms: [{ type: "filter", where: { ">": [{ field: "revenue" }, 0] } }],
      },
    };
    const { io, text } = capture();
    expect(await runInspect([await fileWith(manifest)], io)).toBe(0);
    expect(text()).toContain("Resource");
    expect(text()).toContain("Presentation");
  });

  it("requires at least one path", async () => {
    const { io, text } = capture();
    expect(await runInspect([], io)).toBe(2);
    expect(text()).toContain("Usage");
  });
});
