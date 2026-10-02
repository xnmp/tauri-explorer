import { config as base } from "./wdio.conf";
export const config: WebdriverIO.Config = {
  ...base,
  autoXvfb: false,
  specs: ["./specs/pdf-preview.spec.ts"],
  mochaOpts: { ...base.mochaOpts, grep: process.env.TAURI_NATIVE_PDF_GREP },
};
