import {
  formatPath,
  isPlainObject,
  isUnsafeKey,
  type JsonValue,
  type PathSegment,
  type QSpecIssue,
  type QSpecResult,
} from "@qspecs/core";

/**
 * What crosses the wire to ask a server to run a resource. Deliberately no
 * field for a query, a statement, a source name, or a connection string: the
 * browser names a resource the SERVER already knows about and supplies only
 * parameter values, never anything executable. The server resolves
 * `resource` against its own manifest registry and runs its own runtime with
 * its own credentials — a reviewer can confirm the trust property from this
 * type alone. (SPEC.md §9, §72.1, §72.2)
 */
export interface QSpecExecuteRequest {
  /** A name the SERVER resolves against its own manifest registry. */
  readonly resource: string;
  readonly parameters?: Record<string, JsonValue>;
}

/**
 * A server-side failure rendered for the wire. Never a raw driver message.
 * `issues` reuses core's own `QSpecIssue` shape verbatim (code, message,
 * path, optional suggestion) rather than a hand-picked subset, so a client
 * can reconstruct core's error faithfully instead of losing the per-issue
 * code and the did-you-mean suggestion.
 */
export interface QSpecErrorBody {
  /** A QSpec error code, e.g. QSPEC_PARAMETER_INVALID — never a driver message. */
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly QSpecIssue[];
}

export type QSpecExecuteResponse =
  | { readonly ok: true; readonly result: QSpecResult }
  | { readonly ok: false; readonly error: QSpecErrorBody };

/** Caller-supplied strings longer than this are rejected before any further work. */
const MAX_RESOURCE_LENGTH = 256;

/**
 * Recursion ceiling for `parameters` values. `JSON.parse` has no depth limit
 * of its own — a small request body can still nest arrays or objects tens of
 * thousands of levels deep — so an unguarded recursive walk over parsed JSON
 * can overflow the stack on a request far smaller than any byte-size limit
 * would catch. 64 is generous for any real parameter value (order of
 * magnitude above core's `maxExpressionDepth` default of 32) while keeping
 * recursion nowhere near a real stack limit.
 */
const MAX_PARAMETER_DEPTH = 64;

/** Longest a single path segment is shown as in an error message before truncation. */
const MAX_MESSAGE_SEGMENT_LENGTH = 100;

/**
 * Overall cap on a thrown message. Each path segment is bounded on its own by
 * `MAX_MESSAGE_SEGMENT_LENGTH`, but a path can hold up to `MAX_PARAMETER_DEPTH`
 * of them — bounding only each segment still lets the rendered message grow
 * to several kilobytes for a deep enough path (64 segments at just over 100
 * characters each). This is the ceiling on the message actually thrown.
 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Throws with `message`, first bounding its overall length to
 * `MAX_MESSAGE_LENGTH`. The single place that enforces that ceiling, so no
 * call site below can reintroduce an unbounded message by constructing one
 * itself and calling `throw new Error(...)` directly.
 */
function fail(message: string): never {
  throw new Error(
    message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...` : message,
  );
}

/**
 * Code points `sanitizeForMessage` strips: the C0 controls and DEL
 * (0x00-0x1F, 0x7F), NEL (0x85), and the two Unicode line/paragraph
 * separators (0x2028, 0x2029). All five are line terminators or control
 * characters to some downstream log viewer or JS consumer, and — unlike a
 * plain ASCII newline — none of them is escaped by `JSON.stringify`, which
 * `formatPath` uses to render a non-identifier path segment. Written as
 * numeric code-point comparisons rather than a regex character class so the
 * exact set being stripped is unambiguous at the call site.
 */
function isStrippedCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    codePoint === 0x7f ||
    codePoint === 0x85 ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

/**
 * Renders a caller-supplied string for inclusion in an error message. A
 * parameter or resource name is network input of unbounded length and can
 * contain the control characters and line terminators `isStrippedCodePoint`
 * lists; interpolating any of them raw would let a client control the length
 * and line structure of whatever eventually logs the rejection (Task 2's
 * handler is expected to log these). Stripping them and truncating keeps the
 * message useful for a human without handing a client that much control.
 */
function sanitizeForMessage(value: string): string {
  let stripped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && !isStrippedCodePoint(codePoint)) {
      stripped += character;
    }
  }
  return stripped.length > MAX_MESSAGE_SEGMENT_LENGTH
    ? `${stripped.slice(0, MAX_MESSAGE_SEGMENT_LENGTH)}...`
    : stripped;
}

/** A path safe to embed in a message: every string segment sanitized, per `sanitizeForMessage`. */
function safeFormatPath(path: readonly PathSegment[]): string {
  return formatPath(
    path.map((segment) => (typeof segment === "string" ? sanitizeForMessage(segment) : segment)),
  );
}

/**
 * Walks a `parameters` value confirming three things at once, at every
 * depth — not only among the top-level parameter names: that it contains no
 * key `isUnsafeKey` rejects, that it is a valid `JsonValue` (primitives,
 * `null`, arrays, and plain objects only — nothing `JSON.parse` itself could
 * never produce, such as `undefined` nested inside an array, which is
 * reachable here because this module accepts `unknown`, not only the output
 * of `JSON.parse`), and that it contains no cycle (a value cannot be its own
 * ancestor — not representable as `JsonValue` at all, and fatal to a naive
 * `JSON.stringify` anywhere downstream, e.g. Task 2's handler logging a
 * rejection).
 *
 * Two `WeakSet`s implement a standard three-colour DFS, which is the only
 * combination that rejects a genuine cycle without re-walking a shared
 * subtree:
 * - `onPath` holds every value currently an ancestor of the one being
 *   checked: added just before recursing into it, deleted just after. A
 *   value already in `onPath` is, by construction, its own ancestor — a
 *   real cycle — and is rejected.
 * - `validated` holds every value whose entire subtree has already passed,
 *   permanently. A value already in `validated` (and not in `onPath`) was
 *   reached the first time through one branch and is being reached again
 *   through a different one — a DAG, not a cycle (`{a: shared, b: shared}`,
 *   or two array elements pointing at the same object — an in-process
 *   caller reusing a shared defaults object hits this immediately). It is
 *   pruned, not rejected, matching `packages/core/src/define.ts`'s
 *   `assertNoUnsafeKeys`: core accepts the same shape in a manifest.
 *
 * `onPath` is checked before `validated` — an ancestor is always a cycle
 * regardless of what else is true about it. Every distinct value is walked
 * to completion at most once (on its first visit; every later visit is
 * pruned via `validated` in O(1)), so a DAG with a shared subtree costs
 * linear time in the number of distinct values, not exponential in how many
 * places reference them. An earlier version of this function used one
 * `WeakSet` with "add, never delete" semantics: that rejected every DAG
 * revisit as a false-positive cycle. A version using "add before recursing,
 * delete after, nothing permanent" restores cycle rejection but re-walks a
 * shared subtree from scratch on every reference to it — exponential on a
 * diamond-shaped DAG repeated to any real depth, which is a worse
 * denial-of-service than the false positive it fixes. Both are wrong alone;
 * only the combination is both correct and linear.
 *
 * Throws with a precise message (rather than returning a boolean) because
 * only this function knows which check failed and where.
 */
function checkParameterValue(
  value: unknown,
  path: readonly PathSegment[],
  depth: number,
  onPath: WeakSet<object>,
  validated: WeakSet<object>,
): void {
  if (depth > MAX_PARAMETER_DEPTH) {
    // Reason first, location last: fail() truncates the tail of an
    // overlong message, and the location (a path, potentially dozens of
    // segments deep) is exactly the part that can be that long. Putting it
    // last means a truncated message still says why it was rejected.
    fail(
      `Parameter value exceeds the maximum nesting depth of ${MAX_PARAMETER_DEPTH} (at "${safeFormatPath(path)}").`,
    );
  }

  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return;

  if (Array.isArray(value)) {
    if (onPath.has(value)) {
      fail(`Parameter value contains a circular reference (at "${safeFormatPath(path)}").`);
    }
    if (validated.has(value)) return;
    onPath.add(value);
    value.forEach((item, index) =>
      checkParameterValue(item, [...path, index], depth + 1, onPath, validated),
    );
    onPath.delete(value);
    validated.add(value);
    return;
  }

  if (isPlainObject(value)) {
    if (onPath.has(value)) {
      fail(`Parameter value contains a circular reference (at "${safeFormatPath(path)}").`);
    }
    if (validated.has(value)) return;
    onPath.add(value);
    for (const key of Object.keys(value)) {
      if (isUnsafeKey(key)) {
        // `key` is one of the three literal names UNSAFE_KEYS contains — safe
        // to embed directly, unlike the arbitrary caller-supplied strings
        // sanitizeForMessage exists for.
        fail(`Parameter name "${key}" is not allowed (at "${safeFormatPath(path)}").`);
      }
      checkParameterValue(value[key], [...path, key], depth + 1, onPath, validated);
    }
    onPath.delete(value);
    validated.add(value);
    return;
  }

  // Reason first, location last — see the comment on the depth-ceiling fail() above.
  fail(`Parameter value is not a valid JSON value (at "${safeFormatPath(path)}").`);
}

/**
 * Parses and validates a wire-format execute request. This is the only thing
 * standing between the network and `execute()`, so every field is checked
 * before it is trusted:
 *
 * - `resource` must be a non-empty string, no longer than
 *   `MAX_RESOURCE_LENGTH`, and not a name `isUnsafeKey` rejects — it is a
 *   caller-supplied name a server looks up by name, the same risk parameter
 *   names carry, and defense in depth here does not depend on every future
 *   caller of the parsed result remembering to guard its own lookup.
 * - `parameters`, if present, must be a plain object.
 * - No parameter name may be `__proto__`, `constructor`, or `prototype`, at
 *   any depth — see `checkParameterValue`.
 * - Every parameter value must be a valid `JsonValue`, at any depth and
 *   within `MAX_PARAMETER_DEPTH`, and must not contain a cycle. A value
 *   referenced more than once through different branches (a DAG, not a
 *   cycle) is validated once and pruned on later visits rather than
 *   rejected — see `checkParameterValue`'s doc comment.
 *
 * Unknown top-level keys are ignored, not rejected, so a newer client talking
 * to an older server (or vice versa) does not break on a field neither side
 * recognizes yet.
 *
 * Throws a plain `Error` with a precise message, bounded to
 * `MAX_MESSAGE_LENGTH` characters overall, on any violation.
 *
 * These guarantees assume `value` is data-only — the output of `JSON.parse`,
 * the only shipped caller (`handler.ts`'s step 2b). A hand-built object with
 * a getter can defeat the unsafe-key check: a getter on one already-checked
 * property can plant `__proto__` (or `constructor`/`prototype`) onto a
 * different, already-validated object as a side effect of merely being
 * *read* by `checkParameterValue`, after that object's own keys were
 * enumerated and found safe. `JSON.parse` output can never carry a getter,
 * so this is unreachable through the wire protocol as shipped — but nothing
 * about this function's `unknown` parameter type stops a caller from handing
 * it one directly.
 */
export function parseExecuteRequest(value: unknown): QSpecExecuteRequest {
  if (!isPlainObject(value)) {
    fail("Execute request body must be a JSON object.");
  }

  const resource = value["resource"];
  if (typeof resource !== "string" || resource === "") {
    fail('"resource" is required and must be a non-empty string.');
  }
  if (resource.length > MAX_RESOURCE_LENGTH) {
    fail(
      `"resource" must be at most ${MAX_RESOURCE_LENGTH} characters (received ${resource.length}).`,
    );
  }
  if (isUnsafeKey(resource)) {
    // `resource` is one of the three literal unsafe names here — safe to embed.
    fail(`"resource" must not be "${resource}", which can corrupt object prototypes.`);
  }

  if (!Object.hasOwn(value, "parameters") || value["parameters"] === undefined) {
    return { resource };
  }

  const rawParameters = value["parameters"];
  if (!isPlainObject(rawParameters)) {
    fail('"parameters" must be an object.');
  }

  checkParameterValue(rawParameters, ["parameters"], 0, new WeakSet(), new WeakSet());

  // Built via Object.fromEntries rather than per-key assignment onto a fresh
  // `{}`: assigning through a caller-supplied bracket key (`out[key] = ...`)
  // onto an ordinary object is exactly the operation that turns a key literally
  // named `__proto__` into real prototype mutation, unlike reading it.
  // checkParameterValue above has already proven no key anywhere in
  // `rawParameters` is unsafe, so this is defense in depth, not a
  // substitute for that check. Each value is carried through by reference,
  // not deep-cloned: checkParameterValue has already walked it, and nothing
  // here mutates it afterward.
  const entries: [string, JsonValue][] = Object.keys(rawParameters).map((key) => [
    key,
    rawParameters[key] as JsonValue,
  ]);

  return { resource, parameters: Object.fromEntries(entries) };
}
