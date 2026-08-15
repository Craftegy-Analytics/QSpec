# QSpec Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the QSpec monorepo, `@qspecs/core`, `@qspecs/schema`, and `qspec validate`, reaching the Definition of Done in SPEC.md §115.

**Architecture:** An npm workspace of ESM-only TypeScript packages built with `tsc --build` project references. `@qspecs/core` has zero runtime dependencies and performs hand-written structural validation that produces precise error paths; `@qspecs/schema` publishes JSON Schema documents plus an Ajv validator, with a conformance test asserting the two validators never disagree. Execution splits into `prepare()` (all static work, done once) and `execute()` (per-call work).

**Tech Stack:** TypeScript 5.7+, Node.js ≥20.11, npm workspaces, Vitest 3, Ajv 8, Prettier, GitHub Actions.

**Design document:** `docs/superpowers/specs/2026-08-09-qspec-design.md`
**Source specification:** `SPEC.md`

## Global Constraints

- **`@qspecs/core` must have zero runtime dependencies.** No `dependencies` key with entries in `packages/core/package.json`, ever. (SPEC.md §12)
- **ESM only.** Every `package.json` sets `"type": "module"`. No CommonJS build. (SPEC.md §75)
- **No `eval`, no `new Function`, no dynamic code execution** anywhere in any package. (SPEC.md §72.3)
- **Every package sets `"sideEffects": false`.** (SPEC.md §74)
- **Every package's `exports` map exposes only `.` and `./package.json`.** Internal modules live in `src/internal/` and must be unreachable from outside. (SPEC.md §104)
- **Node engine floor:** `">=20.11"` in every `package.json`.
- **Package version:** all packages start at `0.1.0`.
- **License:** `MIT` in every `package.json` and a root `LICENSE` file. (SPEC.md §1 says "to be determined"; MIT is chosen here and should be raised with the maintainer if wrong.)
- **API version:** the only supported specification version is the exact string `qspec.dev/v1`. (SPEC.md §23)
- **Metadata name pattern:** `^[a-z][a-z0-9-]*$`. (SPEC.md §25)
- **Error codes are stable strings** and must never be changed once written. (SPEC.md §70)
- **TypeScript strictness:** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`.
- **Relative imports inside a package must carry the `.js` extension** (ESM + `verbatimModuleSyntax` requirement), e.g. `import { QSpecError } from "./errors.js"`.
- **Commit after every task.** Conventional Commits format (`feat:`, `test:`, `chore:`, `docs:`).

---

## File Structure

```
qspec/
├── package.json                       workspace root, scripts, devDependencies
├── tsconfig.base.json                 shared compiler options
├── tsconfig.json                      solution file, project references
├── vitest.config.ts                   workspace test projects
├── .prettierrc.json
├── LICENSE
├── README.md
├── .github/workflows/ci.yml
├── schemas/v1/                        published JSON Schema documents (source of truth)
│   ├── qspec.json
│   └── chart.json
├── fixtures/
│   ├── valid/*.qspec.json
│   └── invalid/*.qspec.json
├── examples/
├── docs/
│   ├── architecture.md
│   └── superpowers/{specs,plans}/
└── packages/
    ├── core/
    │   ├── package.json
    │   ├── tsconfig.build.json
    │   └── src/
    │       ├── index.ts               public surface — the ONLY export point
    │       ├── json.ts                JsonValue types, null-prototype helpers
    │       ├── errors.ts              QSpecError hierarchy, codes, QSpecIssue
    │       ├── version.ts             SUPPORTED_API_VERSIONS
    │       ├── define.ts              defineManifest, definePlugin
    │       ├── types/
    │       │   ├── manifest.ts        QSpecManifest, ManifestMetadata, ResourceSpec
    │       │   ├── parameters.ts      ParameterDefinition, ParameterValidation
    │       │   ├── query.ts           QueryDefinition, Binding
    │       │   ├── expression.ts      Expression AST
    │       │   ├── dataset.ts         Field, Dataset, RawQueryResult
    │       │   ├── presentation.ts    PresentationDefinition, PresentationType
    │       │   ├── plugin.ts          QSpecPlugin, QSpecPluginAPI, capability contracts
    │       │   └── runtime.ts         QSpec, ExecutionContext, QSpecResult, limits, logger
    │       └── internal/
    │           ├── registry.ts        Registry implementation
    │           ├── suggest.ts         Levenshtein "did you mean"
    │           ├── hooks.ts           typed lifecycle emitter
    │           ├── bindings.ts        binding parsing and resolution
    │           ├── normalize-result.ts  RawQueryResult -> Dataset
    │           ├── expression/
    │           │   ├── normalize.ts   shorthand -> AST, depth limit
    │           │   └── evaluate.ts    interpreter
    │           ├── validate/
    │           │   ├── manifest.ts    structural validation (stage 1)
    │           │   ├── parameters.ts  parameter compile + runtime validation (stage 3)
    │           │   ├── dataset.ts     dataset validation (stage 5)
    │           │   └── presentation.ts presentation field refs (stage 6)
    │           ├── prepare.ts         prepare() pipeline
    │           ├── execute.ts         execute() pipeline
    │           └── runtime.ts         createQSpec implementation
    ├── schema/
    ├── cli/
    └── testing/                       private, added in a later plan
```

---

### Task 1: Workspace scaffolding and the error model

Sets up the monorepo and delivers the first real unit of core: the structured error
hierarchy from SPEC.md §70–§71. Scaffolding is folded in here because the error tests are
the first thing that needs a working build and test runner.

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.prettierrc.json`, `.gitignore` (already exists — leave it), `LICENSE`
- Create: `packages/core/package.json`, `packages/core/tsconfig.build.json`
- Create: `packages/core/src/index.ts`, `packages/core/src/errors.ts`
- Test: `packages/core/src/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `QSpecError` (base, with `code`/`path`/`details`/`cause`), `QSpecIssue`, and the concrete error classes `ManifestValidationError`, `UnsupportedApiVersionError`, `UnknownResourceKindError`, `ParameterValidationError`, `UnknownQueryLanguageError`, `UnknownDataSourceError`, `QueryCompilationError`, `QueryExecutionError`, `DatasetValidationError`, `TransformError`, `PresentationError`, `PluginRegistrationError`, `QSpecAbortError`, `LimitExceededError`. Also `formatPath(path)`.

- [ ] **Step 1: Create the workspace root files**

`package.json`:

```json
{
  "name": "qspec-monorepo",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20.11" },
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "tsc --build",
    "clean": "tsc --build --clean",
    "typecheck": "tsc --build --dry",
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "prettier": "^3.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": true
  }
}
```

`tsconfig.json` (solution file — add a reference for each new package as it is created):

```json
{
  "files": [],
  "references": [{ "path": "./packages/core/tsconfig.build.json" }]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
```

`.prettierrc.json`:

```json
{ "semi": true, "singleQuote": false, "trailingComma": "all", "printWidth": 100 }
```

`LICENSE`: standard MIT text, copyright holder `QSpec contributors`, year `2026`.

- [ ] **Step 2: Create the core package files**

`packages/core/package.json` — note there is no `dependencies` key at all:

```json
{
  "name": "@qspecs/core",
  "version": "0.1.0",
  "description": "Core runtime and manifest model for QSpec",
  "type": "module",
  "license": "MIT",
  "sideEffects": false,
  "engines": { "node": ">=20.11" },
  "files": ["dist"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "scripts": { "build": "tsc -p tsconfig.build.json" }
}
```

`packages/core/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/core/src/index.ts` — start with only the errors re-export; every later task appends to this file:

```ts
export * from "./errors.js";
```

- [ ] **Step 3: Install dependencies and confirm the toolchain runs**

Run: `npm install`
Expected: succeeds, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 4: Write the failing test**

`packages/core/src/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DatasetValidationError,
  ManifestValidationError,
  ParameterValidationError,
  QSpecAbortError,
  QSpecError,
  UnknownDataSourceError,
  formatPath,
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

describe("concrete error classes", () => {
  it("assign the documented codes", () => {
    expect(new ManifestValidationError("x", { issues: [] }).code).toBe("QSPEC_MANIFEST_INVALID");
    expect(new ParameterValidationError("x", { issues: [] }).code).toBe("QSPEC_PARAMETER_INVALID");
    expect(new UnknownDataSourceError("x").code).toBe("QSPEC_SOURCE_NOT_FOUND");
    expect(new DatasetValidationError("x", { issues: [] }).code).toBe("QSPEC_DATASET_INVALID");
    expect(new QSpecAbortError().code).toBe("QSPEC_EXECUTION_ABORTED");
  });

  it("set name to the class name so stack traces are readable", () => {
    expect(new UnknownDataSourceError("x").name).toBe("UnknownDataSourceError");
  });

  it("are instanceof QSpecError", () => {
    expect(new UnknownDataSourceError("x")).toBeInstanceOf(QSpecError);
  });

  it("carry structured issues on validation errors", () => {
    const error = new ManifestValidationError("invalid", {
      issues: [
        { code: "QSPEC_MANIFEST_INVALID", message: "missing", path: ["metadata", "name"] },
      ],
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/errors.test.ts`
Expected: FAIL — cannot resolve `./errors.js`.

- [ ] **Step 6: Implement the error model**

`packages/core/src/errors.ts`:

```ts
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
  constructor(message: string, options?: { cause?: unknown; details?: unknown; path?: readonly PathSegment[] }) {
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
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/errors.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 8: Verify the build and formatting**

Run: `npm run build && npm run format`
Expected: build succeeds, `packages/core/dist/errors.js` and `.d.ts` exist.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): add workspace scaffolding and structured error model"
```

---

### Task 2: JSON value model and safe object helpers

Delivers the primitives that make SPEC.md §72.4 (prototype pollution) enforceable
everywhere else. The design draws a deliberate line: **manifests reject** unsafe keys,
**datasets tolerate** them via null-prototype rows, because a database column may legitimately
be named `constructor`.

**Files:**
- Create: `packages/core/src/json.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/json.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: types `JsonPrimitive`, `JsonValue`, `JsonObject`; constants `UNSAFE_KEYS`; functions `isPlainObject(value): value is Record<string, unknown>`, `isUnsafeKey(key): boolean`, `createRow<T = unknown>(): Record<string, T>` (null-prototype), `setKey<T>(target, key, value): void`, `ownKeys(value): string[]`, `deepFreeze<T>(value): T`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/json.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRow, isPlainObject, isUnsafeKey, ownKeys, setKey } from "./json.js";

describe("isPlainObject", () => {
  it("accepts object literals", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("accepts null-prototype objects", () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("rejects arrays, null, and class instances", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});

describe("isUnsafeKey", () => {
  it("flags the prototype-pollution keys named in SPEC.md 72.4", () => {
    expect(isUnsafeKey("__proto__")).toBe(true);
    expect(isUnsafeKey("constructor")).toBe(true);
    expect(isUnsafeKey("prototype")).toBe(true);
  });

  it("allows ordinary keys", () => {
    expect(isUnsafeKey("revenue")).toBe(false);
  });
});

describe("createRow", () => {
  it("produces an object with no prototype", () => {
    const row = createRow();
    expect(Object.getPrototypeOf(row)).toBeNull();
    expect((row as Record<string, unknown>)["toString"]).toBeUndefined();
  });

  it("can hold a column literally named __proto__ without polluting anything", () => {
    const row = createRow();
    setKey(row, "__proto__", 42);
    expect(row["__proto__"]).toBe(42);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("ownKeys", () => {
  it("returns own enumerable string keys in insertion order", () => {
    expect(ownKeys({ b: 1, a: 2 })).toEqual(["b", "a"]);
  });

  it("returns an empty array for non-objects", () => {
    expect(ownKeys(null)).toEqual([]);
    expect(ownKeys(7)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/json.test.ts`
Expected: FAIL — cannot resolve `./json.js`.

- [ ] **Step 3: Implement the JSON helpers**

`packages/core/src/json.ts`:

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Keys that can corrupt an object's prototype chain when assigned onto an
 * ordinary object. Manifest parsing rejects these; dataset rows use
 * null-prototype objects instead, so a real column named `constructor` still
 * works. (SPEC.md §72.4)
 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/** True for object literals and null-prototype objects; false for arrays and class instances. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Creates a null-prototype object, the storage used for every dataset row. */
export function createRow<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Assigns a key on a null-prototype target. `defineProperty` is used because
 * plain assignment to `__proto__` is intercepted by the engine even on some
 * host objects; `defineProperty` always creates an own data property.
 */
export function setKey<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Own enumerable string keys in insertion order; empty for non-objects. */
export function ownKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.keys(value);
}

/** Recursively freezes a value. Used on prepared, cacheable structures. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/json.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export from the public surface**

`packages/core/src/index.ts` — append:

```ts
export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
```

Note: only the *types* are public. `createRow`, `setKey`, and friends are implementation
detail and must not be re-exported.

- [ ] **Step 6: Verify the build**

Run: `npm run build && npx vitest run packages/core`
Expected: build succeeds, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add JSON value model and prototype-safe object helpers"
```

---

### Task 3: Registry

Delivers the generic capability registry from SPEC.md §51, with the specified duplicate
behavior: `register` throws, `replace` is the explicit opt-in.

**Files:**
- Create: `packages/core/src/internal/registry.ts`
- Create: `packages/core/src/types/registry.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/internal/registry.test.ts`

**Interfaces:**
- Consumes: `PluginRegistrationError` from Task 1.
- Produces: interface `Registry<T>` with `register(name, impl): void`, `replace(name, impl): void`, `get(name): T | undefined`, `has(name): boolean`, `list(): readonly string[]`; and `createRegistry<T>(label: string): Registry<T>`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PluginRegistrationError } from "../errors.js";
import { createRegistry } from "./registry.js";

describe("createRegistry", () => {
  it("registers and retrieves implementations", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    expect(registry.get("filter")).toBe(1);
    expect(registry.has("filter")).toBe(true);
  });

  it("returns undefined for unknown names", () => {
    const registry = createRegistry<number>("transform");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.has("nope")).toBe(false);
  });

  it("throws PluginRegistrationError on duplicate registration", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    expect(() => registry.register("filter", 2)).toThrow(PluginRegistrationError);
    expect(registry.get("filter")).toBe(1);
  });

  it("names the registry and the key in the duplicate error message", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    expect(() => registry.register("filter", 2)).toThrow(/transform.*"filter"/);
  });

  it("allows explicit replacement", () => {
    const registry = createRegistry<number>("transform");
    registry.register("filter", 1);
    registry.replace("filter", 2);
    expect(registry.get("filter")).toBe(2);
  });

  it("allows replace on an unregistered name", () => {
    const registry = createRegistry<number>("transform");
    registry.replace("filter", 2);
    expect(registry.get("filter")).toBe(2);
  });

  it("lists names sorted, for deterministic diagnostics", () => {
    const registry = createRegistry<number>("transform");
    registry.register("sort", 1);
    registry.register("filter", 2);
    registry.register("limit", 3);
    expect(registry.list()).toEqual(["filter", "limit", "sort"]);
  });

  it("rejects empty names", () => {
    const registry = createRegistry<number>("transform");
    expect(() => registry.register("", 1)).toThrow(PluginRegistrationError);
  });

  it("is not confused by prototype-shaped names", () => {
    const registry = createRegistry<number>("transform");
    expect(registry.has("constructor")).toBe(false);
    expect(registry.get("__proto__")).toBeUndefined();
    registry.register("constructor", 5);
    expect(registry.get("constructor")).toBe(5);
    expect(registry.list()).toEqual(["constructor"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/registry.test.ts`
Expected: FAIL — cannot resolve `./registry.js`.

- [ ] **Step 3: Implement the registry**

`packages/core/src/types/registry.ts`:

```ts
/** Generic capability registry contract. (SPEC.md §51) */
export interface Registry<T> {
  /** Registers an implementation. Throws if `name` is already registered. */
  register(name: string, implementation: T): void;
  /** Replaces an implementation, whether or not one exists. Explicit by design. */
  replace(name: string, implementation: T): void;
  get(name: string): T | undefined;
  has(name: string): boolean;
  /** Registered names, sorted, for deterministic diagnostics. */
  list(): readonly string[];
}
```

`packages/core/src/internal/registry.ts`:

```ts
import { PluginRegistrationError } from "../errors.js";
import type { Registry } from "../types/registry.js";

/**
 * A Map is used rather than an object so that names like `constructor` and
 * `__proto__` behave as ordinary keys. (SPEC.md §72.4)
 */
export function createRegistry<T>(label: string): Registry<T> {
  const entries = new Map<string, T>();

  return {
    register(name, implementation) {
      if (name === "") {
        throw new PluginRegistrationError(`Cannot register a ${label} with an empty name.`);
      }
      if (entries.has(name)) {
        throw new PluginRegistrationError(
          `A ${label} named "${name}" is already registered. ` +
            `Use replace() if overriding it is intentional.`,
          { registry: label, name },
        );
      }
      entries.set(name, implementation);
    },

    replace(name, implementation) {
      if (name === "") {
        throw new PluginRegistrationError(`Cannot register a ${label} with an empty name.`);
      }
      entries.set(name, implementation);
    },

    get(name) {
      return entries.get(name);
    },

    has(name) {
      return entries.has(name);
    },

    list() {
      return [...entries.keys()].sort();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/registry.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export the type from the public surface**

`packages/core/src/index.ts` — append:

```ts
export type { Registry } from "./types/registry.js";
```

`createRegistry` stays internal.

- [ ] **Step 6: Verify**

Run: `npm run build && npx vitest run packages/core`
Expected: build succeeds, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add generic capability registry"
```

---

### Task 4: Manifest types, `defineManifest`, and safe parsing

Delivers the manifest type surface (SPEC.md §21–§26), the `defineManifest` identity helper
(SPEC.md §56), and `parseManifest`, which rejects prototype-polluting keys at the document
boundary (SPEC.md §72.4) and enforces `maxManifestBytes` (SPEC.md §72.5).

**Files:**
- Create: `packages/core/src/types/manifest.ts`, `packages/core/src/types/parameters.ts`, `packages/core/src/types/query.ts`, `packages/core/src/types/expression.ts`, `packages/core/src/types/presentation.ts`, `packages/core/src/types/dataset.ts`
- Create: `packages/core/src/define.ts`, `packages/core/src/version.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/define.test.ts`

**Interfaces:**
- Consumes: `JsonValue`, `isUnsafeKey` (Task 2); `ManifestValidationError`, `LimitExceededError` (Task 1).
- Produces:
  - `SUPPORTED_API_VERSIONS: readonly ["qspec.dev/v1"]`, `QSPEC_V1 = "qspec.dev/v1"`
  - `QSpecManifest<TSpec = QSpecResourceSpec>` with `$schema?`, `apiVersion`, `kind`, `metadata`, `spec`
  - `ManifestMetadata` with `name`, `title?`, `description?`, `tags?`
  - `QSpecResourceSpec` with `parameters?`, `query?`, `dataset?`, `transforms?`, `presentation?`
  - `ParameterDefinition`, `ParameterType`, `ParameterValidation`, `ParameterPresentation`
  - `QueryDefinition<TStatement = unknown>`, `Binding`
  - `Expression`
  - `DatasetSchema`, `FieldDefinition`, `FieldType`
  - `TransformDefinition`, `PresentationDefinition`
  - `defineManifest<T extends QSpecManifest>(manifest: T): T`
  - `parseManifest(input: string | unknown, options?: { maxBytes?: number }): QSpecManifest`

- [ ] **Step 1: Write the type modules**

`packages/core/src/version.ts`:

```ts
/** The QSpec specification version this runtime implements. (SPEC.md §23, §77) */
export const QSPEC_V1 = "qspec.dev/v1";

/** Every specification version this runtime can execute. (SPEC.md §77) */
export const SUPPORTED_API_VERSIONS: readonly string[] = [QSPEC_V1];
```

`packages/core/src/types/parameters.ts`:

```ts
import type { JsonValue } from "../json.js";

/** Standard parameter types. (SPEC.md §28, §96) */
export type ParameterType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "datetime"
  | "enum"
  | "array";

/**
 * Constraints applied after type coercion. (SPEC.md §29, §96)
 * `min`/`max` apply to `number` and `integer`.
 * `minLength`/`maxLength` apply to `string` length and to `array` length.
 */
export interface ParameterValidation {
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** Advisory UI hints. The core runtime must never depend on these. (SPEC.md §30) */
export interface ParameterPresentation {
  readonly control?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly help?: string;
}

export interface ParameterDefinition {
  readonly type: ParameterType;
  readonly required?: boolean;
  readonly default?: JsonValue;
  readonly description?: string;
  /** Allowed values. Required when `type` is `enum`. (SPEC.md §29) */
  readonly values?: readonly JsonValue[];
  /** Element type. Required when `type` is `array`. */
  readonly items?: { readonly type: Exclude<ParameterType, "array" | "enum"> };
  readonly validation?: ParameterValidation;
  readonly presentation?: ParameterPresentation;
}
```

`packages/core/src/types/expression.ts`:

```ts
import type { JsonValue } from "../json.js";

/**
 * The QSpec expression AST. Intentionally limited: it must not become
 * JavaScript represented as JSON. (SPEC.md §42)
 */
export type Expression =
  | { readonly field: string }
  | { readonly literal: JsonValue }
  | { readonly parameter: string }
  | { readonly operator: string; readonly arguments: readonly Expression[] };

/**
 * The comparison shorthand shown in SPEC.md §40. Normalized into the AST form
 * during prepare(); the canonical serialization always uses the AST form.
 */
export interface ComparisonShorthand {
  readonly field: string;
  readonly operator: string;
  readonly value: JsonValue;
}
```

`packages/core/src/types/query.ts`:

```ts
import type { JsonValue } from "../json.js";

/**
 * A query binding. The string form is valid only when it matches
 * `^\$parameters\.[A-Za-z_]\w*$`; any other string is a manifest error.
 * Literal strings must use the `{ literal }` form. (SPEC.md §34; design §2.1)
 */
export type Binding = string | { readonly parameter: string } | { readonly literal: JsonValue };

/** `statement` is deliberately unconstrained so structured queries work. (SPEC.md §35) */
export interface QueryDefinition<TStatement = unknown> {
  readonly source: string;
  readonly language: string;
  readonly statement: TStatement;
  readonly bindings?: { readonly [name: string]: Binding };
}
```

`packages/core/src/types/dataset.ts`:

```ts
import type { JsonObject } from "../json.js";

/** Standard field types. (SPEC.md §38) */
export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "datetime"
  | "object"
  | "array";

/** A field as declared in a manifest's `spec.dataset.fields`. (SPEC.md §37, §39) */
export interface FieldDefinition {
  readonly type: FieldType;
  readonly nullable?: boolean;
  readonly label?: string;
  /** Semantic meaning; never changes the storage type. (SPEC.md §39) */
  readonly semanticType?: string;
  readonly format?: JsonObject;
}

export interface DatasetSchema {
  readonly fields: { readonly [name: string]: FieldDefinition };
}

/** A field in a materialized dataset. Carries its own name; order is significant. */
export interface Field extends FieldDefinition {
  readonly name: string;
}

/** A dataset row. Always a null-prototype object. (design §2.4) */
export type DatasetRow = Record<string, unknown>;

export interface DatasetMetadata {
  /** True when rows were dropped because `limits.maxRows` was reached. */
  readonly truncated?: boolean;
  readonly [key: string]: unknown;
}

/** The normalized dataset produced by query execution. (SPEC.md §36) */
export interface Dataset {
  readonly fields: readonly Field[];
  readonly rows: readonly DatasetRow[];
  readonly metadata?: DatasetMetadata;
}

export interface RawColumn {
  readonly name: string;
  readonly nativeType?: string;
}

/**
 * What a data source adapter returns. Rows are positional so that duplicate
 * column names and prototype-shaped column names survive normalization, and so
 * columnar backends remain possible. (design §2.4; SPEC.md §62, §113)
 */
export interface RawQueryResult {
  readonly columns: readonly RawColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly metadata?: { readonly durationMs?: number; readonly truncated?: boolean };
}
```

`packages/core/src/types/presentation.ts`:

```ts
import type { PathSegment } from "../errors.js";
import type { Field } from "./dataset.js";

/**
 * Core treats presentation generically: it knows the `type` discriminator and
 * the `x-<vendor>` extension convention, and nothing else. Concrete shapes live
 * in packages such as @qspecs/charts. (SPEC.md §12, §44, §48)
 */
export interface PresentationDefinition {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A dataset field reference found inside a presentation definition. */
export interface FieldReference {
  /** The referenced field name. */
  readonly field: string;
  /** Where the reference sits, relative to `spec.presentation`. */
  readonly path: readonly PathSegment[];
}

export interface PresentationValidationContext {
  /** Fields projected to exist after the transform pipeline, or undefined if unknown. */
  readonly fields: readonly Field[] | undefined;
}

/** Registered by presentation plugins. (SPEC.md §50) */
export interface PresentationType<TDefinition = PresentationDefinition> {
  /** Structural checks specific to this presentation type. Throw to reject. */
  readonly validate?: (
    definition: TDefinition,
    context: PresentationValidationContext,
  ) => void;
  /**
   * Every dataset field this definition references. Core uses these to run
   * validation stage 6 with "did you mean" suggestions. (SPEC.md §80, §86)
   */
  readonly fieldReferences?: (definition: TDefinition) => readonly FieldReference[];
}
```

`packages/core/src/types/manifest.ts`:

```ts
import type { JsonValue } from "../json.js";
import type { DatasetSchema } from "./dataset.js";
import type { ParameterDefinition } from "./parameters.js";
import type { PresentationDefinition } from "./presentation.js";
import type { QueryDefinition } from "./query.js";

/** Recommended machine-friendly name pattern. (SPEC.md §25) */
export const METADATA_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ManifestMetadata {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

/** One entry in `spec.transforms`. (SPEC.md §40) */
export interface TransformDefinition {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface QSpecResourceSpec {
  readonly parameters?: { readonly [name: string]: ParameterDefinition };
  readonly query?: QueryDefinition;
  readonly dataset?: DatasetSchema;
  readonly transforms?: readonly TransformDefinition[];
  readonly presentation?: PresentationDefinition;
  readonly [key: string]: JsonValue | unknown;
}

/** The top-level QSpec resource structure. (SPEC.md §21) */
export interface QSpecManifest<TSpec = QSpecResourceSpec> {
  readonly $schema?: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: ManifestMetadata;
  readonly spec: TSpec;
}
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/define.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LimitExceededError, ManifestValidationError } from "./errors.js";
import { defineManifest, parseManifest } from "./define.js";

const minimal = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "example" },
  spec: { parameters: {} },
};

describe("defineManifest", () => {
  it("returns the manifest unchanged", () => {
    const manifest = defineManifest(minimal);
    expect(manifest).toBe(minimal);
  });

  it("preserves literal types for autocomplete", () => {
    const manifest = defineManifest({ ...minimal, kind: "Chart" } as const);
    const kind: "Chart" = manifest.kind;
    expect(kind).toBe("Chart");
  });
});

describe("parseManifest", () => {
  it("parses a JSON string", () => {
    const manifest = parseManifest(JSON.stringify(minimal));
    expect(manifest.metadata.name).toBe("example");
  });

  it("accepts an already-parsed object", () => {
    expect(parseManifest(minimal).kind).toBe("Dataset");
  });

  it("throws ManifestValidationError on malformed JSON", () => {
    expect(() => parseManifest("{ not json")).toThrow(ManifestValidationError);
  });

  it("rejects a manifest whose root is not an object", () => {
    expect(() => parseManifest("[]")).toThrow(ManifestValidationError);
    expect(() => parseManifest('"hello"')).toThrow(ManifestValidationError);
  });

  it("rejects prototype-polluting keys anywhere in the document", () => {
    const hostile = '{"apiVersion":"qspec.dev/v1","kind":"Dataset",' +
      '"metadata":{"name":"x"},"spec":{"__proto__":{"polluted":true}}}';
    expect(() => parseManifest(hostile)).toThrow(ManifestValidationError);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("reports the path of an unsafe key", () => {
    const hostile = '{"apiVersion":"qspec.dev/v1","kind":"Dataset",' +
      '"metadata":{"name":"x"},"spec":{"constructor":1}}';
    try {
      parseManifest(hostile);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).issues[0]?.path).toEqual(["spec", "constructor"]);
    }
  });

  it("enforces maxBytes on string input", () => {
    expect(() => parseManifest(JSON.stringify(minimal), { maxBytes: 10 })).toThrow(
      LimitExceededError,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/define.test.ts`
Expected: FAIL — cannot resolve `./define.js`.

- [ ] **Step 4: Implement `define.ts`**

```ts
import { LimitExceededError, ManifestValidationError, type PathSegment } from "./errors.js";
import { isUnsafeKey } from "./json.js";
import type { QSpecManifest, QSpecResourceSpec } from "./types/manifest.js";

/**
 * Identity function that preserves literal types and gives editors something to
 * autocomplete against. No runtime work. (SPEC.md §56)
 */
export function defineManifest<const T extends QSpecManifest<QSpecResourceSpec>>(manifest: T): T {
  return manifest;
}

export interface ParseManifestOptions {
  /** Reject documents larger than this many UTF-8 bytes. (SPEC.md §72.5) */
  readonly maxBytes?: number;
}

function fail(message: string, path: readonly PathSegment[]): never {
  throw new ManifestValidationError(message, {
    issues: [{ code: "QSPEC_MANIFEST_INVALID", message, path }],
  });
}

/** Walks a parsed document rejecting keys that can corrupt prototypes. (SPEC.md §72.4) */
function assertNoUnsafeKeys(value: unknown, path: readonly PathSegment[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeKeys(item, [...path, index]));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (isUnsafeKey(key)) {
      fail(
        `Manifest contains the disallowed key "${key}", which can corrupt object prototypes.`,
        [...path, key],
      );
    }
    assertNoUnsafeKeys((value as Record<string, unknown>)[key], [...path, key]);
  }
}

/**
 * Parses and structurally admits a manifest document. This is the document
 * boundary only — semantic validation is a separate stage.
 */
export function parseManifest(
  input: string | unknown,
  options: ParseManifestOptions = {},
): QSpecManifest<QSpecResourceSpec> {
  let document: unknown;

  if (typeof input === "string") {
    if (options.maxBytes !== undefined) {
      const bytes = new TextEncoder().encode(input).byteLength;
      if (bytes > options.maxBytes) {
        throw new LimitExceededError(
          `Manifest is ${bytes} bytes, which exceeds the configured limit of ${options.maxBytes}.`,
          { limit: "maxManifestBytes", actual: bytes, allowed: options.maxBytes },
        );
      }
    }
    try {
      document = JSON.parse(input) as unknown;
    } catch (error) {
      throw new ManifestValidationError("Manifest is not valid JSON.", {
        issues: [
          {
            code: "QSPEC_MANIFEST_INVALID",
            message: error instanceof Error ? error.message : "Unparseable JSON.",
            path: [],
          },
        ],
        cause: error,
      });
    }
  } else {
    document = input;
  }

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    fail("A QSpec manifest must be a JSON object.", []);
  }

  assertNoUnsafeKeys(document, []);
  return document as QSpecManifest<QSpecResourceSpec>;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/define.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Export from the public surface**

`packages/core/src/index.ts` — append:

```ts
export { QSPEC_V1, SUPPORTED_API_VERSIONS } from "./version.js";
export { defineManifest, parseManifest, type ParseManifestOptions } from "./define.js";
export { METADATA_NAME_PATTERN } from "./types/manifest.js";
export type {
  ManifestMetadata,
  QSpecManifest,
  QSpecResourceSpec,
  TransformDefinition,
} from "./types/manifest.js";
export type {
  ParameterDefinition,
  ParameterPresentation,
  ParameterType,
  ParameterValidation,
} from "./types/parameters.js";
export type { Binding, QueryDefinition } from "./types/query.js";
export type { ComparisonShorthand, Expression } from "./types/expression.js";
export type {
  Dataset,
  DatasetMetadata,
  DatasetRow,
  DatasetSchema,
  Field,
  FieldDefinition,
  FieldType,
  RawColumn,
  RawQueryResult,
} from "./types/dataset.js";
export type {
  FieldReference,
  PresentationDefinition,
  PresentationType,
  PresentationValidationContext,
} from "./types/presentation.js";
```

- [ ] **Step 7: Verify**

Run: `npm run build && npx vitest run packages/core`
Expected: build succeeds, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): add manifest type model, defineManifest, and safe parsing"
```

---

### Task 5: Manifest structural validation (validation stage 1)

Delivers hand-written structural validation producing the precise paths SPEC.md §71
requires. This is the validator that `@qspecs/schema` must agree with (Task 17).

**Files:**
- Create: `packages/core/src/internal/validate/manifest.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/internal/validate/manifest.test.ts`

**Interfaces:**
- Consumes: `QSpecIssue`, `ManifestValidationError`, `UnsupportedApiVersionError` (Task 1); `isPlainObject` (Task 2); manifest types and `METADATA_NAME_PATTERN` (Task 4); `SUPPORTED_API_VERSIONS` (Task 4).
- Produces: `validateManifestStructure(manifest: unknown): QSpecIssue[]` (pure — returns issues, never throws) and `assertValidManifest(manifest: unknown): QSpecManifest` (throws `ManifestValidationError` when issues exist).

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/validate/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatPath } from "../../errors.js";
import { validateManifestStructure } from "./manifest.js";

const valid = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "monthly-revenue", title: "Monthly Revenue", tags: ["finance"] },
  spec: {},
};

function paths(manifest: unknown): string[] {
  return validateManifestStructure(manifest).map((issue) => formatPath(issue.path));
}

describe("validateManifestStructure", () => {
  it("accepts a minimal valid manifest", () => {
    expect(validateManifestStructure(valid)).toEqual([]);
  });

  it("accepts an optional $schema", () => {
    expect(validateManifestStructure({ ...valid, $schema: "https://qspec.dev/x.json" })).toEqual([]);
  });

  it("requires apiVersion, kind, metadata, and spec", () => {
    expect(paths({})).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  });

  it("rejects an unsupported apiVersion with a dedicated code", () => {
    const issues = validateManifestStructure({ ...valid, apiVersion: "qspec.dev/v9" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("QSPEC_API_VERSION_UNSUPPORTED");
    expect(issues[0]?.path).toEqual(["apiVersion"]);
  });

  it("requires metadata.name", () => {
    expect(paths({ ...valid, metadata: {} })).toEqual(["metadata.name"]);
  });

  it("enforces the metadata.name pattern and suggests a corrected value", () => {
    const issues = validateManifestStructure({ ...valid, metadata: { name: "Monthly Revenue" } });
    expect(issues[0]?.path).toEqual(["metadata", "name"]);
    expect(issues[0]?.suggestion).toBe("monthly-revenue");
  });

  it("requires metadata.tags to be an array of strings", () => {
    expect(paths({ ...valid, metadata: { name: "x", tags: "finance" } })).toEqual(["metadata.tags"]);
    expect(paths({ ...valid, metadata: { name: "x", tags: [1] } })).toEqual(["metadata.tags[0]"]);
  });

  it("requires spec to be an object", () => {
    expect(paths({ ...valid, spec: [] })).toEqual(["spec"]);
  });

  it("requires spec.transforms entries to declare a string type", () => {
    expect(paths({ ...valid, spec: { transforms: [{}] } })).toEqual(["spec.transforms[0].type"]);
  });

  it("requires spec.presentation to declare a string type", () => {
    expect(paths({ ...valid, spec: { presentation: {} } })).toEqual(["spec.presentation.type"]);
  });

  it("requires query.source, query.language, and query.statement", () => {
    expect(paths({ ...valid, spec: { query: {} } })).toEqual([
      "spec.query.source",
      "spec.query.language",
      "spec.query.statement",
    ]);
  });

  it("accepts a structured (non-string) query statement", () => {
    const manifest = {
      ...valid,
      spec: { query: { source: "s", language: "opensearch-dsl", statement: { match_all: {} } } },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("rejects a string binding that is not a $parameters reference", () => {
    const manifest = {
      ...valid,
      spec: { query: { source: "s", language: "sql", statement: "x", bindings: { a: "US" } } },
    };
    const issues = validateManifestStructure(manifest);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.query.bindings.a");
    expect(issues[0]?.message).toMatch(/\$parameters\./);
  });

  it("accepts all three binding forms", () => {
    const manifest = {
      ...valid,
      spec: {
        query: {
          source: "s",
          language: "sql",
          statement: "x",
          bindings: { a: "$parameters.from", b: { parameter: "to" }, c: { literal: "US" } },
        },
      },
    };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });

  it("reports every problem in one pass rather than stopping at the first", () => {
    expect(paths({ apiVersion: "qspec.dev/v1", kind: 1, metadata: {}, spec: 5 }).length).toBe(3);
  });

  it("preserves unknown x-vendor extension fields without complaint", () => {
    const manifest = { ...valid, spec: { presentation: { type: "line", "x-echarts": { a: 1 } } } };
    expect(validateManifestStructure(manifest)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/validate/manifest.test.ts`
Expected: FAIL — cannot resolve `./manifest.js`.

- [ ] **Step 3: Implement the validator**

`packages/core/src/internal/validate/manifest.ts`:

```ts
import {
  ManifestValidationError,
  type PathSegment,
  type QSpecIssue,
} from "../../errors.js";
import { isPlainObject } from "../../json.js";
import { METADATA_NAME_PATTERN, type QSpecManifest, type QSpecResourceSpec } from "../../types/manifest.js";
import { SUPPORTED_API_VERSIONS } from "../../version.js";

const PARAMETER_REFERENCE = /^\$parameters\.[A-Za-z_][A-Za-z0-9_]*$/;

class IssueCollector {
  readonly issues: QSpecIssue[] = [];

  add(message: string, path: readonly PathSegment[], extra?: { code?: string; suggestion?: string }) {
    this.issues.push({
      code: extra?.code ?? "QSPEC_MANIFEST_INVALID",
      message,
      path,
      ...(extra?.suggestion === undefined ? {} : { suggestion: extra.suggestion }),
    });
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
    collector.add("`metadata.name` is required and must be a non-empty string.", ["metadata", "name"]);
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

function validateBindings(bindings: unknown, base: readonly PathSegment[], collector: IssueCollector): void {
  if (!isPlainObject(bindings)) {
    collector.add("`bindings` must be an object.", base);
    return;
  }
  for (const [name, binding] of Object.entries(bindings)) {
    const path = [...base, name];
    if (typeof binding === "string") {
      if (!PARAMETER_REFERENCE.test(binding)) {
        collector.add(
          'A string binding must be a parameter reference of the form "$parameters.<name>". ' +
            'To bind a constant, use { "literal": ... } instead.',
          path,
        );
      }
    } else if (isPlainObject(binding)) {
      // Presence and type are checked separately. Conflating them lets
      // { parameter: 5, literal: "x" } slip through: a wrongly-typed
      // `parameter` reads as absent, so "both present" looks like "exactly one".
      const hasParameter = Object.hasOwn(binding, "parameter");
      const hasLiteral = Object.hasOwn(binding, "literal");
      if (hasParameter === hasLiteral) {
        collector.add(
          'A binding object must have exactly one of "parameter" or "literal".',
          path,
        );
      } else if (hasParameter && typeof binding["parameter"] !== "string") {
        collector.add('A binding\'s "parameter" must be a string.', path);
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

function validateQuery(query: unknown, collector: IssueCollector): void {
  if (!isPlainObject(query)) {
    collector.add("`spec.query` must be an object.", ["spec", "query"]);
    return;
  }
  if (typeof query["source"] !== "string" || query["source"] === "") {
    collector.add("`spec.query.source` is required and must be a non-empty string.", ["spec", "query", "source"]);
  }
  if (typeof query["language"] !== "string" || query["language"] === "") {
    collector.add("`spec.query.language` is required and must be a non-empty string.", ["spec", "query", "language"]);
  }
  if (!Object.hasOwn(query, "statement") || query["statement"] === undefined) {
    collector.add("`spec.query.statement` is required.", ["spec", "query", "statement"]);
  }
  if (query["bindings"] !== undefined) {
    validateBindings(query["bindings"], ["spec", "query", "bindings"], collector);
  }
}

function validateSpec(spec: unknown, collector: IssueCollector): void {
  if (!isPlainObject(spec)) {
    collector.add("`spec` must be an object.", ["spec"]);
    return;
  }
  if (spec["query"] !== undefined) validateQuery(spec["query"], collector);

  if (spec["parameters"] !== undefined && !isPlainObject(spec["parameters"])) {
    collector.add("`spec.parameters` must be an object.", ["spec", "parameters"]);
  }

  if (spec["dataset"] !== undefined) {
    const dataset = spec["dataset"];
    if (!isPlainObject(dataset) || !isPlainObject(dataset["fields"])) {
      collector.add("`spec.dataset` must be an object with a `fields` object.", ["spec", "dataset"]);
    }
  }

  const transforms = spec["transforms"];
  if (transforms !== undefined) {
    if (!Array.isArray(transforms)) {
      collector.add("`spec.transforms` must be an array.", ["spec", "transforms"]);
    } else {
      transforms.forEach((transform, index) => {
        if (!isPlainObject(transform) || typeof transform["type"] !== "string") {
          collector.add("Each transform must be an object with a string `type`.", [
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
    if (!isPlainObject(presentation) || typeof presentation["type"] !== "string") {
      collector.add("`spec.presentation` must be an object with a string `type`.", [
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/validate/manifest.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Export the pure validator publicly**

`packages/core/src/index.ts` — append. `validateManifestStructure` is public because the
CLI and `@qspecs/schema`'s conformance test both need it; `assertValidManifest` stays internal.

```ts
export { validateManifestStructure } from "./internal/validate/manifest.js";
```

- [ ] **Step 6: Verify**

Run: `npm run build && npx vitest run packages/core`
Expected: build succeeds, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add structural manifest validation with precise error paths"
```

---

### Task 6: Parameter model and runtime validation (validation stage 3)

Delivers SPEC.md §27–§30 and §96. Splits into a *compile* step (static, runs once in
`prepare()`) and a *validate* step (per execution).

Date handling decision: `date` and `datetime` values are carried as ISO **strings**, never
as `Date` objects. `date` must match `YYYY-MM-DD`; `datetime` must be ISO 8601 and parse to
a real instant. Keeping them as strings makes execution deterministic and manifests
timezone-independent (SPEC.md §8), and keeps datasets JSON-serializable.

**Files:**
- Create: `packages/core/src/internal/validate/parameters.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/internal/validate/parameters.test.ts`

**Interfaces:**
- Consumes: `QSpecIssue`, `ParameterValidationError`, `ManifestValidationError` (Task 1); `createRow`, `setKey`, `isPlainObject` (Task 2); `ParameterDefinition` (Task 4).
- Produces:
  - `compileParameters(definitions: Record<string, ParameterDefinition> | undefined): CompiledParameters` — throws `ManifestValidationError` for a malformed parameter *declaration*.
  - `CompiledParameters` with `names: readonly string[]` and `definitions: ReadonlyMap<string, ParameterDefinition>`.
  - `validateParameters(compiled: CompiledParameters, input: Record<string, unknown> | undefined): Record<string, JsonValue>` — throws `ParameterValidationError` listing every bad value; returns a frozen null-prototype object of resolved values including applied defaults.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/validate/parameters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ManifestValidationError, ParameterValidationError, formatPath } from "../../errors.js";
import { compileParameters, validateParameters } from "./parameters.js";
import type { ParameterDefinition } from "../../types/parameters.js";

function compile(definitions: Record<string, ParameterDefinition>) {
  return compileParameters(definitions);
}

function expectIssues(fn: () => unknown): { path: string; message: string }[] {
  try {
    fn();
    expect.unreachable("expected ParameterValidationError");
  } catch (error) {
    expect(error).toBeInstanceOf(ParameterValidationError);
    return (error as ParameterValidationError).issues.map((issue) => ({
      path: formatPath(issue.path),
      message: issue.message,
    }));
  }
}

describe("compileParameters", () => {
  it("accepts an absent parameter block", () => {
    expect(compileParameters(undefined).names).toEqual([]);
  });

  it("rejects an unknown parameter type", () => {
    expect(() => compile({ a: { type: "uuid" } as unknown as ParameterDefinition })).toThrow(
      ManifestValidationError,
    );
  });

  it("requires enum parameters to declare values", () => {
    expect(() => compile({ p: { type: "enum" } })).toThrow(/values/);
  });

  it("requires array parameters to declare items", () => {
    expect(() => compile({ p: { type: "array" } })).toThrow(/items/);
  });

  it("rejects a default that does not satisfy its own declaration", () => {
    expect(() => compile({ p: { type: "number", default: "x" } })).toThrow(ManifestValidationError);
  });
});

describe("validateParameters", () => {
  it("returns an empty null-prototype object when nothing is declared", () => {
    const values = validateParameters(compileParameters(undefined), {});
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(Object.keys(values)).toEqual([]);
  });

  it("reports every missing required parameter at once", () => {
    const compiled = compile({ from: { type: "date", required: true }, to: { type: "date", required: true } });
    const issues = expectIssues(() => validateParameters(compiled, {}));
    expect(issues.map((i) => i.path)).toEqual(["parameters.from", "parameters.to"]);
  });

  it("applies declared defaults", () => {
    const compiled = compile({ country: { type: "string", default: "US" } });
    expect(validateParameters(compiled, {})["country"]).toBe("US");
  });

  it("prefers a supplied value over the default", () => {
    const compiled = compile({ country: { type: "string", default: "US" } });
    expect(validateParameters(compiled, { country: "DE" })["country"]).toBe("DE");
  });

  it("omits optional parameters that have no default", () => {
    const compiled = compile({ country: { type: "string" } });
    expect(Object.hasOwn(validateParameters(compiled, {}), "country")).toBe(false);
  });

  it("rejects parameters that were not declared", () => {
    const issues = expectIssues(() => validateParameters(compile({}), { rogue: 1 }));
    expect(issues[0]?.path).toBe("parameters.rogue");
  });

  it("enforces integer vs number", () => {
    const compiled = compile({ n: { type: "integer" } });
    expect(validateParameters(compiled, { n: 5 })["n"]).toBe(5);
    expect(expectIssues(() => validateParameters(compiled, { n: 5.5 }))).toHaveLength(1);
  });

  it("enforces min and max", () => {
    const compiled = compile({ n: { type: "number", validation: { min: 0, max: 10 } } });
    expect(expectIssues(() => validateParameters(compiled, { n: -1 }))[0]?.message).toMatch(/0/);
    expect(expectIssues(() => validateParameters(compiled, { n: 11 }))[0]?.message).toMatch(/10/);
    expect(validateParameters(compiled, { n: 0 })["n"]).toBe(0);
  });

  it("enforces minLength and maxLength on strings", () => {
    const compiled = compile({ s: { type: "string", validation: { minLength: 2, maxLength: 4 } } });
    expect(expectIssues(() => validateParameters(compiled, { s: "a" }))).toHaveLength(1);
    expect(expectIssues(() => validateParameters(compiled, { s: "abcde" }))).toHaveLength(1);
    expect(validateParameters(compiled, { s: "ab" })["s"]).toBe("ab");
  });

  it("enforces enum values and suggests a close match", () => {
    const compiled = compile({ period: { type: "enum", values: ["7d", "30d", "90d"] } });
    const issues = expectIssues(() => validateParameters(compiled, { period: "31d" }));
    expect(issues[0]?.message).toMatch(/7d, 30d, 90d/);
  });

  it("accepts date and datetime as ISO strings", () => {
    const compiled = compile({ d: { type: "date" }, t: { type: "datetime" } });
    const values = validateParameters(compiled, { d: "2026-01-01", t: "2026-01-01T10:00:00Z" });
    expect(values["d"]).toBe("2026-01-01");
    expect(values["t"]).toBe("2026-01-01T10:00:00Z");
  });

  it("rejects a malformed date and an impossible calendar date", () => {
    const compiled = compile({ d: { type: "date" } });
    expect(expectIssues(() => validateParameters(compiled, { d: "01/01/2026" }))).toHaveLength(1);
    expect(expectIssues(() => validateParameters(compiled, { d: "2026-02-31" }))).toHaveLength(1);
  });

  it("rejects a Date object, which is not portable", () => {
    const compiled = compile({ d: { type: "date" } });
    expect(expectIssues(() => validateParameters(compiled, { d: new Date() }))).toHaveLength(1);
  });

  it("validates array element types and length", () => {
    const compiled = compile({
      ids: { type: "array", items: { type: "integer" }, validation: { maxLength: 2 } },
    });
    expect(validateParameters(compiled, { ids: [1, 2] })["ids"]).toEqual([1, 2]);
    expect(expectIssues(() => validateParameters(compiled, { ids: [1, 2, 3] }))).toHaveLength(1);
    const issues = expectIssues(() => validateParameters(compiled, { ids: [1, "x"] }));
    expect(issues[0]?.path).toBe("parameters.ids[1]");
  });

  it("rejects NaN and Infinity, which do not survive JSON", () => {
    const compiled = compile({ n: { type: "number" } });
    expect(expectIssues(() => validateParameters(compiled, { n: Number.NaN }))).toHaveLength(1);
    expect(expectIssues(() => validateParameters(compiled, { n: Infinity }))).toHaveLength(1);
  });

  it("treats null as absent so JSON callers can omit optional values", () => {
    const compiled = compile({ country: { type: "string", default: "US" } });
    expect(validateParameters(compiled, { country: null })["country"]).toBe("US");
  });

  it("returns a frozen result", () => {
    const values = validateParameters(compile({ a: { type: "string", default: "x" } }), {});
    expect(Object.isFrozen(values)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/validate/parameters.test.ts`
Expected: FAIL — cannot resolve `./parameters.js`.

- [ ] **Step 3: Implement parameter compilation and validation**

`packages/core/src/internal/validate/parameters.ts`:

```ts
import {
  ManifestValidationError,
  ParameterValidationError,
  type PathSegment,
  type QSpecIssue,
} from "../../errors.js";
import { createRow, deepFreeze, isPlainObject, setKey, type JsonValue } from "../../json.js";
import type { ParameterDefinition, ParameterType } from "../../types/parameters.js";

const PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "string", "number", "integer", "boolean", "date", "datetime", "enum", "array",
]);

/**
 * Types permitted as `items.type` on an array parameter. Deliberately excludes
 * the composite types: `checkScalar` has no branch for them, and its `never`
 * default would return the type NAME as the element value at runtime.
 */
const ITEM_TYPES: ReadonlySet<string> = new Set([
  "string", "number", "integer", "boolean", "date", "datetime",
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
    if (definition.default !== undefined) {
      const issues: QSpecIssue[] = [];
      coerce(definition, name, definition.default, [...path, "default"], issues);
      if (issues.length > 0) {
        declarationError(
          `Default value for parameter "${name}" is not valid for its declaration: ${issues[0]?.message}`,
          [...path, "default"],
        );
      }
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
      reject(`Parameter "${name}" must have at least ${rules.minLength} ${
        typeof value === "string" ? "characters" : "items"
      }.`);
    }
    if (rules.maxLength !== undefined && length > rules.maxLength) {
      reject(`Parameter "${name}" must have at most ${rules.maxLength} ${
        typeof value === "string" ? "characters" : "items"
      }.`);
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
          (compiled.names.length === 0 ? "(none)" : compiled.names.join(", ")) + ".",
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/validate/parameters.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Verify the whole package still builds**

Run: `npm run build && npx vitest run packages/core`
Expected: build succeeds, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add parameter compilation and runtime validation"
```

---

### Task 7: "Did you mean" suggestions

Delivers the Levenshtein-based suggestion used by SPEC.md §86 diagnostics.

**Files:**
- Create: `packages/core/src/internal/suggest.ts`
- Test: `packages/core/src/internal/suggest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `suggest(input: string, candidates: readonly string[]): string | undefined` and `editDistance(a: string, b: string): number`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/suggest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { editDistance, suggest } from "./suggest.js";

describe("editDistance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("revenue", "revenue")).toBe(0);
  });

  it("counts a transposition as two edits", () => {
    expect(editDistance("reveneu", "revenue")).toBe(2);
  });

  it("counts insertions and deletions", () => {
    expect(editDistance("revenu", "revenue")).toBe(1);
    expect(editDistance("revenuee", "revenue")).toBe(1);
  });
});

describe("suggest", () => {
  it("finds the SPEC.md 86 example", () => {
    expect(suggest("reveneu", ["month", "revenue", "cost"])).toBe("revenue");
  });

  it("returns undefined when nothing is close enough", () => {
    expect(suggest("timestamp", ["month", "revenue"])).toBeUndefined();
  });

  it("returns undefined for an empty candidate list", () => {
    expect(suggest("x", [])).toBeUndefined();
  });

  it("is case-insensitive but returns the candidate's original casing", () => {
    expect(suggest("Revenue", ["revenue"])).toBe("revenue");
    // The returned value must be the candidate as registered, not lowercased.
    expect(suggest("revenue", ["Revenue"])).toBe("Revenue");
  });

  it("prefers the closest candidate", () => {
    expect(suggest("gte_", ["gt", "gte", "lte"])).toBe("gte");
  });

  it("is deterministic when two candidates tie", () => {
    // Both candidates are distance 1 from "aaa", which is inside the len-3
    // threshold of 2 — so this genuinely exercises tie-breaking. Candidates
    // that fall OUTSIDE the threshold would both yield undefined and the test
    // would pass even with the sort removed.
    const candidates = ["aac", "aab"];
    expect(suggest("aaa", candidates)).toBe("aab");
    expect(suggest("aaa", [...candidates].reverse())).toBe("aab");
  });

  it("does not mutate the caller's candidate array while sorting", () => {
    const candidates = ["sort", "filter", "limit"];
    suggest("fitler", candidates);
    expect(candidates).toEqual(["sort", "filter", "limit"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/suggest.test.ts`
Expected: FAIL — cannot resolve `./suggest.js`.

- [ ] **Step 3: Implement**

`packages/core/src/internal/suggest.ts`:

```ts
/** Standard Levenshtein distance, two-row implementation. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length] as number;
}

/**
 * Returns the closest candidate, or undefined when none is close enough to be
 * a helpful guess. The threshold scales with input length so short names do not
 * produce nonsense suggestions. (SPEC.md §86)
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const needle = input.toLowerCase();
  const threshold = Math.max(1, Math.floor(needle.length / 3) + 1);

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  // Sorted so ties resolve identically regardless of candidate order.
  for (const candidate of [...candidates].sort()) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return bestDistance <= threshold ? best : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/suggest.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add did-you-mean suggestions for diagnostics"
```

---
### Task 8: Expression normalization

Delivers the shorthand-to-AST normalization and depth limiting from design §2.2 and §2.3.
Normalization runs during `prepare()` so the evaluator only ever sees one shape.

**Files:**
- Create: `packages/core/src/internal/expression/normalize.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/internal/expression/normalize.test.ts`

**Interfaces:**
- Consumes: `ManifestValidationError`, `LimitExceededError`, `PathSegment` (Task 1); `isPlainObject` (Task 2); `Expression` (Task 4); `suggest` (Task 7).
- Produces:
  - `OPERATORS: ReadonlyMap<string, { minArity: number; maxArity: number }>`
  - `normalizeExpression(input: unknown, path: readonly PathSegment[], maxDepth: number): Expression`

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/expression/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LimitExceededError, ManifestValidationError } from "../../errors.js";
import { normalizeExpression } from "./normalize.js";

const at = ["spec", "transforms", 0, "where"] as const;

function normalize(input: unknown, maxDepth = 32) {
  return normalizeExpression(input, at, maxDepth);
}

describe("normalizeExpression", () => {
  it("passes leaf nodes through", () => {
    expect(normalize({ field: "revenue" })).toEqual({ field: "revenue" });
    expect(normalize({ literal: 0 })).toEqual({ literal: 0 });
    expect(normalize({ parameter: "from" })).toEqual({ parameter: "from" });
  });

  it("passes an operator node through, normalizing its arguments", () => {
    expect(normalize({ operator: "gt", arguments: [{ field: "r" }, { literal: 0 }] })).toEqual({
      operator: "gt",
      arguments: [{ field: "r" }, { literal: 0 }],
    });
  });

  it("expands the SPEC.md 40 comparison shorthand into the AST form", () => {
    expect(normalize({ field: "revenue", operator: "gt", value: 0 })).toEqual({
      operator: "gt",
      arguments: [{ field: "revenue" }, { literal: 0 }],
    });
  });

  it("rejects an unknown operator and suggests a close one", () => {
    try {
      normalize({ operator: "gte_", arguments: [{ field: "r" }, { literal: 0 }] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestValidationError);
      expect((error as ManifestValidationError).issues[0]?.suggestion).toBe("gte");
    }
  });

  it("rejects wrong arity", () => {
    expect(() => normalize({ operator: "not", arguments: [] })).toThrow(ManifestValidationError);
    expect(() => normalize({ operator: "eq", arguments: [{ literal: 1 }] })).toThrow(
      ManifestValidationError,
    );
  });

  it.each(["and", "or", "coalesce"])("accepts %s with more than two arguments", (operator) => {
    const args = [{ literal: true }, { literal: false }, { literal: true }];
    // Assert the normalized shape, not merely that an `arguments` key exists —
    // the latter would pass even if the arguments were dropped or reordered.
    expect(normalize({ operator, arguments: args })).toEqual({ operator, arguments: args });
  });

  it("accepts a single argument for a variadic operator", () => {
    expect(normalize({ operator: "and", arguments: [{ literal: true }] })).toEqual({
      operator: "and",
      arguments: [{ literal: true }],
    });
  });

  it("rejects a node that is neither a leaf nor an operator", () => {
    expect(() => normalize({})).toThrow(ManifestValidationError);
    expect(() => normalize("row => row.revenue > 100")).toThrow(ManifestValidationError);
    expect(() => normalize(null)).toThrow(ManifestValidationError);
  });

  it("reports the path of the offending node", () => {
    try {
      normalize({ operator: "and", arguments: [{ field: "a" }, {}] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ManifestValidationError).issues[0]?.path).toEqual([
        "spec", "transforms", 0, "where", "arguments", 1,
      ]);
    }
  });

  it("enforces the depth limit", () => {
    let expression: unknown = { field: "a" };
    for (let i = 0; i < 6; i += 1) {
      expression = { operator: "not", arguments: [expression] };
    }
    expect(() => normalize(expression, 3)).toThrow(LimitExceededError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/expression/normalize.test.ts`
Expected: FAIL — cannot resolve `./normalize.js`.

- [ ] **Step 3: Implement normalization**

`packages/core/src/internal/expression/normalize.ts`:

```ts
import {
  LimitExceededError,
  ManifestValidationError,
  type PathSegment,
} from "../../errors.js";
import { isPlainObject, type JsonValue } from "../../json.js";
import type { Expression } from "../../types/expression.js";
import { suggest } from "../suggest.js";

interface Arity {
  readonly minArity: number;
  readonly maxArity: number;
}

const VARIADIC = Number.POSITIVE_INFINITY;

/**
 * The complete operator set. Deliberately fixed and not registry-extensible:
 * an expression's meaning must not depend on which plugins are installed.
 * (SPEC.md §42; design §2.2)
 */
export const OPERATORS: ReadonlyMap<string, Arity> = new Map<string, Arity>([
  ["eq", { minArity: 2, maxArity: 2 }],
  ["ne", { minArity: 2, maxArity: 2 }],
  ["gt", { minArity: 2, maxArity: 2 }],
  ["gte", { minArity: 2, maxArity: 2 }],
  ["lt", { minArity: 2, maxArity: 2 }],
  ["lte", { minArity: 2, maxArity: 2 }],
  ["and", { minArity: 1, maxArity: VARIADIC }],
  ["or", { minArity: 1, maxArity: VARIADIC }],
  ["not", { minArity: 1, maxArity: 1 }],
  ["in", { minArity: 2, maxArity: 2 }],
  ["isNull", { minArity: 1, maxArity: 1 }],
  ["add", { minArity: 2, maxArity: 2 }],
  ["subtract", { minArity: 2, maxArity: 2 }],
  ["multiply", { minArity: 2, maxArity: 2 }],
  ["divide", { minArity: 2, maxArity: 2 }],
  ["coalesce", { minArity: 1, maxArity: VARIADIC }],
]);

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
 * Converts any accepted expression form into the canonical AST, validating
 * operator names, arity, and nesting depth. (SPEC.md §42, §72.5)
 */
export function normalizeExpression(
  input: unknown,
  path: readonly PathSegment[],
  maxDepth: number,
  depth = 1,
): Expression {
  if (depth > maxDepth) {
    throw new LimitExceededError(
      `Expression nesting exceeds the configured maximum depth of ${maxDepth}.`,
      { limit: "maxExpressionDepth", allowed: maxDepth, path },
    );
  }

  if (!isPlainObject(input)) {
    fail(
      "An expression must be an object: { field }, { literal }, { parameter }, or { operator, arguments }. " +
        "Embedded code is not permitted.",
      path,
    );
  }

  const hasOperator = typeof input["operator"] === "string";

  // Comparison shorthand: { field, operator, value } with no `arguments`.
  if (hasOperator && !Object.hasOwn(input, "arguments")) {
    if (typeof input["field"] !== "string" || !Object.hasOwn(input, "value")) {
      fail(
        "Shorthand comparison requires `field`, `operator`, and `value`. " +
          "Otherwise use the { operator, arguments } form.",
        path,
      );
    }
    return normalizeOperator(input["operator"] as string, [
      { field: input["field"] },
      { literal: input["value"] as JsonValue },
    ], path);
  }

  if (hasOperator) {
    const args = input["arguments"];
    if (!Array.isArray(args)) {
      fail("`arguments` must be an array of expressions.", [...path, "arguments"]);
    }
    const normalized = args.map((argument, index) =>
      normalizeExpression(argument, [...path, "arguments", index], maxDepth, depth + 1),
    );
    return normalizeOperator(input["operator"] as string, normalized, path);
  }

  if (typeof input["field"] === "string") return { field: input["field"] };
  if (typeof input["parameter"] === "string") return { parameter: input["parameter"] };
  if (Object.hasOwn(input, "literal")) return { literal: input["literal"] as JsonValue };

  fail(
    "Unrecognized expression node. Expected { field }, { literal }, { parameter }, or { operator, arguments }.",
    path,
  );
}

function normalizeOperator(
  operator: string,
  args: readonly Expression[],
  path: readonly PathSegment[],
): Expression {
  const arity = OPERATORS.get(operator);
  if (arity === undefined) {
    fail(
      `Unknown operator "${operator}". Supported operators: ${[...OPERATORS.keys()].join(", ")}.`,
      [...path, "operator"],
      suggest(operator, [...OPERATORS.keys()]),
    );
  }
  if (args.length < arity.minArity || args.length > arity.maxArity) {
    const expected =
      arity.maxArity === VARIADIC
        ? `at least ${arity.minArity}`
        : arity.minArity === arity.maxArity
          ? `exactly ${arity.minArity}`
          : `${arity.minArity} to ${arity.maxArity}`;
    fail(
      `Operator "${operator}" expects ${expected} argument(s) but received ${args.length}.`,
      [...path, "arguments"],
    );
  }
  return { operator, arguments: args };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core/src/internal/expression/normalize.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export the operator list publicly**

`packages/core/src/index.ts` — append:

```ts
export { OPERATORS } from "./internal/expression/normalize.js";
```

- [ ] **Step 6: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add expression normalization with fixed operator set"
```

---


### Task 9: Expression evaluation

Delivers the interpreter. No `eval`, no `new Function` (SPEC.md §72.3). Null and comparison
semantics are fixed and documented here because they must be identical in every consumer.

**Semantics (binding decisions — implement exactly):**
- `null` and `undefined` are both "null". Reading a missing field yields null.
- Arithmetic with a null operand yields null.
- `divide` by zero yields null (not `Infinity`), because `Infinity` does not survive JSON.
- Ordering comparisons (`gt` `gte` `lt` `lte`) yield `false` when either operand is null or
  when the operands are of different types. They never throw.
- `eq` is strict: `null eq null` is `true`; `null eq anything-else` is `false`.
- `ne` is the negation of `eq`.
- `and`/`or` use JavaScript truthiness on evaluated arguments and short-circuit.
- `in` requires its second argument to evaluate to an array; otherwise `false`.
- `coalesce` returns the first non-null argument, or null.

**Files:**
- Create: `packages/core/src/internal/expression/evaluate.ts`
- Test: `packages/core/src/internal/expression/evaluate.test.ts`

**Interfaces:**
- Consumes: `Expression` (Task 4); `JsonValue` (Task 2).
- Produces: `evaluateExpression(expression: Expression, scope: EvaluationScope): unknown` and `EvaluationScope` with `row: DatasetRow` and `parameters: Record<string, JsonValue>`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/expression/evaluate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRow, setKey } from "../../json.js";
import type { Expression } from "../../types/expression.js";
import { evaluateExpression } from "./evaluate.js";

function scope(fields: Record<string, unknown> = {}, parameters: Record<string, never> | Record<string, unknown> = {}) {
  const row = createRow();
  for (const [key, value] of Object.entries(fields)) setKey(row, key, value);
  return { row, parameters: parameters as Record<string, never> };
}

function evaluate(expression: Expression, fields: Record<string, unknown> = {}, parameters = {}) {
  return evaluateExpression(expression, scope(fields, parameters));
}

describe("leaf nodes", () => {
  it("reads literals, fields, and parameters", () => {
    expect(evaluate({ literal: 42 })).toBe(42);
    expect(evaluate({ field: "revenue" }, { revenue: 10 })).toBe(10);
    expect(evaluate({ parameter: "country" }, {}, { country: "US" })).toBe("US");
  });

  it("yields null for a missing field or parameter", () => {
    expect(evaluate({ field: "nope" })).toBeNull();
    expect(evaluate({ parameter: "nope" })).toBeNull();
  });

  it("does not read inherited properties, even from a row that has a prototype", () => {
    // createRow() is null-prototype, so asserting against it proves nothing —
    // there is no chain to leak from. A plain object exercises the guard: with
    // `in` instead of Object.hasOwn, this would return Object.prototype.toString.
    const row: Record<string, unknown> = {};
    expect(evaluateExpression({ field: "toString" }, { row, parameters: {} })).toBeNull();
  });

  it("does not read inherited properties for a parameter", () => {
    // `parameters` is an ordinary object, so this is where the guard matters.
    expect(evaluate({ parameter: "toString" })).toBeNull();
  });
});

describe("comparison", () => {
  const gt = (a: unknown, b: unknown) =>
    evaluate({ operator: "gt", arguments: [{ field: "a" }, { field: "b" }] }, { a, b });

  it("compares numbers and strings", () => {
    expect(gt(2, 1)).toBe(true);
    expect(gt(1, 2)).toBe(false);
    expect(gt("b", "a")).toBe(true);
  });

  it("is false rather than throwing when an operand is null", () => {
    expect(gt(null, 1)).toBe(false);
    expect(gt(1, null)).toBe(false);
  });

  it("is false for mismatched types", () => {
    expect(gt("2", 1)).toBe(false);
  });

  it("treats eq strictly and handles null equality", () => {
    const eq = (a: unknown, b: unknown) =>
      evaluate({ operator: "eq", arguments: [{ field: "a" }, { field: "b" }] }, { a, b });
    expect(eq(1, 1)).toBe(true);
    expect(eq(1, "1")).toBe(false);
    expect(eq(null, null)).toBe(true);
    expect(eq(null, 0)).toBe(false);
  });

  it("negates eq for ne", () => {
    expect(evaluate({ operator: "ne", arguments: [{ literal: 1 }, { literal: 2 }] })).toBe(true);
  });
});

describe("logical operators", () => {
  it("evaluates and / or / not", () => {
    expect(evaluate({ operator: "and", arguments: [{ literal: true }, { literal: false }] })).toBe(false);
    expect(evaluate({ operator: "or", arguments: [{ literal: false }, { literal: true }] })).toBe(true);
    expect(evaluate({ operator: "not", arguments: [{ literal: false }] })).toBe(true);
  });

  it("short-circuits `and` without evaluating later arguments", () => {
    // A tripwire accessor proves laziness. Using divide-by-zero as the second
    // argument would NOT: it evaluates to null rather than throwing, so an
    // eager implementation would produce the same `false` and the test would
    // pass against the very bug it is meant to catch.
    const row = createRow();
    let touched = 0;
    Object.defineProperty(row, "tripwire", {
      get: () => {
        touched += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    const scope = { row, parameters: {} as Record<string, never> };

    evaluateExpression(
      { operator: "and", arguments: [{ literal: false }, { field: "tripwire" }] },
      scope,
    );
    expect(touched).toBe(0);

    // Confirm the tripwire actually fires when it is reached, so the zero above
    // means "skipped", not "broken".
    evaluateExpression(
      { operator: "and", arguments: [{ literal: true }, { field: "tripwire" }] },
      scope,
    );
    expect(touched).toBe(1);
  });
});

describe("arithmetic", () => {
  it("adds, subtracts, multiplies, and divides", () => {
    const arith = (operator: string) =>
      evaluate({ operator, arguments: [{ literal: 6 }, { literal: 3 }] });
    expect(arith("add")).toBe(9);
    expect(arith("subtract")).toBe(3);
    expect(arith("multiply")).toBe(18);
    expect(arith("divide")).toBe(2);
  });

  it("propagates null", () => {
    expect(evaluate({ operator: "add", arguments: [{ field: "missing" }, { literal: 1 }] })).toBeNull();
  });

  it("yields null on divide by zero rather than Infinity", () => {
    expect(evaluate({ operator: "divide", arguments: [{ literal: 1 }, { literal: 0 }] })).toBeNull();
  });

  it("yields null for non-numeric operands", () => {
    expect(evaluate({ operator: "add", arguments: [{ literal: "a" }, { literal: 1 }] })).toBeNull();
  });
});

describe("in, isNull, coalesce", () => {
  it("tests membership against an array literal", () => {
    const expression: Expression = {
      operator: "in",
      arguments: [{ field: "country" }, { literal: ["US", "DE"] }],
    };
    expect(evaluate(expression, { country: "DE" })).toBe(true);
    expect(evaluate(expression, { country: "FR" })).toBe(false);
  });

  it("is false when the second argument is not an array", () => {
    expect(
      evaluate({ operator: "in", arguments: [{ literal: 1 }, { literal: 1 }] }),
    ).toBe(false);
  });

  it("detects null", () => {
    expect(evaluate({ operator: "isNull", arguments: [{ field: "nope" }] })).toBe(true);
    expect(evaluate({ operator: "isNull", arguments: [{ literal: 0 }] })).toBe(false);
  });

  it("coalesces to the first non-null value", () => {
    expect(
      evaluate({
        operator: "coalesce",
        arguments: [{ field: "nope" }, { literal: null }, { literal: "fallback" }],
      }),
    ).toBe("fallback");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/expression/evaluate.test.ts`
Expected: FAIL — cannot resolve `./evaluate.js`.

- [ ] **Step 3: Implement the evaluator**

`packages/core/src/internal/expression/evaluate.ts`:

```ts
import { QSpecError } from "../../errors.js";
import type { JsonValue } from "../../json.js";
import type { DatasetRow } from "../../types/dataset.js";
import type { Expression } from "../../types/expression.js";

export interface EvaluationScope {
  readonly row: DatasetRow;
  readonly parameters: Record<string, JsonValue>;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Reads a required argument. `normalizeExpression` enforces arity before any
 * expression reaches the evaluator, so a missing argument means an
 * un-normalized expression was passed directly. A cast would strip the
 * `undefined` that `noUncheckedIndexedAccess` correctly surfaces, turning that
 * mistake into a raw TypeError deep in the interpreter.
 */
function argAt(args: readonly Expression[], index: number): Expression {
  const argument = args[index];
  if (argument === undefined) {
    throw new QSpecError(
      `Expression is missing argument ${index}. Expressions must be normalized before evaluation.`,
      { code: "QSPEC_MANIFEST_INVALID" },
    );
  }
  return argument;
}

/** Ordering comparison. Returns undefined when the operands are not comparable. */
function compare(left: unknown, right: unknown): number | undefined {
  if (isNullish(left) || isNullish(right)) return undefined;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arithmetic(operator: string, left: unknown, right: unknown): number | null {
  const a = asNumber(left);
  const b = asNumber(right);
  if (a === undefined || b === undefined) return null;
  switch (operator) {
    case "add":
      return a + b;
    case "subtract":
      return a - b;
    case "multiply":
      return a * b;
    case "divide":
      // Infinity and NaN do not survive JSON, so a null result is used instead.
      return b === 0 ? null : a / b;
    default:
      return null;
  }
}

/**
 * Interprets a normalized expression. Never uses eval or the Function
 * constructor. (SPEC.md §41, §72.3)
 */
export function evaluateExpression(expression: Expression, scope: EvaluationScope): unknown {
  if ("literal" in expression) return expression.literal;

  if ("field" in expression) {
    // Object.hasOwn keeps inherited properties from leaking into results.
    return Object.hasOwn(scope.row, expression.field) ? scope.row[expression.field] ?? null : null;
  }

  if ("parameter" in expression) {
    return Object.hasOwn(scope.parameters, expression.parameter)
      ? scope.parameters[expression.parameter] ?? null
      : null;
  }

  const { operator, arguments: args } = expression;

  switch (operator) {
    case "and": {
      for (const argument of args) {
        if (!evaluateExpression(argument, scope)) return false;
      }
      return true;
    }
    case "or": {
      for (const argument of args) {
        if (evaluateExpression(argument, scope)) return true;
      }
      return false;
    }
    case "not":
      return !evaluateExpression(argAt(args, 0), scope);
    case "coalesce": {
      for (const argument of args) {
        const value = evaluateExpression(argument, scope);
        if (!isNullish(value)) return value;
      }
      return null;
    }
    case "isNull":
      return isNullish(evaluateExpression(argAt(args, 0), scope));
    default:
      break;
  }

  const left = evaluateExpression(argAt(args, 0), scope);
  const right = args.length > 1 ? evaluateExpression(argAt(args, 1), scope) : undefined;

  switch (operator) {
    case "eq":
      return isNullish(left) && isNullish(right) ? true : left === right;
    case "ne":
      return !(isNullish(left) && isNullish(right)) && left !== right;
    case "gt": {
      const result = compare(left, right);
      return result === undefined ? false : result > 0;
    }
    case "gte": {
      const result = compare(left, right);
      return result === undefined ? false : result >= 0;
    }
    case "lt": {
      const result = compare(left, right);
      return result === undefined ? false : result < 0;
    }
    case "lte": {
      const result = compare(left, right);
      return result === undefined ? false : result <= 0;
    }
    case "in":
      return Array.isArray(right) && right.some((candidate) => candidate === left);
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      return arithmetic(operator, left, right);
    default:
      // Unreachable: normalizeExpression rejects unknown operators.
      return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/expression/evaluate.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add expression evaluator with documented null semantics"
```

---

### Task 10: Query bindings

Delivers binding parsing and resolution per design §2.1 and SPEC.md §34.

**Files:**
- Create: `packages/core/src/internal/bindings.ts`
- Test: `packages/core/src/internal/bindings.test.ts`

**Interfaces:**
- Consumes: `ManifestValidationError`, `PathSegment` (Task 1); `createRow`, `setKey`, `isPlainObject`, `JsonValue` (Task 2); `Binding` (Task 4); `CompiledParameters` (Task 6); `suggest` (Task 7).
- Produces:
  - `PARAMETER_REFERENCE: RegExp`
  - `CompiledBinding = { name: string } & ({ kind: "parameter"; parameter: string } | { kind: "literal"; value: JsonValue })`
  - `compileBindings(bindings, compiledParameters, path): readonly CompiledBinding[]` — throws if a binding references an undeclared parameter, with a suggestion.
  - `resolveBindings(compiled, parameters): Record<string, JsonValue>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/bindings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ManifestValidationError } from "../errors.js";
import { compileParameters } from "./validate/parameters.js";
import { compileBindings, resolveBindings } from "./bindings.js";

const declared = compileParameters({
  from: { type: "date", required: true },
  country: { type: "string", default: "US" },
});

const at = ["spec", "query", "bindings"] as const;

describe("compileBindings", () => {
  it("returns an empty list when there are no bindings", () => {
    expect(compileBindings(undefined, declared, at)).toEqual([]);
  });

  it("compiles the string reference form", () => {
    expect(compileBindings({ a: "$parameters.from" }, declared, at)).toEqual([
      { name: "a", kind: "parameter", parameter: "from" },
    ]);
  });

  it("compiles the object parameter form", () => {
    expect(compileBindings({ a: { parameter: "from" } }, declared, at)).toEqual([
      { name: "a", kind: "parameter", parameter: "from" },
    ]);
  });

  it("compiles the literal form", () => {
    expect(compileBindings({ a: { literal: "US" } }, declared, at)).toEqual([
      { name: "a", kind: "literal", value: "US" },
    ]);
  });

  it("rejects a bare string that is not a parameter reference", () => {
    expect(() => compileBindings({ a: "US" }, declared, at)).toThrow(ManifestValidationError);
  });

  it("rejects a near-miss reference prefix rather than treating it as a literal", () => {
    expect(() => compileBindings({ a: "$parameter.from" }, declared, at)).toThrow(
      ManifestValidationError,
    );
  });

  it("rejects a reference to an undeclared parameter and suggests a declared one", () => {
    try {
      compileBindings({ a: "$parameters.form" }, declared, at);
      expect.unreachable("should have thrown");
    } catch (error) {
      const issue = (error as ManifestValidationError).issues[0];
      expect(issue?.suggestion).toBe("from");
      expect(issue?.path).toEqual(["spec", "query", "bindings", "a"]);
    }
  });

  it("rejects an object with both parameter and literal", () => {
    expect(() =>
      compileBindings({ a: { parameter: "from", literal: 1 } as never }, declared, at),
    ).toThrow(ManifestValidationError);
  });
});

describe("resolveBindings", () => {
  it("resolves parameter references against validated values", () => {
    const compiled = compileBindings({ f: "$parameters.from", c: { literal: 7 } }, declared, at);
    const resolved = resolveBindings(compiled, { from: "2026-01-01" });
    expect(resolved["f"]).toBe("2026-01-01");
    expect(resolved["c"]).toBe(7);
  });

  it("resolves an absent optional parameter to null", () => {
    const compiled = compileBindings({ c: "$parameters.country" }, declared, at);
    expect(resolveBindings(compiled, {})["c"]).toBeNull();
  });

  it("returns a null-prototype frozen object", () => {
    const resolved = resolveBindings(compileBindings({}, declared, at), {});
    expect(Object.getPrototypeOf(resolved)).toBeNull();
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/bindings.test.ts`
Expected: FAIL — cannot resolve `./bindings.js`.

- [ ] **Step 3: Implement bindings**

`packages/core/src/internal/bindings.ts`:

```ts
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
      if (match === null) {
        fail(
          `Binding "${name}" must be a parameter reference of the form "$parameters.<name>". ` +
            `To bind the constant value ${JSON.stringify(binding)}, write ` +
            `{ "literal": ${JSON.stringify(binding)} } instead.`,
          path,
        );
      }
      const parameter = match[1] as string;
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
        fail(
          `Binding "${name}" has an undefined "literal". Use null for an absent value.`,
          path,
        );
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/bindings.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add query binding compilation and resolution"
```

---

### Task 11: Result normalization

Turns a positional `RawQueryResult` into a `Dataset` (design §2.4), including the duplicate
column rule and `maxRows` enforcement.

**Files:**
- Create: `packages/core/src/internal/normalize-result.ts`
- Test: `packages/core/src/internal/normalize-result.test.ts`

**Interfaces:**
- Consumes: `createRow`, `setKey` (Task 2); `Dataset`, `Field`, `FieldType`, `RawQueryResult`, `DatasetSchema` (Task 4).
- Produces: `normalizeResult(raw: RawQueryResult, options?: NormalizeOptions): NormalizeOutcome` where `NormalizeOptions` is `{ schema?: DatasetSchema; maxRows?: number }` and `NormalizeOutcome` is `{ dataset: Dataset; duplicates: readonly { original: string; renamed: string }[] }`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/normalize-result.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RawQueryResult } from "../types/dataset.js";
import { normalizeResult } from "./normalize-result.js";

function raw(columns: string[], rows: unknown[][]): RawQueryResult {
  return { columns: columns.map((name) => ({ name })), rows };
}

describe("normalizeResult", () => {
  it("converts positional rows into keyed rows", () => {
    const { dataset } = normalizeResult(raw(["month", "revenue"], [["2026-01", 10]]));
    expect(dataset.rows).toHaveLength(1);
    expect(dataset.rows[0]?.["month"]).toBe("2026-01");
    expect(dataset.rows[0]?.["revenue"]).toBe(10);
  });

  it("produces null-prototype rows", () => {
    const { dataset } = normalizeResult(raw(["a"], [[1]]));
    expect(Object.getPrototypeOf(dataset.rows[0])).toBeNull();
  });

  it("preserves column order in fields", () => {
    const { dataset } = normalizeResult(raw(["b", "a"], []));
    expect(dataset.fields.map((field) => field.name)).toEqual(["b", "a"]);
  });

  it("infers types from the first non-null value", () => {
    const { dataset } = normalizeResult(
      raw(["s", "n", "i", "b", "o", "arr"], [[null, null, null, null, null, null], ["x", 1.5, 3, true, { a: 1 }, [1]]]),
    );
    const types = Object.fromEntries(dataset.fields.map((f) => [f.name, f.type]));
    expect(types).toEqual({ s: "string", n: "number", i: "integer", b: "boolean", o: "object", arr: "array" });
  });

  it("defaults an all-null column to string", () => {
    const { dataset } = normalizeResult(raw(["a"], [[null], [null]]));
    expect(dataset.fields[0]?.type).toBe("string");
  });

  it("converts Date values to ISO strings so datasets stay JSON-serializable", () => {
    const { dataset } = normalizeResult(raw(["t"], [[new Date("2026-01-01T00:00:00Z")]]));
    expect(dataset.fields[0]?.type).toBe("datetime");
    expect(dataset.rows[0]?.["t"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("prefers declared schema metadata over inference", () => {
    const { dataset } = normalizeResult(raw(["revenue"], [[10]]), {
      schema: {
        fields: {
          revenue: { type: "number", nullable: false, semanticType: "currency", format: { currency: "USD" } },
        },
      },
    });
    expect(dataset.fields[0]).toMatchObject({
      name: "revenue",
      type: "number",
      semanticType: "currency",
      format: { currency: "USD" },
    });
  });

  it("renames duplicate columns and reports the renames", () => {
    const outcome = normalizeResult(raw(["id", "id", "id"], [[1, 2, 3]]));
    expect(outcome.dataset.fields.map((f) => f.name)).toEqual(["id", "id_2", "id_3"]);
    expect(outcome.dataset.rows[0]).toMatchObject({ id: 1, id_2: 2, id_3: 3 });
    expect(outcome.duplicates).toEqual([
      { original: "id", renamed: "id_2" },
      { original: "id", renamed: "id_3" },
    ]);
  });

  it("skips past a generated name that collides with a real column", () => {
    const outcome = normalizeResult(raw(["id", "id_2", "id"], [[1, 2, 3]]));
    expect(outcome.dataset.fields.map((f) => f.name)).toEqual(["id", "id_2", "id_3"]);
  });

  it("carries a column literally named __proto__ as an own property", () => {
    const { dataset } = normalizeResult(raw(["__proto__"], [[{ polluted: true }]]));
    const row = dataset.rows[0];
    // Reading row["__proto__"] alone proves nothing: on a plain object it would
    // return the prototype, and the assertion would still pass. Assert it is an
    // OWN property and that the row's prototype is still null.
    expect(row === undefined ? undefined : Object.hasOwn(row, "__proto__")).toBe(true);
    expect(row === undefined ? undefined : Object.getPrototypeOf(row)).toBeNull();
    expect(row?.["__proto__"]).toEqual({ polluted: true });
  });

  it("truncates at maxRows and flags it in metadata", () => {
    const { dataset } = normalizeResult(raw(["a"], [[1], [2], [3]]), { maxRows: 2 });
    expect(dataset.rows).toHaveLength(2);
    expect(dataset.metadata?.truncated).toBe(true);
  });

  it("does not flag truncation when the result fits", () => {
    const { dataset } = normalizeResult(raw(["a"], [[1]]), { maxRows: 2 });
    expect(dataset.metadata?.truncated).toBeUndefined();
  });

  it("fills missing trailing cells with null", () => {
    const { dataset } = normalizeResult(raw(["a", "b"], [[1]]));
    expect(dataset.rows[0]?.["b"]).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/normalize-result.test.ts`
Expected: FAIL — cannot resolve `./normalize-result.js`.

- [ ] **Step 3: Implement normalization**

`packages/core/src/internal/normalize-result.ts`:

```ts
import { createRow, setKey } from "../json.js";
import type {
  Dataset,
  DatasetSchema,
  Field,
  FieldType,
  RawQueryResult,
} from "../types/dataset.js";

export interface NormalizeOptions {
  /** Declared field metadata, applied in preference to inference. */
  readonly schema?: DatasetSchema | undefined;
  /** Hard row cap; excess rows are dropped and `metadata.truncated` is set. */
  readonly maxRows?: number | undefined;
}

export interface DuplicateColumn {
  readonly original: string;
  readonly renamed: string;
}

export interface NormalizeOutcome {
  readonly dataset: Dataset;
  readonly duplicates: readonly DuplicateColumn[];
}

function inferType(value: unknown): FieldType | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return "datetime";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return "string";
  }
}

/**
 * Converts a top-level Date to an ISO string so a Dataset survives JSON.
 * Dates nested inside array or object values are left alone — adapters are
 * expected to hand back JSON-shaped values inside composite columns.
 */
function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Converts a positional adapter result into a keyed, prototype-safe Dataset.
 * (design §2.4; SPEC.md §36, §72.4, §72.5)
 */
export function normalizeResult(
  raw: RawQueryResult,
  options: NormalizeOptions = {},
): NormalizeOutcome {
  const duplicates: DuplicateColumn[] = [];
  const used = new Set<string>();
  const names: string[] = [];

  for (const column of raw.columns) {
    if (!used.has(column.name)) {
      used.add(column.name);
      names.push(column.name);
      continue;
    }
    let suffix = 2;
    let candidate = `${column.name}_${suffix}`;
    while (used.has(candidate) || raw.columns.some((other) => other.name === candidate)) {
      suffix += 1;
      candidate = `${column.name}_${suffix}`;
    }
    used.add(candidate);
    names.push(candidate);
    duplicates.push({ original: column.name, renamed: candidate });
  }

  const limit = options.maxRows;
  const truncated = limit !== undefined && raw.rows.length > limit;
  const sourceRows = truncated ? raw.rows.slice(0, limit) : raw.rows;

  const rows = sourceRows.map((cells) => {
    const row = createRow();
    names.forEach((name, index) => {
      setKey(row, name, normalizeValue(cells[index]));
    });
    return row;
  });

  const declared = options.schema?.fields;

  const fields: Field[] = names.map((name, index) => {
    const definition = declared?.[name];
    if (definition !== undefined) {
      return { name, ...definition };
    }
    let inferred: FieldType | undefined;
    let sawNull = false;
    for (const cells of sourceRows) {
      const value = cells[index];
      if (value === null || value === undefined) {
        sawNull = true;
      } else if (inferred === undefined) {
        inferred = inferType(value);
      }
      // Breaking at the first non-null value would miss nulls in later rows and
      // report nullable: false for a column like [10, null]. Stop only once
      // both facts are known.
      if (inferred !== undefined && sawNull) break;
    }
    // Bound to a local so TypeScript narrows it: indexing twice would make
    // the second read `string | undefined` again, which is what tempted the
    // original draft into a double non-null assertion.
    const nativeType = raw.columns[index]?.nativeType;
    return {
      name,
      type: inferred ?? "string",
      nullable: sawNull || inferred === undefined,
      ...(nativeType === undefined ? {} : { format: { nativeType } }),
    };
  });

  const dataset: Dataset = {
    fields,
    rows,
    ...(truncated || raw.metadata?.truncated === true ? { metadata: { truncated: true } } : {}),
  };

  return { dataset, duplicates };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/normalize-result.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add positional result normalization into datasets"
```

---

### Task 12: Dataset validation (validation stage 5)

Validates a materialized dataset against `spec.dataset`. Extra undeclared fields are
**allowed** — the declared schema is a contract on a subset, so adding a column to a query
does not break a manifest. Missing declared fields, wrong types, and null values in
non-nullable fields are errors.

**Files:**
- Create: `packages/core/src/internal/validate/dataset.ts`
- Test: `packages/core/src/internal/validate/dataset.test.ts`

**Interfaces:**
- Consumes: `DatasetValidationError`, `QSpecIssue` (Task 1); `Dataset`, `DatasetSchema`, `FieldType` (Task 4); `suggest` (Task 7).
- Produces: `validateDataset(dataset: Dataset, schema: DatasetSchema | undefined, options?: { maxIssues?: number }): QSpecIssue[]` and `assertValidDataset(dataset, schema, options?): void`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/validate/dataset.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatPath } from "../../errors.js";
import { createRow, setKey } from "../../json.js";
import type { Dataset, DatasetSchema, Field } from "../../types/dataset.js";
import { validateDataset } from "./dataset.js";

function dataset(fields: Field[], rows: Record<string, unknown>[]): Dataset {
  return {
    fields,
    rows: rows.map((source) => {
      const row = createRow();
      for (const [key, value] of Object.entries(source)) setKey(row, key, value);
      return row;
    }),
  };
}

const schema: DatasetSchema = {
  fields: {
    month: { type: "datetime", nullable: false },
    revenue: { type: "number", nullable: false },
  },
};

describe("validateDataset", () => {
  it("accepts a dataset matching its schema", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
      ],
      [{ month: "2026-01-01T00:00:00Z", revenue: 10 }],
    );
    expect(validateDataset(data, schema)).toEqual([]);
  });

  it("accepts everything when no schema is declared", () => {
    expect(validateDataset(dataset([], []), undefined)).toEqual([]);
  });

  it("allows extra undeclared fields", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
        { name: "extra", type: "string" },
      ],
      [{ month: "2026-01-01T00:00:00Z", revenue: 10, extra: "x" }],
    );
    expect(validateDataset(data, schema)).toEqual([]);
  });

  it("reports a missing declared field and suggests a close actual field", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "reveneu", type: "number" },
      ],
      [],
    );
    const issues = validateDataset(data, schema);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.dataset.fields.revenue");
    expect(issues[0]?.suggestion).toBe("reveneu");
  });

  it("reports a declared type mismatch", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "string" },
      ],
      [],
    );
    const issues = validateDataset(data, schema);
    expect(issues[0]?.message).toMatch(/number.*string/);
  });

  it("accepts an integer value where a number is declared", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "integer" },
      ],
      [{ month: "2026-01-01T00:00:00Z", revenue: 10 }],
    );
    expect(validateDataset(data, schema)).toEqual([]);
  });

  it("rejects a null in a non-nullable field and names the row index", () => {
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
      ],
      [{ month: "2026-01-01T00:00:00Z", revenue: 10 }, { month: null, revenue: 1 }],
    );
    const issues = validateDataset(data, schema);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("rows[1].month");
  });

  it("allows nulls when the field is declared nullable", () => {
    const nullable: DatasetSchema = { fields: { a: { type: "string", nullable: true } } };
    const data = dataset([{ name: "a", type: "string" }], [{ a: null }]);
    expect(validateDataset(data, nullable)).toEqual([]);
  });

  it("caps the number of reported row issues", () => {
    const rows = Array.from({ length: 100 }, () => ({ month: null, revenue: 1 }));
    const data = dataset(
      [
        { name: "month", type: "datetime" },
        { name: "revenue", type: "number" },
      ],
      rows,
    );
    expect(validateDataset(data, schema, { maxIssues: 5 })).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/validate/dataset.test.ts`
Expected: FAIL — cannot resolve `./dataset.js`.

- [ ] **Step 3: Implement dataset validation**

`packages/core/src/internal/validate/dataset.ts`:

```ts
import { DatasetValidationError, type QSpecIssue } from "../../errors.js";
import type { Dataset, DatasetSchema, FieldType } from "../../types/dataset.js";
import { suggest } from "../suggest.js";

export interface ValidateDatasetOptions {
  /** Upper bound on reported issues, so a wrong query cannot produce a million errors. */
  readonly maxIssues?: number;
}

const DEFAULT_MAX_ISSUES = 50;

/** `integer` satisfies a declared `number`; nothing else widens. */
function typeSatisfies(actual: FieldType, declared: FieldType): boolean {
  if (actual === declared) return true;
  return declared === "number" && actual === "integer";
}

/**
 * Validation stage 5. Undeclared fields are permitted: `spec.dataset` is a
 * contract on the fields a manifest depends on, not an exhaustive list.
 * (SPEC.md §37, §80)
 */
export function validateDataset(
  dataset: Dataset,
  schema: DatasetSchema | undefined,
  options: ValidateDatasetOptions = {},
): QSpecIssue[] {
  if (schema === undefined) return [];

  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const issues: QSpecIssue[] = [];
  const actualNames = dataset.fields.map((field) => field.name);
  const byName = new Map(dataset.fields.map((field) => [field.name, field]));

  for (const [name, definition] of Object.entries(schema.fields)) {
    const field = byName.get(name);
    if (field === undefined) {
      const hint = suggest(name, actualNames);
      issues.push({
        code: "QSPEC_DATASET_INVALID",
        message:
          `Declared field "${name}" is not present in the query result. ` +
          `Result fields: ${actualNames.length === 0 ? "(none)" : actualNames.join(", ")}.`,
        path: ["spec", "dataset", "fields", name],
        ...(hint === undefined ? {} : { suggestion: hint }),
      });
      continue;
    }
    if (!typeSatisfies(field.type, definition.type)) {
      issues.push({
        code: "QSPEC_DATASET_INVALID",
        message: `Field "${name}" is declared as ${definition.type} but the result is ${field.type}.`,
        path: ["spec", "dataset", "fields", name, "type"],
      });
    }
  }

  const nonNullable = Object.entries(schema.fields)
    .filter(([, definition]) => definition.nullable === false)
    .map(([name]) => name);

  if (nonNullable.length > 0) {
    // rows.entries() yields an already-narrowed row, avoiding an indexed access
    // whose `undefined` would otherwise have to be cast away.
    outer: for (const [index, row] of dataset.rows.entries()) {
      // Schema-level issues may already have filled the budget; do not scan
      // every row only to discard the results in the final slice.
      if (issues.length >= maxIssues) break outer;
      for (const name of nonNullable) {
        if (!byName.has(name)) continue;
        const value = row[name];
        if (value === null || value === undefined) {
          issues.push({
            code: "QSPEC_DATASET_INVALID",
            message: `Field "${name}" is declared non-nullable but row ${index} contains null.`,
            path: ["rows", index, name],
          });
          if (issues.length >= maxIssues) break outer;
        }
      }
    }
  }

  return issues.slice(0, maxIssues);
}

export function assertValidDataset(
  dataset: Dataset,
  schema: DatasetSchema | undefined,
  options?: ValidateDatasetOptions,
): void {
  const issues = validateDataset(dataset, schema, options);
  if (issues.length > 0) {
    throw new DatasetValidationError(
      `Query result does not match the declared dataset schema (${issues.length} problem${
        issues.length === 1 ? "" : "s"
      }).`,
      { issues },
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/validate/dataset.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add dataset schema validation"
```

---

### Task 13: Presentation validation (validation stage 6)

Delivers the SPEC.md §86 headline diagnostic: a presentation referencing `reveneu` when the
projected schema has `revenue` fails during `prepare()` with a suggestion.

**Files:**
- Create: `packages/core/src/internal/validate/presentation.ts`
- Test: `packages/core/src/internal/validate/presentation.test.ts`

**Interfaces:**
- Consumes: `PresentationError`, `QSpecIssue` (Task 1); `Field` (Task 4); `PresentationDefinition`, `PresentationType`, `FieldReference` (Task 4); `suggest` (Task 7).
- Produces: `validatePresentation(definition, presentationType, projectedFields): QSpecIssue[]`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/validate/presentation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatPath } from "../../errors.js";
import type { Field } from "../../types/dataset.js";
import type { PresentationDefinition, PresentationType } from "../../types/presentation.js";
import { validatePresentation } from "./presentation.js";

const lineChart: PresentationType = {
  fieldReferences: (definition) => {
    const references: { field: string; path: (string | number)[] }[] = [];
    const x = (definition as { x?: { field?: string } }).x;
    if (typeof x?.field === "string") references.push({ field: x.field, path: ["x", "field"] });
    const series = (definition as { series?: { field?: string }[] }).series ?? [];
    series.forEach((entry, index) => {
      if (typeof entry.field === "string") {
        references.push({ field: entry.field, path: ["series", index, "field"] });
      }
    });
    return references;
  },
};

const fields: Field[] = [
  { name: "month", type: "datetime" },
  { name: "revenue", type: "number" },
];

const definition: PresentationDefinition = {
  type: "line",
  x: { field: "month" },
  series: [{ field: "revenue" }],
};

describe("validatePresentation", () => {
  it("accepts references that all exist", () => {
    expect(validatePresentation(definition, lineChart, fields)).toEqual([]);
  });

  it("produces the SPEC.md 86 diagnostic for a misspelled field", () => {
    const bad = { ...definition, series: [{ field: "reveneu" }] };
    const issues = validatePresentation(bad, lineChart, fields);
    expect(issues).toHaveLength(1);
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.presentation.series[0].field");
    expect(issues[0]?.message).toMatch(/Unknown dataset field "reveneu"/);
    expect(issues[0]?.suggestion).toBe("revenue");
  });

  it("omits a suggestion when nothing is close", () => {
    const bad = { ...definition, series: [{ field: "zzzzzzzzzz" }] };
    expect(validatePresentation(bad, lineChart, fields)[0]?.suggestion).toBeUndefined();
  });

  it("skips validation when the projected schema is unknown", () => {
    const bad = { ...definition, series: [{ field: "reveneu" }] };
    expect(validatePresentation(bad, lineChart, undefined)).toEqual([]);
  });

  it("skips validation when the presentation type declares no references", () => {
    expect(validatePresentation(definition, {}, fields)).toEqual([]);
  });

  it("surfaces an error thrown by a presentation type's own validate hook", () => {
    const strict: PresentationType = {
      validate: () => {
        throw new Error("series must not be empty");
      },
    };
    const issues = validatePresentation(definition, strict, fields);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe("series must not be empty");
    expect(formatPath(issues[0]?.path ?? [])).toBe("spec.presentation");
  });

  it("reports every bad reference at once", () => {
    const bad = { type: "line", x: { field: "monht" }, series: [{ field: "reveneu" }] };
    expect(validatePresentation(bad, lineChart, fields)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/validate/presentation.test.ts`
Expected: FAIL — cannot resolve `./presentation.js`.

- [ ] **Step 3: Implement presentation validation**

`packages/core/src/internal/validate/presentation.ts`:

```ts
import { PresentationError, type QSpecIssue } from "../../errors.js";
import type { Field } from "../../types/dataset.js";
import type { PresentationDefinition, PresentationType } from "../../types/presentation.js";
import { suggest } from "../suggest.js";

/**
 * Validation stage 6. `projectedFields` is the field set expected to exist
 * *after* the transform pipeline; when it is undefined the projection could not
 * be computed statically and the check is deferred to runtime.
 * (SPEC.md §80, §86; design §2.5)
 */
export function validatePresentation(
  definition: PresentationDefinition,
  presentationType: PresentationType,
  projectedFields: readonly Field[] | undefined,
): QSpecIssue[] {
  const issues: QSpecIssue[] = [];

  if (presentationType.validate !== undefined) {
    try {
      presentationType.validate(definition, { fields: projectedFields });
    } catch (error) {
      issues.push({
        code: "QSPEC_PRESENTATION_INVALID",
        message: error instanceof Error ? error.message : String(error),
        path: ["spec", "presentation"],
      });
    }
  }

  if (projectedFields === undefined || presentationType.fieldReferences === undefined) {
    return issues;
  }

  const known = projectedFields.map((field) => field.name);
  const knownSet = new Set(known);

  for (const reference of presentationType.fieldReferences(definition)) {
    if (knownSet.has(reference.field)) continue;
    const hint = suggest(reference.field, known);
    issues.push({
      code: "QSPEC_PRESENTATION_INVALID",
      message:
        `Unknown dataset field "${reference.field}". ` +
        `Available fields: ${known.length === 0 ? "(none)" : known.join(", ")}.`,
      path: ["spec", "presentation", ...reference.path],
      ...(hint === undefined ? {} : { suggestion: hint }),
    });
  }

  return issues;
}

export function assertValidPresentation(
  definition: PresentationDefinition,
  presentationType: PresentationType,
  projectedFields: readonly Field[] | undefined,
): void {
  const issues = validatePresentation(definition, presentationType, projectedFields);
  if (issues.length > 0) {
    throw new PresentationError(
      `Presentation is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"}).`,
      { issues },
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/validate/presentation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add presentation field-reference validation"
```

---

### Task 14: Lifecycle hooks

Delivers the typed observer model from SPEC.md §68 and design §2.9. Handlers observe; they
cannot mutate. A throwing handler must never break execution.

**Files:**
- Create: `packages/core/src/internal/hooks.ts`
- Create: `packages/core/src/types/events.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/internal/hooks.test.ts`

**Interfaces:**
- Consumes: `QSpecLogger` (declared here, moved to `types/runtime.ts` in Task 15 — declare it in `types/events.ts` for now and re-export).
- Produces:
  - `QSpecEventMap` — a map of event name to payload type, covering `manifest:parse:start/end`, `validation:start/end`, `query:compile:start/end`, `query:execute:start/end`, `dataset:normalize:duplicate-column`, `transform:start/end`, `execution:complete`, `execution:error`.
  - `QSpecEventName = keyof QSpecEventMap`
  - `createHooks(onHandlerError?: (error: unknown) => void): HookRegistry` with `on<E>(event, handler): () => void`, `emit<E>(event, payload): void`.

- [ ] **Step 1: Write the type module**

`packages/core/src/types/events.ts`:

```ts
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
  "query:compile:end": ExecutionEventBase & { readonly language: string; readonly durationMs: number };
  "query:execute:start": ExecutionEventBase & { readonly source: string; readonly language: string };
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
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/internal/hooks.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createHooks } from "./hooks.js";

describe("createHooks", () => {
  it("delivers a payload to a subscriber", () => {
    const hooks = createHooks();
    const handler = vi.fn();
    hooks.on("manifest:parse:end", handler);
    hooks.emit("manifest:parse:end", { kind: "Chart", name: "x" });
    expect(handler).toHaveBeenCalledWith({ kind: "Chart", name: "x" });
  });

  it("supports multiple subscribers in registration order", () => {
    const hooks = createHooks();
    const calls: number[] = [];
    hooks.on("validation:start", () => calls.push(1));
    hooks.on("validation:start", () => calls.push(2));
    hooks.emit("validation:start", { stage: "manifest" });
    expect(calls).toEqual([1, 2]);
  });

  it("unsubscribes via the returned function", () => {
    const hooks = createHooks();
    const handler = vi.fn();
    const off = hooks.on("validation:start", handler);
    off();
    hooks.emit("validation:start", { stage: "manifest" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("is a no-op for events with no subscribers", () => {
    const hooks = createHooks();
    expect(() => hooks.emit("validation:start", { stage: "manifest" })).not.toThrow();
  });

  it("isolates a throwing handler so execution is never broken by observability", () => {
    const onHandlerError = vi.fn();
    const hooks = createHooks(onHandlerError);
    const second = vi.fn();
    hooks.on("validation:start", () => {
      throw new Error("handler exploded");
    });
    hooks.on("validation:start", second);
    expect(() => hooks.emit("validation:start", { stage: "manifest" })).not.toThrow();
    expect(second).toHaveBeenCalled();
    expect(onHandlerError).toHaveBeenCalledOnce();
  });

  it("still calls a handler that an earlier handler unsubscribed mid-emit", () => {
    // This is what the [...set] snapshot actually buys. Self-unsubscription
    // alone would pass without the copy, because JS Set iteration already
    // tolerates deleting the current entry — so a self-unsubscribe test proves
    // nothing about the copy.
    const hooks = createHooks();
    const second = vi.fn();
    let off: () => void = () => {};
    hooks.on("validation:start", () => off());
    off = hooks.on("validation:start", second);
    hooks.emit("validation:start", { stage: "manifest" });
    expect(second).toHaveBeenCalledOnce();
  });

  it("keeps running later handlers when the error reporter itself throws", () => {
    const second = vi.fn();
    const hooks = createHooks(() => {
      throw new Error("reporter exploded");
    });
    hooks.on("validation:start", () => {
      throw new Error("handler exploded");
    });
    hooks.on("validation:start", second);
    expect(() => hooks.emit("validation:start", { stage: "manifest" })).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/hooks.test.ts`
Expected: FAIL — cannot resolve `./hooks.js`.

- [ ] **Step 4: Implement the hook registry**

`packages/core/src/internal/hooks.ts`:

```ts
import type {
  HookRegistry,
  QSpecEventHandler,
  QSpecEventMap,
  QSpecEventName,
} from "../types/events.js";

/**
 * Observers only: handlers receive payloads and cannot alter execution.
 * A handler that throws is contained, because telemetry must never be able to
 * break a query. (SPEC.md §68, §69)
 */
export function createHooks(onHandlerError?: (error: unknown) => void): HookRegistry {
  // Pre-populated so `on`/`emit` only ever READ at a generic key, which is
  // sound. Writing at a generic key is not — TS2322, because E could be
  // instantiated with any subtype of the constraint, collapsing the target to
  // an intersection of every value type — so a lazily-filled Partial<> cannot
  // work here.
  //
  // Because this type is not Partial, omitting an event is a COMPILE ERROR.
  // Adding an entry to QSpecEventMap forces adding its Set here, so the two
  // cannot drift apart. That guarantee is what makes this better than erasing
  // to a single Map and casting on both sides.
  const listeners: { [K in QSpecEventName]: Set<QSpecEventHandler<K>> } = {
    "manifest:parse:start": new Set(),
    "manifest:parse:end": new Set(),
    "validation:start": new Set(),
    "validation:end": new Set(),
    "query:compile:start": new Set(),
    "query:compile:end": new Set(),
    "query:execute:start": new Set(),
    "query:execute:end": new Set(),
    "dataset:normalize:duplicate-column": new Set(),
    "transform:start": new Set(),
    "transform:end": new Set(),
    "execution:complete": new Set(),
    "execution:error": new Set(),
  };

  return {
    on(event, handler) {
      const set = listeners[event];
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    emit<E extends QSpecEventName>(event: E, payload: QSpecEventMap[E]) {
      const set = listeners[event];
      if (set.size === 0) return;
      // Snapshot: a handler may unsubscribe itself — or another pending
      // handler — mid-emit. Everyone registered when the event fired still runs.
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          try {
            onHandlerError?.(error);
          } catch {
            // The error reporter failed too. There is nowhere left to report
            // this, and telemetry must never break a query, so it is dropped.
          }
        }
      }
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/internal/hooks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Export the public types**

`packages/core/src/index.ts` — append:

```ts
export type {
  ExecutionEventBase,
  HookRegistry,
  QSpecEventHandler,
  QSpecEventMap,
  QSpecEventName,
  QSpecLogger,
} from "./types/events.js";
```

- [ ] **Step 7: Verify and commit**

```bash
npm run build && npx vitest run packages/core
git add -A
git commit -m "feat(core): add typed lifecycle hook registry"
```

---

### Task 15: Plugin API, capability contracts, and `createQSpec`

Delivers SPEC.md §49–§53 and §115's `createQSpec().use(plugin)`.

**Key decision — async setup with synchronous chaining.** SPEC.md §49 allows
`setup()` to return a promise, while §52 requires `.use()` to return the runtime for
chaining. `.use()` therefore *queues* the plugin and returns `this` synchronously; queued
setups are awaited on the first `prepare()`/`execute()`, or explicitly via `await
qspec.ready()`. Registration order is preserved, and setups run sequentially so a plugin can
depend on one installed before it.

**Files:**
- Create: `packages/core/src/types/plugin.ts`, `packages/core/src/types/runtime.ts`
- Create: `packages/core/src/internal/runtime.ts`
- Modify: `packages/core/src/define.ts` (add `definePlugin`), `packages/core/src/index.ts`
- Test: `packages/core/src/internal/runtime.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–14.
- Produces:
  - Capability contracts `DataSource`, `DataSourceContext`, `QueryLanguage`, `QueryCompileContext`, `Transform`, `TransformContext`, `SemanticType`, `ResourceKind`, `Renderer`, `RenderContext`.
  - `QSpecPlugin`, `QSpecPluginAPI`, `definePlugin(plugin: QSpecPlugin): QSpecPlugin`.
  - `QSpecLimits`, `DEFAULT_LIMITS`, `QSpecOptions`, `ExecutionContext`, `ExecutionMetadata`, `QSpecResult`, `PreparedResource`, `QSpec`.
  - `createQSpec(options?: QSpecOptions): QSpec`.

- [ ] **Step 1: Write the capability contracts**

`packages/core/src/types/plugin.ts`:

```ts
import type { JsonValue } from "../json.js";
import type { Dataset, Field, FieldType, RawQueryResult } from "./dataset.js";
import type { QSpecLogger } from "./events.js";
import type { PresentationDefinition, PresentationType } from "./presentation.js";
import type { QueryDefinition } from "./query.js";
import type { QSpecResourceSpec } from "./manifest.js";
import type { Registry } from "./registry.js";

export interface DataSourceContext {
  readonly executionId: string;
  readonly signal?: AbortSignal | undefined;
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
  readonly logger: QSpecLogger;
}

/** Connectivity and native execution only; never decides presentation. (SPEC.md §62) */
export interface DataSource<TCompiledQuery = unknown> {
  execute(query: TCompiledQuery, context: DataSourceContext): Promise<RawQueryResult>;
  /** Optional cleanup, called by `QSpec.dispose()`. */
  dispose?(): Promise<void> | void;
}

export interface QueryCompileContext {
  readonly source: string;
  /** Bindings already resolved against validated parameters. */
  readonly bindings: Record<string, JsonValue>;
  readonly parameters: Record<string, JsonValue>;
}

/** Compiles a portable query declaration into something a data source can run. (SPEC.md §63) */
export interface QueryLanguage<TStatement = unknown, TCompiledQuery = unknown> {
  compile(
    query: QueryDefinition<TStatement>,
    context: QueryCompileContext,
  ): Promise<TCompiledQuery> | TCompiledQuery;
  /** Static checks run during prepare(), before any database is touched. (SPEC.md §81) */
  validate?(query: QueryDefinition<TStatement>): void;
}

export interface TransformContext {
  readonly executionId: string;
  readonly parameters: Record<string, JsonValue>;
  readonly signal?: AbortSignal | undefined;
}

/** Transforms must not mutate their input dataset. (SPEC.md §64) */
export interface Transform<TSpec = unknown> {
  execute(dataset: Dataset, spec: TSpec, context: TransformContext): Promise<Dataset> | Dataset;
  /**
   * Static schema inference: given the fields entering this transform, returns
   * the fields leaving it. Omitting this makes the transform schema-opaque and
   * stops static presentation validation at this point. (design §2.5)
   */
  describe?(fields: readonly Field[], spec: TSpec): readonly Field[];
  /** Static validation of the transform's own declaration. Throw to reject. */
  validate?(spec: TSpec, fields: readonly Field[] | undefined): void;
}

/** Semantic types annotate meaning without changing storage type. (SPEC.md §39) */
export interface SemanticType {
  readonly baseTypes?: readonly FieldType[];
  readonly description?: string;
}

export interface ResourceKindContext {
  readonly presentations: Registry<PresentationType>;
}

/** A registry-driven `kind`. (SPEC.md §24) */
export interface ResourceKind {
  readonly requiresQuery?: boolean;
  readonly requiresPresentation?: boolean;
  validate?(spec: QSpecResourceSpec, context: ResourceKindContext): void;
}

export interface RenderContext {
  readonly locale?: string | undefined;
  readonly timezone?: string | undefined;
}

/** Rendering sits entirely outside query execution. (SPEC.md §65) */
export interface Renderer<TPresentation = PresentationDefinition, TOutput = unknown> {
  render(dataset: Dataset, presentation: TPresentation, context: RenderContext): TOutput;
}

/** The capability surface handed to every plugin. (SPEC.md §50) */
export interface QSpecPluginAPI {
  readonly queryLanguages: Registry<QueryLanguage>;
  readonly sources: Registry<DataSource>;
  readonly transforms: Registry<Transform>;
  readonly semanticTypes: Registry<SemanticType>;
  readonly resources: Registry<ResourceKind>;
  readonly presentations: Registry<PresentationType>;
  readonly renderers: Registry<Renderer>;
  readonly hooks: { on: import("./events.js").HookRegistry["on"] };
  readonly logger: QSpecLogger;
  readonly limits: Readonly<import("./runtime.js").QSpecLimits>;
}

export interface QSpecPlugin {
  readonly name: string;
  readonly version?: string;
  setup(api: QSpecPluginAPI): void | Promise<void>;
}
```

Note that `QSpecPluginAPI.hooks` exposes only `on`. Plugins observe lifecycle events; they
do not emit them.

- [ ] **Step 2: Write the runtime types**

`packages/core/src/types/runtime.ts`:

```ts
import type { Dataset } from "./dataset.js";
import type { HookRegistry, QSpecLogger } from "./events.js";
import type { QSpecManifest, QSpecResourceSpec } from "./manifest.js";
import type { PresentationDefinition } from "./presentation.js";
import type { QSpecPlugin } from "./plugin.js";

/** Host-enforceable execution limits. (SPEC.md §72.5) */
export interface QSpecLimits {
  readonly maxRows: number;
  readonly maxTransforms: number;
  readonly maxManifestBytes: number;
  readonly maxExpressionDepth: number;
  /** Wall-clock cap per query, in milliseconds. `undefined` means no timeout. */
  readonly queryTimeoutMs: number | undefined;
}

export const DEFAULT_LIMITS: QSpecLimits = {
  maxRows: 1_000_000,
  maxTransforms: 64,
  maxManifestBytes: 1_048_576,
  maxExpressionDepth: 32,
  queryTimeoutMs: undefined,
};

export interface QSpecOptions {
  readonly limits?: Partial<QSpecLimits>;
  /** Quiet by default. (SPEC.md §85) */
  readonly logger?: QSpecLogger;
}

/** Per-execution inputs. (SPEC.md §59) */
export interface ExecutionContext {
  readonly parameters?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly locale?: string;
  readonly timezone?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Never includes credentials or bound values. (SPEC.md §61, §72.6) */
export interface ExecutionMetadata {
  readonly executionId: string;
  readonly durationMs: number;
  readonly rowCount: number;
  readonly query?: {
    readonly source: string;
    readonly language: string;
    readonly durationMs?: number;
  };
}

export interface QSpecResult {
  readonly data: Dataset;
  readonly presentation?: PresentationDefinition;
  readonly meta: ExecutionMetadata;
}

export interface PreparedResource {
  readonly manifest: QSpecManifest<QSpecResourceSpec>;
  readonly kind: string;
  readonly name: string;
  /** Field names projected to exist after transforms, or undefined if not statically known. */
  readonly projectedFields: readonly string[] | undefined;
  execute(context?: ExecutionContext): Promise<QSpecResult>;
}

export interface QSpec {
  /** Queues a plugin and returns the runtime for chaining. (SPEC.md §52) */
  use(plugin: QSpecPlugin): QSpec;
  /** Awaits any queued plugin setups. Called implicitly by prepare/execute. */
  ready(): Promise<void>;
  prepare(manifest: QSpecManifest<QSpecResourceSpec> | string | unknown): Promise<PreparedResource>;
  execute(
    manifest: QSpecManifest<QSpecResourceSpec> | string | unknown,
    context?: ExecutionContext,
  ): Promise<QSpecResult>;
  /** Subscribe to lifecycle events. (SPEC.md §68) */
  on: HookRegistry["on"];
  /** Disposes every registered data source that declares a `dispose` method. */
  dispose(): Promise<void>;
  readonly limits: QSpecLimits;
}

```

- [ ] **Step 3: Write the failing test**

`packages/core/src/internal/runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PluginRegistrationError, UnknownResourceKindError } from "../errors.js";
import { definePlugin } from "../define.js";
import { createQSpec } from "./runtime.js";

const minimal = {
  apiVersion: "qspec.dev/v1",
  kind: "Dataset",
  metadata: { name: "example" },
  spec: { parameters: {} },
};

describe("createQSpec", () => {
  it("registers the built-in Dataset resource kind", async () => {
    const qspec = createQSpec();
    const prepared = await qspec.prepare(minimal);
    expect(prepared.kind).toBe("Dataset");
    expect(prepared.name).toBe("example");
  });

  it("rejects an unregistered kind and suggests a registered one", async () => {
    const qspec = createQSpec();
    await expect(qspec.prepare({ ...minimal, kind: "Datset" })).rejects.toThrow(
      UnknownResourceKindError,
    );
  });

  it("returns itself from use() so calls chain", () => {
    const qspec = createQSpec();
    const plugin = definePlugin({ name: "p", setup: () => {} });
    expect(qspec.use(plugin)).toBe(qspec);
  });

  it("runs plugin setup lazily, on ready()", async () => {
    const setup = vi.fn();
    const qspec = createQSpec().use(definePlugin({ name: "p", setup }));
    expect(setup).not.toHaveBeenCalled();
    await qspec.ready();
    expect(setup).toHaveBeenCalledOnce();
  });

  it("awaits an async setup before prepare resolves", async () => {
    let done = false;
    const qspec = createQSpec().use(
      definePlugin({
        name: "p",
        setup: async (api) => {
          await Promise.resolve();
          api.resources.register("Widget", {});
          done = true;
        },
      }),
    );
    await qspec.prepare({ ...minimal, kind: "Widget" });
    expect(done).toBe(true);
  });

  it("runs each setup exactly once across repeated calls", async () => {
    const setup = vi.fn();
    const qspec = createQSpec().use(definePlugin({ name: "p", setup }));
    await qspec.ready();
    await qspec.ready();
    await qspec.prepare(minimal);
    expect(setup).toHaveBeenCalledOnce();
  });

  it("runs setups in registration order", async () => {
    const order: string[] = [];
    const qspec = createQSpec()
      .use(definePlugin({ name: "a", setup: () => void order.push("a") }))
      .use(definePlugin({ name: "b", setup: () => void order.push("b") }));
    await qspec.ready();
    expect(order).toEqual(["a", "b"]);
  });

  it("rejects two plugins with the same name", async () => {
    const qspec = createQSpec()
      .use(definePlugin({ name: "dup", setup: () => {} }))
      .use(definePlugin({ name: "dup", setup: () => {} }));
    await expect(qspec.ready()).rejects.toThrow(PluginRegistrationError);
  });

  it("wraps a setup failure with the plugin name", async () => {
    const qspec = createQSpec().use(
      definePlugin({
        name: "broken",
        setup: () => {
          throw new Error("nope");
        },
      }),
    );
    await expect(qspec.ready()).rejects.toThrow(/broken/);
  });

  it("exposes registries to plugins and shares them across plugins", async () => {
    const qspec = createQSpec()
      .use(definePlugin({ name: "a", setup: (api) => api.transforms.register("noop", { execute: (d) => d }) }))
      .use(
        definePlugin({
          name: "b",
          setup: (api) => {
            expect(api.transforms.has("noop")).toBe(true);
          },
        }),
      );
    await qspec.ready();
  });

  it("merges partial limits over the defaults", () => {
    const qspec = createQSpec({ limits: { maxRows: 10 } });
    expect(qspec.limits.maxRows).toBe(10);
    expect(qspec.limits.maxTransforms).toBe(64);
  });

  it("forwards lifecycle events to subscribers", async () => {
    const qspec = createQSpec();
    const handler = vi.fn();
    qspec.on("manifest:parse:end", handler);
    await qspec.prepare(minimal);
    expect(handler).toHaveBeenCalledWith({ kind: "Dataset", name: "example" });
  });

  it("disposes data sources that declare dispose", async () => {
    const dispose = vi.fn();
    const qspec = createQSpec().use(
      definePlugin({
        name: "src",
        setup: (api) => api.sources.register("s", { execute: async () => ({ columns: [], rows: [] }), dispose }),
      }),
    );
    await qspec.ready();
    await qspec.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("accepts a JSON string manifest", async () => {
    const prepared = await createQSpec().prepare(JSON.stringify(minimal));
    expect(prepared.name).toBe("example");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/runtime.test.ts`
Expected: FAIL — cannot resolve `./runtime.js`.

- [ ] **Step 5: Add `definePlugin` to `define.ts`**

Append to `packages/core/src/define.ts`:

```ts
import type { QSpecPlugin } from "./types/plugin.js";

/**
 * Identity helper that gives plugin authors autocomplete without requiring them
 * to understand any runtime internals. (SPEC.md §105)
 */
export function definePlugin(plugin: QSpecPlugin): QSpecPlugin {
  return plugin;
}
```

- [ ] **Step 6: Implement the runtime**

`packages/core/src/internal/runtime.ts`:

```ts
import { PluginRegistrationError, QSpecError } from "../errors.js";
import type { HookRegistry } from "../types/events.js";
import type { QSpecManifest, QSpecResourceSpec } from "../types/manifest.js";
import type { PresentationType } from "../types/presentation.js";
import type {
  DataSource,
  QSpecPlugin,
  QSpecPluginAPI,
  QueryLanguage,
  Renderer,
  ResourceKind,
  SemanticType,
  Transform,
} from "../types/plugin.js";
import {
  DEFAULT_LIMITS,
  type ExecutionContext,
  type PreparedResource,
  type QSpec,
  type QSpecLimits,
  type QSpecOptions,
  type QSpecResult,
} from "../types/runtime.js";
import { createHooks } from "./hooks.js";
import { createRegistry } from "./registry.js";
import { prepareResource } from "./prepare.js";

/** Everything the prepare/execute pipelines need from the runtime. */
export interface RuntimeInternals {
  readonly registries: {
    readonly queryLanguages: ReturnType<typeof createRegistry<QueryLanguage>>;
    readonly sources: ReturnType<typeof createRegistry<DataSource>>;
    readonly transforms: ReturnType<typeof createRegistry<Transform>>;
    readonly semanticTypes: ReturnType<typeof createRegistry<SemanticType>>;
    readonly resources: ReturnType<typeof createRegistry<ResourceKind>>;
    readonly presentations: ReturnType<typeof createRegistry<PresentationType>>;
    readonly renderers: ReturnType<typeof createRegistry<Renderer>>;
  };
  readonly hooks: HookRegistry;
  readonly limits: QSpecLimits;
  readonly logger: NonNullable<QSpecOptions["logger"]>;
}

export function createQSpec(options: QSpecOptions = {}): QSpec {
  const limits: QSpecLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const logger = options.logger ?? {};
  const hooks = createHooks((error) => {
    logger.warn?.("A QSpec lifecycle handler threw and was ignored.", error);
  });

  const registries = {
    queryLanguages: createRegistry<QueryLanguage>("query language"),
    sources: createRegistry<DataSource>("data source"),
    transforms: createRegistry<Transform>("transform"),
    semanticTypes: createRegistry<SemanticType>("semantic type"),
    resources: createRegistry<ResourceKind>("resource kind"),
    presentations: createRegistry<PresentationType>("presentation type"),
    renderers: createRegistry<Renderer>("renderer"),
  };

  // The one kind core owns: a resource with no presentation. (SPEC.md §24)
  registries.resources.register("Dataset", { requiresPresentation: false });

  const internals: RuntimeInternals = { registries, hooks, limits, logger };

  const pluginApi: QSpecPluginAPI = {
    queryLanguages: registries.queryLanguages,
    sources: registries.sources,
    transforms: registries.transforms,
    semanticTypes: registries.semanticTypes,
    resources: registries.resources,
    presentations: registries.presentations,
    renderers: registries.renderers,
    hooks: { on: hooks.on },
    logger,
    limits,
  };

  const queued: QSpecPlugin[] = [];
  const installed = new Set<string>();
  let settling: Promise<void> | undefined;

  async function drain(): Promise<void> {
    while (queued.length > 0) {
      const plugin = queued.shift() as QSpecPlugin;
      if (installed.has(plugin.name)) {
        throw new PluginRegistrationError(
          `Plugin "${plugin.name}" is already installed.`,
          { plugin: plugin.name },
        );
      }
      installed.add(plugin.name);
      try {
        await plugin.setup(pluginApi);
      } catch (error) {
        if (error instanceof QSpecError) throw error;
        throw new PluginRegistrationError(
          `Plugin "${plugin.name}" failed during setup: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { plugin: plugin.name },
        );
      }
    }
  }

  const qspec: QSpec = {
    limits,
    on: hooks.on,

    use(plugin) {
      queued.push(plugin);
      // A new plugin invalidates any settled state so ready() drains it.
      settling = undefined;
      return qspec;
    },

    async ready() {
      if (settling === undefined) {
        settling = drain().catch((error: unknown) => {
          // Re-throw on every await, but do not wedge the runtime in a
          // half-settled state that silently swallows the failure later.
          settling = Promise.reject(error);
          throw error;
        });
      }
      await settling;
    },

    async prepare(manifest): Promise<PreparedResource> {
      await qspec.ready();
      return prepareResource(manifest, internals);
    },

    async execute(manifest, context?: ExecutionContext): Promise<QSpecResult> {
      const prepared = await qspec.prepare(manifest);
      return prepared.execute(context);
    },

    async dispose() {
      for (const name of registries.sources.list()) {
        const source = registries.sources.get(name);
        await source?.dispose?.();
      }
    },
  };

  return qspec;
}

```

- [ ] **Step 7: Export the public surface**

`packages/core/src/index.ts` — append:

```ts
export { createQSpec } from "./internal/runtime.js";
export { definePlugin } from "./define.js";
export { DEFAULT_LIMITS } from "./types/runtime.js";
export type {
  ExecutionContext,
  ExecutionMetadata,
  PreparedResource,
  QSpec,
  QSpecLimits,
  QSpecOptions,
  QSpecResult,
} from "./types/runtime.js";
export type {
  DataSource,
  DataSourceContext,
  QSpecPlugin,
  QSpecPluginAPI,
  QueryCompileContext,
  QueryLanguage,
  RenderContext,
  Renderer,
  ResourceKind,
  ResourceKindContext,
  SemanticType,
  Transform,
  TransformContext,
} from "./types/plugin.js";
```

- [ ] **Step 8: Run the tests**

This task's tests cannot pass until Task 16 supplies `prepare.ts`. Run them at the end of
Task 16 instead. Verify only that the package type-checks so far:

Run: `npm run build`
Expected: FAIL — `./prepare.js` does not exist yet. Proceed straight to Task 16; commit at
the end of Task 16.

---

### Task 16: `prepare()` — the static pipeline

Delivers SPEC.md §58 and §81: all static work done once, so invalid manifests fail without
touching a database.

**Files:**
- Create: `packages/core/src/internal/prepare.ts`
- Test: `packages/core/src/internal/prepare.test.ts`

**Interfaces:**
- Consumes: `parseManifest` (Task 4), `assertValidManifest` (Task 5), `compileParameters` (Task 6), `suggest` (Task 7), `normalizeExpression` (Task 8), `compileBindings` (Task 10), `validatePresentation` (Task 13), `RuntimeInternals` (Task 15).
- Produces:
  - `PreparedPlan` — the internal frozen artifact: `{ manifest, kind, name, parameters, bindings, queryLanguage, sourceName, transforms: readonly PreparedTransform[], presentation, projectedFields }`.
  - `PreparedTransform = { type: string; spec: TransformDefinition; implementation: Transform; index: number }`.
  - `prepareResource(input, internals): PreparedResource`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/prepare.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  LimitExceededError,
  ManifestValidationError,
  PresentationError,
  UnknownDataSourceError,
  UnknownQueryLanguageError,
  UnknownResourceKindError,
} from "../errors.js";
import { definePlugin } from "../define.js";
import type { Field } from "../types/dataset.js";
import { createQSpec } from "./runtime.js";

function chartManifest(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "qspec.dev/v1",
    kind: "Chart",
    metadata: { name: "monthly-revenue" },
    spec: {
      parameters: { from: { type: "date", required: true } },
      query: {
        source: "analytics",
        language: "sql",
        statement: "SELECT 1",
        bindings: { from: "$parameters.from" },
      },
      dataset: {
        fields: { month: { type: "datetime" }, revenue: { type: "number" } },
      },
      presentation: { type: "line", x: { field: "month" }, series: [{ field: "revenue" }] },
      ...overrides,
    },
  };
}

/** A runtime with just enough registered capability to prepare a chart. */
function runtime() {
  return createQSpec().use(
    definePlugin({
      name: "test-capabilities",
      setup(api) {
        api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
        api.queryLanguages.register("sql", { compile: (query) => query.statement });
        api.sources.register("analytics", { execute: async () => ({ columns: [], rows: [] }) });
        api.presentations.register("line", {
          fieldReferences: (definition) => {
            const references: { field: string; path: (string | number)[] }[] = [];
            const x = (definition as { x?: { field?: string } }).x;
            if (x?.field) references.push({ field: x.field, path: ["x", "field"] });
            ((definition as { series?: { field?: string }[] }).series ?? []).forEach((s, i) => {
              if (s.field) references.push({ field: s.field, path: ["series", i, "field"] });
            });
            return references;
          },
        });
        api.transforms.register("rename", {
          execute: (dataset) => dataset,
          describe: (fields, spec) => {
            const { from, to } = spec as { from: string; to: string };
            return fields.map((field): Field => (field.name === from ? { ...field, name: to } : field));
          },
        });
        api.transforms.register("opaque", { execute: (dataset) => dataset });
      },
    }),
  );
}

describe("prepare", () => {
  it("prepares a valid chart manifest", async () => {
    const prepared = await runtime().prepare(chartManifest());
    expect(prepared.kind).toBe("Chart");
    expect(prepared.projectedFields).toEqual(["month", "revenue"]);
  });

  it("rejects a structurally invalid manifest before touching capabilities", async () => {
    await expect(runtime().prepare({ apiVersion: "qspec.dev/v1" })).rejects.toThrow(
      ManifestValidationError,
    );
  });

  it("rejects an unknown resource kind", async () => {
    await expect(runtime().prepare({ ...chartManifest(), kind: "Widget" })).rejects.toThrow(
      UnknownResourceKindError,
    );
  });

  it("rejects an unknown query language", async () => {
    const manifest = chartManifest();
    manifest.spec.query.language = "promql";
    await expect(runtime().prepare(manifest)).rejects.toThrow(UnknownQueryLanguageError);
  });

  it("rejects an unknown data source", async () => {
    const manifest = chartManifest();
    manifest.spec.query.source = "warehouse";
    await expect(runtime().prepare(manifest)).rejects.toThrow(UnknownDataSourceError);
  });

  it("requires a query when the resource kind demands one", async () => {
    const manifest = chartManifest();
    delete (manifest.spec as Record<string, unknown>)["query"];
    await expect(runtime().prepare(manifest)).rejects.toThrow(/query/);
  });

  it("rejects an unknown transform type and suggests a registered one", async () => {
    const manifest = chartManifest({ transforms: [{ type: "renmae", from: "a", to: "b" }] });
    await expect(runtime().prepare(manifest)).rejects.toThrow(/rename/);
  });

  it("fails static presentation validation for a misspelled field", async () => {
    const manifest = chartManifest();
    manifest.spec.presentation.series = [{ field: "reveneu" }];
    await expect(runtime().prepare(manifest)).rejects.toThrow(PresentationError);
  });

  it("projects renamed fields so presentation validation follows the pipeline", async () => {
    const manifest = chartManifest({ transforms: [{ type: "rename", from: "revenue", to: "total" }] });
    manifest.spec.presentation.series = [{ field: "total" }];
    const prepared = await runtime().prepare(manifest);
    expect(prepared.projectedFields).toEqual(["month", "total"]);
  });

  it("stops projecting at a schema-opaque transform and skips the field check", async () => {
    const manifest = chartManifest({ transforms: [{ type: "opaque" }] });
    manifest.spec.presentation.series = [{ field: "anything-goes" }];
    const prepared = await runtime().prepare(manifest);
    expect(prepared.projectedFields).toBeUndefined();
  });

  it("skips static field checks when no dataset schema is declared", async () => {
    const manifest = chartManifest();
    delete (manifest.spec as Record<string, unknown>)["dataset"];
    manifest.spec.presentation.series = [{ field: "unknowable" }];
    const prepared = await runtime().prepare(manifest);
    expect(prepared.projectedFields).toBeUndefined();
  });

  it("rejects a binding to an undeclared parameter", async () => {
    const manifest = chartManifest();
    manifest.spec.query.bindings = { from: "$parameters.form" };
    await expect(runtime().prepare(manifest)).rejects.toThrow(/form/);
  });

  it("enforces maxTransforms", async () => {
    const transforms = Array.from({ length: 5 }, () => ({ type: "opaque" }));
    const qspec = createQSpec({ limits: { maxTransforms: 2 } }).use(
      definePlugin({
        name: "t",
        setup: (api) => {
          api.resources.register("Dataset2", {});
          api.transforms.register("opaque", { execute: (d) => d });
        },
      }),
    );
    await expect(
      qspec.prepare({
        apiVersion: "qspec.dev/v1",
        kind: "Dataset2",
        metadata: { name: "x" },
        spec: { transforms },
      }),
    ).rejects.toThrow(LimitExceededError);
  });

  it("is reusable: preparing once allows many executions", async () => {
    const prepared = await runtime().prepare(chartManifest());
    expect(typeof prepared.execute).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/prepare.test.ts`
Expected: FAIL — cannot resolve `./prepare.js`.

- [ ] **Step 3: Implement `prepare.ts`**

`packages/core/src/internal/prepare.ts`:

```ts
import {
  LimitExceededError,
  ManifestValidationError,
  PresentationError,
  UnknownDataSourceError,
  UnknownQueryLanguageError,
  UnknownResourceKindError,
} from "../errors.js";
import { parseManifest } from "../define.js";
import { deepFreeze } from "../json.js";
import type { Field } from "../types/dataset.js";
import type { QSpecManifest, QSpecResourceSpec, TransformDefinition } from "../types/manifest.js";
import type { PresentationDefinition, PresentationType } from "../types/presentation.js";
import type { DataSource, QueryLanguage, ResourceKind, Transform } from "../types/plugin.js";
import type { ExecutionContext, PreparedResource, QSpecResult } from "../types/runtime.js";
import { compileBindings, type CompiledBinding } from "./bindings.js";
import { executePrepared } from "./execute.js";
import type { RuntimeInternals } from "./runtime.js";
import { suggest } from "./suggest.js";
import { assertValidManifest } from "./validate/manifest.js";
import { compileParameters, type CompiledParameters } from "./validate/parameters.js";
import { validatePresentation } from "./validate/presentation.js";

export interface PreparedTransform {
  readonly index: number;
  readonly type: string;
  readonly spec: TransformDefinition;
  readonly implementation: Transform;
}

export interface PreparedPlan {
  readonly manifest: QSpecManifest<QSpecResourceSpec>;
  readonly kind: string;
  readonly name: string;
  readonly parameters: CompiledParameters;
  readonly bindings: readonly CompiledBinding[];
  readonly queryLanguage: QueryLanguage | undefined;
  readonly source: DataSource | undefined;
  readonly sourceName: string | undefined;
  readonly languageName: string | undefined;
  readonly transforms: readonly PreparedTransform[];
  readonly presentation: PresentationDefinition | undefined;
  readonly projectedFields: readonly Field[] | undefined;
}

function manifestError(message: string, path: (string | number)[], suggestion?: string): never {
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
 * Runs every validation stage that does not need query results, then freezes
 * the plan so repeated executions do no static work. (SPEC.md §58, §81, §112)
 */
export function prepareResource(
  input: QSpecManifest<QSpecResourceSpec> | string | unknown,
  internals: RuntimeInternals,
): PreparedResource {
  const { registries, hooks, limits } = internals;

  hooks.emit("manifest:parse:start", {});
  const parsed = parseManifest(input, { maxBytes: limits.maxManifestBytes });

  hooks.emit("validation:start", { stage: "manifest" });
  const manifest = assertValidManifest(parsed);
  hooks.emit("validation:end", { stage: "manifest", issues: [] });
  hooks.emit("manifest:parse:end", { kind: manifest.kind, name: manifest.metadata.name });

  // Stage 2: capabilities.
  const resourceKind: ResourceKind | undefined = registries.resources.get(manifest.kind);
  if (resourceKind === undefined) {
    throw new UnknownResourceKindError(
      `Unknown resource kind "${manifest.kind}". Registered kinds: ${
        registries.resources.list().join(", ") || "(none)"
      }.`,
      { suggestion: suggest(manifest.kind, registries.resources.list()) },
    );
  }

  const spec = manifest.spec;
  const parameters = compileParameters(spec.parameters);

  let queryLanguage: QueryLanguage | undefined;
  let source: DataSource | undefined;
  let bindings: readonly CompiledBinding[] = [];
  let sourceName: string | undefined;
  let languageName: string | undefined;

  if (spec.query === undefined) {
    if (resourceKind.requiresQuery === true) {
      manifestError(`Resource kind "${manifest.kind}" requires a \`spec.query\`.`, ["spec", "query"]);
    }
  } else {
    sourceName = spec.query.source;
    languageName = spec.query.language;

    queryLanguage = registries.queryLanguages.get(languageName);
    if (queryLanguage === undefined) {
      throw new UnknownQueryLanguageError(
        `Unknown query language "${languageName}". Registered languages: ${
          registries.queryLanguages.list().join(", ") || "(none)"
        }.`,
        { suggestion: suggest(languageName, registries.queryLanguages.list()) },
      );
    }

    source = registries.sources.get(sourceName);
    if (source === undefined) {
      throw new UnknownDataSourceError(
        `Unknown data source "${sourceName}". Configured sources: ${
          registries.sources.list().join(", ") || "(none)"
        }.`,
        { suggestion: suggest(sourceName, registries.sources.list()) },
      );
    }

    bindings = compileBindings(spec.query.bindings, parameters, ["spec", "query", "bindings"]);
    queryLanguage.validate?.(spec.query);
  }

  // Stage 6 input: project the field schema through the transform pipeline.
  const declaredTransforms = spec.transforms ?? [];
  if (declaredTransforms.length > limits.maxTransforms) {
    throw new LimitExceededError(
      `Manifest declares ${declaredTransforms.length} transforms, exceeding the limit of ${limits.maxTransforms}.`,
      { limit: "maxTransforms", allowed: limits.maxTransforms, actual: declaredTransforms.length },
    );
  }

  let projected: readonly Field[] | undefined =
    spec.dataset === undefined
      ? undefined
      : Object.entries(spec.dataset.fields).map(([name, definition]) => ({ name, ...definition }));

  const transforms: PreparedTransform[] = declaredTransforms.map((definition, index) => {
    const implementation = registries.transforms.get(definition.type);
    if (implementation === undefined) {
      manifestError(
        `Unknown transform "${definition.type}". Registered transforms: ${
          registries.transforms.list().join(", ") || "(none)"
        }.`,
        ["spec", "transforms", index, "type"],
        suggest(definition.type, registries.transforms.list()),
      );
    }
    implementation.validate?.(definition, projected);
    // A transform without describe() is schema-opaque: projection stops here.
    projected =
      implementation.describe === undefined || projected === undefined
        ? undefined
        : implementation.describe(projected, definition);
    return { index, type: definition.type, spec: definition, implementation };
  });

  let presentation: PresentationDefinition | undefined;
  if (spec.presentation === undefined) {
    if (resourceKind.requiresPresentation === true) {
      manifestError(
        `Resource kind "${manifest.kind}" requires a \`spec.presentation\`.`,
        ["spec", "presentation"],
      );
    }
  } else {
    presentation = spec.presentation;
    const presentationType: PresentationType | undefined = registries.presentations.get(
      presentation.type,
    );
    if (presentationType === undefined) {
      manifestError(
        `Unknown presentation type "${presentation.type}". Registered types: ${
          registries.presentations.list().join(", ") || "(none)"
        }.`,
        ["spec", "presentation", "type"],
        suggest(presentation.type, registries.presentations.list()),
      );
    }
    hooks.emit("validation:start", { stage: "presentation" });
    const issues = validatePresentation(presentation, presentationType, projected);
    hooks.emit("validation:end", { stage: "presentation", issues });
    if (issues.length > 0) {
      throw new PresentationError(
        `Presentation is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"}).`,
        { issues },
      );
    }
  }

  resourceKind.validate?.(spec, { presentations: registries.presentations });

  const plan: PreparedPlan = deepFreeze({
    manifest,
    kind: manifest.kind,
    name: manifest.metadata.name,
    parameters,
    bindings,
    queryLanguage,
    source,
    sourceName,
    languageName,
    transforms,
    presentation,
    projectedFields: projected,
  });

  return {
    manifest,
    kind: plan.kind,
    name: plan.name,
    projectedFields: projected?.map((field) => field.name),
    execute: (context?: ExecutionContext): Promise<QSpecResult> =>
      executePrepared(plan, internals, context ?? {}),
  };
}
```

- [ ] **Step 4: Run the tests**

These still require Task 17's `execute.ts`. Proceed to Task 17, then run:

Run: `npx vitest run packages/core/src/internal/prepare.test.ts packages/core/src/internal/runtime.test.ts`
Expected: PASS (14 + 14 tests).

---

### Task 17: `execute()` — the per-execution pipeline

Delivers SPEC.md §57, §59–§61, and §72.5–§72.6.

> **Tasks 15, 16, and 17 are mutually dependent and share one commit.** The runtime needs
> `prepare`, `prepare` needs `execute`, and none of the three type-checks alone. Write all
> three, then run the full suite and commit once at the end of this task. This is the only
> place in the plan where a task does not stand alone; splitting it further would mean
> committing code that does not compile.

**Files:**
- Create: `packages/core/src/internal/execute.ts`
- Test: `packages/core/src/internal/execute.test.ts`

**Interfaces:**
- Consumes: `validateParameters` (Task 6), `resolveBindings` (Task 10), `normalizeResult` (Task 11), `assertValidDataset` (Task 12), `PreparedPlan` and `RuntimeInternals` (Tasks 15–16).
- Produces: `executePrepared(plan: PreparedPlan, internals: RuntimeInternals, context: ExecutionContext): Promise<QSpecResult>`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/internal/execute.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  DatasetValidationError,
  ParameterValidationError,
  QSpecAbortError,
  QueryExecutionError,
} from "../errors.js";
import { definePlugin } from "../define.js";
import type { Dataset, RawQueryResult } from "../types/dataset.js";
import { createQSpec } from "./runtime.js";

const rows: RawQueryResult = {
  columns: [{ name: "month" }, { name: "revenue" }],
  rows: [
    ["2026-01-01T00:00:00Z", 10],
    ["2026-02-01T00:00:00Z", 0],
  ],
};

function build(options: {
  execute?: (query: unknown, context: { signal?: AbortSignal }) => Promise<RawQueryResult>;
  limits?: { maxRows?: number };
} = {}) {
  const compile = vi.fn((query: { statement: unknown }, ctx: { bindings: Record<string, unknown> }) => ({
    statement: query.statement,
    bindings: ctx.bindings,
  }));
  const execute = options.execute ?? (async () => rows);

  const qspec = createQSpec(options.limits ? { limits: options.limits } : {}).use(
    definePlugin({
      name: "test",
      setup(api) {
        api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
        api.queryLanguages.register("sql", { compile });
        api.sources.register("analytics", { execute });
        api.presentations.register("line", {});
        api.transforms.register("drop-zero", {
          execute: (dataset): Dataset => ({
            ...dataset,
            rows: dataset.rows.filter((row) => row["revenue"] !== 0),
          }),
          describe: (fields) => fields,
        });
      },
    }),
  );
  return { qspec, compile };
}

const manifest = {
  apiVersion: "qspec.dev/v1",
  kind: "Chart",
  metadata: { name: "monthly-revenue" },
  spec: {
    parameters: { from: { type: "date", required: true } },
    query: {
      source: "analytics",
      language: "sql",
      statement: "SELECT 1",
      bindings: { from: "$parameters.from" },
    },
    dataset: { fields: { month: { type: "datetime" }, revenue: { type: "number" } } },
    presentation: { type: "line" },
  },
};

describe("execute", () => {
  it("runs the pipeline and returns a normalized dataset", async () => {
    const { qspec } = build();
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.rows).toHaveLength(2);
    expect(result.data.fields.map((f) => f.name)).toEqual(["month", "revenue"]);
    expect(result.presentation).toEqual({ type: "line" });
  });

  it("reports metadata without leaking bound values", async () => {
    const { qspec } = build();
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.meta.rowCount).toBe(2);
    expect(result.meta.query).toMatchObject({ source: "analytics", language: "sql" });
    expect(typeof result.meta.executionId).toBe("string");
    expect(JSON.stringify(result.meta)).not.toContain("2026-01-01");
  });

  it("validates parameters before compiling the query", async () => {
    const { qspec, compile } = build();
    await expect(qspec.execute(manifest, { parameters: {} })).rejects.toThrow(
      ParameterValidationError,
    );
    expect(compile).not.toHaveBeenCalled();
  });

  it("passes resolved bindings to the query compiler", async () => {
    const { qspec, compile } = build();
    await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(compile.mock.calls[0]?.[1]).toMatchObject({ bindings: { from: "2026-01-01" } });
  });

  it("runs transforms in declaration order", async () => {
    const { qspec } = build();
    const withTransform = {
      ...manifest,
      spec: { ...manifest.spec, transforms: [{ type: "drop-zero" }] },
    };
    const result = await qspec.execute(withTransform, { parameters: { from: "2026-01-01" } });
    expect(result.data.rows).toHaveLength(1);
    expect(result.meta.rowCount).toBe(1);
  });

  it("does not mutate the dataset a transform received", async () => {
    const seen: { rows: number }[] = [];
    const qspec = createQSpec().use(
      definePlugin({
        name: "observer",
        setup(api) {
          api.resources.register("Chart", { requiresQuery: true, requiresPresentation: true });
          api.queryLanguages.register("sql", { compile: (query) => query.statement });
          api.sources.register("analytics", { execute: async () => rows });
          api.presentations.register("line", {});
          api.transforms.register("drop-zero", {
            execute: (dataset): Dataset => {
              const output = {
                ...dataset,
                rows: dataset.rows.filter((row) => row["revenue"] !== 0),
              };
              // Recorded after building the output: the input must be untouched.
              seen.push({ rows: dataset.rows.length });
              return output;
            },
            describe: (fields) => fields,
          });
        },
      }),
    );
    const result = await qspec.execute(
      { ...manifest, spec: { ...manifest.spec, transforms: [{ type: "drop-zero" }] } },
      { parameters: { from: "2026-01-01" } },
    );
    // The transform still saw both rows; only its return value was filtered.
    expect(seen).toEqual([{ rows: 2 }]);
    expect(result.data.rows).toHaveLength(1);
  });

  it("validates the dataset against the declared schema", async () => {
    const { qspec } = build({
      execute: async () => ({ columns: [{ name: "month" }], rows: [["2026-01-01T00:00:00Z"]] }),
    });
    await expect(qspec.execute(manifest, { parameters: { from: "2026-01-01" } })).rejects.toThrow(
      DatasetValidationError,
    );
  });

  it("wraps an adapter failure in QueryExecutionError with the cause attached", async () => {
    const underlying = new Error("connection refused");
    const { qspec } = build({
      execute: async () => {
        throw underlying;
      },
    });
    try {
      await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryExecutionError);
      expect((error as QueryExecutionError).cause).toBe(underlying);
    }
  });

  it("throws QSpecAbortError when the signal is already aborted", async () => {
    const { qspec, compile } = build();
    const controller = new AbortController();
    controller.abort();
    await expect(
      qspec.execute(manifest, { parameters: { from: "2026-01-01" }, signal: controller.signal }),
    ).rejects.toThrow(QSpecAbortError);
    expect(compile).not.toHaveBeenCalled();
  });

  it("propagates the signal to the data source", async () => {
    let received: AbortSignal | undefined;
    const { qspec } = build({
      execute: async (_query, context) => {
        received = context.signal;
        return rows;
      },
    });
    const controller = new AbortController();
    await qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    expect(received?.aborted).toBe(false);
  });

  it("aborts mid-flight when the caller cancels", async () => {
    const { qspec } = build({
      execute: (_query, context) =>
        new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const controller = new AbortController();
    const promise = qspec.execute(manifest, {
      parameters: { from: "2026-01-01" },
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(QSpecAbortError);
  });

  it("truncates at maxRows", async () => {
    const { qspec } = build({ limits: { maxRows: 1 } });
    const result = await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.metadata?.truncated).toBe(true);
  });

  it("emits execution:complete on success and execution:error on failure", async () => {
    const { qspec } = build();
    const complete = vi.fn();
    const failed = vi.fn();
    qspec.on("execution:complete", complete);
    qspec.on("execution:error", failed);

    await qspec.execute(manifest, { parameters: { from: "2026-01-01" } });
    expect(complete).toHaveBeenCalledOnce();

    await qspec.execute(manifest, { parameters: {} }).catch(() => undefined);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ code: "QSPEC_PARAMETER_INVALID" });
  });

  it("emits a duplicate-column event when the adapter returns repeated names", async () => {
    const { qspec } = build({
      execute: async () => ({
        columns: [{ name: "month" }, { name: "revenue" }, { name: "revenue" }],
        rows: [["2026-01-01T00:00:00Z", 1, 2]],
      }),
    });
    const handler = vi.fn();
    qspec.on("dataset:normalize:duplicate-column", handler);
    const bare = { ...manifest, spec: { ...manifest.spec, dataset: undefined } };
    await qspec.execute(bare, { parameters: { from: "2026-01-01" } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ original: "revenue", renamed: "revenue_2" }),
    );
  });

  it("supports repeated execution of one prepared resource", async () => {
    const { qspec, compile } = build();
    const prepared = await qspec.prepare(manifest);
    await prepared.execute({ parameters: { from: "2026-01-01" } });
    await prepared.execute({ parameters: { from: "2026-02-01" } });
    expect(compile).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/internal/execute.test.ts`
Expected: FAIL — cannot resolve `./execute.js`.

- [ ] **Step 3: Implement `execute.ts`**

`packages/core/src/internal/execute.ts`:

```ts
import {
  QSpecAbortError,
  QSpecError,
  QueryCompilationError,
  QueryExecutionError,
  TransformError,
} from "../errors.js";
import type { Dataset } from "../types/dataset.js";
import type { ExecutionContext, QSpecResult } from "../types/runtime.js";
import { normalizeResult } from "./normalize-result.js";
import type { PreparedPlan } from "./prepare.js";
import { resolveBindings } from "./bindings.js";
import type { RuntimeInternals } from "./runtime.js";
import { assertValidDataset } from "./validate/dataset.js";
import { validateParameters } from "./validate/parameters.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new QSpecAbortError("QSpec execution was aborted before it began.", {
      cause: signal.reason,
    });
  }
}

/**
 * Combines a caller-supplied signal with the configured query timeout, so a
 * timeout never discards the caller's own cancellation. (SPEC.md §60, §72.5)
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (timeoutMs === undefined) return { signal, dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Query exceeded the ${timeoutMs}ms timeout.`));
  }, timeoutMs);
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

/**
 * True when a rejection represents cancellation rather than a genuine failure.
 * Shared by every plugin boundary — an abort surfacing through a transform is
 * still a cancellation, not a transform defect.
 */
function isAbortLike(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

/** Turns any adapter rejection into a QSpec error, preserving abort semantics. */
function asQueryError(error: unknown, signal: AbortSignal | undefined): QSpecError {
  if (error instanceof QSpecError) return error;
  if (isAbortLike(error, signal)) {
    return new QSpecAbortError("QSpec execution was aborted.", { cause: error });
  }
  return new QueryExecutionError(
    `Data source execution failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export async function executePrepared(
  plan: PreparedPlan,
  internals: RuntimeInternals,
  context: ExecutionContext,
): Promise<QSpecResult> {
  const { hooks, limits, logger } = internals;
  const executionId = globalThis.crypto.randomUUID();
  const resource = plan.name;
  const startedAt = performance.now();
  const base = { executionId, resource } as const;

  try {
    throwIfAborted(context.signal);

    // Stage 3: parameters.
    hooks.emit("validation:start", { stage: "parameters" });
    const parameters = validateParameters(plan.parameters, context.parameters);
    hooks.emit("validation:end", { stage: "parameters", issues: [] });

    let dataset: Dataset = { fields: [], rows: [] };
    let queryDurationMs: number | undefined;

    if (plan.queryLanguage !== undefined && plan.source !== undefined) {
      const language = plan.languageName as string;
      const sourceName = plan.sourceName as string;
      const bindings = resolveBindings(plan.bindings, parameters);

      // Stage 4: compile.
      hooks.emit("query:compile:start", { ...base, language });
      const compileStart = performance.now();
      let compiled: unknown;
      try {
        compiled = await plan.queryLanguage.compile(
          plan.manifest.spec.query as never,
          { source: sourceName, bindings, parameters },
        );
      } catch (error) {
        throw error instanceof QSpecError
          ? error
          : new QueryCompilationError(
              `Failed to compile the ${language} query: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { cause: error },
            );
      }
      hooks.emit("query:compile:end", {
        ...base,
        language,
        durationMs: performance.now() - compileStart,
      });

      throwIfAborted(context.signal);

      // Execute.
      const timeout = withTimeout(context.signal, limits.queryTimeoutMs);
      hooks.emit("query:execute:start", { ...base, source: sourceName, language });
      const queryStart = performance.now();
      let raw;
      try {
        raw = await plan.source.execute(compiled, {
          executionId,
          signal: timeout.signal,
          locale: context.locale,
          timezone: context.timezone,
          logger,
        });
      } catch (error) {
        throw asQueryError(error, timeout.signal);
      } finally {
        timeout.dispose();
      }
      queryDurationMs = performance.now() - queryStart;

      // Normalize.
      const outcome = normalizeResult(raw, {
        schema: plan.manifest.spec.dataset,
        maxRows: limits.maxRows,
      });
      dataset = outcome.dataset;
      for (const duplicate of outcome.duplicates) {
        hooks.emit("dataset:normalize:duplicate-column", { ...base, ...duplicate });
      }

      hooks.emit("query:execute:end", {
        ...base,
        source: sourceName,
        language,
        durationMs: queryDurationMs,
        rowCount: dataset.rows.length,
      });

      // Stage 5: dataset.
      hooks.emit("validation:start", { stage: "dataset" });
      assertValidDataset(dataset, plan.manifest.spec.dataset);
      hooks.emit("validation:end", { stage: "dataset", issues: [] });
    }

    // Transform pipeline.
    for (const transform of plan.transforms) {
      throwIfAborted(context.signal);
      hooks.emit("transform:start", { ...base, type: transform.type, index: transform.index });
      const transformStart = performance.now();
      try {
        dataset = await transform.implementation.execute(dataset, transform.spec, {
          executionId,
          parameters,
          signal: context.signal,
        });
      } catch (error) {
        // Wrapped so the failure carries which transform failed and where.
        // A QSpecError from the transform passes through unwrapped rather than
        // being double-wrapped.
        if (error instanceof QSpecError) throw error;
        // Check abort BEFORE wrapping: a cancellation surfacing through a
        // transform is still a cancellation. Wrapping it as TransformError
        // would report a plugin defect for something the caller asked for.
        if (isAbortLike(error, context.signal)) {
          throw new QSpecAbortError("QSpec execution was aborted.", { cause: error });
        }
        throw new TransformError(
          `Transform "${transform.type}" at index ${transform.index} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error, path: ["spec", "transforms", transform.index] },
        );
      }
      hooks.emit("transform:end", {
        ...base,
        type: transform.type,
        index: transform.index,
        durationMs: performance.now() - transformStart,
        rowCount: dataset.rows.length,
      });
    }

    // A transform that ignores its signal and returns normally would otherwise
    // let a cancelled execution resolve with data — the same gap closed at the
    // adapter boundary above.
    throwIfAborted(context.signal);

    const durationMs = performance.now() - startedAt;
    hooks.emit("execution:complete", {
      ...base,
      durationMs,
      rowCount: dataset.rows.length,
      success: true,
    });

    return {
      data: dataset,
      ...(plan.presentation === undefined ? {} : { presentation: plan.presentation }),
      meta: {
        executionId,
        durationMs,
        rowCount: dataset.rows.length,
        ...(plan.sourceName === undefined || plan.languageName === undefined
          ? {}
          : {
              query: {
                source: plan.sourceName,
                language: plan.languageName,
                ...(queryDurationMs === undefined ? {} : { durationMs: queryDurationMs }),
              },
            }),
      },
    };
  } catch (error) {
    hooks.emit("execution:error", {
      ...base,
      durationMs: performance.now() - startedAt,
      code: error instanceof QSpecError ? error.code : "QSPEC_UNKNOWN",
      success: false,
    });
    throw error;
  }
}
```

- [ ] **Step 4: Run the full core suite**

Run: `npx vitest run packages/core`
Expected: PASS — every test from Tasks 1–17.

- [ ] **Step 5: Verify the build and the zero-dependency constraint**

Run: `npm run build && node -e "const p=require('./packages/core/package.json'); if (p.dependencies && Object.keys(p.dependencies).length) { throw new Error('core gained a runtime dependency'); }"`
Expected: build succeeds, no error.

- [ ] **Step 6: Commit Tasks 15, 16, and 17 together**

```bash
git add -A
git commit -m "feat(core): add plugin API, createQSpec, and the prepare/execute pipeline"
```

---

### Task 18: Fixtures, `@qspecs/schema`, and the conformance test

Delivers SPEC.md §13, §76, and §91. The conformance test is the point of this task: two
validators exist, so a test must prove they never disagree.

**Files:**
- Create: `schemas/v1/qspec.json`
- Create: `fixtures/valid/{minimal-dataset,monthly-revenue-chart,transformed-dataset}.qspec.json`
- Create: `fixtures/invalid/{missing-name,unsupported-version,bad-binding,invalid-name-pattern}.qspec.json`
- Create: `packages/schema/package.json`, `packages/schema/tsconfig.build.json`, `packages/schema/src/index.ts`
- Create: `packages/schema/test/conformance.test.ts`, `packages/schema/src/index.test.ts`
- Create: `scripts/copy-schemas.mjs`
- Modify: root `tsconfig.json` (add the reference), `tsconfig.base.json` (add `resolveJsonModule`), `.gitignore`

**Interfaces:**
- Consumes: `validateManifestStructure` from `@qspecs/core` (Task 5).
- Produces: `qspecV1Schema` (the parsed JSON Schema object), `QSPEC_V1_SCHEMA_ID`, `validateWithJsonSchema(manifest: unknown): SchemaValidationResult`, `SchemaIssue = { path: string; message: string }`.

- [ ] **Step 1: Write the JSON Schema**

`schemas/v1/qspec.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://qspec.dev/schemas/v1/qspec.json",
  "title": "QSpec v1 resource",
  "type": "object",
  "required": ["apiVersion", "kind", "metadata", "spec"],
  "properties": {
    "$schema": { "type": "string" },
    "apiVersion": { "const": "qspec.dev/v1" },
    "kind": { "type": "string", "minLength": 1 },
    "metadata": { "$ref": "#/$defs/metadata" },
    "spec": { "$ref": "#/$defs/spec" }
  },
  "$defs": {
    "metadata": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
        "title": { "type": "string" },
        "description": { "type": "string" },
        "tags": { "type": "array", "items": { "type": "string" } }
      }
    },
    "spec": {
      "type": "object",
      "properties": {
        "parameters": { "type": "object", "additionalProperties": { "$ref": "#/$defs/parameter" } },
        "query": { "$ref": "#/$defs/query" },
        "dataset": { "$ref": "#/$defs/dataset" },
        "transforms": { "type": "array", "items": { "$ref": "#/$defs/transform" } },
        "presentation": { "$ref": "#/$defs/presentation" }
      }
    },
    "parameter": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": {
          "enum": ["string", "number", "integer", "boolean", "date", "datetime", "enum", "array"]
        },
        "required": { "type": "boolean" },
        "default": true,
        "description": { "type": "string" },
        "values": { "type": "array", "minItems": 1 },
        "items": {
          "type": "object",
          "required": ["type"],
          "properties": {
            "type": { "enum": ["string", "number", "integer", "boolean", "date", "datetime"] }
          }
        },
        "validation": {
          "type": "object",
          "properties": {
            "min": { "type": "number" },
            "max": { "type": "number" },
            "minLength": { "type": "integer", "minimum": 0 },
            "maxLength": { "type": "integer", "minimum": 0 }
          }
        },
        "presentation": {
          "type": "object",
          "properties": {
            "control": { "type": "string" },
            "label": { "type": "string" },
            "placeholder": { "type": "string" },
            "help": { "type": "string" }
          }
        }
      },
      "allOf": [
        {
          "if": { "properties": { "type": { "const": "enum" } }, "required": ["type"] },
          "then": { "required": ["values"] }
        },
        {
          "if": { "properties": { "type": { "const": "array" } }, "required": ["type"] },
          "then": { "required": ["items"] }
        }
      ]
    },
    "binding": {
      "oneOf": [
        { "type": "string", "pattern": "^\\$parameters\\.[A-Za-z_][A-Za-z0-9_]*$" },
        {
          "type": "object",
          "required": ["parameter"],
          "properties": { "parameter": { "type": "string" } },
          "additionalProperties": false
        },
        {
          "type": "object",
          "required": ["literal"],
          "properties": { "literal": true },
          "additionalProperties": false
        }
      ]
    },
    "query": {
      "type": "object",
      "required": ["source", "language", "statement"],
      "properties": {
        "source": { "type": "string", "minLength": 1 },
        "language": { "type": "string", "minLength": 1 },
        "statement": true,
        "bindings": { "type": "object", "additionalProperties": { "$ref": "#/$defs/binding" } }
      }
    },
    "fieldType": {
      "enum": ["string", "number", "integer", "boolean", "date", "datetime", "object", "array"]
    },
    "dataset": {
      "type": "object",
      "required": ["fields"],
      "properties": {
        "fields": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "required": ["type"],
            "properties": {
              "type": { "$ref": "#/$defs/fieldType" },
              "nullable": { "type": "boolean" },
              "label": { "type": "string" },
              "semanticType": { "type": "string" },
              "format": { "type": "object" }
            }
          }
        }
      }
    },
    "transform": {
      "type": "object",
      "required": ["type"],
      "properties": { "type": { "type": "string", "minLength": 1 } }
    },
    "presentation": {
      "type": "object",
      "required": ["type"],
      "properties": { "type": { "type": "string", "minLength": 1 } }
    }
  }
}
```

- [ ] **Step 2: Write the fixtures**

`fixtures/valid/minimal-dataset.qspec.json`:

```json
{
  "apiVersion": "qspec.dev/v1",
  "kind": "Dataset",
  "metadata": { "name": "minimal" },
  "spec": {}
}
```

`fixtures/valid/monthly-revenue-chart.qspec.json`: the complete manifest from SPEC.md §94,
copied verbatim.

`fixtures/valid/transformed-dataset.qspec.json`:

```json
{
  "apiVersion": "qspec.dev/v1",
  "kind": "Dataset",
  "metadata": { "name": "top-products", "title": "Top Products", "tags": ["sales"] },
  "spec": {
    "parameters": {
      "limit": { "type": "integer", "default": 10, "validation": { "min": 1, "max": 100 } },
      "period": { "type": "enum", "default": "30d", "values": ["7d", "30d", "90d"] }
    },
    "query": {
      "source": "analytics",
      "language": "sql",
      "statement": "SELECT product, SUM(amount) AS revenue FROM orders GROUP BY product",
      "bindings": { "period": "$parameters.period" }
    },
    "dataset": {
      "fields": {
        "product": { "type": "string", "nullable": false },
        "revenue": { "type": "number", "nullable": false, "semanticType": "currency" }
      }
    },
    "transforms": [
      { "type": "sort", "field": "revenue", "direction": "desc" },
      { "type": "limit", "count": 10 }
    ]
  }
}
```

`fixtures/invalid/missing-name.qspec.json`:

```json
{ "apiVersion": "qspec.dev/v1", "kind": "Dataset", "metadata": {}, "spec": {} }
```

`fixtures/invalid/unsupported-version.qspec.json`:

```json
{ "apiVersion": "qspec.dev/v2", "kind": "Dataset", "metadata": { "name": "x" }, "spec": {} }
```

`fixtures/invalid/invalid-name-pattern.qspec.json`:

```json
{
  "apiVersion": "qspec.dev/v1",
  "kind": "Dataset",
  "metadata": { "name": "Monthly Revenue" },
  "spec": {}
}
```

`fixtures/invalid/bad-binding.qspec.json`:

```json
{
  "apiVersion": "qspec.dev/v1",
  "kind": "Dataset",
  "metadata": { "name": "bad-binding" },
  "spec": {
    "query": {
      "source": "analytics",
      "language": "sql",
      "statement": "SELECT 1",
      "bindings": { "country": "US" }
    }
  }
}
```

- [ ] **Step 3: Create the schema package**

`packages/schema/package.json`:

```json
{
  "name": "@qspecs/schema",
  "version": "0.1.0",
  "description": "Official JSON Schema documents for the QSpec specification",
  "type": "module",
  "license": "MIT",
  "sideEffects": false,
  "engines": { "node": ">=20.11" },
  "files": ["dist"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "dependencies": { "ajv": "^8.17.1" },
  "devDependencies": { "@qspecs/core": "0.1.0" },
  "scripts": { "build": "node ../../scripts/copy-schemas.mjs && tsc -p tsconfig.build.json" }
}
```

`packages/schema/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts", "src/schemas/**/*.json"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../core/tsconfig.build.json" }]
}
```

Add `{ "path": "./packages/schema/tsconfig.build.json" }` to root `tsconfig.json`
references, and `"resolveJsonModule": true` to `tsconfig.base.json`.

`scripts/copy-schemas.mjs`:

```js
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../schemas");
const target = resolve(here, "../packages/schema/src/schemas");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Copied JSON Schemas to ${target}`);
```

The copy runs *before* `tsc` (already ordered that way in the build script above) because
the schema is imported as a module and must exist under `rootDir` at compile time. With
`resolveJsonModule`, `tsc` emits the JSON to `dist/schemas/v1/qspec.json` alongside
`dist/index.js`, so the published package is self-contained.

Add `packages/schema/src/schemas/` to `.gitignore` — it is a build artifact whose source of
truth is the repo-root `schemas/` directory, which is what gets published to the website
(SPEC.md §13).

`@qspecs/core` is a **dev** dependency of `@qspecs/schema`, used only by the conformance test.
Making it a runtime dependency would invert the layering: the schema package must not pull
the runtime into an editor or CI install.

- [ ] **Step 4: Write the failing tests**

`packages/schema/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { QSPEC_V1_SCHEMA_ID, qspecV1Schema, validateWithJsonSchema } from "./index.js";

const minimal = { apiVersion: "qspec.dev/v1", kind: "Dataset", metadata: { name: "x" }, spec: {} };

describe("@qspecs/schema", () => {
  it("exposes the schema and its immutable id", () => {
    expect(QSPEC_V1_SCHEMA_ID).toBe("https://qspec.dev/schemas/v1/qspec.json");
    expect(qspecV1Schema).toHaveProperty("$id", QSPEC_V1_SCHEMA_ID);
  });

  it("accepts a valid manifest", () => {
    expect(validateWithJsonSchema(minimal)).toEqual({ valid: true, errors: [] });
  });

  it("reports a dotted path for a nested failure", () => {
    const result = validateWithJsonSchema({ ...minimal, metadata: { name: "Bad Name" } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe("metadata.name");
  });

  it("rejects an unsupported apiVersion", () => {
    expect(validateWithJsonSchema({ ...minimal, apiVersion: "qspec.dev/v2" }).valid).toBe(false);
  });

  it("requires enum parameters to declare values", () => {
    const manifest = {
      ...minimal,
      spec: { parameters: { p: { type: "enum" } } },
    };
    expect(validateWithJsonSchema(manifest).valid).toBe(false);
  });

  it("rejects a bare string binding that is not a parameter reference", () => {
    const manifest = {
      ...minimal,
      spec: {
        query: { source: "s", language: "sql", statement: "x", bindings: { a: "US" } },
      },
    };
    expect(validateWithJsonSchema(manifest).valid).toBe(false);
  });
});
```

`packages/schema/test/conformance.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifestStructure } from "@qspecs/core";
import { validateWithJsonSchema } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");

async function load(kind: "valid" | "invalid") {
  const directory = join(root, "fixtures", kind);
  const names = await readdir(directory);
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => ({
        name,
        manifest: JSON.parse(await readFile(join(directory, name), "utf8")) as unknown,
      })),
  );
}

describe("validator conformance", () => {
  it("finds fixtures to test", async () => {
    expect((await load("valid")).length).toBeGreaterThanOrEqual(3);
    expect((await load("invalid")).length).toBeGreaterThanOrEqual(3);
  });

  it("both validators accept every valid fixture", async () => {
    for (const { name, manifest } of await load("valid")) {
      expect(validateManifestStructure(manifest), `core rejected ${name}`).toEqual([]);
      expect(validateWithJsonSchema(manifest).valid, `schema rejected ${name}`).toBe(true);
    }
  });

  it("both validators reject every invalid fixture", async () => {
    for (const { name, manifest } of await load("invalid")) {
      expect(validateManifestStructure(manifest).length, `core accepted ${name}`).toBeGreaterThan(0);
      expect(validateWithJsonSchema(manifest).valid, `schema accepted ${name}`).toBe(false);
    }
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run packages/schema`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 6: Implement the schema package**

`packages/schema/src/index.ts`:

```ts
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import schemaDocument from "./schemas/v1/qspec.json" with { type: "json" };

/** Immutable once published. (SPEC.md §76) */
export const QSPEC_V1_SCHEMA_ID = "https://qspec.dev/schemas/v1/qspec.json";

/** The official QSpec v1 JSON Schema document. (SPEC.md §13) */
export const qspecV1Schema: Record<string, unknown> = schemaDocument as Record<string, unknown>;

export interface SchemaIssue {
  /** Dotted path into the manifest, e.g. `metadata.name`. */
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaIssue[];
}

// Compiled lazily and cached: recompiling per call is exactly the cost
// SPEC.md §112 says to avoid.
let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (compiled === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    compiled = ajv.compile(qspecV1Schema);
  }
  return compiled;
}

function toPath(error: ErrorObject): string {
  // Ajv emits "/metadata/name"; QSpec diagnostics use "metadata.name".
  return error.instancePath.replace(/^\//, "").replace(/\//g, ".");
}

/**
 * Validates against the published JSON Schema. This is the editor/CI validator;
 * `@qspecs/core`'s `validateManifestStructure` is the runtime validator, and the
 * conformance test asserts the two never disagree. (design §2.7)
 */
export function validateWithJsonSchema(manifest: unknown): SchemaValidationResult {
  const validate = validator();
  const valid = validate(manifest) as boolean;
  if (valid) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (validate.errors ?? []).map((error) => ({
      path: toPath(error),
      message: error.message ?? "Schema validation failed.",
    })),
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm install && npm run build && npx vitest run packages/schema`
Expected: PASS, 9 tests.

If the conformance test fails, the two validators genuinely disagree. Fix whichever is
wrong — do not weaken the test. That test is the entire justification for having two
validators.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(schema): add QSpec v1 JSON Schema, fixtures, and validator conformance test"
```

---

### Task 19: `@qspecs/cli` — `qspec validate`

Delivers SPEC.md §20, §86, and the validate half of §102. Argument parsing uses Node's
built-in `parseArgs`, so the CLI adds no dependency beyond the two QSpec packages.

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.build.json`
- Create: `packages/cli/src/index.ts`, `packages/cli/src/color.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/bin.ts`
- Test: `packages/cli/src/commands/validate.test.ts`
- Modify: root `tsconfig.json`

**Interfaces:**
- Consumes: `validateManifestStructure`, `formatPath`, `parseManifest`, `QSpecIssue` from `@qspecs/core`; `validateWithJsonSchema` from `@qspecs/schema`.
- Produces: `runValidate(paths: readonly string[], io: CliIo): Promise<number>` returning a process exit code, and `CliIo = { out(text): void; err(text): void; readonly color: boolean }`.

Exit codes: `0` all valid, `1` at least one invalid or unreadable, `2` usage error.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/commands/validate.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runValidate } from "./validate.js";

async function fileWith(content: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qspec-cli-"));
  const path = join(directory, "manifest.qspec.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function capture() {
  const lines: string[] = [];
  return {
    io: {
      out: (text: string) => lines.push(text),
      err: (text: string) => lines.push(text),
      color: false,
    },
    text: () => lines.join("\n"),
  };
}

const valid = {
  apiVersion: "qspec.dev/v1",
  kind: "Chart",
  metadata: { name: "monthly-revenue" },
  spec: {},
};

describe("runValidate", () => {
  it("exits 0 and reports the resource for a valid manifest", async () => {
    const { io, text } = capture();
    expect(await runValidate([await fileWith(valid)], io)).toBe(0);
    expect(text()).toContain("Valid QSpec manifest");
    expect(text()).toContain("API version: qspec.dev/v1");
    expect(text()).toContain("Kind: Chart");
    expect(text()).toContain("Name: monthly-revenue");
  });

  it("exits 1 and prints the path and message for an invalid manifest", async () => {
    const { io, text } = capture();
    const path = await fileWith({ ...valid, metadata: { name: "Monthly Revenue" } });
    expect(await runValidate([path], io)).toBe(1);
    expect(text()).toContain("Invalid QSpec manifest");
    expect(text()).toContain("metadata.name");
  });

  it("prints a did-you-mean line when a suggestion exists", async () => {
    const { io, text } = capture();
    const path = await fileWith({ ...valid, metadata: { name: "Monthly Revenue" } });
    await runValidate([path], io);
    expect(text()).toMatch(/Did you mean "monthly-revenue"\?/);
  });

  it("emits no ANSI escapes when color is disabled", async () => {
    const { io, text } = capture();
    await runValidate([await fileWith(valid)], io);
    expect(text()).not.toContain("\u001B[");
  });

  it("exits 1 for malformed JSON without throwing", async () => {
    const { io, text } = capture();
    expect(await runValidate([await fileWith("{ not json")], io)).toBe(1);
    expect(text()).toContain("not valid JSON");
  });

  it("exits 1 for a missing file and names it", async () => {
    const { io, text } = capture();
    expect(await runValidate(["/no/such/file.json"], io)).toBe(1);
    expect(text()).toContain("/no/such/file.json");
  });

  it("validates several files and fails if any fails", async () => {
    const { io } = capture();
    const good = await fileWith(valid);
    const bad = await fileWith({ ...valid, metadata: {} });
    expect(await runValidate([good, bad], io)).toBe(1);
  });

  it("still reports the valid file when a sibling is invalid", async () => {
    const { io, text } = capture();
    await runValidate([await fileWith(valid), await fileWith({ ...valid, metadata: {} })], io);
    expect(text()).toContain("Valid QSpec manifest");
    expect(text()).toContain("Invalid QSpec manifest");
  });

  it("requires at least one path", async () => {
    const { io, text } = capture();
    expect(await runValidate([], io)).toBe(2);
    expect(text()).toContain("Usage");
  });

  it("does not report a validator mismatch for a manifest both validators accept", async () => {
    const { io, text } = capture();
    await runValidate([await fileWith(valid)], io);
    expect(text()).not.toContain("validator mismatch");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli`
Expected: FAIL — cannot resolve `./validate.js`.

- [ ] **Step 3: Create the package**

`packages/cli/package.json`:

```json
{
  "name": "@qspecs/cli",
  "version": "0.1.0",
  "description": "Command-line tooling for QSpec manifests",
  "type": "module",
  "license": "MIT",
  "sideEffects": false,
  "engines": { "node": ">=20.11" },
  "files": ["dist"],
  "bin": { "qspec": "./dist/bin.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "dependencies": { "@qspecs/core": "0.1.0", "@qspecs/schema": "0.1.0" },
  "scripts": { "build": "tsc -p tsconfig.build.json" }
}
```

`packages/cli/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [
    { "path": "../core/tsconfig.build.json" },
    { "path": "../schema/tsconfig.build.json" }
  ]
}
```

Add `{ "path": "./packages/cli/tsconfig.build.json" }` to root `tsconfig.json` references.

- [ ] **Step 4: Implement the color helper**

`packages/cli/src/color.ts`. The escape character is written as the `\u001B` escape
sequence, never as a literal control character in source:

```ts
const CSI = "\u001B[";

/** Honors NO_COLOR and FORCE_COLOR, and falls back to TTY detection. */
export function supportsColor(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.env["FORCE_COLOR"] !== undefined) return true;
  return process.stdout.isTTY === true;
}

function wrap(code: number, text: string, enabled: boolean): string {
  return enabled ? `${CSI}${code}m${text}${CSI}0m` : text;
}

export const green = (text: string, on: boolean): string => wrap(32, text, on);
export const red = (text: string, on: boolean): string => wrap(31, text, on);
export const dim = (text: string, on: boolean): string => wrap(2, text, on);
export const bold = (text: string, on: boolean): string => wrap(1, text, on);
```

- [ ] **Step 5: Implement the validate command**

`packages/cli/src/commands/validate.ts`:

```ts
import { readFile } from "node:fs/promises";
import {
  formatPath,
  parseManifest,
  validateManifestStructure,
  type QSpecIssue,
} from "@qspecs/core";
import { validateWithJsonSchema } from "@qspecs/schema";
import { bold, dim, green, red } from "../color.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  readonly color: boolean;
}

function hasIssues(error: unknown): error is { issues: readonly QSpecIssue[] } {
  return (
    error !== null &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown }).issues)
  );
}

/**
 * `summary` carries an aggregate error's own message (e.g. "Manifest is not
 * valid JSON."), which is NOT present on any nested issue — printing only the
 * per-issue messages would drop it entirely.
 */
function printIssues(
  path: string,
  issues: readonly QSpecIssue[],
  io: CliIo,
  summary?: string,
): void {
  io.err(`${red("✗ Invalid QSpec manifest", io.color)} ${dim(path, io.color)}`);
  if (summary !== undefined) io.err(`  ${summary}`);
  for (const issue of issues) {
    io.err("");
    io.err(`${bold(formatPath(issue.path), io.color)}:`);
    io.err(`  ${issue.message}`);
    if (issue.suggestion !== undefined) {
      io.err(`  ${dim(`Did you mean "${issue.suggestion}"?`, io.color)}`);
    }
  }
}

/** Validates one or more manifest files. (SPEC.md §86) */
export async function runValidate(paths: readonly string[], io: CliIo): Promise<number> {
  if (paths.length === 0) {
    io.err("Usage: qspec validate <manifest.json> [...]");
    return 2;
  }

  let failed = false;

  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      failed = true;
      io.err(
        `${red("✗ Cannot read", io.color)} ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    let manifest: unknown;
    try {
      manifest = parseManifest(text);
    } catch (error) {
      failed = true;
      printIssues(
        path,
        hasIssues(error)
          ? error.issues
          : [
              {
                code: "QSPEC_MANIFEST_INVALID",
                message: error instanceof Error ? error.message : String(error),
                path: [],
              },
            ],
        io,
      );
      continue;
    }

    const issues = validateManifestStructure(manifest);
    const schemaResult = validateWithJsonSchema(manifest);

    // The two validators are held in lockstep by the conformance test. A
    // disagreement means that guarantee has broken, and must be loud.
    if (issues.length === 0 && !schemaResult.valid) {
      failed = true;
      io.err(
        `${red("✗ Internal validator mismatch", io.color)} ${path}: the JSON Schema rejected ` +
          `a manifest the runtime accepted. Please report this. Schema errors: ${schemaResult.errors
            .map((error) => `${error.path}: ${error.message}`)
            .join("; ")}`,
      );
      continue;
    }

    if (issues.length > 0) {
      failed = true;
      printIssues(path, issues, io);
      continue;
    }

    const resource = manifest as { apiVersion: string; kind: string; metadata: { name: string } };
    io.out(`${green("✓ Valid QSpec manifest", io.color)} ${dim(path, io.color)}`);
    io.out(`API version: ${resource.apiVersion}`);
    io.out(`Kind: ${resource.kind}`);
    io.out(`Name: ${resource.metadata.name}`);
  }

  return failed ? 1 : 0;
}
```

`packages/cli/src/index.ts`:

```ts
export { runValidate, type CliIo } from "./commands/validate.js";
```

- [ ] **Step 6: Implement the binary entry point**

`packages/cli/src/bin.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { supportsColor } from "./color.js";
import { runValidate, type CliIo } from "./commands/validate.js";

const HELP = `qspec - QSpec manifest tooling

Usage:
  qspec validate <manifest.json> [...]   Validate one or more manifests

Options:
  -h, --help      Show this help
  -v, --version   Show the CLI version
`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  const io: CliIo = {
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    color: supportsColor(),
  };

  if (values.version === true) {
    io.out("0.1.0");
    return 0;
  }

  const [command, ...rest] = positionals;

  if (values.help === true) {
    io.out(HELP);
    return 0;
  }

  if (command === undefined) {
    io.err(HELP);
    return 2;
  }

  switch (command) {
    case "validate":
      return runValidate(rest, io);
    default:
      io.err(`Unknown command "${command}".\n`);
      io.err(HELP);
      return 2;
  }
}

process.exitCode = await main();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm install && npm run build && npx vitest run packages/cli`
Expected: PASS, 10 tests.

- [ ] **Step 8: Verify the CLI end-to-end against real fixtures**

Run: `node packages/cli/dist/bin.js validate fixtures/valid/monthly-revenue-chart.qspec.json`
Expected: prints a check mark and `Valid QSpec manifest`, exit code 0.

Run: `node packages/cli/dist/bin.js validate fixtures/invalid/invalid-name-pattern.qspec.json; echo "exit=$?"`
Expected: prints `Invalid QSpec manifest`, the path `metadata.name`, a
`Did you mean "monthly-revenue"?` line, and `exit=1`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(cli): add qspec validate with path-precise diagnostics"
```

---

### Task 20: CI, boundary guards, and documentation

Delivers SPEC.md §115 items 15–20 and the architectural guards from design §3.1.

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `test/boundaries.test.ts`, `test/definition-of-done.test.ts`
- Create: `README.md`, `docs/architecture.md`
- Modify: root `vitest.config.ts` (include the root `test/` directory)

**Interfaces:**
- Consumes: every package's `package.json` and `src/index.ts`; the public exports of `@qspecs/core`.
- Produces: a CI workflow, plus tests that fail when `@qspecs/core` gains a runtime dependency or a package leaks internals.

- [ ] **Step 1: Include the root test directory**

`vitest.config.ts` — change `include` to:

```ts
include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
```

- [ ] **Step 1b: Make test files type-checked**

Each package's `tsconfig.build.json` excludes `src/**/*.test.ts`, and Vitest strips types
without checking them. That means **no existing command type-checks a test file**. Several
tests in this plan are type-level regression guards — most notably Task 4's proof that
`defineManifest`'s `const` type parameter preserves literal types, which fails at `tsc`
rather than at runtime. Without this step those guards silently stop being enforced.

Create `tsconfig.test.json` at the repo root:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "emitDeclarationOnly": false
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "test/**/*.ts"]
}
```

Add the script to the root `package.json`:

```json
"typecheck:tests": "tsc -p tsconfig.test.json"
```

**Three existing test files will fail this new check**, because they deliberately construct
invalid data to prove validation rejects it, and TypeScript objects to the fixtures rather
than the behavior. Fix them as part of this step, using a double assertion through `unknown`
— which is the idiom TypeScript itself suggests for this case:

- `packages/core/src/internal/bindings.test.ts` — the `{ literal: undefined }` fixture:
  `undefined` is not a `JsonValue`. Use `as unknown as Binding`.
- `packages/core/src/internal/validate/parameters.test.ts` (two sites) — the
  `items: { type: "enum" }` and `items: { type: "array" }` fixtures: `ParameterDefinition`
  forbids composite item types, which is exactly what the tests assert is rejected at
  runtime. Use `as unknown as ParameterDefinition`.

Each of those fixtures is intentionally ill-typed: the test's purpose is to feed the
validator something the type system forbids and confirm it is caught at runtime. Do not
"fix" them by making the fixtures valid — that would delete the test's reason to exist.

Verify it genuinely covers the guard: temporarily change `defineManifest`'s signature in
`packages/core/src/define.ts` from `<const T extends ...>` to `<T extends ...>`, run
`npm run typecheck:tests`, and confirm it FAILS with `TS2322: Type 'string' is not
assignable to type '"Chart"'`. Restore the `const` and confirm it passes. If it passes both
ways, this config does not cover the test files and must be corrected before you proceed.

Then wire it into CI — the `ci.yml` in Step 5 below already includes the
`npm run typecheck:tests` line; do not omit it.

- [ ] **Step 2: Write the boundary test**

`test/boundaries.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

interface PackageEntry {
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
}

async function packages(): Promise<PackageEntry[]> {
  const names = await readdir(join(root, "packages"));
  return Promise.all(
    names.map(async (directory) => ({
      directory,
      manifest: JSON.parse(
        await readFile(join(root, "packages", directory, "package.json"), "utf8"),
      ) as Record<string, unknown>,
    })),
  );
}

describe("package boundaries", () => {
  it("keeps @qspecs/core free of runtime dependencies", async () => {
    const core = (await packages()).find((entry) => entry.manifest["name"] === "@qspecs/core");
    expect(core, "@qspecs/core package.json not found").toBeDefined();
    expect(core?.manifest["dependencies"] ?? {}).toEqual({});
  });

  it("keeps browser-safe packages free of database drivers", async () => {
    const browserSafe = new Set(["@qspecs/core", "@qspecs/schema"]);
    for (const { manifest } of await packages()) {
      if (!browserSafe.has(manifest["name"] as string)) continue;
      const dependencies = Object.keys((manifest["dependencies"] as object) ?? {});
      expect(dependencies, manifest["name"] as string).not.toContain("pg");
    }
  });

  it("exposes only the documented export paths", async () => {
    for (const { manifest } of await packages()) {
      const exported = Object.keys((manifest["exports"] as object) ?? {}).sort();
      expect(exported, manifest["name"] as string).toEqual([".", "./package.json"]);
    }
  });

  it("declares ESM, sideEffects:false, MIT, and the Node engine floor everywhere", async () => {
    for (const { manifest } of await packages()) {
      const name = manifest["name"] as string;
      expect(manifest["type"], name).toBe("module");
      expect(manifest["sideEffects"], name).toBe(false);
      expect(manifest["engines"], name).toEqual({ node: ">=20.11" });
      expect(manifest["license"], name).toBe("MIT");
    }
  });

  it("never wildcard-re-exports an internal module from a public entry", async () => {
    for (const { directory } of await packages()) {
      const source = await readFile(
        join(root, "packages", directory, "src", "index.ts"),
        "utf8",
      ).catch(() => "");
      expect(source, `${directory} wildcard-exports internals`).not.toMatch(
        /export\s+\*\s+from\s+["']\.\/internal\//,
      );
    }
  });

  it("uses no eval or Function constructor anywhere in published source", async () => {
    async function* walk(directory: string): AsyncGenerator<string> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) yield* walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield path;
      }
    }
    for (const { directory } of await packages()) {
      for await (const file of walk(join(root, "packages", directory, "src"))) {
        const source = await readFile(file, "utf8");
        expect(source, file).not.toMatch(/\beval\s*\(/);
        expect(source, file).not.toMatch(/\bnew\s+Function\s*\(/);
      }
    }
  });
});
```

- [ ] **Step 3: Write the acceptance test from SPEC.md §115**

`test/definition-of-done.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createQSpec, defineManifest, definePlugin } from "@qspecs/core";

describe("SPEC.md §115 definition of done", () => {
  it("runs the documented acceptance snippet", async () => {
    const examplePlugin = () => definePlugin({ name: "example", setup: () => {} });

    const qspec = createQSpec().use(examplePlugin());

    const manifest = defineManifest({
      apiVersion: "qspec.dev/v1",
      kind: "Dataset",
      metadata: { name: "example" },
      spec: { parameters: {} },
    });

    const prepared = await qspec.prepare(manifest);
    expect(prepared.name).toBe("example");
    expect(prepared.kind).toBe("Dataset");
  });
});
```

- [ ] **Step 4: Run both tests**

Run: `npx vitest run test`
Expected: PASS. A failure here points at a real violation introduced in an earlier task —
fix the violation, not the test.

- [ ] **Step 5: Write the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: ["20.11", "22", "24"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run format:check
      - run: npm run build
      - run: npm run typecheck:tests
      - run: npm test
      - name: Verify each package packs cleanly
        run: |
          set -euo pipefail
          for directory in packages/*/; do
            name=$(node -p "require('./${directory}package.json').name")
            private=$(node -p "require('./${directory}package.json').private === true")
            if [ "$private" = "true" ]; then continue; fi
            npm pack --dry-run --workspace "$name" > /dev/null
          done
      - name: Validate every fixture with the CLI
        run: node packages/cli/dist/bin.js validate fixtures/valid/*.qspec.json
```

- [ ] **Step 6: Write the README**

`README.md` must contain:

- a one-paragraph description drawn from SPEC.md §1;
- a prominent statement that `@qspecs/core` has zero runtime dependencies;
- the install command from SPEC.md §93;
- the `createQSpec().use(...)` / `qspec.execute(...)` quick start from SPEC.md §93, marked
  clearly as the eventual target, since `@qspecs/sql`, `@qspecs/postgres`, and `@qspecs/charts`
  do not exist yet;
- a second example that runs **today**: `createQSpec()`, `defineManifest`, `prepare`;
- the package table from design §3, with each package's environment;
- `qspec validate` usage plus both sample outputs from SPEC.md §86;
- links to `SPEC.md`, `docs/architecture.md`, and the design document.

Do not document APIs that do not exist yet. Where the quick start references future
packages, say so explicitly — a README that promises a working Postgres example before
plan 3 lands is worse than one that admits the gap.

- [ ] **Step 7: Write the architecture document**

`docs/architecture.md` must contain:

- the pipeline diagram from SPEC.md §10;
- the `prepare()` versus `execute()` split, listing which validation stage runs in which;
- the six validation stages from SPEC.md §80, each mapped to the module implementing it:
  stage 1 → `internal/validate/manifest.ts`, stage 2 → capability resolution in
  `internal/prepare.ts`, stage 3 → `internal/validate/parameters.ts`, stage 4 →
  `QueryLanguage.validate`, stage 5 → `internal/validate/dataset.ts`, stage 6 →
  `internal/validate/presentation.ts`;
- the resolved design decisions, each linking to the matching section of
  `docs/superpowers/specs/2026-08-09-qspec-design.md`;
- the plugin authoring walkthrough from SPEC.md §105, using `definePlugin`;
- the public/internal boundary rule from SPEC.md §104 and how `test/boundaries.test.ts`
  enforces it;
- the `Transform.describe` contract, and why omitting it disables static presentation
  validation for everything downstream of that transform.

- [ ] **Step 8: Full verification from a clean state**

```bash
npm run clean
rm -rf node_modules
npm ci
npm run format:check
npm run build
npm test
node packages/cli/dist/bin.js validate fixtures/valid/*.qspec.json
```

Expected: every command succeeds; the CLI prints one valid line per fixture and exits 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: add CI, package boundary guards, README, and architecture docs"
```

---

## Definition of Done for this plan

All twenty tasks complete, and:

1. `npm ci && npm run build && npm run typecheck:tests && npm test` passes from a clean clone.
2. `packages/core/package.json` has no `dependencies` entries.
3. `qspec validate` accepts every `fixtures/valid/*` and rejects every `fixtures/invalid/*`.
4. The SPEC.md §115 acceptance snippet runs (Task 20, Step 3).
5. CI is green on Node 20.11, 22, and 24.

### SPEC.md §115 checklist coverage

| # | Requirement | Task |
|---|---|---|
| 1 | npm workspace/monorepo | 1 |
| 2 | `@qspecs/core` | 1–17 |
| 3 | `@qspecs/schema` | 18 |
| 4 | plugin API | 15 |
| 5 | generic registries | 3 |
| 6 | QSpec v1 base manifest schema | 18 |
| 7 | parameter model | 4 |
| 8 | parameter validation | 6 |
| 9 | structured errors | 1 |
| 10 | `defineManifest()` | 4 |
| 11 | `createQSpec()` | 15 |
| 12 | `.use(plugin)` | 15 |
| 13 | manifest validation | 5 |
| 14 | unit tests | all |
| 15 | CI | 20 |
| 16 | package build pipeline | 1, 18, 19 |
| 17 | basic CLI validation | 19 |
| 18 | README | 20 |
| 19 | architecture documentation | 20 |
| 20 | at least three valid example manifests | 18 |

### Deliberately out of scope for this plan

These SPEC.md requirements belong to later plans and must **not** be implemented here:

- `@qspecs/transforms`, `@qspecs/charts` (plan 2). Core registers no built-in transforms and
  no presentation types; the only built-in resource kind is `Dataset`.
- `@qspecs/sql`, `@qspecs/postgres` (plan 3). Core registers no query languages or sources.
- `@qspecs/react`, `@qspecs/recharts` (plan 4).
- `qspec inspect`, examples, and the full documentation set from SPEC.md §92 (plan 5).
- `qspec.hash()` (SPEC.md §83), deferred because §83 requires canonicalization rules to be
  defined before hashes may be treated as portable identifiers, and §111 warns against
  inventing those rules prematurely.
- Caching (SPEC.md §82), middleware (SPEC.md §69), and the policy layer (SPEC.md §110), all
  of which SPEC.md places outside v1.
