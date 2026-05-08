import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  target: "node20",
  clean: !options.watch,
  dts: !options.watch,
}));
