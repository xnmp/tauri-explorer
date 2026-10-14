import { config as base } from "../wdio.conf";
export const config: WebdriverIO.Config = { ...base, specs: ["./marquee-probe.spec.ts"], mochaOpts: { ...base.mochaOpts, timeout: 600_000 } };
