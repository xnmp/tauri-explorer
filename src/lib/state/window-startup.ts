/** Settings must precede theme synchronization and plugin activation, while
 * directory navigation remains independent. The window owns this sequence:
 * a late settings result cannot activate services after teardown. */
export function startWindowStartup(dependencies: {
  loadSettings(): Promise<void>;
  synchronizeTheme(): void;
  publishSettingsReady(): void;
  initializePlugins(): Promise<void>;
  disposePlugins(): Promise<void>;
}) {
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const ready = dependencies.loadSettings().then(async () => {
    if (disposed) return;
    dependencies.synchronizeTheme();
    dependencies.publishSettingsReady();
    await dependencies.initializePlugins();
  });

  return {
    ready,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      // Plugin ownership handles activation already in flight. Do not wait
      // for unrelated settings IO before revoking existing contributions.
      disposal = dependencies.disposePlugins();
      return disposal;
    },
  };
}
