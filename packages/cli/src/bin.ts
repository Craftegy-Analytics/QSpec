#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { supportsColor } from "./color.js";
import { runInspect } from "./commands/inspect.js";
import { runValidate, type CliIo } from "./commands/validate.js";

const HELP = `qspec - QSpec manifest tooling

Usage:
  qspec validate <manifest.json> [...] [--config <path>]
                                                    Validate one or more manifests
  qspec inspect <manifest.json> [...] [--json]     Inspect one or more manifests

Options:
  -h, --help      Show this help
  -v, --version   Show the CLI version
      --json      (inspect) Emit a JSON array, one object per manifest
                  successfully inspected, instead of text. Always an array,
                  even for a single manifest.
      --config <path>
                  (validate) Load plugins from this config module and run
                  prepare() against them, on top of structural validation.
                  Catches what a registry-free validator cannot: an unknown
                  transform operator, an expression nested past
                  maxExpressionDepth, a typo'd SQL binding, and the like.
                  Opt-in — loading a config executes arbitrary code, and
                  omitting this flag runs no plugins and no user code at all.
                  The path is resolved against the current working directory;
                  it is never discovered implicitly.
`;

/**
 * The real stdout/stderr I/O `main()` uses when run as the actual CLI. A test
 * calling `main()` directly supplies its own `CliIo` (a capturing stub) as the
 * second argument instead, the same dependency-injection style the command
 * modules already use for `runValidate`/`runInspect`.
 */
function defaultIo(): CliIo {
  return {
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    color: supportsColor(),
  };
}

/**
 * `argv` defaults to the real process argv and `baseIo` to real stdout/stderr,
 * so calling `main()` with no arguments — what the module-level auto-run below
 * does — behaves exactly as it always has. Both are overridable so a test can
 * pass a synthetic argv and a capturing `CliIo` without touching
 * `process.argv` or real streams.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  baseIo: CliIo = defaultIo(),
): Promise<number> {
  let positionals: readonly string[];
  let values: { help?: boolean; version?: boolean; json?: boolean; config?: string };
  try {
    ({ positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        json: { type: "boolean" },
        config: { type: "string" },
      },
    }));
  } catch (error) {
    baseIo.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const io: CliIo = { ...baseIo, json: values.json === true };

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
      return runValidate(
        rest,
        io,
        values.config === undefined ? {} : { configPath: values.config },
      );
    case "inspect":
      if (values.config !== undefined) {
        io.err('"--config" is not supported by "inspect" — it only applies to "validate".');
        return 2;
      }
      return runInspect(rest, io);
    default:
      io.err(`Unknown command "${command}".\n`);
      io.err(HELP);
      return 2;
  }
}

// Only auto-run against the real process argv when this module is the
// program's entry point. Importing `main` from a test (bin.test.ts) loads
// this module without it being the entry point, so `process.argv[1]` is the
// test runner's own script, the two paths don't match, and this guard skips
// the side effect.
//
// The comparison MUST go through `realpathSync`. `process.argv[1]` is the
// path as the caller wrote it, while `import.meta.url` is always fully
// resolved — so comparing them directly is false whenever any part of the
// invocation path is a symlink. Two cases, and npm creates both:
//
//   - `node_modules/.bin/qspec` is a symlink to this file. That is how every
//     npm install of this package exposes the binary, so the naive
//     comparison made the shipped CLI a silent no-op: it exited 0 having
//     validated nothing, for every user who installed it.
//   - On macOS `/tmp` is itself a symlink to `/private/tmp`, so even a
//     direct `node /tmp/x/bin.js` disagrees.
//
// `realpathSync` throws if the path no longer exists (a script deleted
// mid-run); an entry point we cannot resolve is not one we can confirm is
// this file, so treat it as "not the entry point" rather than crashing.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && isThisModule(entryPoint)) {
  process.exitCode = await main();
}

function isThisModule(entryPoint: string): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(entryPoint)).href;
  } catch {
    return false;
  }
}
