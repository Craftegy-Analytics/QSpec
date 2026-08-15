import { describe, expect, it } from "vitest";
import {
  DatasetValidationError,
  LimitExceededError,
  ManifestValidationError,
  ParameterValidationError,
  PluginRegistrationError,
  PresentationError,
  QSpecAbortError,
  QSpecError,
  QueryCompilationError,
  QueryExecutionError,
  TransformError,
  UnknownDataSourceError,
  UnknownQueryLanguageError,
  UnknownResourceKindError,
  UnsupportedApiVersionError,
  formatPath,
  type PathSegment,
} from "./errors.js";

describe("QSpecError", () => {
  it("carries a stable code and is an Error", () => {
    const error = new QSpecError("boom", { code: "QSPEC_TEST" });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("QSPEC_TEST");
    expect(error.name).toBe("QSpecError");
    expect(error.message).toBe("boom");
  });

  it("preserves cause and details", () => {
    const cause = new Error("underlying");
    const error = new QSpecError("boom", { code: "QSPEC_TEST", cause, details: { a: 1 } });
    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ a: 1 });
  });

  it("exposes a path when given one", () => {
    const error = new QSpecError("boom", { code: "QSPEC_TEST", path: ["spec", "query"] });
    expect(error.path).toEqual(["spec", "query"]);
  });
});

interface ErrorCase {
  readonly name: string;
  readonly code: string;
  readonly create: () => QSpecError;
  readonly path?: readonly PathSegment[];
}

const errorCases: readonly ErrorCase[] = [
  {
    name: "ManifestValidationError",
    code: "QSPEC_MANIFEST_INVALID",
    create: () => new ManifestValidationError("x", { issues: [] }),
  },
  {
    name: "ParameterValidationError",
    code: "QSPEC_PARAMETER_INVALID",
    create: () => new ParameterValidationError("x", { issues: [] }),
  },
  {
    name: "DatasetValidationError",
    code: "QSPEC_DATASET_INVALID",
    create: () => new DatasetValidationError("x", { issues: [] }),
  },
  {
    name: "PresentationError",
    code: "QSPEC_PRESENTATION_INVALID",
    create: () => new PresentationError("x", { issues: [] }),
  },
  {
    name: "UnsupportedApiVersionError",
    code: "QSPEC_API_VERSION_UNSUPPORTED",
    create: () => new UnsupportedApiVersionError("x"),
    path: ["apiVersion"],
  },
  {
    name: "UnknownResourceKindError",
    code: "QSPEC_RESOURCE_KIND_UNKNOWN",
    create: () => new UnknownResourceKindError("x"),
    path: ["kind"],
  },
  {
    name: "UnknownQueryLanguageError",
    code: "QSPEC_QUERY_LANGUAGE_UNKNOWN",
    create: () => new UnknownQueryLanguageError("x"),
    path: ["spec", "query", "language"],
  },
  {
    name: "UnknownDataSourceError",
    code: "QSPEC_SOURCE_NOT_FOUND",
    create: () => new UnknownDataSourceError("x"),
    path: ["spec", "query", "source"],
  },
  {
    name: "QueryCompilationError",
    code: "QSPEC_QUERY_COMPILATION_FAILED",
    create: () => new QueryCompilationError("x"),
  },
  {
    name: "QueryExecutionError",
    code: "QSPEC_QUERY_FAILED",
    create: () => new QueryExecutionError("x"),
  },
  {
    name: "TransformError",
    code: "QSPEC_TRANSFORM_FAILED",
    create: () => new TransformError("x"),
  },
  {
    name: "PluginRegistrationError",
    code: "QSPEC_PLUGIN_REGISTRATION_FAILED",
    create: () => new PluginRegistrationError("x"),
  },
  {
    name: "QSpecAbortError",
    code: "QSPEC_EXECUTION_ABORTED",
    create: () => new QSpecAbortError(),
  },
  {
    name: "LimitExceededError",
    code: "QSPEC_LIMIT_EXCEEDED",
    create: () => new LimitExceededError("x"),
  },
];

describe.each(errorCases)("$name", ({ name, code, create, path }) => {
  it("has the documented code, class name, and is instanceof QSpecError", () => {
    const error = create();
    expect(error.code).toBe(code);
    expect(error.name).toBe(name);
    expect(error).toBeInstanceOf(QSpecError);
    expect(error).toBeInstanceOf(Error);
    if (path !== undefined) {
      expect(error.path).toEqual(path);
    }
  });
});

describe("concrete error classes", () => {
  it("carry structured issues on validation errors", () => {
    const error = new ManifestValidationError("invalid", {
      issues: [{ code: "QSPEC_MANIFEST_INVALID", message: "missing", path: ["metadata", "name"] }],
    });
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.path).toEqual(["metadata", "name"]);
  });
});

describe("formatPath", () => {
  it("renders object keys with dots and array indices with brackets", () => {
    expect(formatPath(["spec", "presentation", "series", 0, "field"])).toBe(
      "spec.presentation.series[0].field",
    );
  });

  it("renders the empty path as <root>", () => {
    expect(formatPath([])).toBe("<root>");
  });

  it("bracket-quotes keys that are not plain identifiers", () => {
    expect(formatPath(["spec", "parameters", "from-date"])).toBe('spec.parameters["from-date"]');
  });
});
