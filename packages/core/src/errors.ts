/** A path segment: an object key or an array index. */
export type PathSegment = string | number;

/** One structured validation problem. Multiple issues are aggregated on a single error. */
export interface QSpecIssue {
  /** Stable machine-readable code, e.g. QSPEC_MANIFEST_INVALID. */
  readonly code: string;
  /** Human-readable description of the problem. */
  readonly message: string;
  /** Location of the problem within the manifest or parameter set. */
  readonly path: readonly PathSegment[];
  /** Optional "did you mean" hint. */
  readonly suggestion?: string;
}

export interface QSpecErrorOptions {
  readonly code: string;
  readonly path?: readonly PathSegment[];
  readonly details?: unknown;
  readonly cause?: unknown;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Renders a path array as the dotted/indexed form used in diagnostics,
 * e.g. `spec.presentation.series[0].field`. (SPEC.md §71)
 */
export function formatPath(path: readonly PathSegment[]): string {
  if (path.length === 0) return "<root>";
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (IDENTIFIER.test(segment)) {
      out += out === "" ? segment : `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}

/** Base class for every error QSpec throws. (SPEC.md §70) */
export class QSpecError extends Error {
  readonly code: string;
  readonly path?: readonly PathSegment[];
  readonly details?: unknown;

  constructor(message: string, options: QSpecErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QSpecError";
    this.code = options.code;
    if (options.path !== undefined) this.path = options.path;
    if (options.details !== undefined) this.details = options.details;
  }
}

interface IssueErrorOptions {
  readonly issues: readonly QSpecIssue[];
  readonly cause?: unknown;
}

/** Base for errors that aggregate several independent problems into one throw. */
class AggregateQSpecError extends QSpecError {
  readonly issues: readonly QSpecIssue[];

  constructor(message: string, code: string, options: IssueErrorOptions) {
    super(message, { code, details: options.issues, cause: options.cause });
    this.issues = options.issues;
  }
}

export class ManifestValidationError extends AggregateQSpecError {
  constructor(message: string, options: IssueErrorOptions) {
    super(message, "QSPEC_MANIFEST_INVALID", options);
    this.name = "ManifestValidationError";
  }
}

export class ParameterValidationError extends AggregateQSpecError {
  constructor(message: string, options: IssueErrorOptions) {
    super(message, "QSPEC_PARAMETER_INVALID", options);
    this.name = "ParameterValidationError";
  }
}

export class DatasetValidationError extends AggregateQSpecError {
  constructor(message: string, options: IssueErrorOptions) {
    super(message, "QSPEC_DATASET_INVALID", options);
    this.name = "DatasetValidationError";
  }
}

export class PresentationError extends AggregateQSpecError {
  constructor(message: string, options: IssueErrorOptions) {
    super(message, "QSPEC_PRESENTATION_INVALID", options);
    this.name = "PresentationError";
  }
}

export class UnsupportedApiVersionError extends QSpecError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "QSPEC_API_VERSION_UNSUPPORTED", path: ["apiVersion"], details });
    this.name = "UnsupportedApiVersionError";
  }
}

export class UnknownResourceKindError extends QSpecError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "QSPEC_RESOURCE_KIND_UNKNOWN", path: ["kind"], details });
    this.name = "UnknownResourceKindError";
  }
}

export class UnknownQueryLanguageError extends QSpecError {
  constructor(message: string, details?: unknown) {
    super(message, {
      code: "QSPEC_QUERY_LANGUAGE_UNKNOWN",
      path: ["spec", "query", "language"],
      details,
    });
    this.name = "UnknownQueryLanguageError";
  }
}

export class UnknownDataSourceError extends QSpecError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "QSPEC_SOURCE_NOT_FOUND", path: ["spec", "query", "source"], details });
    this.name = "UnknownDataSourceError";
  }
}

export class QueryCompilationError extends QSpecError {
  constructor(message: string, options?: { cause?: unknown; details?: unknown }) {
    super(message, { code: "QSPEC_QUERY_COMPILATION_FAILED", ...options });
    this.name = "QueryCompilationError";
  }
}

export class QueryExecutionError extends QSpecError {
  constructor(message: string, options?: { cause?: unknown; details?: unknown }) {
    super(message, { code: "QSPEC_QUERY_FAILED", ...options });
    this.name = "QueryExecutionError";
  }
}

export class TransformError extends QSpecError {
  constructor(
    message: string,
    options?: { cause?: unknown; details?: unknown; path?: readonly PathSegment[] },
  ) {
    super(message, { code: "QSPEC_TRANSFORM_FAILED", ...options });
    this.name = "TransformError";
  }
}

export class PluginRegistrationError extends QSpecError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "QSPEC_PLUGIN_REGISTRATION_FAILED", details });
    this.name = "PluginRegistrationError";
  }
}

/** Thrown when execution is cancelled through an AbortSignal. (SPEC.md §60) */
export class QSpecAbortError extends QSpecError {
  constructor(message = "QSpec execution was aborted", options?: { cause?: unknown }) {
    super(message, { code: "QSPEC_EXECUTION_ABORTED", ...options });
    this.name = "QSpecAbortError";
  }
}

/** Thrown when a configured resource limit is exceeded. (SPEC.md §72.5) */
export class LimitExceededError extends QSpecError {
  constructor(message: string, details?: unknown) {
    super(message, { code: "QSPEC_LIMIT_EXCEEDED", details });
    this.name = "LimitExceededError";
  }
}
