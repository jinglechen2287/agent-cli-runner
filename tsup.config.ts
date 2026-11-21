import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep `node:` specifiers: `node:sqlite` exists only under that scheme, and
  // the bare `sqlite` tsup would rewrite it to is not a Node module.
  removeNodeProtocol: false,
});
