import { readFile } from "node:fs/promises";
import {
  parseManifest,
  validateManifestStructure,
  type PathSegment,
  type PresentationDefinition,
  type QSpecManifest,
  type QSpecResourceSpec,
} from "@qspecs/core";
import { dim, green, red } from "../color.js";
import { printIssues, toIssues, type CliIo } from "./validate.js";

/** Column gap after the widest cell in a section's table. (SPEC.md §87) */
const COLUMN_GAP = 4;

interface ParameterRow {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

interface DatasetFieldRow {
  readonly name: string;
  readonly type: string;
  readonly semanticType?: string;
}

/** A dataset field reference found inside `spec.presentation`. */
interface PresentationFieldRef {
  readonly path: readonly PathSegment[];
  readonly field: string;
}

/**
 * What `qspec inspect` reports for one manifest. Shared by the
 * human-readable renderer and `--json` (via `InspectionEntry`, below), so
 * the two forms cannot say different things about the same manifest.
 */
export interface InspectionResult {
  readonly resource: { readonly name: string; readonly kind: string; readonly apiVersion: string };
  readonly parameters: readonly ParameterRow[];
  readonly query?: { readonly source: string; readonly language: string };
  readonly dataset: readonly DatasetFieldRow[];
  readonly presentation?: {
    readonly type: string;
    readonly fieldReferences: readonly PresentationFieldRef[];
  };
}

/**
 * One `--json` array element. `path` is what lets a script pair a result
 * back up with the file that produced it once more than one path is given —
 * `InspectionResult` alone has no such field, since the human renderer
 * already says which file it is via the per-file header line.
 */
export interface InspectionEntry extends InspectionResult {
  readonly path: string;
}

/**
 * Property names @qspecs/charts itself treats as dataset field references,
 * confirmed by reading its extractors rather than guessed: `field`
 * (cartesian's `x`/`series` entries, pie's `category`/`value` —
 * packages/charts/src/internal/cartesian.ts, pie.ts) and `groupBy` (a
 * grouped series' partitioning column — cartesian.ts:97-99 explains that
 * dropping it "would let a manifest grouping by a misspelled column pass").
 * This is every reference-bearing key that package's two presentation types
 * use; a third presentation type outside this repo could introduce another
 * one this generic walker would not know to look for.
 */
const REFERENCE_KEYS: ReadonlySet<string> = new Set(["field", "groupBy"]);

/**
 * Every dataset field reference nested inside a presentation value. Generic
 * by design: `inspect` never loads the presentation plugin that owns
 * `spec.presentation.type`, so it cannot call that plugin's own
 * `fieldReferences()` (SPEC.md §50, §87). Instead it recognizes the
 * convention every core presentation shape (`x`, `series`, `category`,
 * `value`, ...) shares — an object with a string `field` or `groupBy`
 * property, read structurally instead of through the plugin. A shape that
 * does not follow it simply contributes no references; this never throws on
 * unfamiliar or malformed presentation content, since presentation internals
 * beyond `type` are not otherwise structurally validated.
 */
function collectFieldReferences(
  value: unknown,
  path: readonly PathSegment[],
): readonly PresentationFieldRef[] {
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index) => collectFieldReferences(item, [...path, index]));
  }
  if (value === null || typeof value !== "object") return [];

  const refs: PresentationFieldRef[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (REFERENCE_KEYS.has(key) && typeof nested === "string") {
      refs.push({ path: [...path, key], field: nested });
      continue;
    }
    refs.push(...collectFieldReferences(nested, [...path, key]));
  }
  return refs;
}

function presentationFieldReferences(
  presentation: PresentationDefinition,
): readonly PresentationFieldRef[] {
  const refs: PresentationFieldRef[] = [];
  for (const [key, value] of Object.entries(presentation)) {
    if (key === "type") continue;
    refs.push(...collectFieldReferences(value, [key]));
  }
  return refs;
}

/**
 * Reads a manifest's static content into the shape both renderers share.
 * Never touches `spec.transforms`: transforms are not part of the inspect
 * output (SPEC.md §87 shows no such section) and inspecting them would
 * invite resolving them against a plugin registry, which `inspect`
 * deliberately never does.
 */
function inspect(manifest: QSpecManifest<QSpecResourceSpec>): InspectionResult {
  const spec = manifest.spec;

  const parameters: readonly ParameterRow[] =
    spec.parameters === undefined
      ? []
      : Object.entries(spec.parameters).map(([name, definition]) => ({
          name,
          type: definition.type,
          required: definition.required === true,
        }));

  const dataset: readonly DatasetFieldRow[] =
    spec.dataset === undefined
      ? []
      : Object.entries(spec.dataset.fields).map(([name, definition]) => ({
          name,
          type: definition.type,
          ...(definition.semanticType === undefined
            ? {}
            : { semanticType: definition.semanticType }),
        }));

  return {
    resource: {
      name: manifest.metadata.name,
      kind: manifest.kind,
      apiVersion: manifest.apiVersion,
    },
    parameters,
    ...(spec.query === undefined
      ? {}
      : { query: { source: spec.query.source, language: spec.query.language } }),
    dataset,
    ...(spec.presentation === undefined
      ? {}
      : {
          presentation: {
            type: spec.presentation.type,
            fieldReferences: presentationFieldReferences(spec.presentation),
          },
        }),
  };
}

/** Groups a flat reference list by its top-level presentation key, in first-seen order. */
function groupFieldReferences(
  refs: readonly PresentationFieldRef[],
): readonly { readonly label: string; readonly fields: readonly string[] }[] {
  const order: string[] = [];
  const byKey = new Map<string, string[]>();
  for (const ref of refs) {
    const key = ref.path[0];
    if (typeof key !== "string") continue;
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.push(ref.field);
  }
  return order.map((key) => ({
    label: key.length === 0 ? key : `${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    fields: byKey.get(key) ?? [],
  }));
}

function renderParameters(rows: readonly ParameterRow[]): readonly string[] {
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const typeWidth = Math.max(...rows.map((row) => row.type.length));
  return rows.map(
    (row) =>
      `  ${row.name.padEnd(nameWidth + COLUMN_GAP)}${row.type.padEnd(typeWidth + COLUMN_GAP)}${
        row.required ? "required" : "optional"
      }`,
  );
}

function renderDataset(rows: readonly DatasetFieldRow[]): readonly string[] {
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  return rows.map((row) => {
    const typeLabel = row.semanticType === undefined ? row.type : `${row.type}/${row.semanticType}`;
    return `  ${row.name.padEnd(nameWidth + COLUMN_GAP)}${typeLabel}`;
  });
}

/** Renders a manifest's inspection result exactly per SPEC.md §87. */
function renderHuman(result: InspectionResult): readonly string[] {
  const sections: (readonly string[])[] = [];

  sections.push([
    "Resource",
    `  Name: ${result.resource.name}`,
    `  Kind: ${result.resource.kind}`,
    `  API: ${result.resource.apiVersion}`,
  ]);

  if (result.parameters.length > 0) {
    sections.push(["Parameters", ...renderParameters(result.parameters)]);
  }

  if (result.query !== undefined) {
    sections.push([
      "Query",
      `  Source: ${result.query.source}`,
      `  Language: ${result.query.language}`,
    ]);
  }

  if (result.dataset.length > 0) {
    sections.push(["Dataset", ...renderDataset(result.dataset)]);
  }

  if (result.presentation !== undefined) {
    const lines = [`  Type: ${result.presentation.type}`];
    for (const group of groupFieldReferences(result.presentation.fieldReferences)) {
      lines.push(`  ${group.label}: ${group.fields.join(", ")}`);
    }
    sections.push(["Presentation", ...lines]);
  }

  return sections.flatMap((section, index) => (index === 0 ? section : ["", ...section]));
}

/**
 * Inspects one or more manifest files: prints resource identity, parameters,
 * query, dataset, and presentation exactly as declared. Reads the manifest
 * and nothing else — no plugins are loaded and `prepare()` is never called,
 * so this works whether or not the plugins a manifest's `transforms` or
 * `presentation` name are installed. (SPEC.md §87)
 *
 * `--json` always emits a single JSON array, one `InspectionEntry` per
 * manifest that parsed and validated successfully — even for one path. A
 * per-path branch (bare object for one file, array for several) would force
 * every script to inspect its own input before it could decide how to parse
 * the output; a fixed shape needs one code path regardless of argument
 * count. A manifest that fails to read, parse, or structurally validate
 * contributes no array entry — its diagnostic still goes to stderr via
 * `printIssues`/the read-error line below, and the process still exits
 * non-zero, so nothing is silently dropped.
 */
export async function runInspect(paths: readonly string[], io: CliIo): Promise<number> {
  if (paths.length === 0) {
    io.err("Usage: qspec inspect <manifest.json> [...] [--json]");
    return 2;
  }

  let failed = false;
  let printedAny = false;
  const entries: InspectionEntry[] = [];

  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      failed = true;
      io.err(
        `${red("✗ Cannot read", io.color)} ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    let manifest: QSpecManifest<QSpecResourceSpec>;
    try {
      manifest = parseManifest(text);
    } catch (error) {
      failed = true;
      printIssues(path, toIssues(error), io, error instanceof Error ? error.message : undefined);
      continue;
    }

    const issues = validateManifestStructure(manifest);
    if (issues.length > 0) {
      failed = true;
      printIssues(path, issues, io);
      continue;
    }

    const result = inspect(manifest);

    if (io.json === true) {
      entries.push({ path, ...result });
    } else {
      // A per-file header, matching runValidate's own styling
      // (validate.ts:152), so a reader inspecting several manifests at once
      // can tell which Resource/Parameters/... block belongs to which file.
      if (printedAny) io.out("");
      io.out(`${green("✓ Valid QSpec manifest", io.color)} ${dim(path, io.color)}`);
      io.out("");
      for (const line of renderHuman(result)) io.out(line);
    }
    printedAny = true;
  }

  if (io.json === true) {
    io.out(JSON.stringify(entries, null, 2));
  }

  return failed ? 1 : 0;
}
