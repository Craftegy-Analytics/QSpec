import { defineConfig } from "vitest/config";

export default defineConfig({
  // vitest's default esbuild JSX transform is the classic runtime, which
  // expects a `React` identifier in scope. This package's `.tsx` sources and
  // tests use the automatic runtime (`"jsx": "react-jsx"` in tsconfig, no
  // `import React from "react"` anywhere) — esbuild needs to be told to match,
  // or every JSX expression fails at runtime with "React is not defined"
  // despite typechecking cleanly.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "packages/*/test/**/*.test.ts",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ],
    environment: "node",
  },
});
