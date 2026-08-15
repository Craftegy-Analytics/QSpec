import { describe, expect, it } from "vitest";
import { scanSql } from "./scan.js";

// Named so each test reads clearly, and gathered below into a module-level
// corpus for the invariant tests. Defined as constants (not appended as a
// side effect of running tests) so the corpus exists independently of test
// execution order — it must not shrink under `-t` filtering, `.only`, or
// shuffled test order.
const SINGLE_PARAMETER = "SELECT * FROM t WHERE a = :from";
const TWO_PARAMETERS = "SELECT * FROM t WHERE a = :from AND b = :to";
const PARAMETER_AT_START = ":from = a";
const PARAMETER_AT_END = "a = :from";
const ADJACENT_PARAMETERS = ":a:b";
const PARAMETER_WITH_DIGITS_AND_UNDERSCORE = "SELECT * FROM t WHERE a = :from_1";
const COLON_DIGIT_IS_NOT_A_PARAMETER = "SELECT * FROM t WHERE a = :1abc";
const REPEATED_PARAMETER = "WHERE a = :from OR b = :from";
const PARAMETER_IN_SINGLE_QUOTED_STRING = "WHERE s = ':from'";
const ESCAPED_QUOTE_IN_SINGLE_QUOTED_STRING = "':from '' :to'";
const PARAMETER_IN_DOUBLE_QUOTED_IDENTIFIER = 'SELECT "a:b" FROM t';
const PARAMETER_IN_LINE_COMMENT = "-- :from";
const LINE_COMMENT_THEN_REAL_PARAMETER = "SELECT 1 -- :from\nWHERE x = :real";
const PARAMETER_IN_BLOCK_COMMENT = "/* :from */";
const NESTED_BLOCK_COMMENT_TRAILING_PARAMETER =
  "/* outer /* :from */ still comment */ WHERE x = :real";
const NESTED_BLOCK_COMMENT_LEAKED_PARAMETER =
  "/* outer /* :inner */ still :leak comment */ WHERE x = :real";
const PARAMETER_IN_DOLLAR_QUOTE = "$$ :from $$";
const PARAMETER_IN_TAGGED_DOLLAR_QUOTE = "$tag$ :from $tag$";
const MISMATCHED_DOLLAR_QUOTE_TAG = "$a$ :from $b$ more $a$";
const CAST_OPERATOR = "SELECT created_at::date FROM t";
const CAST_OPERATOR_NEXT_TO_PARAMETER = "WHERE created_at::date = :from::date";
const BARE_COLON_IS_NOT_A_PARAMETER = "SELECT a : b";
const UNTERMINATED_SINGLE_QUOTE = "WHERE s = ':from";
const UNTERMINATED_BLOCK_COMMENT = "/* :from";
const UNTERMINATED_DOLLAR_QUOTE = "$$ :from";
const ESCAPE_STRING_BACKSLASH_ESCAPES_QUOTE = "SELECT E'a\\':from'";
const ESCAPE_STRING_ESCAPED_BACKSLASH_THEN_PARAMETER = "SELECT E'a\\\\' WHERE x = :real";
const LOWERCASE_ESCAPE_STRING = "SELECT e'a\\':from'";
const IDENTIFIER_ENDING_IN_E_THEN_STRING = "SELECT nowE'a\\':from'";
const UNICODE_ESCAPE_STRING_DOUBLED_QUOTE = "U&'a'':from'";
const UNICODE_ESCAPE_STRING_BACKSLASH_QUOTE = "U&'a\\':from'";
const POSITIONAL_PLACEHOLDER_IN_SQL = "SELECT * FROM t WHERE a = $1 AND b = :x";
const SECOND_POSITIONAL_PLACEHOLDER_IS_MULTI_DIGIT = "SELECT $12, $3 FROM t";
const POSITIONAL_PLACEHOLDER_IN_SINGLE_QUOTED_STRING = "SELECT '$1' AS s WHERE b = :x";
const POSITIONAL_PLACEHOLDER_IN_LINE_COMMENT = "SELECT 1 -- $1\nWHERE b = :x";
const POSITIONAL_PLACEHOLDER_IN_BLOCK_COMMENT = "/* $1 */ WHERE b = :x";
const POSITIONAL_PLACEHOLDER_IN_DOLLAR_QUOTE = "SELECT $$ $1 $$ WHERE b = :x";
const DOLLAR_NOT_FOLLOWED_BY_A_DIGIT = "SELECT a $ b WHERE c = :x";

/** Every statement exercised anywhere in this file. */
const STATEMENTS: readonly string[] = [
  SINGLE_PARAMETER,
  TWO_PARAMETERS,
  PARAMETER_AT_START,
  PARAMETER_AT_END,
  ADJACENT_PARAMETERS,
  PARAMETER_WITH_DIGITS_AND_UNDERSCORE,
  COLON_DIGIT_IS_NOT_A_PARAMETER,
  REPEATED_PARAMETER,
  PARAMETER_IN_SINGLE_QUOTED_STRING,
  ESCAPED_QUOTE_IN_SINGLE_QUOTED_STRING,
  PARAMETER_IN_DOUBLE_QUOTED_IDENTIFIER,
  PARAMETER_IN_LINE_COMMENT,
  LINE_COMMENT_THEN_REAL_PARAMETER,
  PARAMETER_IN_BLOCK_COMMENT,
  NESTED_BLOCK_COMMENT_TRAILING_PARAMETER,
  NESTED_BLOCK_COMMENT_LEAKED_PARAMETER,
  PARAMETER_IN_DOLLAR_QUOTE,
  PARAMETER_IN_TAGGED_DOLLAR_QUOTE,
  MISMATCHED_DOLLAR_QUOTE_TAG,
  CAST_OPERATOR,
  CAST_OPERATOR_NEXT_TO_PARAMETER,
  BARE_COLON_IS_NOT_A_PARAMETER,
  UNTERMINATED_SINGLE_QUOTE,
  UNTERMINATED_BLOCK_COMMENT,
  UNTERMINATED_DOLLAR_QUOTE,
  ESCAPE_STRING_BACKSLASH_ESCAPES_QUOTE,
  ESCAPE_STRING_ESCAPED_BACKSLASH_THEN_PARAMETER,
  LOWERCASE_ESCAPE_STRING,
  IDENTIFIER_ENDING_IN_E_THEN_STRING,
  UNICODE_ESCAPE_STRING_DOUBLED_QUOTE,
  UNICODE_ESCAPE_STRING_BACKSLASH_QUOTE,
  POSITIONAL_PLACEHOLDER_IN_SQL,
  SECOND_POSITIONAL_PLACEHOLDER_IS_MULTI_DIGIT,
  POSITIONAL_PLACEHOLDER_IN_SINGLE_QUOTED_STRING,
  POSITIONAL_PLACEHOLDER_IN_LINE_COMMENT,
  POSITIONAL_PLACEHOLDER_IN_BLOCK_COMMENT,
  POSITIONAL_PLACEHOLDER_IN_DOLLAR_QUOTE,
  DOLLAR_NOT_FOLLOWED_BY_A_DIGIT,
];

describe("scanSql — parameters found correctly", () => {
  it("finds a single parameter and splits the surrounding segments", () => {
    const result = scanSql(SINGLE_PARAMETER);
    expect(result.segments).toEqual(["SELECT * FROM t WHERE a = ", ""]);
    expect(result.parameterNames).toEqual(["from"]);
  });

  it("finds two distinct parameters in order", () => {
    const result = scanSql(TWO_PARAMETERS);
    expect(result.segments).toEqual(["SELECT * FROM t WHERE a = ", " AND b = ", ""]);
    expect(result.parameterNames).toEqual(["from", "to"]);
  });

  it("finds a parameter at the very start of the statement", () => {
    const result = scanSql(PARAMETER_AT_START);
    expect(result.segments).toEqual(["", " = a"]);
    expect(result.parameterNames).toEqual(["from"]);
  });

  it("finds a parameter at the very end of the statement", () => {
    const result = scanSql(PARAMETER_AT_END);
    expect(result.segments).toEqual(["a = ", ""]);
    expect(result.parameterNames).toEqual(["from"]);
  });

  it("pins the behavior of adjacent parameters :a:b", () => {
    const result = scanSql(ADJACENT_PARAMETERS);
    // The colon is not part of the identifier character class, so the first
    // parameter's scan stops before the second colon and the second colon
    // immediately starts a new parameter. Two parameters, three (empty)
    // segments.
    expect(result.segments).toEqual(["", "", ""]);
    expect(result.parameterNames).toEqual(["a", "b"]);
  });

  it("allows digits and underscores in a parameter name after the first character", () => {
    const result = scanSql(PARAMETER_WITH_DIGITS_AND_UNDERSCORE);
    expect(result.segments).toEqual(["SELECT * FROM t WHERE a = ", ""]);
    expect(result.parameterNames).toEqual(["from_1"]);
  });

  it("does not treat a colon followed by a digit as a parameter", () => {
    const result = scanSql(COLON_DIGIT_IS_NOT_A_PARAMETER);
    expect(result.segments).toEqual([COLON_DIGIT_IS_NOT_A_PARAMETER]);
    expect(result.parameterNames).toEqual([]);
  });
});

describe("scanSql — repeated parameters", () => {
  it("does not deduplicate — the same name used twice yields two entries and three segments", () => {
    const result = scanSql(REPEATED_PARAMETER);
    expect(result.parameterNames).toEqual(["from", "from"]);
    expect(result.segments).toEqual(["WHERE a = ", " OR b = ", ""]);
  });
});

describe("scanSql — contexts that must be skipped", () => {
  it("skips a parameter-shaped token inside a single-quoted string", () => {
    const result = scanSql(PARAMETER_IN_SINGLE_QUOTED_STRING);
    expect(result.parameterNames).toEqual([]);
  });

  it("pins the documented behavior of a '' escape inside a single-quoted string", () => {
    // This is a correctness/regression check on the documented behavior, not
    // a guard on the escape-handling branch itself: see the comment on that
    // branch in scan.ts for why no test can distinguish its presence from
    // its absence through scanSql's output.
    const result = scanSql(ESCAPED_QUOTE_IN_SINGLE_QUOTED_STRING);
    expect(result.parameterNames).toEqual([]);
  });

  it("skips a parameter-shaped token inside a double-quoted identifier", () => {
    const result = scanSql(PARAMETER_IN_DOUBLE_QUOTED_IDENTIFIER);
    expect(result.parameterNames).toEqual([]);
  });

  it("skips a parameter-shaped token inside a line comment that runs to end of input", () => {
    const result = scanSql(PARAMETER_IN_LINE_COMMENT);
    expect(result.parameterNames).toEqual([]);
  });

  it("resumes scanning after a line comment ends at a newline", () => {
    const result = scanSql(LINE_COMMENT_THEN_REAL_PARAMETER);
    expect(result.parameterNames).toEqual(["real"]);
  });

  it("skips a parameter-shaped token inside a block comment", () => {
    const result = scanSql(PARAMETER_IN_BLOCK_COMMENT);
    expect(result.parameterNames).toEqual([]);
  });

  it("finds the trailing parameter after a nested block comment", () => {
    // This alone does not distinguish nesting from a naive scanner that
    // stops at the first `*/`: the text between the two closes here has no
    // colon, so both implementations happen to land on the same segments.
    // The next test is the actual nesting guard.
    const result = scanSql(NESTED_BLOCK_COMMENT_TRAILING_PARAMETER);
    expect(result.parameterNames).toEqual(["real"]);
  });

  it("keeps a parameter-shaped token between the inner and outer close inside the comment", () => {
    // Put a parameter-shaped token between the two closes — a non-nesting
    // scanner would already be back in "SQL mode" after the first `*/` and
    // would wrongly capture it as a real parameter.
    const result = scanSql(NESTED_BLOCK_COMMENT_LEAKED_PARAMETER);
    expect(result.parameterNames).toEqual(["real"]);
  });

  it("skips a parameter-shaped token inside a dollar-quoted string", () => {
    const result = scanSql(PARAMETER_IN_DOLLAR_QUOTE);
    expect(result.parameterNames).toEqual([]);
  });

  it("skips a parameter-shaped token inside a tagged dollar quote", () => {
    const result = scanSql(PARAMETER_IN_TAGGED_DOLLAR_QUOTE);
    expect(result.parameterNames).toEqual([]);
  });

  it("does not close a dollar quote on a differently tagged delimiter", () => {
    const result = scanSql(MISMATCHED_DOLLAR_QUOTE_TAG);
    expect(result.parameterNames).toEqual([]);
  });

  it("does not treat the cast operator as a parameter", () => {
    const result = scanSql(CAST_OPERATOR);
    expect(result.parameterNames).toEqual([]);
  });

  it("finds only the real parameter next to a cast operator", () => {
    const result = scanSql(CAST_OPERATOR_NEXT_TO_PARAMETER);
    expect(result.parameterNames).toEqual(["from"]);
  });

  it("does not treat a bare colon not followed by an identifier character as a parameter", () => {
    const result = scanSql(BARE_COLON_IS_NOT_A_PARAMETER);
    expect(result.parameterNames).toEqual([]);
  });
});

describe("scanSql — Postgres escape-string literals", () => {
  it("treats a backslash inside E'...' as escaping the next character, so \\' does not close the string", () => {
    const result = scanSql(ESCAPE_STRING_BACKSLASH_ESCAPES_QUOTE);
    expect(result.parameterNames).toEqual([]);
  });

  it("still closes E'...' on a backslash-escaped backslash, so the following parameter is found", () => {
    const result = scanSql(ESCAPE_STRING_ESCAPED_BACKSLASH_THEN_PARAMETER);
    expect(result.parameterNames).toEqual(["real"]);
  });

  it("recognizes the lowercase e'...' escape-string prefix", () => {
    const result = scanSql(LOWERCASE_ESCAPE_STRING);
    expect(result.parameterNames).toEqual([]);
  });

  it("does not treat an identifier ending in e as the escape-string prefix", () => {
    // "nowE'...'" — the E is the tail of the identifier "nowE", not a prefix
    // introducing an escape string, so this must scan as an ORDINARY
    // single-quoted literal. The ordinary branch has no backslash handling,
    // so it closes early at the escaped-looking quote, and ":from" ends up
    // outside any string and is found as a real parameter. A scanner that
    // wrongly read this as an escape string would report zero parameters
    // instead, exactly like ESCAPE_STRING_BACKSLASH_ESCAPES_QUOTE above —
    // that contrast is what makes this test distinguish the two code paths.
    const result = scanSql(IDENTIFIER_ENDING_IN_E_THEN_STRING);
    expect(result.parameterNames).toEqual(["from"]);
  });

  it("closes U&'...' on ordinary doubled-quote escaping, with no backslash handling", () => {
    const result = scanSql(UNICODE_ESCAPE_STRING_DOUBLED_QUOTE);
    expect(result.parameterNames).toEqual([]);
  });

  it("does NOT treat a backslash inside U&'...' as escaping the closing quote", () => {
    // The regression guard for the branch comment in scan.ts: U&'...' must
    // keep falling through to the ORDINARY quote branch, whose backslash has
    // no special meaning. So `\'` closes the string here, ":from" lands in
    // live SQL, and it is found. Teaching the ordinary branch to treat a
    // backslash as an escape — the exact change the comment warns against —
    // would keep the string open past the quote and yield [] instead.
    //
    // The doubled-quote case above cannot detect that change: it contains no
    // backslash at all, so both implementations agree on it.
    const result = scanSql(UNICODE_ESCAPE_STRING_BACKSLASH_QUOTE);
    expect(result.parameterNames).toEqual(["from"]);
  });
});

describe("scanSql — positional placeholders", () => {
  it("reports a $n in live SQL, and still finds the named parameter beside it", () => {
    // The failure this exists to prevent: an adapter appends its own $1 after
    // the first segment, so the statement reaches Postgres with two $1
    // references and one value — a query that runs and returns wrong rows.
    const result = scanSql(POSITIONAL_PLACEHOLDER_IN_SQL);
    expect(result.positionalPlaceholder).toBe("$1");
    expect(result.parameterNames).toEqual(["x"]);
  });

  it("reports the first placeholder verbatim, digits included, not merely that one exists", () => {
    const result = scanSql(SECOND_POSITIONAL_PLACEHOLDER_IS_MULTI_DIGIT);
    expect(result.positionalPlaceholder).toBe("$12");
  });

  it("does not report a $n inside a single-quoted string", () => {
    const result = scanSql(POSITIONAL_PLACEHOLDER_IN_SINGLE_QUOTED_STRING);
    expect(result.positionalPlaceholder).toBeUndefined();
    // The named parameter after it proves the scanner really did resume in
    // live SQL, rather than swallowing the rest of the statement.
    expect(result.parameterNames).toEqual(["x"]);
  });

  it("does not report a $n inside a line comment", () => {
    const result = scanSql(POSITIONAL_PLACEHOLDER_IN_LINE_COMMENT);
    expect(result.positionalPlaceholder).toBeUndefined();
    expect(result.parameterNames).toEqual(["x"]);
  });

  it("does not report a $n inside a block comment", () => {
    const result = scanSql(POSITIONAL_PLACEHOLDER_IN_BLOCK_COMMENT);
    expect(result.positionalPlaceholder).toBeUndefined();
    expect(result.parameterNames).toEqual(["x"]);
  });

  it("does not report a $n inside a dollar-quoted body", () => {
    const result = scanSql(POSITIONAL_PLACEHOLDER_IN_DOLLAR_QUOTE);
    expect(result.positionalPlaceholder).toBeUndefined();
    expect(result.parameterNames).toEqual(["x"]);
  });

  it("does not report a $ that is neither a dollar quote nor a placeholder", () => {
    const result = scanSql(DOLLAR_NOT_FOLLOWED_BY_A_DIGIT);
    expect(result.positionalPlaceholder).toBeUndefined();
    expect(result.parameterNames).toEqual(["x"]);
  });

  it("reports undefined for every other statement in the corpus", () => {
    // Guards the other direction: a check that over-reports would reject
    // valid manifests, which is the more visible failure but no less wrong.
    const withPlaceholder = new Set([
      POSITIONAL_PLACEHOLDER_IN_SQL,
      SECOND_POSITIONAL_PLACEHOLDER_IS_MULTI_DIGIT,
    ]);
    for (const sql of STATEMENTS) {
      if (withPlaceholder.has(sql)) continue;
      expect(scanSql(sql).positionalPlaceholder, sql).toBeUndefined();
    }
  });
});

describe("scanSql — unterminated constructs", () => {
  it("consumes an unterminated single-quoted string to end of input", () => {
    const result = scanSql(UNTERMINATED_SINGLE_QUOTE);
    expect(result.parameterNames).toEqual([]);
  });

  it("consumes an unterminated block comment to end of input", () => {
    const result = scanSql(UNTERMINATED_BLOCK_COMMENT);
    expect(result.parameterNames).toEqual([]);
  });

  it("consumes an unterminated dollar-quoted string to end of input", () => {
    const result = scanSql(UNTERMINATED_DOLLAR_QUOTE);
    expect(result.parameterNames).toEqual([]);
  });
});

describe("scanSql — structural invariant", () => {
  it("always yields one more segment than parameter, and reassembling segments and parameters reproduces the input, for every statement in the corpus", () => {
    expect(STATEMENTS.length).toBeGreaterThan(0);
    for (const sql of STATEMENTS) {
      const result = scanSql(sql);
      expect(result.segments.length).toBe(result.parameterNames.length + 1);

      // The scanner must not silently drop or alter any text: interleaving
      // segments with `:name` back together has to reproduce the original
      // statement byte for byte. Losing text here means QSpec would run a
      // different query than the manifest describes without ever raising an
      // error — the exact failure this scanner exists to prevent.
      let rebuilt = result.segments[0] ?? "";
      for (const [i, name] of result.parameterNames.entries()) {
        rebuilt += `:${name}${result.segments[i + 1] ?? ""}`;
      }
      expect(rebuilt).toBe(sql);
    }
  });
});
