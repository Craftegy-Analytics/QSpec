import {
  ManifestValidationError,
  ParameterValidationError,
  type PathSegment,
  type QSpecIssue,
} from "../../errors.js";
import { createRow, deepFreeze, isPlainObject, setKey, type JsonValue } from "../../json.js";
import type { ParameterDefinition, ParameterType } from "../../types/parameters.js";

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

/**
 * Types permitted as `items.type` on an array parameter. Deliberately excludes
 * the composite types: `checkScalar` has no branch for them, and its `never`
 * default would return the type NAME as the element value at runtime.
 */
const ITEM_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export interface CompiledParameters {
  readonly names: readonly string[];
  readonly definitions: ReadonlyMap<string, ParameterDefinition>;
}

function declarationError(message: string, path: readonly PathSegment[]): never {
  throw new ManifestValidationError(message, {
    issues: [{ code: "QSPEC_MANIFEST_INVALID", message, path }],
  });
}

/**
 * Static work: performed once during prepare(). Rejects a malformed parameter
 * *declaration*, which is a manifest bug, not a runtime input bug.
 */
export function compileParameters(
  definitions: { readonly [name: string]: ParameterDefinition } | undefined,
): CompiledParameters {
  const map = new Map<string, ParameterDefinition>();
  if (definitions === undefined) return { names: [], definitions: map };
  if (!isPlainObject(definitions)) {
    declarationError("`spec.parameters` must be an object.", ["spec", "parameters"]);
  }

  for (const [name, definition] of Object.entries(definitions)) {
    const path: PathSegment[] = ["spec", "parameters", name];
    if (!isPlainObject(definition)) {
      declarationError(`Parameter "${name}" must be an object.`, path);
    }
    const type = (definition as ParameterDefinition).type;
    if (typeof type !== "string" || !PARAMETER_TYPES.has(type)) {
      declarationError(
        `Parameter "${name}" has unknown type "${String(type)}". ` +
          `Supported types: ${[...PARAMETER_TYPES].join(", ")}.`,
        [...path, "type"],
      );
    }
    if (type === "enum") {
      const values = definition.values;
      if (!Array.isArray(values) || values.length === 0) {
        declarationError(`Enum parameter "${name}" must declare a non-empty \`values\` array.`, [
          ...path,
          "values",
        ]);
      }
    }
    if (type === "array") {
      const items = definition.items;
      if (!isPlainObject(items) || !ITEM_TYPES.has(String(items["type"]))) {
        declarationError(
          `Array parameter "${name}" must declare \`items.type\` as one of: ` +
            `${[...ITEM_TYPES].join(", ")}.`,
          [...path, "items"],
        );
      }
    }
    const defaultIssues = collectDefaultIssues(definition as ParameterDefinition, name, [
      ...path,
      "default",
    ]);
    if (defaultIssues.length > 0) {
      declarationError(
        `Default value for parameter "${name}" is not valid for its declaration: ${defaultIssues[0]?.message}`,
        [...path, "default"],
      );
    }
    map.set(name, definition);
  }

  return { names: [...map.keys()], definitions: map };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Confirms an ISO date names a real calendar day (rejects e.g. 2026-02-31). */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function checkScalar(
  type: Exclude<ParameterType, "array" | "enum">,
  name: string,
  value: unknown,
  path: readonly PathSegment[],
  issues: QSpecIssue[],
): JsonValue | undefined {
  const reject = (message: string): undefined => {
    issues.push({ code: "QSPEC_PARAMETER_INVALID", message, path });
    return undefined;
  };

  switch (type) {
    case "string":
      if (typeof value !== "string") return reject(`Parameter "${name}" must be a string.`);
      return value;
    case "number":
      if (!isFiniteNumber(value)) return reject(`Parameter "${name}" must be a finite number.`);
      return value;
    case "integer":
      if (!isFiniteNumber(value) || !Number.isInteger(value)) {
        return reject(`Parameter "${name}" must be an integer.`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") return reject(`Parameter "${name}" must be a boolean.`);
      return value;
    case "date":
      if (typeof value !== "string" || !DATE_PATTERN.test(value) || !isRealDate(value)) {
        return reject(`Parameter "${name}" must be a date string in YYYY-MM-DD form.`);
      }
      return value;
    case "datetime":
      if (
        typeof value !== "string" ||
        !DATETIME_PATTERN.test(value) ||
        Number.isNaN(new Date(value).getTime()) ||
        // Date() silently rolls 2026-02-30 over to 2026-03-02. The `date` type
        // guards against that with isRealDate; datetime must match.
        !isRealDate(value.slice(0, 10))
      ) {
        return reject(`Parameter "${name}" must be an ISO 8601 datetime string.`);
      }
      return value;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function applyScalarConstraints(
  definition: ParameterDefinition,
  name: string,
  value: JsonValue,
  path: readonly PathSegment[],
  issues: QSpecIssue[],
): void {
  const rules = definition.validation;
  if (rules === undefined) return;
  const reject = (message: string) =>
    issues.push({ code: "QSPEC_PARAMETER_INVALID", message, path });

  if (typeof value === "number") {
    if (rules.min !== undefined && value < rules.min) {
      reject(`Parameter "${name}" must be greater than or equal to ${rules.min}.`);
    }
    if (rules.max !== undefined && value > rules.max) {
      reject(`Parameter "${name}" must be less than or equal to ${rules.max}.`);
    }
  }
  const length =
    typeof value === "string" ? value.length : Array.isArray(value) ? value.length : undefined;
  if (length !== undefined) {
    if (rules.minLength !== undefined && length < rules.minLength) {
      reject(
        `Parameter "${name}" must have at least ${rules.minLength} ${
          typeof value === "string" ? "characters" : "items"
        }.`,
      );
    }
    if (rules.maxLength !== undefined && length > rules.maxLength) {
      reject(
        `Parameter "${name}" must have at most ${rules.maxLength} ${
          typeof value === "string" ? "characters" : "items"
        }.`,
      );
    }
  }
}

function coerce(
  definition: ParameterDefinition,
  name: string,
  value: unknown,
  path: readonly PathSegment[],
  issues: QSpecIssue[],
): JsonValue | undefined {
  if (definition.type === "enum") {
    const allowed = definition.values ?? [];
    if (!allowed.some((candidate) => candidate === value)) {
      issues.push({
        code: "QSPEC_PARAMETER_INVALID",
        message: `Parameter "${name}" must be one of: ${allowed.map(String).join(", ")}.`,
        path,
      });
      return undefined;
    }
    return value as JsonValue;
  }

  if (definition.type === "array") {
    if (!Array.isArray(value)) {
      issues.push({
        code: "QSPEC_PARAMETER_INVALID",
        message: `Parameter "${name}" must be an array.`,
        path,
      });
      return undefined;
    }
    const itemType = definition.items?.type ?? "string";
    const before = issues.length;
    const items = value.map((item, index) =>
      checkScalar(itemType, name, item, [...path, index], issues),
    );
    if (issues.length !== before) return undefined;
    const result = items as JsonValue[];
    applyScalarConstraints(definition, name, result, path, issues);
    return result;
  }

  const before = issues.length;
  const scalar = checkScalar(definition.type, name, value, path, issues);
  if (issues.length !== before || scalar === undefined) return undefined;
  applyScalarConstraints(definition, name, scalar, path, issues);
  return scalar;
}

/**
 * Issues with a parameter's declared `default`. Shared by structural validation
 * and by compileParameters so the two cannot drift: `qspec validate` must not
 * accept a declaration that prepare() will reject.
 */
export function collectDefaultIssues(
  definition: ParameterDefinition,
  name: string,
  path: readonly PathSegment[],
): QSpecIssue[] {
  if (definition.default === undefined) return [];
  const issues: QSpecIssue[] = [];
  coerce(definition, name, definition.default, path, issues);
  return issues;
}

/**
 * Validation stage 3: runtime parameter values. Every problem is collected so a
 * caller sees all of them in one pass. (SPEC.md §29, §71, §80)
 */
export function validateParameters(
  compiled: CompiledParameters,
  input: Record<string, unknown> | undefined,
): Record<string, JsonValue> {
  const issues: QSpecIssue[] = [];
  const supplied = input ?? {};
  const resolved = createRow<JsonValue>();

  for (const [name, definition] of compiled.definitions) {
    const path: PathSegment[] = ["parameters", name];
    const raw = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    const provided = raw !== undefined && raw !== null;

    if (!provided) {
      if (definition.default !== undefined) {
        setKey(resolved, name, definition.default);
      } else if (definition.required === true) {
        issues.push({
          code: "QSPEC_PARAMETER_INVALID",
          message: `Parameter "${name}" is required.`,
          path,
        });
      }
      continue;
    }

    const value = coerce(definition, name, raw, path, issues);
    if (value !== undefined) setKey(resolved, name, value);
  }

  for (const name of Object.keys(supplied)) {
    if (!compiled.definitions.has(name)) {
      issues.push({
        code: "QSPEC_PARAMETER_INVALID",
        message:
          `Unknown parameter "${name}". Declared parameters: ` +
          (compiled.names.length === 0 ? "(none)" : compiled.names.join(", ")) +
          ".",
        path: ["parameters", name],
      });
    }
  }

  if (issues.length > 0) {
    throw new ParameterValidationError(
      `Parameter validation failed (${issues.length} problem${issues.length === 1 ? "" : "s"}).`,
      { issues },
    );
  }

  // deepFreeze, not Object.freeze: a shallow freeze leaves an array-typed
  // parameter's value array mutable by the caller after validation.
  return deepFreeze(resolved);
}
