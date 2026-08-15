# QSpec

## Technical Specification and Architecture Requirements

**Project:** QSpec
**Primary ecosystem:** TypeScript / JavaScript / npm
**Primary package namespace:** `@qspecs/*`
**Document status:** Initial Architecture Specification
**Target specification:** QSpec v1
**License:** To be determined

---

# 1. Executive Summary

QSpec is an extensible declarative specification and runtime for defining parameterized data queries, validating their inputs and outputs, transforming returned datasets, and describing how those datasets should be presented.

A QSpec manifest should make it possible to describe an analytical resource without writing application-specific execution or visualization code.

The conceptual pipeline is:

```text
Parameters
    ↓
Validation
    ↓
Query
    ↓
Data Source
    ↓
Result
    ↓
Dataset Validation
    ↓
Transformations
    ↓
Normalized Dataset
    ↓
Presentation
```

QSpec must not be designed as a charting library.

Charts are only one possible presentation of a QSpec dataset.

The architecture must support resources such as:

```text
Chart
Table
Metric
Dataset
Dashboard
```

and must allow future resource kinds to be introduced through extensions.

QSpec consists of two major concepts:

1. **QSpec Specification**
   - portable JSON manifest format;
   - versioned;
   - deterministic;
   - serializable;
   - implementation-independent.

2. **QSpec Runtime**
   - TypeScript/JavaScript implementation;
   - plugin system;
   - query execution;
   - validation;
   - transformations;
   - adapters;
   - presentation integrations.

The primary architectural principle is:

> QSpec Core must remain small, stable, deterministic, and extensible. Domain-specific functionality belongs in plugins.

---

# 2. Goals

QSpec must provide:

- a declarative JSON specification;
- excellent TypeScript developer experience;
- runtime manifest validation;
- parameter validation;
- query parameter binding;
- pluggable query languages;
- pluggable data sources;
- normalized query results;
- result schema validation;
- extensible transformations;
- semantic field metadata;
- declarative presentation definitions;
- pluggable visualization/rendering systems;
- framework-independent core;
- browser/server separation;
- cancellation support;
- plugin lifecycle management;
- observability hooks;
- JSON Schema distribution;
- command-line validation tooling;
- backward-compatible specification evolution.

The following should eventually be possible:

```ts
const qspec = createQSpec().use(sql()).use(postgres()).use(charts());

const result = await qspec.execute(manifest, {
  parameters: {
    from: "2026-01-01",
    to: "2026-12-31",
  },
});
```

The basic use case must remain simple even as advanced extensibility is added.

---

# 3. Non-Goals

QSpec v1 is not intended to be:

- a database;
- a BI platform;
- a data warehouse;
- an ETL platform;
- a replacement for SQL;
- a replacement for PromQL;
- a chart rendering engine;
- a dashboard SaaS;
- an authentication system;
- a secrets manager;
- a general-purpose programming language;
- an arbitrary JavaScript execution environment.

QSpec defines and executes specifications.

Applications built on QSpec may implement the above capabilities separately.

---

# 4. Design Principles

## 4.1 Declarative First

A QSpec resource must have a fully serializable representation.

The canonical representation is JSON.

Example:

```json
{
  "apiVersion": "qspec.dev/v1",
  "kind": "Chart",
  "metadata": {
    "name": "monthly-revenue"
  },
  "spec": {}
}
```

No JavaScript functions may exist inside the canonical manifest.

The following must therefore be invalid:

```ts
{
  transform: rows => rows.filter(...)
}
```

QSpec should use declarative operators or plugin references instead.

---

# 5. Portability

A valid standard QSpec manifest should not depend on:

- React;
- Recharts;
- ECharts;
- PostgreSQL driver implementations;
- Node.js runtime internals;
- browser APIs.

Vendor-specific behavior must be isolated through extensions.

---

# 6. Extensibility

QSpec must allow third parties to add:

- parameter types;
- validators;
- query languages;
- query compilers;
- data source adapters;
- transforms;
- semantic types;
- resource kinds;
- presentation types;
- renderers;
- formatters;
- middleware;
- telemetry integrations.

Adding these capabilities must not require modifications to `@qspecs/core`.

---

# 7. Type Safety

The TypeScript API must provide strong compile-time validation and autocomplete.

Where practical, plugin installation should extend available TypeScript capabilities.

---

# 8. Determinism

Given:

```text
manifest
+
parameters
+
runtime configuration
+
data source response
```

QSpec's internal processing should be deterministic.

Manifest behavior must not depend on arbitrary embedded code.

---

# 9. Security by Design

The specification must never require credentials inside manifests.

This is forbidden:

```json
{
  "source": {
    "password": "secret"
  }
}
```

Instead:

```json
{
  "query": {
    "source": "analytics"
  }
}
```

The runtime maps `analytics` to actual credentials and infrastructure.

---

# 10. High-Level Architecture

The runtime architecture should follow:

```text
                     QSpec Manifest
                           │
                           ▼
                  Manifest Parser
                           │
                           ▼
                 Schema Validation
                           │
                           ▼
                 Resource Resolver
                           │
                           ▼
               Parameter Resolution
                           │
                           ▼
               Parameter Validation
                           │
                           ▼
                  Query Resolver
                           │
                           ▼
                  Query Compiler
                           │
                           ▼
                Data Source Adapter
                           │
                           ▼
                     Raw Result
                           │
                           ▼
                 Result Normalizer
                           │
                           ▼
                 Dataset Validator
                           │
                           ▼
                Transform Pipeline
                           │
                           ▼
                Normalized Dataset
                           │
                           ▼
               Presentation Model
                           │
                           ▼
                      Renderer
```

Each major capability should be replaceable or extensible through registries.

---

# 11. Package Architecture

QSpec should use an npm monorepo.

Recommended initial structure:

```text
qspec/
├── packages/
│   ├── core/
│   ├── schema/
│   ├── sql/
│   ├── postgres/
│   ├── transforms/
│   ├── charts/
│   ├── react/
│   ├── recharts/
│   └── cli/
│
├── examples/
├── docs/
├── schemas/
├── tests/
├── package.json
└── README.md
```

Future packages may include:

```text
@qspecs/mysql
@qspecs/sqlite
@qspecs/duckdb
@qspecs/clickhouse
@qspecs/bigquery

@qspecs/opensearch
@qspecs/prometheus

@qspecs/tables
@qspecs/metrics
@qspecs/dashboards

@qspecs/echarts
@qspecs/vega

@qspecs/server
@qspecs/express
@qspecs/fastify

@qspecs/telemetry
```

---

# 12. `@qspecs/core`

This is the most important package.

It must remain lightweight.

It must contain:

- core manifest interfaces;
- plugin interfaces;
- registry implementation;
- runtime creation;
- execution context;
- execution pipeline;
- normalized dataset model;
- errors;
- lifecycle infrastructure;
- generic resource abstractions.

It must NOT directly depend on:

```text
pg
mysql
react
recharts
echarts
prom-client
OpenSearch clients
```

It should have as few runtime dependencies as reasonably possible.

---

# 13. `@qspecs/schema`

Responsibilities:

- official JSON Schema definitions;
- schema version exports;
- programmatic schema access;
- manifest validation helpers.

Example:

```ts
import { qspecV1Schema } from "@qspecs/schema";
```

Schemas should also be publishable independently through the QSpec website.

Example conceptual URL:

```text
https://qspec.dev/schemas/v1/qspec.json
```

---

# 14. `@qspecs/sql`

Responsibilities:

- SQL query specification;
- SQL named parameter model;
- SQL query compilation;
- SQL parameter binding abstractions.

It must NOT be tied specifically to PostgreSQL.

---

# 15. `@qspecs/postgres`

Responsibilities:

- PostgreSQL data source adapter;
- connection pooling;
- execution;
- cancellation;
- PostgreSQL result normalization;
- PostgreSQL-specific type conversion.

Example:

```ts
postgres({
  sources: {
    analytics: {
      connectionString: process.env.ANALYTICS_DB,
    },
  },
});
```

---

# 16. `@qspecs/transforms`

Provides standard transformations such as:

```text
filter
sort
limit
rename
select
derive
aggregate
```

Only deterministic declarative transformations should be included.

---

# 17. `@qspecs/charts`

Defines standardized chart presentation models.

Initial chart types:

```text
line
bar
area
pie
scatter
```

This package must NOT render charts.

It only defines chart semantics.

---

# 18. `@qspecs/react`

Provides framework integration.

Responsibilities may include:

```text
QSpecProvider
useQSpec
useQSpecQuery
useQSpecResource
```

It must not require a particular chart library.

---

# 19. `@qspecs/recharts`

Provides rendering of standardized QSpec chart models using Recharts.

It should depend on:

```text
@qspecs/core
@qspecs/charts
recharts
```

---

# 20. `@qspecs/cli`

Initial commands:

```bash
qspec validate manifest.json
```

```bash
qspec inspect manifest.json
```

Potential later commands:

```bash
qspec execute manifest.json
qspec schema
qspec plugins
```

---

# 21. Manifest Structure

Every QSpec v1 resource must follow the top-level structure:

```json
{
  "$schema": "...",
  "apiVersion": "qspec.dev/v1",
  "kind": "Chart",
  "metadata": {},
  "spec": {}
}
```

---

# 22. `$schema`

Optional but strongly recommended.

Example:

```json
{
  "$schema": "https://qspec.dev/schemas/v1/chart.json"
}
```

This enables editor autocomplete and validation.

---

# 23. `apiVersion`

Required.

Example:

```json
{
  "apiVersion": "qspec.dev/v1"
}
```

The runtime must use this field to resolve the appropriate manifest parser and compatibility behavior.

---

# 24. `kind`

Required.

Examples:

```json
{
  "kind": "Chart"
}
```

Future values:

```text
Dataset
Chart
Table
Metric
Dashboard
```

Resource kinds should eventually be registry-driven.

---

# 25. `metadata`

Standard structure:

```json
{
  "metadata": {
    "name": "monthly-revenue",
    "title": "Monthly Revenue",
    "description": "Revenue grouped by month",
    "tags": ["finance", "sales"]
  }
}
```

`name` must:

- be required;
- be stable;
- be machine-friendly;
- use a documented naming format.

Recommended pattern:

```text
^[a-z][a-z0-9-]*$
```

---

# 26. `spec`

Contains the actual resource declaration.

For a Chart:

```json
{
  "spec": {
    "parameters": {},
    "query": {},
    "dataset": {},
    "transforms": [],
    "presentation": {}
  }
}
```

The preferred term should be `presentation`, rather than `visualization`, because QSpec must support resources that are not graphical.

---

# 27. Parameters

Parameters are first-class QSpec entities.

Example:

```json
{
  "parameters": {
    "from": {
      "type": "date",
      "required": true
    },

    "to": {
      "type": "date",
      "required": true
    },

    "country": {
      "type": "string",
      "required": false,
      "default": "US"
    }
  }
}
```

---

# 28. Standard Parameter Types

QSpec v1 should support:

```text
string
number
integer
boolean
date
datetime
enum
array
```

Future types may be introduced through plugins.

---

# 29. Parameter Validation

Example:

```json
{
  "minRevenue": {
    "type": "number",
    "required": false,
    "default": 0,

    "validation": {
      "min": 0,
      "max": 1000000
    }
  }
}
```

String validation:

```json
{
  "search": {
    "type": "string",

    "validation": {
      "minLength": 2,
      "maxLength": 100
    }
  }
}
```

Enum:

```json
{
  "period": {
    "type": "enum",
    "default": "30d",

    "values": ["7d", "30d", "90d"]
  }
}
```

---

# 30. Parameter Presentation Metadata

Parameter definitions may optionally describe suggested UI controls.

Example:

```json
{
  "country": {
    "type": "string",

    "presentation": {
      "control": "select",
      "label": "Country"
    }
  }
}
```

This metadata must be advisory.

The core runtime must not depend on it.

A React package may use it to automatically generate controls.

---

# 31. Query Specification

A query declaration should contain:

```json
{
  "query": {
    "source": "analytics",
    "language": "sql",
    "statement": "...",
    "bindings": {}
  }
}
```

---

# 32. Source

`source` identifies a logical runtime-configured data source.

Example manifest:

```json
{
  "source": "analytics"
}
```

Runtime:

```ts
createQSpec({
  sources: {
    analytics: ...
  }
});
```

The manifest must not contain infrastructure credentials.

---

# 33. Query Language

The language is independently resolved from the source.

Example:

```json
{
  "language": "sql"
}
```

Other possibilities:

```text
promql
opensearch-dsl
graphql
custom languages
```

This enables query-language plugins and data-source plugins to remain conceptually independent.

---

# 34. Query Bindings

SQL example:

```json
{
  "query": {
    "source": "analytics",
    "language": "sql",

    "statement": "SELECT * FROM orders WHERE created_at >= :from AND created_at < :to",

    "bindings": {
      "from": "$parameters.from",
      "to": "$parameters.to"
    }
  }
}
```

Bindings must be parameterized.

Implementations must never interpolate untrusted values directly into SQL strings.

---

# 35. Structured Queries

`statement` must not be restricted to strings.

Example OpenSearch specification:

```json
{
  "query": {
    "source": "search",
    "language": "opensearch-dsl",

    "statement": {
      "query": {
        "match_all": {}
      }
    }
  }
}
```

Therefore query implementations should use a generic query payload.

Conceptually:

```ts
interface QueryDefinition<TStatement = unknown> {
  source: string;
  language: string;
  statement: TStatement;
  bindings?: Record<string, Binding>;
}
```

---

# 36. Dataset Model

Query execution must produce a normalized dataset.

A dataset consists conceptually of:

```ts
interface Dataset {
  fields: Field[];
  rows: Record<string, unknown>[];
  metadata?: DatasetMetadata;
}
```

---

# 37. Dataset Schema

Manifest example:

```json
{
  "dataset": {
    "fields": {
      "month": {
        "type": "datetime",
        "nullable": false
      },

      "revenue": {
        "type": "number",
        "nullable": false
      }
    }
  }
}
```

The runtime should optionally validate query output against this schema.

---

# 38. Field Types

Standard field types:

```text
string
number
integer
boolean
date
datetime
object
array
```

Additional types may be introduced later.

---

# 39. Semantic Types

Fields may include semantic information.

Example:

```json
{
  "revenue": {
    "type": "number",
    "semanticType": "currency",

    "format": {
      "currency": "USD"
    }
  }
}
```

Other semantic types may include:

```text
currency
percentage
duration
bytes
timestamp
country
latitude
longitude
url
```

Semantic type must not change the underlying storage type.

For example:

```text
type = number
semanticType = currency
```

---

# 40. Transform Pipeline

Transforms operate on normalized datasets.

Example:

```json
{
  "transforms": [
    {
      "type": "filter",
      "where": {
        "field": "revenue",
        "operator": "gt",
        "value": 0
      }
    },

    {
      "type": "sort",
      "field": "month",
      "direction": "asc"
    },

    {
      "type": "limit",
      "count": 100
    }
  ]
}
```

Transforms execute sequentially.

---

# 41. No Arbitrary JavaScript in Manifests

The following must be forbidden:

```json
{
  "transform": "row => row.revenue > 100"
}
```

QSpec must provide declarative expressions.

This is required for:

- security;
- portability;
- deterministic execution;
- static validation;
- server-side execution;
- AI-generated manifests;
- future sandboxing.

---

# 42. Expression Model

QSpec should eventually define a small expression AST.

Example:

```json
{
  "operator": "gt",
  "arguments": [
    {
      "field": "revenue"
    },
    {
      "literal": 100
    }
  ]
}
```

Compound expression:

```json
{
  "operator": "and",

  "arguments": [
    {
      "operator": "gt",
      "arguments": [
        {
          "field": "revenue"
        },
        {
          "literal": 100
        }
      ]
    },

    {
      "operator": "eq",
      "arguments": [
        {
          "field": "country"
        },
        {
          "literal": "US"
        }
      ]
    }
  ]
}
```

The expression language must remain intentionally limited.

It must not become JavaScript represented as JSON.

---

# 43. Derived Fields

The architecture should support derived fields.

Example:

```json
{
  "profit": {
    "type": "number",

    "derive": {
      "operator": "subtract",

      "arguments": [
        {
          "field": "revenue"
        },
        {
          "field": "cost"
        }
      ]
    }
  }
}
```

---

# 44. Presentation Model

Presentation must describe semantic intent rather than a specific rendering library.

Example:

```json
{
  "presentation": {
    "type": "line",

    "x": {
      "field": "month",
      "label": "Month"
    },

    "series": [
      {
        "field": "revenue",
        "label": "Revenue"
      }
    ]
  }
}
```

QSpec must not expose Recharts internals in the standard specification.

---

# 45. Chart Presentation Types

Initial standard chart types:

```text
line
bar
area
pie
scatter
```

Later:

```text
stacked-bar
histogram
heatmap
funnel
gauge
```

Complex visualization types should not block QSpec v1.

---

# 46. Multiple Series

Example:

```json
{
  "presentation": {
    "type": "line",

    "x": {
      "field": "timestamp"
    },

    "series": [
      {
        "field": "requests",
        "label": "Requests"
      },

      {
        "field": "errors",
        "label": "Errors"
      }
    ]
  }
}
```

---

# 47. Dynamic Series

QSpec should eventually support series generated from a grouping field.

Example:

```json
{
  "presentation": {
    "type": "line",

    "x": {
      "field": "timestamp"
    },

    "series": {
      "field": "requests",
      "groupBy": "service"
    }
  }
}
```

Given:

```text
timestamp | service | requests
----------|---------|---------
10:00     | api     | 120
10:00     | worker  | 80
```

the renderer should derive series such as:

```text
api
worker
```

---

# 48. Renderer-Specific Extensions

QSpec must support vendor-specific extensions without polluting the portable specification.

Recommended convention:

```json
{
  "presentation": {
    "type": "line",

    "x": {
      "field": "month"
    },

    "series": [
      {
        "field": "revenue"
      }
    ],

    "x-echarts": {
      "animationDuration": 300
    }
  }
}
```

All extension fields should use:

```text
x-<vendor>
```

Core must preserve unknown extension fields when parsing and serializing manifests.

Core should otherwise ignore them.

---

# 49. Plugin Architecture

Plugin support is a fundamental requirement.

Base interface:

```ts
export interface QSpecPlugin {
  name: string;
  version?: string;

  setup(api: QSpecPluginAPI): void | Promise<void>;
}
```

Example:

```ts
export function charts(): QSpecPlugin {
  return {
    name: "@qspecs/charts",

    setup(api) {
      api.presentations.register(...);
    }
  };
}
```

---

# 50. Plugin API

The plugin API should expose capability registries.

Conceptually:

```ts
interface QSpecPluginAPI {
  parameters: ParameterRegistry;
  queryLanguages: QueryLanguageRegistry;
  sources: DataSourceRegistry;
  transforms: TransformRegistry;
  semanticTypes: SemanticTypeRegistry;
  resources: ResourceRegistry;
  presentations: PresentationRegistry;
  renderers: RendererRegistry;
  hooks: HookRegistry;
}
```

---

# 51. Registry Contract

Registries should provide a consistent interface.

Example:

```ts
interface Registry<T> {
  register(name: string, implementation: T): void;

  get(name: string): T | undefined;

  has(name: string): boolean;

  list(): readonly string[];
}
```

Duplicate registration behavior must be explicitly defined.

Recommended default:

- duplicate registration throws;
- explicit replacement requires a dedicated API.

Example:

```ts
registry.replace(...)
```

This prevents plugins from silently overriding security-sensitive behavior.

---

# 52. Plugin Installation

Preferred API:

```ts
const qspec = createQSpec()
  .use(sql())
  .use(
    postgres({
      sources: {
        analytics: {
          connectionString: process.env.DB_URL!,
        },
      },
    }),
  )
  .use(charts());
```

`.use()` should return the QSpec runtime to support chaining.

---

# 53. Plugin Isolation

Plugins should interact through documented interfaces.

A plugin must not depend on private runtime internals.

Internal implementation objects should not be exported unless explicitly part of the public API.

---

# 54. TypeScript Capability Model

Where practical, QSpec should use generics to track installed capabilities.

Conceptually:

```ts
QSpecRuntime<TCapabilities>;
```

Installing:

```ts
.use(sql())
```

may extend query language capabilities.

Installing:

```ts
.use(charts())
```

may extend presentation types.

The implementation should balance type sophistication against compiler performance and usability.

Type-level architecture must not become so complex that:

- errors become unreadable;
- TypeScript performance degrades significantly;
- plugin authors cannot understand the contracts.

Developer experience takes priority over type-system cleverness.

---

# 55. Programmatic TypeScript DSL

JSON is the canonical portable representation.

TypeScript users should additionally receive an ergonomic DSL.

Example:

```ts
const revenueChart = defineChart({
  name: "monthly-revenue",

  parameters: {
    from: date().required(),
    to: date().required(),
  },

  query: sqlQuery({
    source: "analytics",

    statement: `
      SELECT
        date_trunc('month', created_at) AS month,
        SUM(amount) AS revenue
      FROM orders
      WHERE created_at >= :from
        AND created_at < :to
      GROUP BY month
      ORDER BY month
    `,
  }),

  dataset: {
    month: datetime(),
    revenue: number().currency("USD"),
  },

  presentation: lineChart({
    x: field("month"),
    series: [field("revenue")],
  }),
});
```

The resulting object must be serializable to a standard QSpec manifest.

---

# 56. `defineManifest`

QSpec should also provide a lower-level helper:

```ts
const manifest = defineManifest({
  apiVersion: "qspec.dev/v1",

  kind: "Chart",

  metadata: {
    name: "monthly-revenue"
  },

  spec: {
    ...
  }
});
```

Its purpose is primarily:

- compile-time checking;
- autocomplete;
- preserving literal types.

It should introduce minimal runtime overhead.

---

# 57. Execution API

Basic execution:

```ts
const result = await qspec.execute(manifest, {
  parameters: {
    from: "2026-01-01",
    to: "2026-12-31",
  },
});
```

---

# 58. Prepared Resource API

For repeated execution:

```ts
const resource = await qspec.prepare(manifest);

const result = await resource.execute({
  parameters: {
    from: "2026-01-01",
    to: "2026-12-31",
  },
});
```

`prepare()` may perform:

- manifest parsing;
- schema validation;
- plugin resolution;
- query-language resolution;
- static validation;
- execution-plan construction.

This avoids repeating expensive static work.

---

# 59. Execution Context

Suggested interface:

```ts
interface ExecutionContext {
  parameters: Record<string, unknown>;

  signal?: AbortSignal;

  locale?: string;

  timezone?: string;

  metadata?: Record<string, unknown>;
}
```

Internal execution context may additionally contain:

```text
execution ID
start time
resolved resource
registered plugins
telemetry context
```

---

# 60. Cancellation

Cancellation must be supported through standard `AbortSignal`.

Example:

```ts
const controller = new AbortController();

const promise = qspec.execute(manifest, {
  parameters,
  signal: controller.signal,
});

controller.abort();
```

Adapters should propagate cancellation whenever their underlying client supports it.

---

# 61. Execution Result

Execution should return a stable result independent of the underlying database.

Suggested interface:

```ts
interface QSpecResult {
  data: Dataset;

  presentation?: PresentationModel;

  meta: ExecutionMetadata;
}
```

Example metadata:

```ts
interface ExecutionMetadata {
  executionId: string;
  durationMs: number;
  rowCount: number;

  query?: {
    source: string;
    language: string;
    durationMs?: number;
  };
}
```

Sensitive information must not be included automatically.

---

# 62. Data Source Interface

Conceptual interface:

```ts
interface DataSource<TQuery = unknown> {
  execute(query: TQuery, context: DataSourceContext): Promise<RawQueryResult>;
}
```

Data sources should be responsible for:

- connectivity;
- native query execution;
- cancellation propagation;
- raw result acquisition.

They should not decide how results are visualized.

---

# 63. Query Language Interface

Conceptually:

```ts
interface QueryLanguage<TStatement = unknown, TCompiledQuery = unknown> {
  compile(
    query: QueryDefinition<TStatement>,
    context: QueryCompileContext,
  ): Promise<TCompiledQuery> | TCompiledQuery;
}
```

This separation enables combinations such as:

```text
SQL + PostgreSQL
SQL + MySQL
SQL + DuckDB
```

without treating every combination as a separate query language.

---

# 64. Transform Interface

Conceptually:

```ts
interface Transform<TSpec = unknown> {
  execute(
    dataset: Dataset,
    spec: TSpec,
    context: TransformContext,
  ): Promise<Dataset> | Dataset;
}
```

Transforms must not mutate their input dataset unless explicitly documented.

Immutable behavior is preferred.

---

# 65. Renderer Interface

Rendering must remain outside query execution.

Conceptual interface:

```ts
interface Renderer<TPresentation = unknown, TOutput = unknown> {
  render(
    dataset: Dataset,
    presentation: TPresentation,
    context: RenderContext,
  ): TOutput;
}
```

This allows:

```text
React renderer
server-side SVG renderer
PNG renderer
CLI renderer
PDF renderer
```

without changing query execution.

---

# 66. React Integration

Example desired API:

```tsx
<QSpecProvider runtime={qspec}>
  <QSpecResource
    manifest={manifest}
    parameters={{
      from,
      to,
    }}
  />
</QSpecProvider>
```

Lower-level hook:

```ts
const { data, presentation, loading, error, refetch } = useQSpecQuery({
  manifest,
  parameters,
});
```

React must remain optional.

---

# 67. Automatic Parameter Forms

Future React packages may use parameter metadata to generate forms.

Example manifest:

```json
{
  "period": {
    "type": "enum",

    "values": ["7d", "30d", "90d"],

    "presentation": {
      "control": "select",
      "label": "Period"
    }
  }
}
```

Could automatically produce:

```text
Period

[ Last 30 days ▼ ]

[ Apply ]
```

This functionality should live outside core.

---

# 68. Lifecycle Hooks

QSpec should expose observable lifecycle events.

Examples:

```text
manifest:parse:start
manifest:parse:end

validation:start
validation:end

query:compile:start
query:compile:end

query:execute:start
query:execute:end

transform:start
transform:end

execution:complete
execution:error
```

Exact naming may change before public stabilization.

---

# 69. Middleware

Middleware may be introduced for cross-cutting functionality.

Examples:

```text
logging
metrics
tracing
caching
authorization
query auditing
rate limiting
```

The middleware model must not permit accidental corruption of runtime invariants.

A typed lifecycle/event model may be preferable to unrestricted middleware for v1.

---

# 70. Error Model

QSpec must provide structured errors.

Base:

```ts
class QSpecError extends Error {
  code: string;
  cause?: unknown;
  details?: unknown;
}
```

Standard errors should include:

```text
ManifestValidationError
UnsupportedApiVersionError
UnknownResourceKindError
ParameterValidationError
UnknownQueryLanguageError
UnknownDataSourceError
QueryCompilationError
QueryExecutionError
DatasetValidationError
TransformError
PresentationError
PluginRegistrationError
AbortError
```

Errors should expose stable machine-readable codes.

Example:

```text
QSPEC_MANIFEST_INVALID
QSPEC_PARAMETER_INVALID
QSPEC_SOURCE_NOT_FOUND
QSPEC_QUERY_FAILED
QSPEC_DATASET_INVALID
QSPEC_EXECUTION_ABORTED
```

---

# 71. Error Paths

Validation errors should contain paths.

Example:

```json
{
  "code": "QSPEC_PARAMETER_INVALID",
  "message": "Parameter must be greater than or equal to 0",
  "path": ["parameters", "minRevenue"]
}
```

Manifest errors should point to locations such as:

```text
spec.parameters.country.validation
spec.presentation.series[0].field
```

This is critical for editors and AI tooling.

---

# 72. Security Requirements

## 72.1 No Credentials in Manifests

Credentials must remain runtime configuration.

## 72.2 Parameterized Queries

SQL adapters must use native database parameterization.

Never:

```ts
`WHERE id = ${value}`;
```

Prefer driver bindings.

## 72.3 No `eval`

Core and official plugins must not use:

```text
eval()
new Function()
dynamic arbitrary JavaScript execution
```

for manifest expressions.

## 72.4 Prototype Pollution

Manifest parsing and transformation logic must be resistant to dangerous object keys such as:

```text
__proto__
constructor
prototype
```

## 72.5 Resource Limits

Execution APIs should allow host applications to enforce:

```text
maximum rows
maximum query duration
maximum transform count
maximum manifest size
maximum expression depth
```

## 72.6 Sensitive Logging

Database credentials and sensitive bound parameter values must not be logged by default.

---

# 73. Server/Browser Separation

Packages must clearly define runtime compatibility.

Example:

```text
@qspecs/core          browser + server
@qspecs/schema        browser + server
@qspecs/charts        browser + server
@qspecs/transforms    browser + server

@qspecs/postgres      server only

@qspecs/react         browser/React
@qspecs/recharts      browser/React
```

Importing `@qspecs/core` in a browser must not pull database drivers into the bundle.

---

# 74. Tree Shaking

Packages should:

- use ESM;
- avoid unnecessary side effects;
- expose correct `exports`;
- mark side-effect behavior correctly;
- support modern bundlers.

Example package metadata should use:

```json
{
  "sideEffects": false
}
```

where technically correct.

---

# 75. Module Strategy

Recommended target:

```text
ESM-first
TypeScript source
generated declaration files
modern Node.js LTS
modern browsers
```

Dual ESM/CommonJS support should only be added if there is a demonstrated ecosystem requirement.

Avoid increasing build complexity solely for legacy compatibility.

---

# 76. JSON Schema

Official QSpec schemas should support editor integrations.

For example, VS Code should autocomplete:

```json
{
  "apiVersion": "qspec.dev/v1",
  "kind": "Chart",
  "metadata": {
    "name": ""
  }
}
```

Schema releases must be versioned and immutable once published.

---

# 77. Specification Versioning

`apiVersion` is independent of npm package version.

For example:

```text
@qspecs/core 2.4.0
```

may support:

```text
qspec.dev/v1
qspec.dev/v2
```

The runtime must explicitly declare supported specification versions.

---

# 78. Backward Compatibility

Published specification versions must not be silently changed in breaking ways.

Breaking changes require a new API version.

Example:

```text
qspec.dev/v1
        ↓
qspec.dev/v2
```

The runtime may provide migration tooling.

Example future command:

```bash
qspec migrate \
  --from v1 \
  --to v2 \
  manifest.json
```

---

# 79. Plugin Version Compatibility

Plugins should declare compatible core ranges through npm peer dependencies.

Example:

```json
{
  "peerDependencies": {
    "@qspecs/core": "^1.0.0"
  }
}
```

Where necessary, plugins may additionally expose capability/version metadata.

---

# 80. Validation Stages

Validation should happen at several distinct stages.

### Stage 1 — Manifest structure

Validate JSON against QSpec schema.

### Stage 2 — Plugin capabilities

Check that required:

```text
resource kinds
query languages
sources
transforms
presentation types
```

exist.

### Stage 3 — Parameters

Validate runtime values.

### Stage 4 — Query

Validate query-specific requirements.

### Stage 5 — Dataset

Validate returned data against expected fields.

### Stage 6 — Presentation

Validate references to dataset fields.

For example:

```json
{
  "series": [
    {
      "field": "reveneu"
    }
  ]
}
```

should fail if only:

```text
revenue
```

exists.

---

# 81. Static Validation

QSpec should perform as much validation as possible before executing a query.

For example:

```text
presentation references unknown dataset field
unknown transform
unknown query language
invalid parameter binding
missing required query property
```

should fail during `prepare()`.

This prevents unnecessary database queries.

---

# 82. Caching Architecture

Caching is not required for initial QSpec v1, but the architecture must allow it.

Potential cache key:

```text
manifest identity
+
manifest version/hash
+
resolved parameters
+
source
+
query
```

Cache providers should eventually be plugins.

Possible implementations:

```text
memory
Redis
filesystem
custom
```

---

# 83. Manifest Identity

QSpec should support stable manifest hashing.

The runtime may expose:

```ts
const hash = qspec.hash(manifest);
```

Canonicalization rules must be defined before hashes are treated as portable identifiers.

Potential uses:

- caching;
- audit logging;
- deployment tracking;
- manifest signing;
- change detection.

---

# 84. Observability

Execution should expose enough information for telemetry.

Example event:

```ts
{
  executionId: "...",
  resource: "monthly-revenue",
  source: "analytics",
  language: "sql",
  durationMs: 43,
  rowCount: 12,
  success: true
}
```

Official telemetry integrations may eventually include OpenTelemetry.

---

# 85. Logging

Core should not impose a logging library.

Runtime configuration may accept a minimal logger interface:

```ts
interface QSpecLogger {
  debug?(message: string, context?: unknown): void;
  info?(message: string, context?: unknown): void;
  warn?(message: string, context?: unknown): void;
  error?(message: string, context?: unknown): void;
}
```

Default behavior should be quiet.

---

# 86. CLI Requirements

Initial:

```bash
qspec validate report.json
```

Expected output:

```text
✓ Valid QSpec manifest
API version: qspec.dev/v1
Kind: Chart
Name: monthly-revenue
```

Invalid:

```text
✗ Invalid QSpec manifest

spec.presentation.series[0].field:
Unknown dataset field "reveneu".

Did you mean "revenue"?
```

Developer-friendly diagnostics are an important product feature.

---

# 87. CLI Inspect

Recommended:

```bash
qspec inspect report.json
```

Output:

```text
Resource
  Name: monthly-revenue
  Kind: Chart
  API: qspec.dev/v1

Parameters
  from       date      required
  to         date      required
  country    string    optional

Query
  Source: analytics
  Language: sql

Dataset
  month      datetime
  revenue    number/currency

Presentation
  Type: line
  X: month
  Series: revenue
```

---

# 88. Testing Strategy

Each package must include unit tests.

Core requires especially strong coverage around:

- registries;
- plugin loading;
- manifest validation;
- parameter validation;
- execution lifecycle;
- errors;
- cancellation;
- transform ordering.

---

# 89. Contract Tests

Data source plugins should pass common contract tests.

Example:

```ts
runDataSourceContractTests(postgresAdapter);
```

This ensures consistent behavior across:

```text
PostgreSQL
MySQL
DuckDB
ClickHouse
```

Similar contracts should exist for:

```text
transforms
query languages
renderers
```

---

# 90. Integration Tests

Integration tests should include a real PostgreSQL instance.

Recommended CI infrastructure:

```text
PostgreSQL container
Node.js test process
example QSpec manifests
```

Tests must verify:

```text
parameter binding
query execution
result normalization
dataset validation
cancellation
database errors
```

---

# 91. Manifest Fixtures

Maintain a dedicated fixture directory:

```text
fixtures/
├── valid/
│   ├── basic-line-chart.json
│   ├── parameterized-chart.json
│   └── transformed-dataset.json
│
└── invalid/
    ├── unknown-field.json
    ├── invalid-parameter.json
    └── unsupported-version.json
```

These fixtures can be shared between:

- schema tests;
- core tests;
- CLI tests;
- documentation.

---

# 92. Documentation

Documentation should include:

```text
Introduction
Quick Start
Manifest Specification
Parameters
Queries
Data Sources
Datasets
Transforms
Presentations
Plugins
React Integration
CLI
Security
Plugin Authoring
Specification Versioning
```

---

# 93. Quick Start Target

The quick-start experience should remain approximately:

```bash
npm install \
  @qspecs/core \
  @qspecs/sql \
  @qspecs/postgres \
  @qspecs/charts
```

Then:

```ts
const qspec = createQSpec()
  .use(sql())
  .use(
    postgres({
      sources: {
        analytics: {
          connectionString: process.env.DATABASE_URL!,
        },
      },
    }),
  )
  .use(charts());
```

Then:

```ts
const result = await qspec.execute(manifest, {
  parameters: {
    from: "2026-01-01",
    to: "2026-12-31",
  },
});
```

This simplicity should be treated as an architectural requirement.

---

# 94. Example Complete QSpec Manifest

```json
{
  "$schema": "https://qspec.dev/schemas/v1/chart.json",

  "apiVersion": "qspec.dev/v1",

  "kind": "Chart",

  "metadata": {
    "name": "monthly-revenue",
    "title": "Monthly Revenue",
    "description": "Revenue grouped by month",
    "tags": ["finance", "sales"]
  },

  "spec": {
    "parameters": {
      "from": {
        "type": "date",
        "required": true
      },

      "to": {
        "type": "date",
        "required": true
      },

      "country": {
        "type": "string",
        "required": false,
        "default": "US"
      }
    },

    "query": {
      "source": "analytics",
      "language": "sql",

      "statement": "SELECT date_trunc('month', created_at) AS month, SUM(amount) AS revenue FROM orders WHERE created_at >= :from AND created_at < :to AND country = :country GROUP BY month ORDER BY month",

      "bindings": {
        "from": "$parameters.from",
        "to": "$parameters.to",
        "country": "$parameters.country"
      }
    },

    "dataset": {
      "fields": {
        "month": {
          "type": "datetime",
          "nullable": false
        },

        "revenue": {
          "type": "number",
          "nullable": false,
          "semanticType": "currency",

          "format": {
            "currency": "USD"
          }
        }
      }
    },

    "transforms": [
      {
        "type": "filter",

        "where": {
          "operator": "gt",

          "arguments": [
            {
              "field": "revenue"
            },

            {
              "literal": 0
            }
          ]
        }
      }
    ],

    "presentation": {
      "type": "line",

      "x": {
        "field": "month",
        "label": "Month"
      },

      "series": [
        {
          "field": "revenue",
          "label": "Revenue"
        }
      ],

      "legend": {
        "visible": false
      },

      "tooltip": {
        "visible": true
      }
    }
  }
}
```

---

# 95. Recommended v1 Scope

The first production-quality milestone should deliberately remain smaller than the final architecture.

## QSpec Specification v1

Implement:

```text
apiVersion
kind
metadata
spec

parameters
query
dataset
transforms
presentation
```

---

# 96. Parameter Support v1

Implement:

```text
string
number
integer
boolean
date
datetime
enum
array
```

Validation:

```text
required
default
min
max
minLength
maxLength
enum values
```

---

# 97. Query Support v1

Implement:

```text
SQL
named bindings
PostgreSQL
```

Architecture must already support additional query languages and sources.

---

# 98. Dataset v1

Implement:

```text
schema definition
field validation
nullability
semantic types
format metadata
```

---

# 99. Transform v1

Implement:

```text
filter
sort
limit
select
rename
```

Derived expressions may be implemented in v1.1 if necessary.

---

# 100. Chart v1

Implement:

```text
line
bar
area
pie
scatter
```

Support:

```text
x field
series
labels
formatting
legend
tooltip
```

---

# 101. Renderer v1

Implement:

```text
React
Recharts
```

while keeping rendering completely optional for server-only QSpec users.

---

# 102. CLI v1

Implement:

```text
qspec validate
qspec inspect
```

Execution through CLI may be postponed because configuring credentials and runtime plugins introduces additional complexity.

---

# 103. Recommended Development Phases

## Phase 1 — Core Foundation

Deliver:

```text
@qspecs/core
@qspecs/schema
plugin API
registry API
manifest parser
errors
execution context
```

No database integration required yet.

---

## Phase 2 — Query Runtime

Deliver:

```text
@qspecs/sql
@qspecs/postgres

query compiler
bindings
execution
result normalization
AbortSignal support
```

At this point QSpec can execute useful manifests.

---

## Phase 3 — Dataset and Transforms

Deliver:

```text
dataset validation
semantic types
@qspecs/transforms
```

---

## Phase 4 — Presentation

Deliver:

```text
@qspecs/charts
chart semantic model
presentation validation
```

---

## Phase 5 — React Ecosystem

Deliver:

```text
@qspecs/react
@qspecs/recharts
```

Provide:

```tsx
<QSpecProvider />
<QSpecResource />
```

and:

```ts
useQSpecQuery();
```

---

## Phase 6 — Developer Tooling

Deliver:

```text
@qspecs/cli
JSON Schema hosting
examples
documentation
plugin author guide
```

---

# 104. Public API Stability

The project should explicitly distinguish:

```text
Public API
Internal API
Experimental API
```

Anything exported from stable package entry points should be treated as public.

Internal code should use paths that are not exposed through package `exports`.

Avoid exposing implementation details merely because another QSpec package needs them.

If multiple packages need an abstraction, promote it intentionally into a documented public or internal shared contract.

---

# 105. Plugin Author Experience

Creating a plugin should be simple.

Target:

```ts
import { definePlugin } from "@qspecs/core";

export const myPlugin = definePlugin({
  name: "my-qspec-plugin",

  setup(api) {
    api.transforms.register("normalize-score", {
      execute(dataset, spec) {
        // implementation
        return dataset;
      },
    });
  },
});
```

Usage:

```ts
const qspec = createQSpec().use(myPlugin);
```

The plugin author should not need to understand QSpec internal classes.

---

# 106. Third-Party Plugin Naming

Official plugins:

```text
@qspecs/postgres
@qspecs/charts
```

Community plugins may use names such as:

```text
qspec-clickhouse
qspec-datadog
qspec-highcharts
```

or their own npm scopes:

```text
@company/qspec-clickhouse
```

QSpec documentation should clearly distinguish official and community packages.

---

# 107. Future Manifest Registry

The architecture should allow QSpec resources to eventually be stored and referenced by identity.

Example:

```text
finance/monthly-revenue
```

This could support:

```text
versioning
sharing
deployment
dependencies
dashboards
remote execution
```

This functionality is outside v1 but should not be prevented by manifest design.

---

# 108. Future Resource References

Resources should eventually be able to reference other resources.

For example:

```json
{
  "kind": "Dashboard",

  "spec": {
    "items": [
      {
        "ref": "finance/total-revenue"
      },
      {
        "ref": "finance/monthly-revenue"
      }
    ]
  }
}
```

A resolver abstraction should eventually handle:

```text
local manifests
filesystem
HTTP
registry
application-defined stores
```

---

# 109. Future AI Integration

QSpec should intentionally remain friendly to AI-generated analytics.

Because manifests are:

```text
structured
declarative
schema validated
deterministic
portable
```

an AI system can potentially generate:

```text
parameters
queries
datasets
presentations
```

without generating application code.

Example workflow:

```text
User:
"Show monthly revenue for Germany."

            ↓

LLM

            ↓

QSpec manifest

            ↓

QSpec validation

            ↓

Authorization/policy layer

            ↓

Execution

            ↓

Dataset

            ↓

Renderer
```

This should influence the design of validation and diagnostics.

However, QSpec Core must not contain an AI dependency.

---

# 110. Future Policy Layer

Enterprise environments may need policies such as:

```text
which sources may be queried
which tables are allowed
maximum result size
allowed query languages
allowed transforms
which users may execute which resources
```

The architecture should allow a policy plugin or execution interceptor to approve or reject execution.

This is not required for the initial release.

---

# 111. Future Signing

Because manifests are deterministic JSON documents, future versions may support cryptographic signing.

Potential use:

```text
manifest
   ↓
canonicalization
   ↓
hash
   ↓
signature
```

This could allow systems to verify that an approved manifest has not been modified.

Canonical JSON/signature rules should not be invented prematurely in v1.

---

# 112. Performance Requirements

Core framework overhead should remain small relative to actual query execution.

The implementation should avoid:

- unnecessary deep clones;
- repeated JSON Schema compilation;
- repeated manifest parsing;
- unnecessary transformation passes;
- loading unused plugins;
- importing browser/server-incompatible dependencies.

Prepared resources should cache static validation work.

---

# 113. Large Dataset Considerations

Initial QSpec may operate on in-memory datasets.

However, interfaces should avoid assuming that all future datasets must always fit into memory.

Future implementations may support:

```text
streaming
pagination
incremental results
server-side transforms
Arrow
columnar datasets
```

Do not prematurely implement these in v1.

But avoid APIs that make future support impossible.

---

# 114. Naming Conventions

Project:

```text
QSpec
```

npm scope:

```text
@qspecs
```

Package examples:

```text
@qspecs/core
@qspecs/schema
@qspecs/postgres
```

JavaScript naming:

```ts
createQSpec();
defineManifest();
definePlugin();
```

Primary runtime type:

```ts
QSpec;
```

Primary errors:

```ts
QSpecError;
```

Manifest specification:

```text
QSpec Specification
```

Resource files may use:

```text
*.qspec.json
```

Example:

```text
monthly-revenue.qspec.json
```

This file convention is recommended but not mandatory.

---

# 115. Initial Repository Definition of Done

The initial repository milestone is complete when the project contains:

1. npm workspace/monorepo;
2. `@qspecs/core`;
3. `@qspecs/schema`;
4. plugin API;
5. generic registries;
6. QSpec v1 base manifest schema;
7. parameter model;
8. parameter validation;
9. structured errors;
10. `defineManifest()`;
11. `createQSpec()`;
12. `.use(plugin)`;
13. manifest validation;
14. unit tests;
15. CI;
16. package build pipeline;
17. basic CLI validation;
18. README;
19. architecture documentation;
20. at least three valid example manifests.

The following API should work:

```ts
const qspec = createQSpec().use(examplePlugin());

const manifest = defineManifest({
  apiVersion: "qspec.dev/v1",

  kind: "Dataset",

  metadata: {
    name: "example",
  },

  spec: {
    parameters: {},
  },
});

await qspec.prepare(manifest);
```

---

# 116. v1 Production Definition of Done

QSpec v1 can be considered production-ready when the following complete flow works:

```text
JSON manifest
      ↓
schema validation
      ↓
parameter validation
      ↓
SQL compilation
      ↓
PostgreSQL execution
      ↓
dataset normalization
      ↓
dataset validation
      ↓
transform pipeline
      ↓
chart presentation
      ↓
React/Recharts rendering
```

while maintaining strict separation between the individual packages.

The following packages should be publishable independently:

```text
@qspecs/core
@qspecs/schema
@qspecs/sql
@qspecs/postgres
@qspecs/transforms
@qspecs/charts
@qspecs/react
@qspecs/recharts
@qspecs/cli
```

---

# 117. Architectural Acceptance Criteria

The architecture should be considered successful if all of the following are true.

### Extensibility

A third party can add ClickHouse support without changing `@qspecs/core`.

### Presentation Independence

A third party can implement ECharts rendering without changing the Chart specification.

### Framework Independence

A server application can execute QSpec without installing React.

### Data Source Independence

Chart definitions do not know whether their data originated from PostgreSQL, OpenSearch, or Prometheus.

### Query Language Independence

The runtime can add PromQL without modifying the execution core.

### Serialization

A QSpec manifest can be safely serialized to JSON and stored in Git.

### Validation

Invalid resources can be rejected before query execution whenever statically possible.

### Developer Experience

A basic QSpec application requires only a few lines of runtime setup.

### TypeScript Experience

Official packages provide strong autocomplete and useful compile-time errors.

### Ecosystem Growth

New functionality can primarily be implemented as npm packages rather than patches to core.

---

# 118. Final Architecture Principle

QSpec should follow one central rule throughout its development:

> **The specification describes intent. Plugins provide capabilities. The runtime connects the two.**

Therefore:

```text
QSpec Specification
       │
       │ describes
       ▼
      Intent
       │
       │ resolved by
       ▼
   QSpec Runtime
       │
       │ extended by
       ▼
     Plugins
       │
       ├── Query Languages
       ├── Data Sources
       ├── Transforms
       ├── Presentations
       └── Renderers
```

This separation is the foundation that should allow QSpec to grow from a small parameterized-query library into a general declarative data-query and presentation ecosystem without turning `@qspecs/core` into a monolithic framework.
