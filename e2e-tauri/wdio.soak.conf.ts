import { config as baseConfig } from "./wdio.conf";

const durationMs = Number.parseInt(
  process.env.SOAK_DURATION_MS ?? "14400000",
  10,
);
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error("SOAK_DURATION_MS must be a positive integer");
}

export const config: WebdriverIO.Config = {
  ...baseConfig,
  specs: ["./soak/**/*.spec.ts"],
  exclude: [],
  bail: 1,
  mochaOpts: {
    ui: "bdd",
    timeout: durationMs + 10 * 60_000,
  },
};
