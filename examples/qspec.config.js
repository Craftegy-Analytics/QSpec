// Config for `qspec validate --config examples/qspec.config.js`.
//
// Loads the plugins the example manifests exercise — sql() for SQL query
// bindings, transforms() for filter/select/rename/derive/sort/limit, and
// charts() for line/bar/pie presentations — so `qspec validate` runs each
// manifest through prepare() and catches what structural validation alone
// cannot (an unknown transform operator, a typo'd SQL binding, a chart
// series naming a field a transform projected away).
//
// Deliberately does NOT load @qspecs/postgres: `qspec validate`'s
// plugin-aware mode runs manifests against a stub data source (its
// execute() always throws, so it is never actually queried), so no real
// adapter — and no database driver dependency — belongs in this file.
import { sql } from "@qspecs/sql";
import { transforms } from "@qspecs/transforms";
import { charts } from "@qspecs/charts";

export const plugins = [sql(), transforms(), charts()];
