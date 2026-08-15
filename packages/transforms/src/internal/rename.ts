import type { Dataset, Field, QSpecIssue, Transform } from "@qspecs/core";
import { issue, unknownFieldIssue } from "./issues.js";
import { emptyRow, setCell } from "./rows.js";

export interface RenameSpec {
  /** `{ oldName: newName }`. Unlisted fields are left alone. */
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Original order preserved: a rename is not a reorder. A field keeps the slot
 * it started in — only its name changes.
 */
function renamed(
  fields: readonly Field[],
  mapping: Readonly<Record<string, string>>,
): readonly Field[] {
  return fields.map((field) => {
    // Object.hasOwn is load-bearing, not ceremony: a field legitimately named
    // `constructor` or `toString` reads a FUNCTION off Object.prototype through
    // bare bracket access, so `mapping[name] ?? name` would treat an unrenamed
    // field as renamed and set its name to a function. Binding after the
    // hasOwn check also avoids casting away the `undefined` that
    // noUncheckedIndexedAccess correctly surfaces.
    const target = Object.hasOwn(mapping, field.name) ? mapping[field.name] : undefined;
    return target === undefined ? field : { ...field, name: target };
  });
}

/**
 * `validate` catches every collision it CAN, but it only sees the schema when
 * the upstream stage projected one. If any earlier transform omits `describe()`,
 * `validate` is handed `fields === undefined` and cannot know that renaming `a`
 * to `b` lands on a `b` that already exists — the resulting dataset then carried
 * `fields: ["b", "b"]` alongside single-key rows, breaking the Transform
 * contract's "row keys match the returned fields exactly" and silently dropping
 * a column.
 *
 * Execute is the only place with both the spec and the real schema, so the
 * check has to land here too. A plain `Error` is thrown rather than a
 * `QSpecError`: core's transform boundary wraps it as a `TransformError`
 * naming the transform and its index, whereas a QSpecError passes through with
 * whatever path this file invents and loses that location.
 */
function assertDistinct(fields: readonly Field[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new Error(
        `\`rename\` would produce two fields named "${field.name}". ` +
          "Rename the colliding field as well, or drop it with `select`.",
      );
    }
    seen.add(field.name);
  }
}

export const renameTransform: Transform<RenameSpec> = {
  execute(dataset: Dataset, spec: RenameSpec): Dataset {
    const fields = renamed(dataset.fields, spec.fields);
    assertDistinct(fields);
    const rows = dataset.rows.map((row) => {
      const next = emptyRow();
      for (const field of dataset.fields) {
        // Same hazard as renamed(): bare bracket access on a field named
        // `constructor` returns Object.prototype.constructor, not undefined.
        const mapped = Object.hasOwn(spec.fields, field.name) ? spec.fields[field.name] : undefined;
        setCell(next, mapped ?? field.name, row[field.name]);
      }
      return next;
    });
    return { ...dataset, fields, rows };
  },

  describe(fields: readonly Field[], spec: RenameSpec): readonly Field[] {
    return renamed(fields, spec.fields);
  },

  validate(spec: RenameSpec, fields: readonly Field[] | undefined): readonly QSpecIssue[] {
    if (spec?.fields === null || typeof spec?.fields !== "object" || Array.isArray(spec.fields)) {
      return [
        issue("`rename.fields` must be an object mapping old names to new names.", ["fields"]),
      ];
    }

    const issues: QSpecIssue[] = [];
    const entries = Object.entries(spec.fields);

    for (const [from, to] of entries) {
      if (typeof to !== "string" || to === "") {
        issues.push(
          issue(`Rename target for "${from}" must be a non-empty string.`, ["fields", from]),
        );
      }
    }

    const targets = new Map<string, string>();
    for (const [from, to] of entries) {
      const existing = targets.get(to);
      if (existing !== undefined) {
        issues.push(issue(`"${existing}" and "${from}" both rename to "${to}".`, ["fields", from]));
      }
      targets.set(to, from);
    }

    if (fields !== undefined) {
      const known = fields.map((field) => field.name);
      const knownSet = new Set(known);
      const renamedAway = new Set(entries.map(([from]) => from));

      for (const [from, to] of entries) {
        if (!knownSet.has(from)) {
          issues.push(unknownFieldIssue(from, known, ["fields", from]));
        }
        // Colliding with a field that is itself being renamed away is fine.
        if (knownSet.has(to) && !renamedAway.has(to)) {
          issues.push(
            issue(`Renaming "${from}" to "${to}" would collide with an existing field.`, [
              "fields",
              from,
            ]),
          );
        }
      }
    }

    return issues;
  },
};
