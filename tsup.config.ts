import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  dts: false,
  // Make the built CLI directly executable: `arbella` resolves to dist/index.js.
  banner: {
    js: "#!/usr/bin/env node",
  },
});
