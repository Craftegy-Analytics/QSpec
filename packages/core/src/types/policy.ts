import type { QSpecIssue } from "../errors.js";
import type { QSpecManifest, QSpecResourceSpec } from "./manifest.js";

/**
 * What one binding reads. A literal's value is omitted here; the literal the manifest declares is
 * still readable through `ExecutionPolicyInput.manifest`.
 */
export type PolicyBinding =
  { readonly kind: "parameter"; readonly parameter: string } | { readonly kind: "literal" };

export interface PolicyQuery {
  readonly language: string;
  readonly source: string;
  /** Binding name to what it reads, from `spec.query.bindings`. (design §2.1) */
  readonly bindings: Readonly<Record<string, PolicyBinding>>;
  /**
   * `QueryLanguage.policyView(compiled)`, deep-frozen. `undefined` when the language defines no
   * view. Narrow it with the language package's guard, for example `isSqlPolicyView`.
   */
  readonly view: unknown;
}

/**
 * Everything a policy may see: never a caller-supplied value (no parameter value and nothing
 * resolved from one). What the manifest itself declares, including binding literals and parameter
 * defaults, is visible through `manifest`. (SPEC.md §61, §72.6)
 */
export interface ExecutionPolicyInput {
  readonly executionId: string;
  readonly resource: { readonly kind: string; readonly name: string };
  readonly manifest: QSpecManifest<QSpecResourceSpec>;
  /** `undefined` when the resource declares no `spec.query`. */
  readonly query: PolicyQuery | undefined;
  /**
   * The frozen, null-prototype shallow copy of `ExecutionContext.metadata`, shared with the data
   * source.
   */
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly signal: AbortSignal | undefined;
}

export type ExecutionPolicyDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly issues: readonly QSpecIssue[] };

/** Approves or rejects one execution before its data source runs. (SPEC.md §110) */
export interface ExecutionPolicy {
  check(input: ExecutionPolicyInput): ExecutionPolicyDecision | Promise<ExecutionPolicyDecision>;
}
