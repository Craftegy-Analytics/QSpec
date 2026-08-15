import { describe, expect, it } from "vitest";
import { main } from "./bin.js";

function capture() {
  const lines: string[] = [];
  return {
    io: {
      out: (text: string) => lines.push(text),
      err: (text: string) => lines.push(text),
      color: false,
    },
    text: () => lines.join("\n"),
  };
}

describe("main", () => {
  it("rejects `inspect --config` with exit 2 and an explanatory message", async () => {
    // This is the carried gap from Task 3's review: `inspect --config` was
    // previously verified only by hand against the built CLI, because
    // importing bin.ts ran the real CLI against the test runner's own argv
    // as a module-level side effect. The DI refactor (argv/io parameters,
    // plus the import.meta.url entry-point guard) makes this assertion
    // possible without that side effect.
    const { io, text } = capture();

    const code = await main(["inspect", "--config", "examples/qspec.config.js", "x.json"], io);

    expect(code).toBe(2);
    expect(text()).toBe(
      '"--config" is not supported by "inspect" — it only applies to "validate".',
    );
  });

  it("prints the version and exits 0 for --version", async () => {
    const { io, text } = capture();

    const code = await main(["--version"], io);

    expect(code).toBe(0);
    expect(text()).toBe("0.1.0");
  });

  it("prints help and exits 0 for --help", async () => {
    const { io, text } = capture();

    const code = await main(["--help"], io);

    expect(code).toBe(0);
    expect(text()).toContain("qspec - QSpec manifest tooling");
  });

  it("prints help to stderr and exits 2 when no command is given", async () => {
    const { io, text } = capture();

    const code = await main([], io);

    expect(code).toBe(2);
    expect(text()).toContain("qspec - QSpec manifest tooling");
  });

  it("exits 2 with an error for an unknown command", async () => {
    const { io, text } = capture();

    const code = await main(["frobnicate"], io);

    expect(code).toBe(2);
    expect(text()).toContain('Unknown command "frobnicate".');
  });

  it("exits 2 with a diagnostic for an unrecognized flag, instead of throwing", async () => {
    // parseArgs() throws ERR_PARSE_ARGS_UNKNOWN_OPTION for a flag it doesn't
    // know; left uncaught, that escapes main() as a raw Node stack trace and
    // an exit code of 1 (an unhandled-rejection exit, not this CLI's usage-error
    // code of 2). Caught here so `--bogus` gets the same clean diagnostic and
    // exit code as every other usage error.
    const { io, text } = capture();

    const code = await main(["validate", "--bogus", "x.json"], io);

    expect(code).toBe(2);
    expect(text()).toContain("--bogus");
  });
});
