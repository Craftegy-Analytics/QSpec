import {
  ExecutionContextError,
  ExecutionDeniedError,
  ExecutionPolicyError,
  QSpecAbortError,
  type PathSegment,
  type QSpecIssue,
} from "../errors.js";
import { createRow, isPlainObject, setKey } from "../json.js";
import type { HookRegistry } from "../types/events.js";
import type { ExecutionPolicy, ExecutionPolicyInput } from "../types/policy.js";
import { throwIfAborted } from "./abort.js";

/** One registered policy, in the order `runPolicies` evaluates it. */
export interface PolicyEntry {
  readonly name: string;
  readonly policy: ExecutionPolicy;
}

/** Raised for metadata core cannot read. Fixed text: nothing the host's object threw is kept. */
function unreadableMetadata(): ExecutionContextError {
  return new ExecutionContextError(
    "`metadata` could not be read: one of its properties threw when it was copied.",
    ["metadata"],
  );
}

/**
 * One shallow, frozen, null-prototype copy per execution, shared by every policy and the data
 * source, so a policy cannot add, remove or replace a key the source reads, and a key named like
 * an `Object.prototype` member reads as absent. Values are the host's own references (a
 * transaction handle must stay live), so they are neither cloned nor frozen. (SPEC.md §59)
 *
 * Anything but `undefined` or a plain object is rejected rather than ignored or spread: a string
 * or an array spread into a record would hand the source keys nobody meant to pass. An object
 * whose getters or proxy traps throw while it is copied is rejected the same way. No error
 * message includes a value or anything the host's object threw, and none attaches it as `cause`.
 * (policy design 3.10)
 */
export function freezeMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  let plain: boolean;
  try {
    plain = isPlainObject(value);
  } catch {
    throw unreadableMetadata();
  }
  if (!plain) {
    throw new ExecutionContextError(
      "`metadata` must be a plain object. Wrap other values, for example `{ scope: value }`.",
      ["metadata"],
    );
  }
  const source = value as Record<string, unknown>;
  const copy = createRow<unknown>();
  try {
    for (const key of Object.keys(source)) setKey(copy, key, source[key]);
  } catch {
    throw unreadableMetadata();
  }
  return Object.freeze(copy);
}

/** A path segment is a string or a finite number (an array index); nothing else. */
function isPathSegment(value: unknown): value is PathSegment {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Rebuilds one issue from a policy's value, reading each field exactly once, or returns
 * `undefined` when it is not a well-formed issue. Only `code`, `message`, `path` and `suggestion`
 * are kept, so a getter cannot pass the check and then change, and nothing else a policy attached
 * (a metadata value, for instance) reaches the error or the `policy:decision` event.
 */
function rebuildIssue(value: unknown): QSpecIssue | undefined {
  if (!isPlainObject(value)) return undefined;
  const code = value["code"];
  const message = value["message"];
  const path = value["path"];
  const suggestion = Object.hasOwn(value, "suggestion") ? value["suggestion"] : undefined;
  if (typeof code !== "string" || typeof message !== "string" || !Array.isArray(path)) {
    return undefined;
  }
  if (suggestion !== undefined && typeof suggestion !== "string") return undefined;
  const segments: PathSegment[] = [];
  const length = path.length;
  for (let index = 0; index < length; index += 1) {
    const segment: unknown = path[index];
    if (!isPathSegment(segment)) return undefined;
    segments.push(segment);
  }
  return Object.freeze({
    code,
    message,
    path: Object.freeze(segments),
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

/** Every issue rebuilt, or `undefined` when the value is not an array of well-formed issues. */
function rebuildIssues(value: unknown): readonly QSpecIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: QSpecIssue[] = [];
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    const issue = rebuildIssue(value[index]);
    if (issue === undefined) return undefined;
    issues.push(issue);
  }
  return Object.freeze(issues);
}

type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly error: ExecutionDeniedError }
  | { readonly kind: "error"; readonly error: QSpecAbortError | ExecutionPolicyError };

/**
 * Anything but a well-formed decision denies or fails: never allows. (policy design 3.7) Each
 * field is read once; the reported issues are rebuilt and frozen, so a policy that keeps and
 * later mutates its own objects cannot rewrite the error.
 */
function readDecision(name: string, decision: unknown): Verdict {
  if (isPlainObject(decision)) {
    const outcome = decision["outcome"];
    if (outcome === "allow") return { kind: "allow" };
    if (outcome === "deny") {
      const issues = rebuildIssues(decision["issues"]);
      if (issues !== undefined) {
        const reported: readonly QSpecIssue[] =
          issues.length > 0
            ? issues
            : Object.freeze([
                Object.freeze({
                  code: "QSPEC_EXECUTION_DENIED",
                  message: `Policy "${name}" denied the execution without reporting a reason.`,
                  path: Object.freeze([]),
                }),
              ]);
        return {
          kind: "deny",
          error: new ExecutionDeniedError({ policy: name, issues: reported }),
        };
      }
    }
  }
  return {
    kind: "error",
    error: new ExecutionPolicyError(`Policy "${name}" returned something that is not a decision.`, {
      policy: name,
    }),
  };
}

/**
 * A thrown denial is rebuilt under the registered name, so a policy cannot attribute its denial
 * to another. Its issues go through the same check as a returned denial, so a thrown denial with
 * malformed issues fails closed too. A throw is a cancellation only when the caller's signal is
 * actually aborted: an `AbortError`, `TimeoutError` or `QSpecAbortError` from the policy's own
 * backend while the signal is live is that policy's failure. Every other throw fails closed as
 * ExecutionPolicyError, including other QSpecErrors: a policy must not surface as a validation
 * error whose issues @qspecs/http would forward, nor as a client abort (499) it never was.
 */
function readThrow(name: string, error: unknown, signal: AbortSignal | undefined): Verdict {
  if (error instanceof ExecutionDeniedError) {
    try {
      return readDecision(name, { outcome: "deny", issues: error.issues });
    } catch (cause) {
      // An issue whose properties throw when read: still a failure, never an allow.
      return {
        kind: "error",
        error: new ExecutionPolicyError(`Policy "${name}" failed while checking the execution.`, {
          policy: name,
          cause,
        }),
      };
    }
  }
  if (signal?.aborted === true) {
    return {
      kind: "error",
      error:
        error instanceof QSpecAbortError
          ? error
          : new QSpecAbortError("QSpec execution was aborted.", { cause: error }),
    };
  }
  return {
    kind: "error",
    error: new ExecutionPolicyError(`Policy "${name}" failed while checking the execution.`, {
      policy: name,
      cause: error,
    }),
  };
}

/**
 * Settles one `check`, or rejects with QSpecAbortError as soon as the caller's signal aborts, so
 * a policy that never settles (a hung backend call) cannot hold the execution past the caller's
 * cancellation. A result or rejection that arrives after the abort is ignored, never unhandled.
 */
async function check(policy: ExecutionPolicy, input: ExecutionPolicyInput): Promise<unknown> {
  const checking = Promise.resolve().then(() => policy.check(input));
  const signal = input.signal;
  if (signal === undefined) return checking;
  // The race below leaves `checking` behind on an abort; this keeps its late rejection handled.
  checking.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new QSpecAbortError("QSpec execution was aborted.", { cause: signal.reason }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([checking, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs every policy in registration order. The first denial or failure throws; nothing after it
 * runs, and the caller never reaches the data source. (SPEC.md §110; policy design 3.5)
 *
 * The signal is checked before each policy and once after the last, so a cancellation during a
 * policy surfaces as QSpecAbortError even when that policy allowed. One `policy:decision` event
 * per policy evaluated, carrying codes and timing only.
 */
export async function runPolicies(
  entries: readonly PolicyEntry[],
  input: ExecutionPolicyInput,
  hooks: HookRegistry,
): Promise<void> {
  const base = { executionId: input.executionId, resource: input.resource.name } as const;
  for (const { name, policy } of entries) {
    throwIfAborted(input.signal);
    const startedAt = performance.now();
    let verdict: Verdict;
    try {
      verdict = readDecision(name, await check(policy, input));
    } catch (error) {
      verdict = readThrow(name, error, input.signal);
    }
    hooks.emit("policy:decision", {
      ...base,
      policy: name,
      outcome: verdict.kind,
      codes:
        verdict.kind === "allow"
          ? []
          : verdict.kind === "deny"
            ? verdict.error.issues.map((issue) => issue.code)
            : [verdict.error.code],
      durationMs: performance.now() - startedAt,
    });
    if (verdict.kind !== "allow") throw verdict.error;
  }
  throwIfAborted(input.signal);
}
