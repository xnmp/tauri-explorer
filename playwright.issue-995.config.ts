import config from "./playwright.config";

export default {
  ...config,
  use: { ...config.use, baseURL: "http://localhost:1495" },
  webServer: {
    command: "bun run dev -- --port 1495",
    url: "http://localhost:1495",
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
};
