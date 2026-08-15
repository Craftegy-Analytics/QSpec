import {
  LimitExceededError,
  ManifestValidationError,
  PresentationError,
  UnknownDataSourceError,
  UnknownQueryLanguageError,
  UnknownResourceKindError,
  type PathSegment,
  type QSpecIssue,
} from "../errors.js";
import { parseManifest } from "../define.js";
import { deepFreeze } from "../json.js";
import type { DatasetSchema, Field } from "../types/dataset.js";
import type { QSpecManifest, QSpecResourceSpec, TransformDefinition } from "../types/manifest.js";
import type { PresentationDefinition, PresentationType } from "../types/presentation.js";
import type { DataSource, QueryLanguage, ResourceKind, Transform } from "../types/plugin.js";
import type { QueryDefinition } from "../types/query.js";
import type { ExecutionContext, PreparedResource, QSpecResult } from "../types/runtime.js";
import { compileBindings, type CompiledBinding } from "./bindings.js";
import { executePrepared } from "./execute.js";
import { rebaseIssues } from "./plugin-issues.js";
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

/**
 * The resolved query, or nothing at all. Grouping these six values into one
 * optional record makes the invariant structural: "a language implies a source
 * implies a definition" is enforced by the type rather than by four correlated
 * `| undefined` fields that execute() would have to re-check (or assert away).
 */
export interface PreparedQuery {
  readonly definition: QueryDefinition;
  readonly language: QueryLanguage;
  readonly languageName: string;
  readonly source: DataSource;
  readonly sourceName: string;
  readonly bindings: readonly CompiledBinding[];
}

/**
 * Carries only what execute() actually reads. The manifest and the projected
 * field list are deliberately absent: execute() needs neither (it reads
 * `datasetSchema` directly), and the projection is a prepare-time artifact
 * whose only consumer is the `projectedFields` name list on PreparedResource.
 */
export interface PreparedPlan {
  readonly kind: string;
  readonly name: string;
  readonly parameters: CompiledParameters;
  readonly query: PreparedQuery | undefined;
  readonly datasetSchema: DatasetSchema | undefined;
  readonly transforms: readonly PreparedTransform[];
  readonly presentation: PresentationDefinition | undefined;
}

function manifestError(message: string, path: readonly PathSegment[], suggestion?: string): never {
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

function listOrNone(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.join(", ");
}

/**
 * `details` for a "did you mean" hint, or nothing when there is no near match.
 *
 * Passing `{ suggestion: suggest(...) }` unconditionally would wrap `undefined`
 * in a truthy object, so `QSpecError`'s `details !== undefined` guard would
 * store an empty hint and every consumer would have to re-check the inner
 * field.
 */
function suggestionDetails(
  input: string,
  candidates: readonly string[],
): { readonly suggestion: string } | undefined {
  const suggestion = suggest(input, candidates);
  return suggestion === undefined ? undefined : { suggestion };
}

/**
 * A plugin's static `validate` hook reports problems two ways: by returning any
 * number of issues, or by throwing one. Returned issues are raised as the same
 * aggregate error a throw would have produced, so prepare() has exactly one
 * failure shape regardless of which style the plugin chose. Throws are left to
 * propagate untouched, as they always have.
 */
function assertNoPluginIssues(
  reported: void | readonly QSpecIssue[],
  base: readonly PathSegment[],
  message: string,
): void {
  if (reported === undefined || reported.length === 0) return;
  throw new ManifestValidationError(message, { issues: rebaseIssues(reported, base) });
}

/**
 * Freezes the projection QSpec folds through the transform pipeline. The Field
 * records are handed to plugin code (`Transform.validate`, `Transform.describe`,
 * `PresentationType`), so freezing them stops a plugin from mutating the
 * projection out from under the transforms that come after it.
 */
function freezeFields(fields: readonly Field[]): readonly Field[] {
  for (const field of fields) Object.freeze(field);
  // Copied first so a plugin's own array is never frozen on its behalf.
  return Object.freeze([...fields]);
}

/**
 * `definitions` is a real Map, and Object.freeze does not block `Map.set`, so
 * it is left as-is rather than given a freeze that would do nothing. The
 * guarantee is carried by the type instead: it is declared `ReadonlyMap`,
 * `CompiledParameters` is internal (never exported from index.ts), and every
 * value in it is a manifest node that the deep freeze above already covered.
 * Proxying each lookup to enforce it at runtime would cost more than it is worth.
 */
function freezeParameters(parameters: CompiledParameters): CompiledParameters {
  Object.freeze(parameters.names);
  return Object.freeze(parameters);
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
  // Deep-frozen because the plan aliases live manifest nodes throughout:
  // `query.definition`, `datasetSchema`, `presentation`, and every
  // `transform.spec` point straight at the caller's object, which
  // parseManifest returns un-cloned. Freezing is what makes "static
  // validation happens exactly once" true — without it a caller could set
  // `spec.query.statement` after prepare() and the next execute() would
  // compile a statement nothing ever validated. A manifest is plain JSON, so
  // freezing it is safe; the plugin-owned capability objects reached from the
  // plan (DataSource, QueryLanguage, Transform) are deliberately left alone,
  // since those are live objects that may own a connection pool.
  const manifest = deepFreeze(assertValidManifest(parsed));
  hooks.emit("validation:end", { stage: "manifest", issues: [] });
  hooks.emit("manifest:parse:end", { kind: manifest.kind, name: manifest.metadata.name });

  // Stage 2: capabilities.
  const resourceKind: ResourceKind | undefined = registries.resources.get(manifest.kind);
  if (resourceKind === undefined) {
    throw new UnknownResourceKindError(
      `Unknown resource kind "${manifest.kind}". ` +
        `Registered kinds: ${listOrNone(registries.resources.list())}.`,
      suggestionDetails(manifest.kind, registries.resources.list()),
    );
  }

  const spec = manifest.spec;
  const parameters = compileParameters(spec.parameters);

  let query: PreparedQuery | undefined;

  const declaredQuery = spec.query;
  if (declaredQuery === undefined) {
    if (resourceKind.requiresQuery === true) {
      manifestError(`Resource kind "${manifest.kind}" requires a \`spec.query\`.`, [
        "spec",
        "query",
      ]);
    }
  } else {
    const languageName = declaredQuery.language;
    const sourceName = declaredQuery.source;

    const language = registries.queryLanguages.get(languageName);
    if (language === undefined) {
      throw new UnknownQueryLanguageError(
        `Unknown query language "${languageName}". ` +
          `Registered languages: ${listOrNone(registries.queryLanguages.list())}.`,
        suggestionDetails(languageName, registries.queryLanguages.list()),
      );
    }

    const source = registries.sources.get(sourceName);
    if (source === undefined) {
      throw new UnknownDataSourceError(
        `Unknown data source "${sourceName}". ` +
          `Configured sources: ${listOrNone(registries.sources.list())}.`,
        suggestionDetails(sourceName, registries.sources.list()),
      );
    }

    // A source that omits `supportedLanguages` accepts any language: the
    // behavior every source had before this field existed. Reported at
    // `language` rather than `source`, since the language is far more often
    // the thing the author got wrong.
    const supportedLanguages = source.supportedLanguages;
    if (supportedLanguages !== undefined && !supportedLanguages.includes(languageName)) {
      manifestError(
        `Data source "${sourceName}" does not support query language "${languageName}". ` +
          `Supported languages: ${listOrNone(supportedLanguages)}.`,
        ["spec", "query", "language"],
        suggest(languageName, supportedLanguages),
      );
    }

    const bindings = compileBindings(declaredQuery.bindings, parameters, [
      "spec",
      "query",
      "bindings",
    ]);
    assertNoPluginIssues(
      language.validate?.(declaredQuery),
      ["spec", "query"],
      `Query language "${languageName}" rejected \`spec.query\`.`,
    );

    query = { definition: declaredQuery, language, languageName, source, sourceName, bindings };
  }

  // Stage 6 input: project the field schema through the transform pipeline.
  const declaredTransforms = spec.transforms ?? [];
  if (declaredTransforms.length > limits.maxTransforms) {
    throw new LimitExceededError(
      `Manifest declares ${declaredTransforms.length} transforms, ` +
        `exceeding the limit of ${limits.maxTransforms}.`,
      { limit: "maxTransforms", allowed: limits.maxTransforms, actual: declaredTransforms.length },
    );
  }

  const datasetSchema = spec.dataset;
  let projected: readonly Field[] | undefined =
    datasetSchema === undefined
      ? undefined
      : freezeFields(
          Object.entries(datasetSchema.fields).map(([name, definition]): Field => ({
            name,
            ...definition,
          })),
        );

  const transforms: PreparedTransform[] = declaredTransforms.map((definition, index) => {
    const implementation = registries.transforms.get(definition.type);
    if (implementation === undefined) {
      manifestError(
        `Unknown transform "${definition.type}". ` +
          `Registered transforms: ${listOrNone(registries.transforms.list())}.`,
        ["spec", "transforms", index, "type"],
        suggest(definition.type, registries.transforms.list()),
      );
    }
    assertNoPluginIssues(
      implementation.validate?.(definition, projected),
      ["spec", "transforms", index],
      `Transform "${definition.type}" rejected its declaration.`,
    );
    // A transform without describe() is schema-opaque: projection stops here
    // and every later static field check is skipped. (design §2.5)
    projected =
      implementation.describe === undefined || projected === undefined
        ? undefined
        : freezeFields(implementation.describe(projected, definition));
    return { index, type: definition.type, spec: definition, implementation };
  });

  let presentation: PresentationDefinition | undefined;
  const declaredPresentation = spec.presentation;
  if (declaredPresentation === undefined) {
    if (resourceKind.requiresPresentation === true) {
      manifestError(`Resource kind "${manifest.kind}" requires a \`spec.presentation\`.`, [
        "spec",
        "presentation",
      ]);
    }
  } else {
    presentation = declaredPresentation;
    const presentationType: PresentationType | undefined = registries.presentations.get(
      declaredPresentation.type,
    );
    if (presentationType === undefined) {
      manifestError(
        `Unknown presentation type "${declaredPresentation.type}". ` +
          `Registered types: ${listOrNone(registries.presentations.list())}.`,
        ["spec", "presentation", "type"],
        suggest(declaredPresentation.type, registries.presentations.list()),
      );
    }
    hooks.emit("validation:start", { stage: "presentation" });
    const issues = validatePresentation(declaredPresentation, presentationType, projected);
    hooks.emit("validation:end", { stage: "presentation", issues });
    if (issues.length > 0) {
      throw new PresentationError(
        `Presentation is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"}).`,
        { issues },
      );
    }
  }

  assertNoPluginIssues(
    resourceKind.validate?.(spec, { presentations: registries.presentations }),
    ["spec"],
    `Resource kind "${manifest.kind}" rejected \`spec\`.`,
  );

  // Every record QSpec allocates here is frozen. The manifest data these
  // records alias was deep-frozen above; the plugin capability objects they
  // reference (`query.language`, `query.source`, `transform.implementation`)
  // are referenced but never frozen, because they belong to the plugin.
  const plan: PreparedPlan = Object.freeze({
    kind: manifest.kind,
    name: manifest.metadata.name,
    parameters: freezeParameters(parameters),
    query: query === undefined ? undefined : Object.freeze(query),
    datasetSchema,
    transforms: Object.freeze(transforms.map((transform) => Object.freeze(transform))),
    presentation,
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
