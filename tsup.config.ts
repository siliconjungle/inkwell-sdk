import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core.ts",
    session: "src/session.ts",
    analytics: "src/analytics.ts",
    assets: "src/assets.ts",
    player: "src/player.ts",
    presence: "src/presence.ts",
  },
  dts: true,
  format: ["esm"],
  clean: true,
  sourcemap: true,
  splitting: true,
  minify: false,
  treeshake: true,
});
