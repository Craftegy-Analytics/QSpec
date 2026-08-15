export interface ScanResult {
  /** Literal SQL between parameters. Always one longer than `parameterNames`. */
  readonly segments: readonly string[];
  /** The parameter name filling each gap, in order. */
  readonly parameterNames: readonly string[];
  /**
   * The first positional placeholder (`$1`, `$2`, …) found in unquoted,
   * uncommented SQL, verbatim — or `undefined` when there was none.
   *
   * Reported rather than acted upon: the scanner is dialect-neutral and a
   * bare `$1` is legal SQL text, so this is not the scanner's error to raise.
   * It is reported because the scanner is the only component that knows which
   * regions of the statement are literal — `validateSqlQuery` and an adapter's
   * renderer both see either the whole string or only the finished segments,
   * and neither can tell a `$1` inside a string from one in live SQL.
   *
   * It matters because an adapter generates its own positional placeholders
   * when it joins `segments`: `@qspecs/postgres` appends `$1…$n`, one per
   * parameter. A `$1` already present in a segment therefore collides with a
   * generated one, and Postgres binds a single value to both references —
   * a wrong query rather than an error. (`$2` in a one-parameter statement
   * fails instead, with pg's opaque "bind message supplies 1 parameters".)
   *
   * Known false positive: Postgres allows `$` after the first character of
   * an unquoted identifier (`a$1`, `t.col$2`), and this scanner does not
   * model unquoted identifiers as a skipped context the way it does strings,
   * comments, and dollar-quoted blocks — so a `$`-digit run inside such an
   * identifier is reported here as if it were a positional placeholder. This
   * is an accepted trade-off: the failure surfaces loudly at `prepare()`
   * rather than silently miscompiling, and the workaround — double-quote the
   * identifier (`"a$1"`) — sits right next to the point of failure.
   */
  readonly positionalPlaceholder: string | undefined;
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
/** `$$` or `$tag$` opening a dollar-quoted string. */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Splits a SQL statement into literal segments and the `:name` parameters
 * between them.
 *
 * Everything inside a string, a quoted identifier, a comment, or a
 * dollar-quoted block is literal, and `::` is the cast operator rather than a parameter. A
 * naive regex over `:name` corrupts all five, and `created_at::date` — read as
 * a parameter called `date` — is the one a real manifest hits first.
 *
 * Unterminated constructs consume to end of input rather than throwing: the
 * database rejects a malformed statement with a far better message than a
 * scanner can, and guessing where the author meant a quote to close would be
 * worse than passing the text through.
 */
export function scanSql(statement: string): ScanResult {
  const segments: string[] = [];
  const parameterNames: string[] = [];
  let positionalPlaceholder: string | undefined;
  let current = "";
  let index = 0;

  const rest = (): string => statement.slice(index);

  while (index < statement.length) {
    const char = statement[index];
    if (char === undefined) break;
    const next = statement[index + 1];

    // Line comment: to end of line, or end of input.
    if (char === "-" && next === "-") {
      const newline = statement.indexOf("\n", index);
      const stop = newline === -1 ? statement.length : newline;
      current += statement.slice(index, stop);
      index = stop;
      continue;
    }

    // Block comment. Postgres nests these, so track depth rather than
    // stopping at the first `*/`.
    if (char === "/" && next === "*") {
      const start = index;
      let depth = 0;
      while (index < statement.length) {
        if (statement[index] === "/" && statement[index + 1] === "*") {
          depth += 1;
          index += 2;
          continue;
        }
        if (statement[index] === "*" && statement[index + 1] === "/") {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
          continue;
        }
        index += 1;
      }
      current += statement.slice(start, index);
      continue;
    }

    // Postgres escape-string literal: E'...' or e'...'. Unlike an ordinary
    // '...' literal, a backslash here escapes the next character — including
    // a quote — so `\'` does NOT end the string the way it would in a plain
    // literal. `''` still ends up being a literal quote too (Postgres allows
    // both spellings inside E'...'). Detected only where a string literal can
    // begin: the E/e must be followed immediately by a quote, and must not be
    // the tail of a longer identifier (`SELECT true` or `nowE'...'` must not
    // misfire), so this checks that whatever precedes the E/e is not itself
    // an identifier character.
    if (
      (char === "E" || char === "e") &&
      next === "'" &&
      !(index > 0 && IDENTIFIER_PART.test(statement[index - 1] ?? ""))
    ) {
      const start = index;
      index += 2; // past `E'`
      while (index < statement.length) {
        const inner = statement[index];
        if (inner === "\\") {
          // Backslash escapes the next character, whatever it is — including
          // a quote that would otherwise close the string. Advancing by two
          // unconditionally is what makes `\\` (an escaped backslash) end up
          // NOT escaping the character after it.
          index += 2;
          continue;
        }
        if (inner === "'") {
          if (statement[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      current += statement.slice(start, index);
      continue;
    }

    // Single-quoted string or double-quoted identifier, and Postgres's
    // Unicode-escape string U&'...'. All three double the quote character to
    // escape it. U&'...' needs no backslash handling here: unlike E'...', its
    // backslash is only the introducer for a \XXXX Unicode escape and never
    // escapes a quote, so treating it like an ordinary '...' literal (falling
    // through to this branch — the `U&` prefix is left as ordinary
    // characters, and scanning resumes at the `'`) is correct as-is.
    //
    // This lookahead is deliberately defensive, not load-bearing: given how
    // this function captures quote content (verbatim, via `slice`, never
    // reinterpreted), removing it does not change `scanSql`'s output for any
    // input. A close-then-reopen on a doubled quote toggles "inside a
    // string" twice with a zero-character gap between the toggles, which is
    // observationally identical to never toggling at all — the two
    // characters are adjacent by definition of the escape, so there is no
    // room for unquoted-SQL processing to occur in between. It stays because
    // that argument is non-obvious and depends entirely on quote content
    // never being decoded or transformed; a future change that decodes `''`
    // into a single quote character (rather than passing it through raw)
    // would make this branch load-bearing without any test noticing its
    // absence otherwise.
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index;
      index += 1;
      while (index < statement.length) {
        if (statement[index] === quote) {
          if (statement[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      current += statement.slice(start, index);
      continue;
    }

    // Dollar-quoted string: closes only on the identical tag.
    if (char === "$") {
      const opening = DOLLAR_TAG.exec(rest());
      if (opening !== null) {
        const tag = opening[0];
        const closing = statement.indexOf(tag, index + tag.length);
        const stop = closing === -1 ? statement.length : closing + tag.length;
        current += statement.slice(index, stop);
        index = stop;
        continue;
      }
      // Not a dollar quote. `$` followed by a digit is a positional
      // placeholder, which reaching this point means is in live SQL: every
      // skipped context above consumed its own body, so a `$1` inside a
      // string, a quoted identifier, a comment, or a dollar-quoted block never
      // gets here. Recorded and passed through — the `$` still falls through to the
      // literal copy below, so segments and the reconstruction property are
      // unchanged. Only the first is kept: one is already fatal, and naming
      // the first one the author can find is more useful than a list.
      if (positionalPlaceholder === undefined && next !== undefined && DIGIT.test(next)) {
        let end = index + 1;
        while (end < statement.length && DIGIT.test(statement[end] ?? "")) end += 1;
        positionalPlaceholder = statement.slice(index, end);
      }
    }

    // Cast operator, not a parameter.
    if (char === ":" && next === ":") {
      current += "::";
      index += 2;
      continue;
    }

    // A parameter reference.
    if (char === ":" && next !== undefined && IDENTIFIER_START.test(next)) {
      let end = index + 1;
      while (end < statement.length) {
        const candidate = statement[end];
        if (candidate === undefined || !IDENTIFIER_PART.test(candidate)) break;
        end += 1;
      }
      segments.push(current);
      current = "";
      parameterNames.push(statement.slice(index + 1, end));
      index = end;
      continue;
    }

    current += char;
    index += 1;
  }

  segments.push(current);
  return { segments, parameterNames, positionalPlaceholder };
}
