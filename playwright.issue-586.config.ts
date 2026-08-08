import config from "./playwright.config";

export default {
  ...config,
  use: { ...config.use, baseURL: "http://localhost:1421" },
  webServer: {
    command: "bun run dev -- --port 1421",
    url: "http://localhost:1421",
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
};
