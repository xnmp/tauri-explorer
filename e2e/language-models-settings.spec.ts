import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";
async function openSettings(page: import("@playwright/test").Page) {
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })));
  await expect(page.getByRole("heading", { name: "Language models" })).toBeVisible();
}
test("custom text connection persists a prefix/model and explicitly tests the saved provider", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Add profile", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("DeepSeek custom");
  await page.getByRole("combobox", { name: "Protocol", exact: true }).selectOption("openai-chat-completions");
  await page.getByLabel("API root", { exact: true }).fill("https://example.test/custom/v1/");
  await page.getByLabel("Model ID", { exact: true }).fill("deepseek-user-model");
  await page.getByRole("combobox", { name: "Credential source", exact: true }).selectOption("environment");
  await page.getByLabel("Environment variable", { exact: true }).fill("DEEPSEEK_API_KEY");
  await expect(page.getByRole("button", { name: "Test generation", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save language models", exact: true }).click();
  await expect(page.getByText("Language model settings saved.", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Default profile", exact: true }).selectOption({ label: "DeepSeek custom" });
  await page.getByRole("button", { name: "Save language models", exact: true }).click();
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect(page.getByText("Local checks passed. Generation and remote authentication have not been tested.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Test generation", exact: true }).click();
  await expect(page.getByText("Test generated: Connection test succeeded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect(page.getByLabel("API root", { exact: true })).toHaveValue("https://example.test/custom/v1/");
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue("deepseek-user-model");
  await expect(page.getByLabel("Environment variable", { exact: true })).toHaveValue("DEEPSEEK_API_KEY");
  await expect(page.getByRole("button", { name: "Delete profile", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.locator(".settings-search").fill("AI");
  await page.locator(".language-models").screenshot({ path: "evidence/language-models-settings.png" });
});
test("key replacement stays write-only and explicit clearing removes its presence", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("combobox", { name: "Protocol", exact: true }).selectOption("openai-chat-completions");
  await page.getByRole("button", { name: "Save language models", exact: true }).click();
  await page.getByLabel("Replacement API key", { exact: true }).fill("fixture-not-a-real-key");
  await page.getByRole("button", { name: "Replace API key", exact: true }).click();
  await expect(page.getByLabel("Replacement API key", { exact: true })).toHaveValue("");
  await expect(page.getByText(/Credential present/)).toBeVisible();
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect(page.getByLabel("Replacement API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Clear credential", exact: true }).click();
  await expect(page.getByText(/No credential available/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Credential source", exact: true })).toHaveValue("none");
});
test("AI search synonyms find the manager and disabling allows removing the final profile", async ({ page }) => {
  await openSettings(page);
  for (const term of ["LLM", "Claude", "DeepSeek", "endpoint", "API key"]) {
    await page.locator(".settings-search").fill(term);
    await expect(page.getByRole("heading", { name: "Language models" })).toBeVisible();
  }
  await page.getByLabel("Enable language models", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Delete profile", exact: true }).click();
  await page.getByRole("button", { name: "Save language models", exact: true }).click();
  await page.getByRole("button", { name: "Reload saved settings", exact: true }).click();
  await expect(page.getByLabel("Enable language models", { exact: true })).not.toBeChecked();
  await expect(page.getByText("Add a profile to configure a language model.", { exact: true })).toBeVisible();
  await page.getByLabel("Enable language models", { exact: true }).check();
  await page.getByRole("button", { name: "Save language models", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Select an existing default profile");
});

test("language settings remain keyboard operable and fit a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 768 });
  await openSettings(page);
  await page.locator(".settings-search").fill("LLM");
  await page.locator(".settings-search").press("Tab");
  await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();
  await page.keyboard.press("Tab");
  const enabled = page.getByLabel("Enable language models", { exact: true });
  await expect(enabled).toBeFocused(); await page.keyboard.press("Space");
  await expect(enabled).not.toBeChecked();
  const bounds = await page.locator(".language-models").evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(320); expect(bounds.width).toBeLessThanOrEqual(bounds.clientWidth);
});
