import { config as base } from "./wdio.conf";

export const config: WebdriverIO.Config = {
  ...base,
  // This suite supplies its own private headless Wayland compositor. WDIO's
  // automatic Xvfb would replace that native display path with X11.
  autoXvfb: false,
  specs: ["./specs/scaled-marquee.spec.ts"],
  mochaOpts: {
    ...base.mochaOpts,
    grep: process.env.TAURI_NATIVE_SELECTION_GREP,
  },
};
