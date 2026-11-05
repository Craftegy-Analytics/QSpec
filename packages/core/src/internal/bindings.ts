import { ManifestValidationError, type PathSegment } from "../errors.js";
import { createRow, isPlainObject, setKey, type JsonValue } from "../json.js";
import type { PolicyBinding } from "../types/policy.js";
import type { Binding } from "../types/query.js";
import { suggest } from "./suggest.js";
import type { CompiledParameters } from "./validate/parameters.js";

/**
 * The only accepted string binding form. (design §2.1) Defined once: every reader of a binding
 * goes through `describeBinding` below, so this is the one place the rule can be edited.
 */
const PARAMETER_REFERENCE = /^\$parameters\.([A-Za-z_][A-Za-z0-9_]*)$/;

const LITERAL: PolicyBinding = Object.freeze({ kind: "literal" });

/**
 * Design §2.1's binding rule: what a declared binding reads, or `undefined` when it is not one of
 * the three accepted forms. A string must match `$parameters.<name>`; an object must have exactly
 * one of `parameter` (a string) or `literal` (anything but `undefined`), "exactly one key, not
 * whichever parses". A literal's value is omitted, so the result is safe to hand to an execution
 * policy. Whether the named parameter is declared is the caller's check, not this function's.
 *
 * Public because a policy's admission check needs the same rule outside a running runtime, and a
 * second copy of it would drift (SPEC.md §104). Both `compileBindings` and the structural
 * validator classify through it, and `PolicyQuery.bindings` is built from that classification, so
 * an admission check and a running policy see the same description of every binding.
 */
export function describeBinding(binding: unknown): PolicyBinding | undefined {
  if (typeof binding === "string") {
    const parameter = PARAMETER_REFERENCE.exec(binding)?.[1];
    return parameter === undefined ? undefined : Object.freeze({ kind: "parameter", parameter });
  }
  if (!isPlainObject(binding)) return undefined;
  // Presence and type are checked separately. Conflating them lets
  // { parameter: 5, literal: "x" } slip through: a wrongly-typed
  // `parameter` reads as absent, so "both present" looks like "exactly one".
  const hasParameter = Object.hasOwn(binding, "parameter");
  const hasLiteral = Object.hasOwn(binding, "literal");
  if (hasParameter === hasLiteral) return undefined;
  if (hasParameter) {
    const parameter = binding["parameter"];
    return typeof parameter === "string"
      ? Object.freeze({ kind: "parameter", parameter })
      : undefined;
  }
  // Object.hasOwn is true for an explicitly-undefined property, and
  // undefined is not a JsonValue. Unreachable from JSON text, but the
  // already-parsed-object input path can produce it.
  return binding["literal"] === undefined ? undefined : LITERAL;
}

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
    const described = describeBinding(binding);

    if (described?.kind === "parameter") {
      const { parameter } = described;
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

    // describeBinding proved `literal` is an own, defined property; `in`
    // only narrows the declared type so the value can be read without a cast.
    if (described?.kind === "literal" && typeof binding === "object" && "literal" in binding) {
      compiled.push({ name, kind: "literal", value: binding.literal });
      continue;
    }

    // Not a binding. Each remaining branch names why, so the author can fix it.
    if (typeof binding === "string") {
      fail(
        `Binding "${name}" must be a parameter reference of the form "$parameters.<name>". ` +
          `To bind the constant value ${JSON.stringify(binding)}, write ` +
          `{ "literal": ${JSON.stringify(binding)} } instead.`,
        path,
      );
    }
    if (!isPlainObject(binding)) {
      fail(`Binding "${name}" must be a string, { parameter }, or { literal }.`, path);
    }
    if (Object.hasOwn(binding, "parameter") === Object.hasOwn(binding, "literal")) {
      fail(`Binding "${name}" must have exactly one of "parameter" or "literal".`, path);
    }
    if (Object.hasOwn(binding, "parameter")) {
      fail(`Binding "${name}" has a non-string "parameter".`, path);
    }
    fail(`Binding "${name}" has an undefined "literal". Use null for an absent value.`, path);
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
