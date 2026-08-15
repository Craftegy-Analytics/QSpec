import type { QSpecIssue } from "../errors.js";

/** Fields common to every execution-scoped event. */
export interface ExecutionEventBase {
  readonly executionId: string;
  readonly resource: string;
}

/**
 * Lifecycle events. Payloads deliberately exclude bound parameter values,
 * statements, and connection details — nothing sensitive is emitted by default.
 * (SPEC.md §68, §72.6, §84)
 */
export interface QSpecEventMap {
  "manifest:parse:start": { readonly bytes?: number };
  "manifest:parse:end": { readonly kind: string; readonly name: string };
  "validation:start": { readonly stage: string };
  "validation:end": { readonly stage: string; readonly issues: readonly QSpecIssue[] };
  "query:compile:start": ExecutionEventBase & { readonly language: string };
  "query:compile:end": ExecutionEventBase & {
    readonly language: string;
    readonly durationMs: number;
  };
  "query:execute:start": ExecutionEventBase & {
    readonly source: string;
    readonly language: string;
  };
  "query:execute:end": ExecutionEventBase & {
    readonly source: string;
    readonly language: string;
    readonly durationMs: number;
    readonly rowCount: number;
  };
  "dataset:normalize:duplicate-column": ExecutionEventBase & {
    readonly original: string;
    readonly renamed: string;
  };
  "transform:start": ExecutionEventBase & { readonly type: string; readonly index: number };
  "transform:end": ExecutionEventBase & {
    readonly type: string;
    readonly index: number;
    readonly durationMs: number;
    readonly rowCount: number;
  };
  "execution:complete": ExecutionEventBase & {
    readonly durationMs: number;
    readonly rowCount: number;
    readonly success: true;
  };
  "execution:error": ExecutionEventBase & {
    readonly durationMs: number;
    readonly code: string;
    readonly success: false;
  };
}

export type QSpecEventName = keyof QSpecEventMap;

export type QSpecEventHandler<E extends QSpecEventName> = (payload: QSpecEventMap[E]) => void;

export interface HookRegistry {
  /** Subscribes to an event. Returns an unsubscribe function. */
  on<E extends QSpecEventName>(event: E, handler: QSpecEventHandler<E>): () => void;
  emit<E extends QSpecEventName>(event: E, payload: QSpecEventMap[E]): void;
}

/** Minimal logger contract. Core imposes no logging library. (SPEC.md §85) */
export interface QSpecLogger {
  debug?(message: string, context?: unknown): void;
  info?(message: string, context?: unknown): void;
  warn?(message: string, context?: unknown): void;
  error?(message: string, context?: unknown): void;
}
