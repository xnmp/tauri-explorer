# Plugin file view eligibility

The runtime at `globalThis.__TAURI_EXPLORER_PLUGIN_SDK__` advertises
`fileViewEligibilityPending` in its optional `capabilities` list. This is
additive: `sdkVersion` stays 1, `apiVersion` stays 3, and existing SDK 1/2/3
packages and boolean predicates keep their current behavior. Detect the
capability, rather than comparing version numbers.

The public types exported by `src/lib/plugins/api.ts` are:

```ts
export type FileViewEligibility = boolean | "pending";

export interface FileViewContribution {
  id: string;
  title: string;
  component: Component<any>;
  props?: Record<string, unknown>;
  available?(directory: string): FileViewEligibility;
  reveal?(targetId: string, pane: FileViewPane, signal: AbortSignal): Promise<void>;
}

// On PluginContext:
registerFileView?(view: FileViewContribution): void;
```

`Component` is Svelte's component type; `FileViewPane` retains its existing
pane-scoped handle. Omitted `available` means true. False (including a thrown
predicate) shows the built-in listing while retaining the view preference.
True shows the preferred plugin view. Other providers cannot select themselves
or delay a different preferred view; an explicit built-in choice bypasses the
barrier. Empty and virtual directory paths also bypass it.

On a supporting host, return the literal string `"pending"` when eligibility
for that directory is unknown. The callback is synchronous and reactive, **not
a Promise**. Read a Svelte reactive cache, queue the async lookup outside the
callback's reactive evaluation, and publish a boolean to that cache when it
settles. No new context method or explicit host notification is required.
Errors should settle false. Keep the last known boolean while refreshing,
rather than returning to pending. Fence stale lookup results on plugin
deactivation and keep caches keyed by directory.

For TraceExplorer, mirror the types above in `integration/plugin-sdk/index.d.ts`,
then change `folder-visibility.svelte.ts` to return `known.get(directory) ??
"pending"` for ordinary directories (retain false for empty/virtual paths and
the existing queued lookup, scope fence and cache eviction). Gate that value
when registering the view:

```ts
const supportsPending = globalThis.__TAURI_EXPLORER_PLUGIN_SDK__
  ?.capabilities?.includes("fileViewEligibilityPending") ?? false;

ctx.registerFileView?.({
  id: TRACE_VIEW_ID,
  title: "Trace",
  component: TraceView,
  reveal, // if the plugin already supplies this hook
  available(directory) {
    const answer = traceFolderVisibility.available(directory);
    return answer === "pending" && !supportsPending ? false : answer;
  },
});
```

On older hosts, never return the pending string: their boolean resolver may
treat it as true. The plugin still needs the pane/default preference set to
`trace.view`; eligibility does not automatically choose a view. An optimistic
preload can remain as an optimization, but is no longer needed for correctness
within the hold window.

## First paint and loading

For each Explorer directory/view choice, the host holds the listing area
at its neutral background while the preferred view is pending. It renders
neither the built-in listing nor a spinner during this hold. The same shared
pane rule serves initial startup, fresh/warm window navigation, new tabs,
restored panes and ordinary folder navigation.

The hold is **400 ms total**, shared by provider loading and eligibility. This
gives a short local backend lookup a chance to finish while capping the blank
interval below half a second. It is a policy bound, not a measured performance
guarantee. At the boundary the built-in listing resumes its ordinary loading,
error and view behavior. A late reactive true answer still switches to the
plugin view. Eligibility updates and registration do not extend the deadline;
navigation or a changed preference starts a fresh scope. The requested
directory starts that scope before listing IO completes. Switching tabs keeps
the Explorer and its deadline, even when the pane component remounts. Once the
scope has painted or timed out, later pending answers do not blank it again.

Native window sessions mark installed-package discovery pending **before**
settings IO and tab initialization. Once the manifest supplies contribution
plugin IDs, package import/styles/activation and individual plugin activation
mark missing views of those owners pending. The manifest lists plugin IDs,
not view IDs, so a missing preference is matched using the API's
`<pluginId>.<dot-free-name>` namespace rule (or the plugin ID itself).
No new manifest field is required. Registered predicates remain authoritative,
including boolean false before the rest of activation completes. Known built-in
owners, including disabled IDs, never wait behind unrelated package discovery.
Discovery retires when the manifest supplies owners (or discovery fails/session tears
down), independently of activation completion. Package import/style leases
hand off to individual activation leases before running plugin activation, so
a failed or disabled owner releases immediately even if a sibling hangs.
Activation retires on completion, failure, disable or disposal. If discovery/activation stalls,
the same 400 ms paint bound still applies. The host cannot anticipate a view
preference that was not yet supplied by settings or the restored pane.

Tests exercise the pure rule, real client-side reactive deadlines, window
discovery ownership and browser first-render outcomes. The browser fixture
uses the demo plugin through the real context/registry/renderer; it does not
qualify native package protocol or TraceExplorer's backend lookup timing.
