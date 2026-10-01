import path from "node:path";
import { config as baseConfig } from "./wdio.conf";
import { resolveSoakArtifactPaths, resolveSoakConfiguration } from "./native-qualification";

const { durationMs, seed } = resolveSoakConfiguration(process.env);
const platform = process.platform === "win32" ? "windows" :
  process.platform === "darwin" ? "macos" : "linux";
const { workerLogDirectory } = resolveSoakArtifactPaths(
  path.resolve("qualification-results"), platform, seed,
);

export const config: WebdriverIO.Config = {
  ...baseConfig,
  // Four-hour runs generate many unique WebDriver messages. Without outputDir,
  // @wdio/logger retains them in its in-memory pre-file cache for the run.
  outputDir: workerLogDirectory,
  specs: ["./soak/**/*.spec.ts"],
  exclude: [],
  bail: 1,
  mochaOpts: {
    ui: "bdd",
    timeout: durationMs + 10 * 60_000,
  },
};
