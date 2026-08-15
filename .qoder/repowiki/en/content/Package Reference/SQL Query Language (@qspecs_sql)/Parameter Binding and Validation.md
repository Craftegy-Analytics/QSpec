# Parameter Binding and Validation

<cite>
**Referenced Files in This Document**
- [parameters.md](file://docs/parameters.md)
- [queries.md](file://docs/queries.md)
- [security.md](file://docs/security.md)
- [03-parameterized-query.qspec.json](file://examples/03-parameterized-query.qspec.json)
- [parameter-types.qspec.json](file://fixtures/valid/parameter-types.qspec.json)
- [parameters.ts](file://packages/core/src/internal/validate/parameters.ts)
- [bindings.ts](file://packages/core/src/internal/bindings.ts)
- [compile.ts](file://packages/sql/src/internal/compile.ts)
- [scan.ts](file://packages/sql/src/internal/scan.ts)
</cite>

## Table of Contents

1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)

## Introduction

This document explains how QSpec binds, validates, and executes SQL parameters safely and predictably. It covers:

- Named parameter syntax (:parameterName)
- Parameter type inference and validation rules
- Default value handling and constraint checking
- Simple, complex object, and array parameters
- Security guarantees against SQL injection
- Performance characteristics and best practices for prepared statements

The system separates manifest authoring (declarations), runtime validation (types and constraints), binding resolution (mapping names to values), and SQL compilation (producing a safe, non-interpolated query structure).

## Project Structure

QSpec’s parameter system spans documentation, examples, fixtures, core validation, and SQL-specific compilation:

- Documentation defines the contract and behavior for parameters and queries.
- Examples and fixtures show real manifests using parameters and bindings.
- Core packages validate parameter declarations and runtime inputs, and compile bindings.
- The SQL package scans SQL text, extracts named parameters, and compiles them into a safe structure that never embeds user data into SQL text.

```mermaid
graph TB
A["Manifest<br/>spec.parameters"] --> B["Compile Parameters<br/>validate/parameters.ts"]
B --> C["Validate Runtime Inputs<br/>validateParameters()"]
C --> D["Bindings Declaration<br/>query.bindings"]
D --> E["Compile Bindings<br/>bindings.ts"]
E --> F["Resolve Bindings<br/>resolveBindings()"]
F --> G["SQL Compile<br/>compile.ts + scan.ts"]
G --> H["CompiledSqlQuery<br/>segments + values"]
```

**Diagram sources**

- [parameters.ts:53-108](file://packages/core/src/internal/validate/parameters.ts#L53-L108)
- [parameters.ts:278-331](file://packages/core/src/internal/validate/parameters.ts#L278-L331)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [bindings.ts:112-128](file://packages/core/src/internal/bindings.ts#L112-L128)
- [compile.ts:65-90](file://packages/sql/src/internal/compile.ts#L65-L90)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)

**Section sources**

- [parameters.md:1-194](file://docs/parameters.md#L1-L194)
- [queries.md:1-167](file://docs/queries.md#L1-L167)
- [security.md:34-62](file://docs/security.md#L34-L62)

## Core Components

- Parameter declaration and validation:
  - Declared types are enforced at compile time and runtime.
  - Defaults are validated at manifest compile time.
  - Constraints like min/max/minLength/maxLength are applied after coercion.
- Binding model:
  - Bindings map statement placeholders to either a declared parameter or a literal JSON value.
  - String shorthand must match a strict pattern; otherwise it is rejected early.
- SQL compilation:
  - The scanner parses SQL to extract :name parameters while ignoring strings, comments, casts, and dollar-quoted blocks.
  - Compilation produces segments and values without ever embedding values into SQL text.

Key behaviors:

- Required, optional, and default semantics determine whether a resolved parameter is present or absent.
- Unknown caller-supplied parameters are reported as errors.
- Every validation problem is collected before throwing to provide complete feedback.

**Section sources**

- [parameters.ts:10-33](file://packages/core/src/internal/validate/parameters.ts#L10-L33)
- [parameters.ts:53-108](file://packages/core/src/internal/validate/parameters.ts#L53-L108)
- [parameters.ts:120-169](file://packages/core/src/internal/validate/parameters.ts#L120-L169)
- [parameters.ts:171-209](file://packages/core/src/internal/validate/parameters.ts#L171-L209)
- [parameters.ts:211-256](file://packages/core/src/internal/validate/parameters.ts#L211-L256)
- [parameters.ts:278-331](file://packages/core/src/internal/validate/parameters.ts#L278-L331)
- [bindings.ts:7-12](file://packages/core/src/internal/bindings.ts#L7-L12)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [bindings.ts:112-128](file://packages/core/src/internal/bindings.ts#L112-L128)
- [compile.ts:27-36](file://packages/sql/src/internal/compile.ts#L27-L36)
- [compile.ts:65-90](file://packages/sql/src/internal/compile.ts#L65-L90)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)

## Architecture Overview

End-to-end flow from manifest to execution-safe SQL:

```mermaid
sequenceDiagram
participant Caller as "Caller"
participant Core as "Core Validator"
participant Bind as "Binding Compiler"
participant SQL as "SQL Compiler"
participant Adapter as "Data Source Adapter"
Caller->>Core : Provide manifest with spec.parameters
Core->>Core : compileParameters()
Core-->>Caller : CompiledParameters
Caller->>Core : Execute with input parameters
Core->>Core : validateParameters(input)
Core-->>Bind : Resolved parameters
Caller->>Bind : Manifest query.bindings
Bind->>Bind : compileBindings()
Bind->>Bind : resolveBindings(resolved params)
Bind-->>SQL : Binding values per placeholder name
SQL->>SQL : scanSql(statement)
SQL->>SQL : compileSql(bindings)
SQL-->>Adapter : CompiledSqlQuery { segments, parameterNames, values }
Adapter-->>Caller : Rows (no interpolated values)
```

**Diagram sources**

- [parameters.ts:53-108](file://packages/core/src/internal/validate/parameters.ts#L53-L108)
- [parameters.ts:278-331](file://packages/core/src/internal/validate/parameters.ts#L278-L331)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [bindings.ts:112-128](file://packages/core/src/internal/bindings.ts#L112-L128)
- [compile.ts:65-90](file://packages/sql/src/internal/compile.ts#L65-L90)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)

## Detailed Component Analysis

### Named Parameter Syntax and Scanning

- Placeholders use the :name form inside SQL statements.
- The scanner recognizes identifiers after : and ignores : inside strings, comments, cast operators (::), and dollar-quoted blocks.
- Positional placeholders ($1, $2, …) in raw SQL are detected and warned about because adapters generate their own positional placeholders during rendering.

```mermaid
flowchart TD
Start(["Scan SQL"]) --> Context{"Inside string/comment/dollar-quote?"}
Context --> |Yes| Skip["Skip content verbatim"]
Context --> |No| Cast{"Is '::'?"}
Cast --> |Yes| AppendCast["Append '::' to current segment"]
Cast --> |No| Param{"':' followed by identifier start?"}
Param --> |Yes| Extract["Extract :name and push segment gap"]
Param --> |No| Literal["Append character to current segment"]
Skip --> Next["Advance index"]
AppendCast --> Next
Extract --> Next
Literal --> Next
Next --> End{"End of input?"}
End --> |No| Context
End --> |Yes| Finish(["Return segments + parameterNames"])
```

**Diagram sources**

- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)

**Section sources**

- [scan.ts:1-34](file://packages/sql/src/internal/scan.ts#L1-L34)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)
- [compile.ts:92-151](file://packages/sql/src/internal/compile.ts#L92-L151)

### Parameter Type Inference and Validation

- Declared types include string, number, integer, boolean, date, datetime, enum, and array.
- Date validation ensures YYYY-MM-DD represents a real calendar day; datetime uses ISO 8601 patterns plus real-date checks.
- Enum requires an explicit non-empty values list and performs strict equality checks.
- Array parameters validate each element against items.type and apply minLength/maxLength to the array itself.
- Constraints (min/max for numbers; minLength/maxLength for strings and arrays) run after coercion.

```mermaid
flowchart TD
S(["Input value"]) --> T{"Type branch"}
T --> |enum| E["Strictly equals one of values?"]
E --> |No| ErrE["Report invalid enum"]
E --> |Yes| V["Return value"]
T --> |array| A["Array?"]
A --> |No| ErrA["Report not array"]
A --> |Yes| Each["Check each item via checkScalar(items.type)"]
Each --> Len["Apply minLength/maxLength on array length"]
Len --> V
T --> |scalar| SC["checkScalar(type)"]
SC --> C["applyScalarConstraints()"]
C --> V
ErrE --> End(["Issues collected"])
ErrA --> End
```

**Diagram sources**

- [parameters.ts:120-169](file://packages/core/src/internal/validate/parameters.ts#L120-L169)
- [parameters.ts:171-209](file://packages/core/src/internal/validate/parameters.ts#L171-L209)
- [parameters.ts:211-256](file://packages/core/src/internal/validate/parameters.ts#L211-L256)

**Section sources**

- [parameters.ts:10-33](file://packages/core/src/internal/validate/parameters.ts#L10-L33)
- [parameters.ts:120-169](file://packages/core/src/internal/validate/parameters.ts#L120-L169)
- [parameters.ts:171-209](file://packages/core/src/internal/validate/parameters.ts#L171-L209)
- [parameters.ts:211-256](file://packages/core/src/internal/validate/parameters.ts#L211-L256)
- [parameters.md:25-49](file://docs/parameters.md#L25-L49)
- [parameters.md:76-115](file://docs/parameters.md#L76-L115)

### Default Value Handling and Required Semantics

- If a parameter is not supplied and has a default, the default is used.
- If not supplied, no default, and required is true, validation fails.
- If not supplied, no default, and not required, the parameter is absent from the resolved map.
- Passing null or undefined counts as “not supplied.”
- Defaults are validated at manifest compile time using the same coercion logic as runtime values.

```mermaid
flowchart TD
Start(["For each declared parameter"]) --> Supplied{"Supplied and not null/undefined?"}
Supplied --> |No| HasDefault{"Has default?"}
HasDefault --> |Yes| UseDefault["Use default"]
HasDefault --> |No| Required{"required === true?"}
Required --> |Yes| Fail["Record required error"]
Required --> |No| Absent["Parameter absent from resolved map"]
Supplied --> |Yes| Coerce["Coerce and validate"]
Coerce --> Valid{"Valid?"}
Valid --> |No| Record["Record validation issues"]
Valid --> |Yes| Set["Set resolved value"]
UseDefault --> Next["Next parameter"]
Absent --> Next
Fail --> Next
Record --> Next
```

**Diagram sources**

- [parameters.ts:278-331](file://packages/core/src/internal/validate/parameters.ts#L278-L331)
- [parameters.ts:258-272](file://packages/core/src/internal/validate/parameters.ts#L258-L272)

**Section sources**

- [parameters.md:50-74](file://docs/parameters.md#L50-L74)
- [parameters.md:116-125](file://docs/parameters.md#L116-L125)
- [parameters.ts:278-331](file://packages/core/src/internal/validate/parameters.ts#L278-L331)

### Binding Model and Resolution

- Bindings map statement placeholders to either:
  - A declared parameter reference (string shorthand "$parameters.<name>" or object form { parameter: "<name>" })
  - A literal JSON value ({ literal: <value> })
- Bare strings that do not match the parameter reference pattern are rejected as manifest errors.
- At runtime, resolveBindings maps each binding to a value; if a referenced parameter is absent, the binding resolves to null.

```mermaid
classDiagram
class CompiledBinding {
+string name
+string kind
+string parameter
+JsonValue value
}
class BindingModel {
+stringShorthand
+objectParameter
+objectLiteral
}
CompiledBinding <|.. BindingModel : "compiled forms"
```

**Diagram sources**

- [bindings.ts:7-12](file://packages/core/src/internal/bindings.ts#L7-L12)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [bindings.ts:112-128](file://packages/core/src/internal/bindings.ts#L112-L128)
- [queries.md:43-135](file://docs/queries.md#L43-L135)

**Section sources**

- [queries.md:43-135](file://docs/queries.md#L43-L135)
- [bindings.ts:7-12](file://packages/core/src/internal/bindings.ts#L7-L12)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [bindings.ts:112-128](file://packages/core/src/internal/bindings.ts#L112-L128)

### SQL Compilation and Safety

- The SQL compiler scans the statement to extract :name placeholders and builds a CompiledSqlQuery with:
  - segments: literal SQL between parameters
  - parameterNames: placeholder names in order
  - values: resolved values in the same order
- There is no text field containing interpolated values; this makes SQL injection structurally impossible at this layer.
- Adapters render final SQL using native parameterization (e.g., $1/$2) with a separate values array.

```mermaid
sequenceDiagram
participant Q as "Query Definition"
participant S as "Scanner"
participant C as "Compiler"
participant R as "Renderer"
Q->>S : statement
S-->>C : segments, parameterNames
C->>C : collect values from bindings in statement order
C-->>R : CompiledSqlQuery { segments, parameterNames, values }
R-->>R : Render with native placeholders + values array
```

**Diagram sources**

- [compile.ts:27-36](file://packages/sql/src/internal/compile.ts#L27-L36)
- [compile.ts:65-90](file://packages/sql/src/internal/compile.ts#L65-L90)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)
- [security.md:34-62](file://docs/security.md#L34-L62)

**Section sources**

- [compile.ts:65-90](file://packages/sql/src/internal/compile.ts#L65-L90)
- [compile.ts:92-151](file://packages/sql/src/internal/compile.ts#L92-L151)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)
- [security.md:34-62](file://docs/security.md#L34-L62)

### Examples of Parameter Usage

- Simple scalar parameters: string, number, integer, boolean, date, datetime, enum.
- Complex object parameters: bind literals or parameters through the binding model.
- Array parameters: validate each element and enforce array-level constraints.

References:

- Example manifest demonstrating multiple parameter types and bindings.
- Fixture manifest enumerating all supported parameter types.

**Section sources**

- [03-parameterized-query.qspec.json:9-43](file://examples/03-parameterized-query.qspec.json#L9-L43)
- [parameter-types.qspec.json:5-15](file://fixtures/valid/parameter-types.qspec.json#L5-L15)
- [queries.md:150-155](file://docs/queries.md#L150-L155)

## Dependency Analysis

The parameter pipeline composes several modules with clear responsibilities:

```mermaid
graph LR
P["parameters.ts<br/>compileParameters / validateParameters"] --> B["bindings.ts<br/>compileBindings / resolveBindings"]
B --> QD["queries.md<br/>binding model rules"]
P --> QD
B --> SC["scan.ts<br/>scanSql()"]
SC --> CO["compile.ts<br/>compileSql()"]
CO --> SEC["security.md<br/>no interpolation guarantee"]
```

**Diagram sources**

- [parameters.ts:53-108](file://packages/core/src/internal/validate/parameters.ts#L53-L108)
- [parameters.ts:278-331](file://packages/core/src/internal/validate/parameters.ts#L278-L331)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [bindings.ts:112-128](file://packages/core/src/internal/bindings.ts#L112-L128)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)
- [compile.ts:65-90](file://packages/sql/src/internal/compile.ts#L65-L90)
- [security.md:34-62](file://docs/security.md#L34-L62)

**Section sources**

- [parameters.ts:53-108](file://packages/core/src/internal/validate/parameters.ts#L53-L108)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [compile.ts:65-90](file://packages/sql/src/internal/compile.ts#L65-L90)
- [scan.ts:56-236](file://packages/sql/src/internal/scan.ts#L56-L236)
- [security.md:34-62](file://docs/security.md#L34-L62)

## Performance Considerations

- Prepared statements and reuse:
  - The compiled representation separates literal SQL segments from values, enabling adapters to reuse prepared statements across executions with different values.
  - Repeated placeholders produce repeated values, preserving correct ordering even when the same parameter appears multiple times.
- Efficiency of scanning:
  - The scanner processes the statement once, skipping quoted strings, comments, and dollar-quoted blocks, minimizing false positives and overhead.
- Best practices:
  - Prefer reusing the same manifest and prepared statement for multiple executions with different parameters.
  - Keep parameter sets stable to maximize plan reuse in the database driver where applicable.
  - Avoid unnecessary large arrays; validate lengths early to reduce payload size.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide

Common issues and how they are surfaced:

- Unknown parameter in caller input:
  - Reported with the list of declared parameters to help fix typos.
- Undeclared parameter reference in bindings:
  - Detected during binding compilation with suggestions based on declared names.
- Missing binding for a :name placeholder:
  - During SQL compilation, a missing binding throws a clear error listing available bindings.
- Unused binding declared but not referenced:
  - Static validation reports bindings that are declared but never referenced by the statement.
- Invalid parameter values:
  - Type mismatches, out-of-range numbers, invalid dates/datetimes, wrong enum values, and array element violations are collected and reported together.

**Section sources**

- [parameters.ts:278-331](file://packages/core/src/internal/validate/parameters.ts#L278-L331)
- [bindings.ts:32-108](file://packages/core/src/internal/bindings.ts#L32-L108)
- [compile.ts:72-90](file://packages/sql/src/internal/compile.ts#L72-L90)
- [compile.ts:100-151](file://packages/sql/src/internal/compile.ts#L100-L151)

## Conclusion

QSpec’s parameter system enforces strong typing, comprehensive validation, and safe SQL execution:

- Named parameters (:name) are parsed precisely and bound only through validated values.
- Defaults and constraints are checked early, providing fast feedback.
- The binding model prevents accidental interpolation and supports both simple and complex inputs.
- SQL compilation produces a structure that cannot be misused to inject values into SQL text, ensuring safety by design.
- Performance benefits come from separating static SQL segments from dynamic values, enabling prepared statement reuse and efficient execution.

[No sources needed since this section summarizes without analyzing specific files]
