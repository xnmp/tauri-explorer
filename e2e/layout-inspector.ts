import type { Page } from "./fixtures";

/** Give core geometry tests an optional inspector without a provider package. */
export async function installLayoutInspector(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const load = new Function(`return Promise.all([
      import('/src/lib/plugins/registry.svelte.ts'),
      import('/src/test-support/LayoutInspector.svelte')
    ])`);
    const [{ pluginRegistry }, { default: component }] = await load();
    await pluginRegistry.registerInstalled([{
      id: "layout-inspector-fixture",
      name: "Layout inspector fixture",
      description: "Optional inspector for core geometry acceptance tests.",
      activate(ctx: import("../src/lib/plugins/api").PluginContext) {
        ctx.registerInspector({
          id: "layout-inspector-fixture",
          title: "Selected file",
          component,
          when: entries => entries.length === 1 && entries[0].kind === "file",
        });
      },
    }]);
  });
}
