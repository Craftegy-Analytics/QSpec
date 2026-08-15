import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../schemas");
const target = resolve(here, "../packages/schema/src/schemas");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Copied JSON Schemas to ${target}`);
