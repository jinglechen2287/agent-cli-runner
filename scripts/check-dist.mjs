// Fails the build when the bundle lost a `node:` specifier that only exists
// under that scheme: agy's step-log reader imports `node:sqlite` lazily.
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
if (!bundle.includes('import("node:sqlite")')) {
  console.error('dist/index.js no longer contains import("node:sqlite"): check tsup\'s removeNodeProtocol.');
  process.exit(1);
}
