import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    achievements: "src/achievements.ts",
    stats: "src/stats.ts",
    index: "src/index.ts",
    core: "src/core.ts",
    session: "src/session.ts",
    analytics: "src/analytics.ts",
    assets: "src/assets.ts",
    player: "src/player.ts",
    presence: "src/presence.ts",
    performance: "src/performance.ts",
    backend: "src/backend.ts",
    server: "src/server.ts",
    storage: "src/storage.ts",
    config: "src/config.ts",
    wire: "src/wire.ts",
    leaderboards: "src/leaderboards.ts",
  },
  dts: true,
  format: ["esm"],
  clean: true,
  sourcemap: true,
  splitting: true,
  minify: false,
  treeshake: true,
});
