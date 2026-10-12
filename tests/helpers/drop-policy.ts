/** Independent behavioral oracle, audited against origin/dev 773eb55a.
 * Do not import production routing: this table is the differential contract.
 * Rows are ordered; dimensions never silently omit unsupported transports.
 */
export const dropSources = ["listing-file", "listing-folder", "miller-file", "miller-folder", "recent", "sidebar-bookmark", "external-file", "external-uri", "text", "plugin-surface"] as const;
export const dropTargets = ["folder", "breadcrumb", "tab", "bookmark", "quick-access", "sidebar-reorder", "plugin", "textarea", "covered-pane", "listing-background", "miller-background", "plugin-view", "terminal"] as const;
export const dropModifiers = ["none", "ctrl", "option"] as const;
export const dropTransports = ["native-accepted", "native-rejected", "dom-only"] as const;
export const dropDeliveryOrders = ["native-first", "dom-first", "native-late-after-dragend", "dom-only"] as const;
export const dropPlatforms = ["linux", "mac", "windows"] as const;
export const dropVisibilities = ["full", "stripped"] as const;
export type DropCase = {
  visibility?: typeof dropVisibilities[number];
  uriHtml?: boolean;
  filesUri?: boolean;
  staleGesture?: "local" | "cross-window" | "retired" | "wrong-clock" | "mismatched-session";
  source: typeof dropSources[number]; target: typeof dropTargets[number];
  modifier: typeof dropModifiers[number]; transport: typeof dropTransports[number]; platform: typeof dropPlatforms[number];
  deliveryOrder?: typeof dropDeliveryOrders[number];
  completionModal?: "window" | "destination-pane" | "other-pane";
  completionPath?: "sidebar-dragend";
  lifetime?: "expired";
  window?: "cross-window";
  pathPair?: { id: string; source: string; destination: string; dev: Outcome; branch: Outcome; reason?: string };
};
export type Outcome = "move" | "copy" | "pin" | "reorder" | "plugin:pane" | "plugin:external" | "plugin:dom" | "text-insertion" | "terminal-insertion" | "blocked" | "ignored";
const explorer = (c: DropCase) => c.source.startsWith("listing-") || c.source.startsWith("miller-");
const folder = (c: DropCase) => c.source.endsWith("-folder");
const nonfile = (c: DropCase) => c.source === "text" || c.source === "plugin-surface";
// Native receiver delivery is separate from explicit native start: Linux
// Recent reaches Wry through GTK with its session URN and source:null.
export const nativeRoute = (c: DropCase) => !nonfile(c) && c.source !== "external-uri" && c.source !== "sidebar-bookmark"
  && c.deliveryOrder !== "dom-only"
  && (c.transport === "native-accepted" || (c.source !== "external-file" && c.transport === "native-rejected" && c.platform === "linux"));
const copy = (c: DropCase) => c.modifier === (c.platform === "mac" ? "option" : "ctrl");
const pointer = (c: DropCase) => c.transport === "dom-only" && c.platform !== "linux" && explorer(c);

/** Explicit dev rows: nativeDropHandler, pointer mouseup, folder DOM handler,
 * NavigationBar, WindowTabBar, FilesSidebarView, FileList and MillerColumns. */
export const devPolicyRows: readonly { id: string; when(c: DropCase): boolean; outcome(c: DropCase): Outcome }[] = [
  { id: "non-file", when: nonfile, outcome: c => ["plugin", "plugin-view"].includes(c.target) ? "plugin:dom" : "ignored" }, // dev's global adapter cancels browser default
  { id: "bookmark-reorder", when: c => c.source === "sidebar-bookmark", outcome: c => c.target === "sidebar-reorder" ? "reorder" : "ignored" },
  { id: "recent-link-only", when: c => c.source === "recent", outcome: c => ["quick-access", "sidebar-reorder", "bookmark"].includes(c.target)
    && !(c.platform !== "linux" && c.transport === "dom-only" && c.target !== "quick-access") ? "pin" : "ignored" },
  { id: "dom-os-paths-unavailable", when: c => c.source === "external-file" && !nativeRoute(c), outcome: () => "ignored" },
  { id: "folder-pin", when: c => folder(c) && ["bookmark", "quick-access", "sidebar-reorder"].includes(c.target), outcome: () => "pin" },
  { id: "quick-access-file", when: c => c.target === "quick-access", outcome: () => "ignored" },
  { id: "terminal-paths", when: c => c.target === "terminal", outcome: c => nativeRoute(c) || pointer(c) ? "terminal-insertion" : "ignored" },
  { id: "native-transfer", when: nativeRoute, outcome: c => explorer(c) || !copy(c) ? "move" : "copy" },
  { id: "pointer-plugin-surface", when: c => pointer(c) && ["plugin", "plugin-view", "textarea"].includes(c.target), outcome: () => "ignored" },
  { id: "pointer-listing-background", when: c => pointer(c) && ["listing-background", "miller-background", "covered-pane"].includes(c.target), outcome: () => "move" },
  { id: "pointer-directory", when: pointer, outcome: c => c.modifier === "option" ? "copy" : "move" }, // dev used altKey even on Windows
  { id: "dom-move-only", when: c => ["breadcrumb", "listing-background", "covered-pane"].includes(c.target), outcome: () => "move" },
  { id: "dom-directory", when: c => ["folder", "tab", "miller-background"].includes(c.target), outcome: c => copy(c) ? "copy" : "move" },
  { id: "dom-unhandled", when: () => true, outcome: () => "ignored" },
];
export function devDropPolicy(c: DropCase): Outcome {
  if (c.pathPair) return c.pathPair.dev;
  if (c.source === "external-uri") return "ignored";
  if (c.visibility === "stripped" && !nativeRoute(c) && !pointer(c)
    && (explorer(c) || c.source === "recent")) return "ignored";
  return devPolicyRows.find(row => row.when(c))!.outcome(c);
}

/** Every deliberate difference is named and justified, never inferred from
 * production output. All other combinations must equal the dev policy. */
export const intendedDifferences = [
  { id: "webkit-dom-visibility", reason: "Internal HTML5 routing survives WebKit hiding custom MIME types; URI-only external gestures never acquire Explorer authority.",
    when: (c: DropCase) => c.visibility === "stripped" && (explorer(c) || c.source === "recent") && !nativeRoute(c) && !pointer(c)
      && branchDropPolicy({ ...c, visibility: "full" }).outcome !== "ignored",
    outcome: (c: DropCase): Outcome => branchDropPolicy({ ...c, visibility: "full" }).outcome },
  { id: "platform-path-semantics", reason: "Use literal POSIX names and Windows separator/case semantics; reject ambiguous parent/drive-relative paths before transfer.",
    when: (c: DropCase) => !!c.pathPair?.reason, outcome: (c: DropCase): Outcome => c.pathPair!.branch },
  { id: "dom-first-pin-only-noop", reason: "A DOM-first file drop on the pin-only Quick Access ancestor completes as a no-op; its receipt consumes late automatic native delivery too.",
    when: (c: DropCase) => c.platform === "linux" && c.transport === "native-rejected"
      && ["dom-first", "native-late-after-dragend"].includes(c.deliveryOrder ?? "")
      && c.source.endsWith("-file") && ["bookmark", "sidebar-reorder"].includes(c.target), outcome: (): Outcome => "ignored" },
  { id: "recent-plugin", reason: "Design29 permits Recent link-only shortcuts to deliver to registered plugin targets without mutating their folders.",
    when: (c: DropCase) => c.source === "recent" && c.target === "plugin", outcome: (): Outcome => "plugin:pane" },
  { id: "recent-bookmark-pointer", reason: "Specific bookmark rows now retain bookmark identity; Recent pins there just like on empty Quick Access, never transferring the folder.",
    when: (c: DropCase) => c.source === "recent" && c.platform !== "linux" && c.transport === "dom-only" && ["bookmark", "sidebar-reorder"].includes(c.target), outcome: (): Outcome => "pin" },
  { id: "recent-modality", reason: "Recent follows the same pane and plugin ownership admission as other Explorer file sources.",
    when: (c: DropCase) => c.source === "recent" && ["covered-pane", "textarea", "plugin-view"].includes(c.target), outcome: (): Outcome => "blocked" },
  { id: "expired-gesture", reason: "An evicted source observation or retired DOM gesture must cancel instead of becoming an external file operation; bounded identity retention cannot guess old provenance.",
    when: (c: DropCase) => c.lifetime === "expired" && ((explorer(c) && (c.transport === "native-accepted" || (c.platform === "linux" && c.transport === "native-rejected")))
      || (c.source === "external-file" && nativeRoute(c))), outcome: (): Outcome => "blocked" },
  { id: "ordinary-dom-payloads", reason: "The file adapter must preserve browser text insertion and plugin-specific DOM handlers (review finding 3).", when: nonfile,
    outcome: (c: DropCase): Outcome => c.target === "textarea" ? "text-insertion" : c.target === "plugin" || c.target === "plugin-view" ? "plugin:dom" : "ignored" },
  { id: "pane-modality", reason: "Design29 forbids transfers into covered base content or unregistered dialog surfaces.",
    when: (c: DropCase) => ["textarea", "covered-pane"].includes(c.target) && (explorer(c) || c.source === "external-file"), outcome: (): Outcome => "blocked" },
  { id: "registered-plugin", reason: "Design29 adds terminal plugin delivery before any filesystem transfer, carrying validated Explorer/external source kind.",
    when: (c: DropCase) => c.target === "plugin" && (explorer(c) || nativeRoute(c)), outcome: (c: DropCase): Outcome => explorer(c) ? "plugin:pane" : "plugin:external" },
  { id: "unregistered-plugin", reason: "Design29 removes the native null-target fallback into the active directory on a plugin view.",
    when: (c: DropCase) => c.target === "plugin-view" && (explorer(c) || c.source === "external-file"), outcome: (): Outcome => "blocked" },
  { id: "windows-pointer-copy-chord", reason: "Correct dev's Windows pointer altKey bug to the host's shared Ctrl copy modifier. Pointer backgrounds remain move-only.",
    when: (c: DropCase) => pointer(c) && c.platform === "windows" && ["folder", "breadcrumb", "tab", "bookmark", "sidebar-reorder"].includes(c.target),
    outcome: (c: DropCase): Outcome => folder(c) && ["bookmark", "sidebar-reorder"].includes(c.target) ? "pin" : copy(c) ? "copy" : "move" },
  { id: "native-former-dom-policy", reason: "New explicit handoff for Miller preserves its former DOM source/target modifier policy; pointer drag-out retains same-window copy intent. Linux listings keep dev native move-only policy.",
    when: (c: DropCase) => nativeRoute(c) && explorer(c) && !(c.platform === "linux" && c.source.startsWith("listing-")) && ["folder", "tab", "bookmark", "covered-pane", "listing-background", "miller-background", "breadcrumb", "sidebar-reorder"].includes(c.target),
    outcome: (c: DropCase): Outcome => folder(c) && ["bookmark", "sidebar-reorder"].includes(c.target) ? "pin"
      : c.platform === "linux" && c.source.startsWith("miller-") && ["breadcrumb", "listing-background"].includes(c.target) ? "move" : copy(c) ? "copy" : "move" },
] as const;
export function branchDropPolicy(c: DropCase): { outcome: Outcome; difference: string | null } {
  if (c.source === "external-uri") return { outcome: "ignored", difference: null };
  if (c.pathPair) return { outcome: c.pathPair.branch, difference: c.pathPair.reason ? "platform-path-semantics" : null };
  const difference = intendedDifferences.find(row => row.when(c));
  return { outcome: difference ? difference.outcome(c) : devDropPolicy(c), difference: difference?.id ?? null };
}
export const dropCases: DropCase[] = dropPlatforms.flatMap(platform => dropSources.flatMap(source => dropTargets.flatMap(target => dropModifiers.flatMap(modifier => dropTransports.map(transport => ({ platform, source, target, modifier, transport }))))));
/** Delivery order is independent of destination. DOM-only rows omit native
 * start as well as native delivery; late rows deliver pre-dragend observations. */
export const dropDeliveryCases: DropCase[] = dropPlatforms.flatMap(platform =>
  dropSources.flatMap(source =>
    dropTargets.flatMap(target => dropDeliveryOrders.flatMap(deliveryOrder =>
      (deliveryOrder === "dom-only" ? ["dom-only"] as const : ["native-accepted", "native-rejected"] as const).map(transport => ({
        platform, source, target, deliveryOrder, transport, modifier: "none" as const,
      }))))));
/** Rejection need not produce any automatic Wry observation. These rows use
 * the HTML5 source and DOM destination, retaining the native-start attempt. */
export const dropRejectedDomCases = (["listing-file", "miller-file"] as const).flatMap(source =>
  (["folder", "breadcrumb", "tab"] as const).flatMap(target =>
    (["none", "ctrl"] as const).map(modifier => ({
      platform: "linux" as const, source, target, modifier,
      transport: "native-rejected" as const, deliveryOrder: "dom-only" as const,
    }))));
export const dropModalCompletionCases: DropCase[] = dropDeliveryCases.filter(c => c.source.startsWith("listing-") || c.source.startsWith("miller-") || c.source === "recent" || c.source === "sidebar-bookmark" || c.source === "external-file")
  .flatMap(c => (["window", "destination-pane", "other-pane"] as const).map(completionModal => ({ ...c, completionModal })))
  .concat((["window", "destination-pane", "other-pane"] as const).map(completionModal => ({
    platform: "linux" as const, source: "miller-folder" as const, target: "quick-access" as const,
    modifier: "none" as const, transport: "dom-only" as const, deliveryOrder: "dom-only" as const,
    completionModal, completionPath: "sidebar-dragend" as const,
  })));
export const dropBoundaryCases: DropCase[] = ["folder", "breadcrumb", "tab", "bookmark", "plugin", "covered-pane"].map(target => ({
  source: "miller-file", target: target as DropCase["target"], platform: "linux", transport: "native-rejected", modifier: "none", lifetime: "expired",
}));

/** Explicit receiver-window cases. Source and receiver have distinct module
 * state; only transport provenance/shared storage can recover the source. */
export const dropCrossWindowCases: DropCase[] = dropCases.filter(c =>
  ["listing-file", "listing-folder", "miller-file", "miller-folder", "recent"].includes(c.source)
  && (c.transport !== "dom-only" || c.platform === "linux")
).concat(dropBoundaryCases).map(c => ({ ...c, window: "cross-window" }));

/** Policy belongs to the event-producing gesture, irrespective of callback
 * delivery order. These rows exercise production source state and routing. */
export type TemporalDropCase = DropCase & {
  ordering: "window-modal-during-native-start" | "retained-local" | "late-start-reply" | "completion-backlog" | "expired-provenance" | "captured-before-completion" | "captured-before-replacement" | "same-millisecond-replacement";
  reply?: "accepted" | "rejected";
  successors?: "html5" | "pointer";
  completion?: "acknowledged" | "pending-reply";
  expected?: Outcome;
};
export const dropTemporalCases: TemporalDropCase[] = [
  ...(["miller-file", "miller-folder"] as const).flatMap(source => dropTargets.map(target => ({ ordering: "window-modal-during-native-start" as const,
    platform: "linux" as const, source, target,
    modifier: "none" as const, transport: "native-rejected" as const, expected: "blocked" as const }))),
  ...(["folder", "plugin"] as const).map(target => ({ ordering: "same-millisecond-replacement" as const,
    platform: "linux" as const, source: "listing-file" as const, target, modifier: "none" as const,
    transport: "native-rejected" as const, lifetime: "expired" as const, window: "cross-window" as const })),
  ...(["retained-local", "late-start-reply"] as const).flatMap(ordering => (["accepted", "rejected"] as const).flatMap(reply => (["bookmark", "plugin"] as const).map(target => ({
    ordering, reply, platform: "linux" as const, source: "recent" as const, target, modifier: "none" as const,
    transport: "native-rejected" as const, window: "cross-window" as const,
  })))),
  ...dropPlatforms.flatMap(platform => (["folder", "plugin"] as const).flatMap(target => [
    { ordering: "completion-backlog" as const, platform, source: "external-file" as const, target,
      modifier: platform === "mac" ? "option" as const : "ctrl" as const, transport: "native-accepted" as const, completion: "acknowledged" as const },
    { ordering: "completion-backlog" as const, platform, source: "external-file" as const, target,
      modifier: platform === "mac" ? "option" as const : "ctrl" as const, transport: "native-accepted" as const, completion: "pending-reply" as const },
    { ordering: "expired-provenance" as const, platform, source: "listing-file" as const, target,
      modifier: "none" as const, transport: "native-accepted" as const, lifetime: "expired" as const, window: "cross-window" as const, successors: "html5" as const },
    { ordering: "expired-provenance" as const, platform, source: "listing-file" as const, target,
      modifier: "none" as const, transport: "native-accepted" as const, lifetime: "expired" as const, window: "cross-window" as const, successors: "pointer" as const },
    { ordering: "captured-before-completion" as const, platform, source: "listing-file" as const, target,
      modifier: "none" as const, transport: "native-accepted" as const, window: "cross-window" as const },
    { ordering: "captured-before-replacement" as const, platform, source: "listing-file" as const, target,
      modifier: "none" as const, transport: "native-accepted" as const, window: "cross-window" as const },
  ])),
];

/** Outgoing shortcuts must export no OS filesystem payload, as on dev.
 * Link is not a portable filesystem effect: GTK3 Wayland maps it to Copy.
 * The mappings describe platform negotiation, not a physical reproduction. */
export const outgoingRecentCases = ([
  { platform: "linux", backend: "gtk-x11", nativeLinkEffect: "link" },
  { platform: "linux", backend: "gtk-wayland", nativeLinkEffect: "copy" },
  { platform: "mac", backend: "appkit", nativeLinkEffect: "link" },
  { platform: "windows", backend: "ole", nativeLinkEffect: "link" },
] as const).flatMap(row => (row.platform === "linux" ? ["html5", "native-request"] as const : ["html5", "native-request", "pointer"] as const)
  .map(adapter => ({ ...row, adapter, devExport: "none" as const, branchExport: "none" as const, nativeStart: "blocked" as const })));

/** Adversarial pairs have literal expectations, independent of production
 * path normalization. Expand each across the actual transport variants. */
const pathRows: { platforms: readonly DropCase["platform"][]; target: DropCase["target"]; source: string; destination: string;
  id: string; dev: Outcome | ((c: DropCase) => Outcome); branch: Outcome; reason?: string }[] = [
  { id: "posix-backslash-distinct", platforms: ["linux", "mac"], target: "breadcrumb", source: "/tmp/a\\b", destination: "/tmp/a/b",
    dev: c => c.platform === "linux" && c.transport === "dom-only" ? "move" : "ignored", branch: "move", reason: "Backslash is a literal POSIX filename character." },
  { id: "posix-backslash-parent", platforms: ["linux", "mac"], target: "tab", source: "/tmp/a\\b/item", destination: "/tmp/a\\b",
    dev: c => c.platform === "mac" && c.transport === "dom-only" ? "ignored" : "move", branch: "ignored", reason: "A literal POSIX parent remains the same directory; native Miller retains the DOM tab no-op rule." },
  { id: "posix-case-distinct", platforms: ["linux", "mac"], target: "tab", source: "/tmp/Case/item", destination: "/tmp/case",
    dev: "move", branch: "move" },
  { id: "posix-trailing-parent", platforms: ["linux", "mac"], target: "tab", source: "/tmp/source/item/", destination: "/tmp/source/",
    dev: c => c.platform === "mac" && c.transport === "dom-only" ? "ignored" : "move", branch: "ignored", reason: "Trailing directory separators do not change parent identity." },
  { id: "windows-backslash-equivalent", platforms: ["windows"], target: "tab", source: "C:\\source\\item", destination: "C:/source/",
    dev: c => c.transport === "dom-only" ? "ignored" : "move", branch: "ignored", reason: "Windows separator variants identify the same parent." },
  { id: "windows-case-parent", platforms: ["windows"], target: "tab", source: "C:/Source/item", destination: "c:/source",
    dev: "move", branch: "move", reason: "Windows directories can be case-sensitive, so a case-only difference below the root is left to the backend." },
  { id: "windows-case-self", platforms: ["windows"], target: "breadcrumb", source: "C:/Source/Item", destination: "c:/source/item/child",
    dev: "move", branch: "move", reason: "Self/descendant checks use the same literal-case identity as equality; the backend rejects a true self-move." },
  { id: "windows-unc-parent", platforms: ["windows"], target: "tab", source: "\\\\server\\share\\source\\item", destination: "//server/share/source/",
    dev: c => c.transport === "dom-only" ? "ignored" : "move", branch: "ignored", reason: "UNC share roots and trailing separators retain parent identity." },
  { id: "windows-unc-distinct-share", platforms: ["windows"], target: "tab", source: "\\\\server\\shareA\\source\\item", destination: "//server/shareB/source",
    dev: "move", branch: "move" },
  { id: "windows-wsl-case-distinct", platforms: ["windows"], target: "tab", source: "\\\\wsl.localhost\\Ubuntu\\Case\\item", destination: "//wsl.localhost/Ubuntu/case",
    dev: "move", branch: "move" },
  { id: "windows-drive-relative-source", platforms: ["windows"], target: "tab", source: "C:source/item", destination: "C:/destination",
    dev: "move", branch: "ignored", reason: "Drive-relative sources lack an absolute filesystem identity." },
  { id: "windows-drive-relative-target", platforms: ["windows"], target: "tab", source: "C:/source/item", destination: "C:destination",
    dev: "move", branch: "ignored", reason: "Drive-relative targets depend on hidden per-drive current-directory state." },
  { id: "posix-parent-source", platforms: ["linux", "mac"], target: "tab", source: "/tmp/source/../item", destination: "/tmp/destination",
    dev: c => nativeRoute(c) ? "ignored" : "move", branch: "ignored", reason: "Parent components are not safe lexical aliases through symlinks; existing source admission rejects them." },
  { id: "posix-parent-target", platforms: ["linux", "mac"], target: "tab", source: "/tmp/source/item", destination: "/tmp/a/../destination",
    dev: "move", branch: "ignored", reason: "Ambiguous parent-component targets need filesystem resolution, not a guessed lexical identity." },
  { id: "windows-parent-source", platforms: ["windows"], target: "tab", source: "C:/source/../item", destination: "C:/destination",
    dev: c => nativeRoute(c) ? "ignored" : "move", branch: "ignored", reason: "Source admission rejects parent components." },
  { id: "windows-parent-target", platforms: ["windows"], target: "tab", source: "C:/source/item", destination: "C:/a/../destination",
    dev: "move", branch: "ignored", reason: "Target admission rejects unresolved parent components." },
];
export const dropPathCases: DropCase[] = pathRows.flatMap(row => row.platforms.flatMap(platform => dropTransports.map(transport => {
  const c: DropCase = { platform, transport, source: "miller-folder", target: row.target, modifier: "none" };
  return { ...c, pathPair: { id: row.id, source: row.source, destination: row.destination,
    dev: typeof row.dev === "function" ? row.dev(c) : row.dev, branch: row.branch,
    ...(row.reason && (typeof row.dev === "function" ? row.dev(c) : row.dev) !== row.branch ? { reason: row.reason } : {}) } };
})));


/** Clock correction is independent of the gesture-retention and renderer lifetime axes. */
export const dropClockCases = (["backward", "forward"] as const).flatMap(direction =>
  ([0, 9] as const).flatMap(priorGestures =>
    [false, true].map(restart => ({ direction, priorGestures, restart }))));

/** Visibility is orthogonal to transport/platform; both engines can run on Linux.
 * Bookmark reorder/text/plugin gestures keep their own unrelated DOM protocol. */
export const withDropVisibility = (cases: readonly DropCase[]): DropCase[] => cases.flatMap(c =>
  dropVisibilities.map(visibility => ({ ...c, visibility })));
export const dropVisibilityCases = withDropVisibility([
  ...dropCases, ...dropDeliveryCases, ...dropRejectedDomCases, ...dropBoundaryCases, ...dropCrossWindowCases, ...dropPathCases,
]);
export const dropUriCases: DropCase[] = dropPlatforms.flatMap(platform =>
  (["local", "cross-window", "retired", "wrong-clock", "mismatched-session", undefined] as const).flatMap(staleGesture =>
    [false, true].flatMap(uriHtml => dropTargets.map(target => ({
      platform, source: "external-uri" as const, target, modifier: "none" as const,
      transport: "dom-only" as const, visibility: "stripped" as const, staleGesture, uriHtml,
    })))));
export const dropUriHtmlCases = withDropVisibility([...dropRejectedDomCases, ...(
  ["bookmark", "quick-access", "plugin", "breadcrumb"].map(target => ({
    platform: "linux" as const, source: "recent" as const, target: target as DropCase["target"],
    modifier: "none" as const, transport: "dom-only" as const, deliveryOrder: "dom-only" as const,
  })))]).map(c => ({ ...c, uriHtml: true }));

/** Readable Drop precedes dragend; rejected native start replays its captured
 * source after dragend. Provenance must survive without admitting a new drag. */
export const dropDeferredUriCases = withDropVisibility(dropPlatforms.flatMap(platform =>
  (["folder", "plugin"] as const).map(target => ({ platform, source: "miller-file" as const, target,
    modifier: "none" as const, transport: "native-rejected" as const, deliveryOrder: "dom-only" as const }))));

/** Native Files never authorizes fallback to an unrelated retained selection,
 * including WebKit's mixed Files + URI-list projection. */
export const dropStaleFilesCases: DropCase[] = dropUriCases.filter(c => c.staleGesture)
  .flatMap(c => [false, true].map(filesUri => ({ ...c, source: "external-file" as const, filesUri })));
