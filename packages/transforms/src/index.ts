import { definePlugin, type QSpecPlugin, type Transform } from "@qspecs/core";
import { createFilterTransform } from "./internal/filter.js";
import { createDeriveTransform } from "./internal/derive.js";
import { limitTransform } from "./internal/limit.js";
import { renameTransform } from "./internal/rename.js";
import { selectTransform } from "./internal/select.js";
import { sortTransform } from "./internal/sort.js";

export type { FilterSpec } from "./internal/filter.js";
export type { SortSpec } from "./internal/sort.js";
export type { LimitSpec } from "./internal/limit.js";
export type { SelectSpec } from "./internal/select.js";
export type { RenameSpec } from "./internal/rename.js";
export type { DeriveSpec } from "./internal/derive.js";

/**
 * Registers the standard transforms. Expression-based transforms are built here
 * rather than at module scope because they need `api.limits.maxExpressionDepth`,
 * which is per-runtime configuration.
 */
export function transforms(): QSpecPlugin {
  return definePlugin({
    name: "@qspecs/transforms",
    setup(api) {
      api.transforms.register(
        "filter",
        createFilterTransform(api.limits.maxExpressionDepth) as Transform,
      );
      api.transforms.register(
        "derive",
        createDeriveTransform(api.limits.maxExpressionDepth) as Transform,
      );
      api.transforms.register("sort", sortTransform as Transform);
      api.transforms.register("limit", limitTransform as Transform);
      api.transforms.register("select", selectTransform as Transform);
      api.transforms.register("rename", renameTransform as Transform);
    },
  });
}
