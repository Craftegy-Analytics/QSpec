# Specification Versioning

`apiVersion` is a required field on every manifest (SPEC.md §23) and is independent of any npm
package's own version number (SPEC.md §77) — a future `@qspecs/core@2.4.0` could, in principle,
still accept `qspec.dev/v1` manifests, or accept both `qspec.dev/v1` and `qspec.dev/v2` at once.
This document covers what `apiVersion` actually is today, how a runtime declares which versions it
accepts, and the compatibility rules SPEC.md §77–79 lay out for the versions this repository has
not yet had to face.

## `apiVersion` and `SUPPORTED_API_VERSIONS`

```ts
export const QSPEC_V1 = "qspec.dev/v1";
export const SUPPORTED_API_VERSIONS: readonly string[] = [QSPEC_V1];
```

(`packages/core/src/version.ts`, both re-exported from `@qspecs/core`'s entry point.)
`SUPPORTED_API_VERSIONS` is, as of this writing, a single-element array — `qspec.dev/v1` is the
only specification version this runtime implements. Structural manifest validation
(`packages/core/src/internal/validate/manifest.ts`) checks `apiVersion` against exactly this list:

```ts
if (typeof apiVersion !== "string" || apiVersion === "") {
  collector.add("`apiVersion` is required and must be a string.", ["apiVersion"]);
} else if (!SUPPORTED_API_VERSIONS.includes(apiVersion)) {
  collector.add(
    `Unsupported apiVersion "${apiVersion}". This runtime supports: ${SUPPORTED_API_VERSIONS.join(", ")}.`,
    ["apiVersion"],
    { code: "QSPEC_API_VERSION_UNSUPPORTED" },
  );
}
```

Verified directly against the CLI: a manifest declaring `"apiVersion": "qspec.dev/v2"` fails
`qspec validate` — with no `--config`, before any plugin or database is involved — with:

```text
✗ Invalid QSpec manifest

apiVersion:
  Unsupported apiVersion "qspec.dev/v2". This runtime supports: qspec.dev/v1.
```

An unrecognized `apiVersion` is a manifest-shape failure, reported as one issue inside a
`ManifestValidationError` (`QSPEC_MANIFEST_INVALID`), not a distinct thrown error class. SPEC.md
§70 names `UnsupportedApiVersionError` in its list of standard errors, and `@qspecs/core` does
export a class by that name (`packages/core/src/errors.ts`, code `QSPEC_API_VERSION_UNSUPPORTED`)
— but nothing in this repository's application code ever constructs one outside a generic
error-class test (`packages/core/src/errors.test.ts`). `docs/known-gaps.md` records this
explicitly: the condition is emitted as an issue inside `ManifestValidationError`, so no caller can
actually `catch` an `UnsupportedApiVersionError` instance from `prepare()` or `qspec validate`
today, even though the class exists and its exported `code` string is the one that appears on the
issue.

## What `apiVersion` is not

`apiVersion` names a **specification** version — the shape and semantics a manifest document
promises to follow — never an npm package version. This repository's own packages currently make
that distinction easy to lose sight of, because every workspace package is at `0.1.0`
simultaneously and every non-`@qspecs/core` package's `peerDependencies` entry pins an **exact**
version rather than a semver range — `"@qspecs/core": "0.1.0"`, not `"^0.1.0"` or `"^1.0.0"`. That
is consistent with 0.x semver conventions, where any release may be breaking and a caret range
would promise more compatibility than pre-1.0 development can back up; it is also narrower than
SPEC.md §79's own example (a caret range against a 1.x baseline), which describes the intended
shape once this repository has a stable `@qspecs/core@1.0.0` to range against, not the shape it
ships in today. Nothing about the exact pin is a version-compatibility mechanism in the SPEC.md
§77 sense — it constrains which npm package versions install together, not which `apiVersion`
values a given runtime accepts, and every package here still accepts exactly the one `apiVersion`
`SUPPORTED_API_VERSIONS` names regardless of which npm versions are installed.

## Backward compatibility (SPEC.md §78)

SPEC.md §78 requires that a published specification version never change in a breaking way once
released — a breaking change requires a new `apiVersion` (`qspec.dev/v1` → `qspec.dev/v2`), not a
silent reinterpretation of `v1`. This repository has shipped only `qspec.dev/v1` so far, so no
migration path or `qspec migrate` command (SPEC.md §78's own sketched future example) exists yet;
`SUPPORTED_API_VERSIONS` being a plain array rather than a single constant is what leaves room for
a future runtime to accept two versions at once during a migration window, without a caller having
to upgrade every manifest atomically the moment `v2` ships.

## Plugin version compatibility (SPEC.md §79)

SPEC.md §79 recommends a plugin declare which `@qspecs/core` versions it is compatible with through
its own package's `peerDependencies` — the ordinary npm mechanism, not a QSpec-specific one — and
notes a plugin "may additionally expose capability/version metadata" where necessary. `QSpecPlugin`
does carry an optional `version` field (`packages/core/src/types/plugin.ts`), but, as
[Plugins](plugins.md#the-qspecplugin-shape) notes, nothing in this runtime reads it: it is not
compared against a compatible-range declaration anywhere, and no `use()` or `ready()` call rejects
a plugin on the basis of its `version` string. Compatibility, as this repository actually enforces
it, is entirely the `peerDependencies` field on each package's `package.json` — every shipped
non-core package (`@qspecs/sql`, `@qspecs/transforms`, `@qspecs/charts`, `@qspecs/postgres`,
`@qspecs/http`, `@qspecs/react`, `@qspecs/recharts`, `@qspecs/testing`) declares `@qspecs/core` there,
checked by npm at install time, not by anything QSpec's own runtime does at `.use()` time.

## See also

- [`docs/manifest-specification.md`](manifest-specification.md#apiversion) — `apiVersion`'s place
  in a manifest's top-level shape, alongside `kind`, `metadata`, and `spec`.
- [`docs/plugins.md`](plugins.md) — `QSpecPlugin`'s shape, including the unread `version` field,
  and how `.use()`/`ready()` install plugins regardless of any version metadata.
- [`docs/known-gaps.md`](known-gaps.md) — `UnsupportedApiVersionError`'s dead-export status, and
  the rest of this repository's recorded, deliberate gaps.
- [`README.md`'s package table](../README.md#packages) — every shipped package's current version
  and runtime/peer dependencies.
