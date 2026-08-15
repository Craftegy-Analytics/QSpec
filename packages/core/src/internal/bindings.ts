import { ManifestValidationError, type PathSegment } from "../errors.js";
import { createRow, isPlainObject, setKey, type JsonValue } from "../json.js";
import type { Binding } from "../types/query.js";
import { suggest } from "./suggest.js";
import type { CompiledParameters } from "./validate/parameters.js";

/** The only accepted string binding form. (design §2.1) */
export const PARAMETER_REFERENCE = /^\$parameters\.([A-Za-z_][A-Za-z0-9_]*)$/;

export type CompiledBinding =
  | { readonly name: string; readonly kind: "parameter"; readonly parameter: string }
  | { readonly name: string; readonly kind: "literal"; readonly value: JsonValue };

function fail(message: string, path: readonly PathSegment[], suggestion?: string): never {
  throw new ManifestValidationError(message, {
    issues: [
      {
        code: "QSPEC_MANIFEST_INVALID",
        message,
        path,
        ...(suggestion === undefined ? {} : { suggestion }),
      },
    ],
  });
}

/**
 * Static work: turns declared bindings into a resolved plan and proves every
 * referenced parameter exists, so a typo fails during prepare() rather than
 * producing a silently wrong query. (SPEC.md §34, §81)
 */
export function compileBindings(
  bindings: { readonly [name: string]: Binding } | undefined,
  parameters: CompiledParameters,
  basePath: readonly PathSegment[],
): readonly CompiledBinding[] {
  if (bindings === undefined) return [];
  if (!isPlainObject(bindings)) fail("`bindings` must be an object.", basePath);

  const compiled: CompiledBinding[] = [];

  for (const [name, binding] of Object.entries(bindings)) {
    const path = [...basePath, name];

    if (typeof binding === "string") {
      const match = PARAMETER_REFERENCE.exec(binding);
      const parameter = match?.[1];
      if (parameter === undefined) {
        fail(
          `Binding "${name}" must be a parameter reference of the form "$parameters.<name>". ` +
            `To bind the constant value ${JSON.stringify(binding)}, write ` +
            `{ "literal": ${JSON.stringify(binding)} } instead.`,
          path,
        );
      }
      if (!parameters.definitions.has(parameter)) {
        fail(
          `Binding "${name}" references undeclared parameter "${parameter}".`,
          path,
          suggest(parameter, parameters.names),
        );
      }
      compiled.push({ name, kind: "parameter", parameter });
      continue;
    }

    if (!isPlainObject(binding)) {
      fail(`Binding "${name}" must be a string, { parameter }, or { literal }.`, path);
    }

    // Presence and type are checked separately. Conflating them lets
    // { parameter: 5, literal: "x" } slip through: a wrongly-typed
    // `parameter` reads as absent, so "both present" looks like "exactly one".
    const hasParameter = Object.hasOwn(binding, "parameter");
    const hasLiteral = Object.hasOwn(binding, "literal");

    if (hasParameter === hasLiteral) {
      fail(`Binding "${name}" must have exactly one of "parameter" or "literal".`, path);
    }

    // `in` narrows a union of object types natively, so no cast is needed on
    // either branch below.
    if ("parameter" in binding) {
      const parameter = binding["parameter"];
      if (typeof parameter !== "string") {
        fail(`Binding "${name}" has a non-string "parameter".`, path);
      }
      if (!parameters.definitions.has(parameter)) {
        fail(
          `Binding "${name}" references undeclared parameter "${parameter}".`,
          path,
          suggest(parameter, parameters.names),
        );
      }
      compiled.push({ name, kind: "parameter", parameter });
    } else if ("literal" in binding) {
      const literal = binding["literal"];
      if (literal === undefined) {
        // Object.hasOwn is true for an explicitly-undefined property, and
        // undefined is not a JsonValue. Unreachable from JSON text, but the
        // already-parsed-object input path can produce it.
        fail(`Binding "${name}" has an undefined "literal". Use null for an absent value.`, path);
      }
      compiled.push({ name, kind: "literal", value: literal as JsonValue });
    }
  }

  return compiled;
}

/** Per-execution work: produces the value map handed to the query compiler. */
export function resolveBindings(
  compiled: readonly CompiledBinding[],
  parameters: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const resolved = createRow<JsonValue>();
  for (const binding of compiled) {
    if (binding.kind === "literal") {
      setKey(resolved, binding.name, binding.value);
    } else {
      const value = Object.hasOwn(parameters, binding.parameter)
        ? parameters[binding.parameter]
        : undefined;
      setKey(resolved, binding.name, value === undefined ? null : value);
    }
  }
  return Object.freeze(resolved);
}
