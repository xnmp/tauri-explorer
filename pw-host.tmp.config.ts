import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({ ...base, reporter: "line", use: { ...base.use, baseURL: "http://localhost:1861" },
  webServer: { ...base.webServer, command: "bun run prepare:pdf && bunx vite dev --port 1861 --strictPort", url: "http://localhost:1861", reuseExistingServer: false } });
