import { ManifestValidationError, type PathSegment, type QSpecIssue } from "../../errors.js";
import { isPlainObject } from "../../json.js";
import { FIELD_TYPES as FIELD_TYPE_VALUES } from "../../types/dataset.js";
import {
  METADATA_NAME_PATTERN,
  type QSpecManifest,
  type QSpecResourceSpec,
} from "../../types/manifest.js";
import type { ParameterDefinition } from "../../types/parameters.js";
import { SUPPORTED_API_VERSIONS } from "../../version.js";
import { suggest } from "../suggest.js";
import { collectDefaultIssues } from "./parameters.js";

const PARAMETER_REFERENCE = /^\$parameters\.[A-Za-z_][A-Za-z0-9_]*$/;

const PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "enum",
  "array",
]);

/** Types permitted as `items.type`; composite types have no scalar checker. */
const ITEM_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
]);

// Derived from the exported FIELD_TYPES value, not a second literal list — a
// hand-copied duplicate here would drift the moment core adds a field type:
// core would accept it while this validator kept rejecting it.
const FIELD_TYPES: ReadonlySet<string> = new Set(FIELD_TYPE_VALUES);

class IssueCollector {
  readonly issues: QSpecIssue[] = [];

  add(
    message: string,
    path: readonly PathSegment[],
    extra?: { code?: string; suggestion?: string },
  ) {
    this.issues.push({
      code: extra?.code ?? "QSPEC_MANIFEST_INVALID",
      message,
      path,
      ...(extra?.suggestion === undefined ? {} : { suggestion: extra.suggestion }),
    });
  }

  addAll(issues: readonly QSpecIssue[]): void {
    this.issues.push(...issues);
  }
}

/** Best-effort conversion of a name to the recommended pattern. (SPEC.md §25) */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
}

function validateMetadata(metadata: unknown, collector: IssueCollector): void {
  if (!isPlainObject(metadata)) {
    collector.add("`metadata` must be an object.", ["metadata"]);
    return;
  }
  const name = metadata["name"];
  if (typeof name !== "string" || name === "") {
    collector.add("`metadata.name` is required and must be a non-empty string.", [
      "metadata",
      "name",
    ]);
  } else if (!METADATA_NAME_PATTERN.test(name)) {
    const suggestion = slugify(name);
    collector.add(
      `\`metadata.name\` must match ${METADATA_NAME_PATTERN.source}.`,
      ["metadata", "name"],
      suggestion === "" ? undefined : { suggestion },
    );
  }
  for (const key of ["title", "description"] as const) {
    if (metadata[key] !== undefined && typeof metadata[key] !== "string") {
      collector.add(`\`metadata.${key}\` must be a string.`, ["metadata", key]);
    }
  }
  const tags = metadata["tags"];
  if (tags !== undefined) {
    if (!Array.isArray(tags)) {
      collector.add("`metadata.tags` must be an array of strings.", ["metadata", "tags"]);
    } else {
      tags.forEach((tag, index) => {
        if (typeof tag !== "string") {
          collector.add("Each tag must be a string.", ["metadata", "tags", index]);
        }
      });
    }
  }
}

/** Matches compileBindings's message exactly (bindings.ts) so `validate` and `prepare` agree. */
function checkDeclaredParameter(
  parameter: string,
  name: string,
  path: readonly PathSegment[],
  declaredParameters: ReadonlySet<string>,
  collector: IssueCollector,
): void {
  if (declaredParameters.has(parameter)) return;
  const hint = suggest(parameter, [...declaredParameters]);
  collector.add(
    `Binding "${name}" references undeclared parameter "${parameter}".`,
    path,
    hint === undefined ? undefined : { suggestion: hint },
  );
}

function validateBindings(
  bindings: unknown,
  base: readonly PathSegment[],
  declaredParameters: ReadonlySet<string>,
  collector: IssueCollector,
): void {
  if (!isPlainObject(bindings)) {
    collector.add("`bindings` must be an object.", base);
    return;
  }
  for (const [name, binding] of Object.entries(bindings)) {
    const path = [...base, name];
    if (typeof binding === "string") {
      const match = PARAMETER_REFERENCE.exec(binding);
      if (match === null) {
        collector.add(
          'A string binding must be a parameter reference of the form "$parameters.<name>". ' +
            'To bind a constant, use { "literal": ... } instead.',
          path,
        );
      } else {
        checkDeclaredParameter(
          binding.slice("$parameters.".length),
          name,
          path,
          declaredParameters,
          collector,
        );
      }
    } else if (isPlainObject(binding)) {
      // Presence and type are checked separately. Conflating them lets
      // { parameter: 5, literal: "x" } slip through: a wrongly-typed
      // `parameter` reads as absent, so "both present" looks like "exactly one".
      const hasParameter = Object.hasOwn(binding, "parameter");
      const hasLiteral = Object.hasOwn(binding, "literal");
      if (hasParameter === hasLiteral) {
        collector.add('A binding object must have exactly one of "parameter" or "literal".', path);
      } else if (hasParameter && typeof binding["parameter"] !== "string") {
        collector.add('A binding\'s "parameter" must be a string.', path);
      } else if (hasParameter) {
        checkDeclaredParameter(
          binding["parameter"] as string,
          name,
          path,
          declaredParameters,
          collector,
        );
      } else if (hasLiteral && binding["literal"] === undefined) {
        // Object.hasOwn is true for an explicitly-undefined property, so a
        // presence check alone lets { "literal": undefined } through — and
        // undefined is not a JsonValue. Unreachable from JSON text, but the
        // already-parsed-object input path can produce it.
        collector.add(
          'A binding\'s "literal" must not be undefined. Use null for an absent value.',
          path,
        );
      }
    } else {
      collector.add("A binding must be a string, { parameter }, or { literal }.", path);
    }
  }
}

/**
 * Declaration-level parameter checks. These duplicate compileParameters by
 * design: that runs only during prepare(), but `qspec validate` never calls
 * prepare() and must still reject a manifest that cannot possibly work.
 */
function validateParameterDeclarations(
  parameters: Record<string, unknown>,
  collector: IssueCollector,
): void {
  for (const [name, definition] of Object.entries(parameters)) {
    const path: PathSegment[] = ["spec", "parameters", name];
    if (!isPlainObject(definition)) {
      collector.add(`Parameter "${name}" must be an object.`, path);
      continue;
    }

    const type = definition["type"];
    if (typeof type !== "string" || !PARAMETER_TYPES.has(type)) {
      const hint = typeof type === "string" ? suggest(type, [...PARAMETER_TYPES]) : undefined;
      collector.add(
        `Parameter "${name}" has unknown type ${JSON.stringify(type)}. ` +
          `Supported types: ${[...PARAMETER_TYPES].join(", ")}.`,
        [...path, "type"],
        hint === undefined ? undefined : { suggestion: hint },
      );
      continue;
    }

    if (definition["required"] !== undefined && typeof definition["required"] !== "boolean") {
      collector.add(`Parameter "${name}" has a non-boolean \`required\`.`, [...path, "required"]);
    }

    if (definition["description"] !== undefined && typeof definition["description"] !== "string") {
      collector.add(`Parameter "${name}" has a non-string \`description\`.`, [
        ...path,
        "description",
      ]);
    }

    // Advisory only: core never reads this to make decisions, but a
    // malformed value is still a mistake `qspec validate` should catch.
    const presentation = definition["presentation"];
    if (presentation !== undefined) {
      if (!isPlainObject(presentation)) {
        collector.add(`Parameter "${name}" has a non-object \`presentation\`.`, [
          ...path,
          "presentation",
        ]);
      } else {
        for (const key of ["control", "label", "placeholder", "help"] as const) {
          if (presentation[key] !== undefined && typeof presentation[key] !== "string") {
            collector.add(`Parameter "${name}" has a non-string \`presentation.${key}\`.`, [
              ...path,
              "presentation",
              key,
            ]);
          }
        }
      }
    }

    // Tracks whether the declaration is sound enough to feed to
    // collectDefaultIssues below: an enum with no `values` or an array with
    // malformed `items` would make coerce()'s judgment of `default` meaningless
    // (or, for array, produce a confusing cascading message).
    let declarationOk = true;

    if (type === "enum") {
      const values = definition["values"];
      if (!Array.isArray(values) || values.length === 0) {
        collector.add(`Enum parameter "${name}" must declare a non-empty \`values\` array.`, [
          ...path,
          "values",
        ]);
        declarationOk = false;
      }
    }

    if (type === "array") {
      const items = definition["items"];
      if (
        !isPlainObject(items) ||
        typeof items["type"] !== "string" ||
        !ITEM_TYPES.has(items["type"])
      ) {
        collector.add(
          `Array parameter "${name}" must declare \`items.type\` as one of: ` +
            `${[...ITEM_TYPES].join(", ")}.`,
          [...path, "items"],
        );
        declarationOk = false;
      }
    }

    const validation = definition["validation"];
    if (validation !== undefined) {
      if (!isPlainObject(validation)) {
        collector.add(`Parameter "${name}" has a non-object \`validation\`.`, [
          ...path,
          "validation",
        ]);
        declarationOk = false;
      } else {
        for (const key of ["min", "max"] as const) {
          if (validation[key] !== undefined && typeof validation[key] !== "number") {
            collector.add(`Parameter "${name}" has a non-numeric \`validation.${key}\`.`, [
              ...path,
              "validation",
              key,
            ]);
            declarationOk = false;
          }
        }
        for (const key of ["minLength", "maxLength"] as const) {
          const value = validation[key];
          if (
            value !== undefined &&
            (typeof value !== "number" || !Number.isInteger(value) || value < 0)
          ) {
            collector.add(
              `Parameter "${name}" has a \`validation.${key}\` that is not a non-negative integer.`,
              [...path, "validation", key],
            );
            declarationOk = false;
          }
        }
      }
    }

    // Shares compileParameters's coerce() logic (see parameters.ts) so
    // `qspec validate` cannot accept a `default` that prepare() then rejects.
    // Double-cast: `definition` is only known to be a plain object here, but
    // its `type`/`values`/`items` shape has just been confirmed above (that
    // is exactly what `declarationOk` records), so the narrower type is safe.
    if (declarationOk) {
      collector.addAll(
        collectDefaultIssues(definition as unknown as ParameterDefinition, name, [
          ...path,
          "default",
        ]),
      );
    }
  }
}

/**
 * Declaration-level dataset field checks. Like the parameter checks, these
 * exist because `qspec validate` never runs prepare(), so a manifest that
 * cannot possibly work must be rejected here.
 */
function validateFieldDeclarations(
  fields: Record<string, unknown>,
  collector: IssueCollector,
): void {
  for (const [name, definition] of Object.entries(fields)) {
    const path: PathSegment[] = ["spec", "dataset", "fields", name];
    if (!isPlainObject(definition)) {
      collector.add(`Field "${name}" must be an object.`, path);
      continue;
    }

    const type = definition["type"];
    if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
      const hint = typeof type === "string" ? suggest(type, [...FIELD_TYPES]) : undefined;
      collector.add(
        `Field "${name}" has unknown type ${JSON.stringify(type)}. ` +
          `Supported types: ${[...FIELD_TYPES].join(", ")}.`,
        [...path, "type"],
        hint === undefined ? undefined : { suggestion: hint },
      );
    }

    if (definition["nullable"] !== undefined && typeof definition["nullable"] !== "boolean") {
      collector.add(`Field "${name}" has a non-boolean \`nullable\`.`, [...path, "nullable"]);
    }

    for (const key of ["label", "semanticType"] as const) {
      if (definition[key] !== undefined && typeof definition[key] !== "string") {
        collector.add(`Field "${name}" has a non-string \`${key}\`.`, [...path, key]);
      }
    }

    if (definition["format"] !== undefined && !isPlainObject(definition["format"])) {
      collector.add(`Field "${name}" has a non-object \`format\`.`, [...path, "format"]);
    }
  }
}

function validateQuery(
  query: unknown,
  declaredParameters: ReadonlySet<string>,
  collector: IssueCollector,
): void {
  if (!isPlainObject(query)) {
    collector.add("`spec.query` must be an object.", ["spec", "query"]);
    return;
  }
  if (typeof query["source"] !== "string" || query["source"] === "") {
    collector.add("`spec.query.source` is required and must be a non-empty string.", [
      "spec",
      "query",
      "source",
    ]);
  }
  if (typeof query["language"] !== "string" || query["language"] === "") {
    collector.add("`spec.query.language` is required and must be a non-empty string.", [
      "spec",
      "query",
      "language",
    ]);
  }
  if (!Object.hasOwn(query, "statement") || query["statement"] === undefined) {
    collector.add("`spec.query.statement` is required.", ["spec", "query", "statement"]);
  }
  if (query["bindings"] !== undefined) {
    validateBindings(
      query["bindings"],
      ["spec", "query", "bindings"],
      declaredParameters,
      collector,
    );
  }
}

function validateSpec(spec: unknown, collector: IssueCollector): void {
  if (!isPlainObject(spec)) {
    collector.add("`spec` must be an object.", ["spec"]);
    return;
  }

  // Gathered up front so binding references can be cross-checked. A malformed
  // `parameters` block still yields whatever names are present; its own issues
  // are reported separately by validateParameterDeclarations.
  const declaredParameters = new Set<string>(
    isPlainObject(spec["parameters"]) ? Object.keys(spec["parameters"]) : [],
  );

  if (spec["query"] !== undefined) validateQuery(spec["query"], declaredParameters, collector);

  if (spec["parameters"] !== undefined) {
    if (!isPlainObject(spec["parameters"])) {
      collector.add("`spec.parameters` must be an object.", ["spec", "parameters"]);
    } else {
      validateParameterDeclarations(spec["parameters"], collector);
    }
  }

  if (spec["dataset"] !== undefined) {
    const dataset = spec["dataset"];
    if (!isPlainObject(dataset)) {
      collector.add("`spec.dataset` must be an object.", ["spec", "dataset"]);
    } else if (!isPlainObject(dataset["fields"])) {
      collector.add("`spec.dataset.fields` must be an object.", ["spec", "dataset", "fields"]);
    } else {
      validateFieldDeclarations(dataset["fields"], collector);
    }
  }

  const transforms = spec["transforms"];
  if (transforms !== undefined) {
    if (!Array.isArray(transforms)) {
      collector.add("`spec.transforms` must be an array.", ["spec", "transforms"]);
    } else {
      transforms.forEach((transform, index) => {
        if (
          !isPlainObject(transform) ||
          typeof transform["type"] !== "string" ||
          transform["type"] === ""
        ) {
          collector.add("Each transform must be an object with a non-empty string `type`.", [
            "spec",
            "transforms",
            index,
            "type",
          ]);
        }
      });
    }
  }

  const presentation = spec["presentation"];
  if (presentation !== undefined) {
    if (
      !isPlainObject(presentation) ||
      typeof presentation["type"] !== "string" ||
      presentation["type"] === ""
    ) {
      collector.add("`spec.presentation` must be an object with a non-empty string `type`.", [
        "spec",
        "presentation",
        "type",
      ]);
    }
  }
}

/**
 * Validation stage 1: structural shape of the manifest. Returns every problem
 * found rather than stopping at the first, so a user sees the whole picture.
 * (SPEC.md §71, §80)
 */
export function validateManifestStructure(manifest: unknown): QSpecIssue[] {
  const collector = new IssueCollector();

  if (!isPlainObject(manifest)) {
    collector.add("A QSpec manifest must be a JSON object.", []);
    return collector.issues;
  }

  const apiVersion = manifest["apiVersion"];
  if (typeof apiVersion !== "string" || apiVersion === "") {
    collector.add("`apiVersion` is required and must be a string.", ["apiVersion"]);
  } else if (!SUPPORTED_API_VERSIONS.includes(apiVersion)) {
    collector.add(
      `Unsupported apiVersion "${apiVersion}". This runtime supports: ${SUPPORTED_API_VERSIONS.join(", ")}.`,
      ["apiVersion"],
      { code: "QSPEC_API_VERSION_UNSUPPORTED" },
    );
  }

  if (typeof manifest["kind"] !== "string" || manifest["kind"] === "") {
    collector.add("`kind` is required and must be a non-empty string.", ["kind"]);
  }

  if (manifest["$schema"] !== undefined && typeof manifest["$schema"] !== "string") {
    collector.add("`$schema` must be a string.", ["$schema"]);
  }

  if (manifest["metadata"] === undefined) {
    collector.add("`metadata` is required.", ["metadata"]);
  } else {
    validateMetadata(manifest["metadata"], collector);
  }

  if (manifest["spec"] === undefined) {
    collector.add("`spec` is required.", ["spec"]);
  } else {
    validateSpec(manifest["spec"], collector);
  }

  return collector.issues;
}

/** Throws when the manifest is structurally invalid; otherwise narrows the type. */
export function assertValidManifest(manifest: unknown): QSpecManifest<QSpecResourceSpec> {
  const issues = validateManifestStructure(manifest);
  if (issues.length > 0) {
    throw new ManifestValidationError(
      `Manifest is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"}).`,
      { issues },
    );
  }
  return manifest as QSpecManifest<QSpecResourceSpec>;
}
