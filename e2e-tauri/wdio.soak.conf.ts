import { config as baseConfig } from "./wdio.conf";
import { resolveSoakConfiguration } from "./native-qualification";

const { durationMs } = resolveSoakConfiguration(process.env);

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
