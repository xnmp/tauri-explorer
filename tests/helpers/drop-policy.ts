/** Independent behavioral oracle, audited against origin/dev 773eb55a.
 * Do not import production routing: this table is the differential contract.
 * Rows are ordered; dimensions never silently omit unsupported transports.
 */
export const dropSources = ["listing-file", "listing-folder", "miller-file", "miller-folder", "sidebar-bookmark", "external-file", "text", "plugin-surface"] as const;
export const dropTargets = ["folder", "breadcrumb", "tab", "bookmark", "quick-access", "sidebar-reorder", "plugin", "textarea", "covered-pane", "listing-background", "miller-background", "plugin-view"] as const;
export const dropModifiers = ["none", "ctrl", "option"] as const;
export const dropTransports = ["native-accepted", "native-rejected", "dom-only"] as const;
export const dropPlatforms = ["linux", "mac", "windows"] as const;
export type DropCase = {
  source: typeof dropSources[number]; target: typeof dropTargets[number];
  modifier: typeof dropModifiers[number]; transport: typeof dropTransports[number]; platform: typeof dropPlatforms[number];
  lifetime?: "expired";
};
export type Outcome = "move" | "copy" | "pin" | "reorder" | "plugin:pane" | "plugin:external" | "plugin:dom" | "text-insertion" | "blocked" | "ignored";
const explorer = (c: DropCase) => c.source.startsWith("listing-") || c.source.startsWith("miller-");
const folder = (c: DropCase) => c.source.endsWith("-folder");
const nonfile = (c: DropCase) => c.source === "text" || c.source === "plugin-surface";
export const nativeRoute = (c: DropCase) => !nonfile(c) && c.source !== "sidebar-bookmark"
  && (c.transport === "native-accepted" || (c.source !== "external-file" && c.transport === "native-rejected" && c.platform === "linux"));
const copy = (c: DropCase) => c.modifier === (c.platform === "mac" ? "option" : "ctrl");
const pointer = (c: DropCase) => c.transport === "dom-only" && c.platform !== "linux" && explorer(c);

/** Explicit dev rows: nativeDropHandler, pointer mouseup, folder DOM handler,
 * NavigationBar, WindowTabBar, FilesSidebarView, FileList and MillerColumns. */
export const devPolicyRows: readonly { id: string; when(c: DropCase): boolean; outcome(c: DropCase): Outcome }[] = [
  { id: "non-file", when: nonfile, outcome: c => ["plugin", "plugin-view"].includes(c.target) ? "plugin:dom" : "ignored" }, // dev's global adapter cancels browser default
  { id: "bookmark-reorder", when: c => c.source === "sidebar-bookmark", outcome: c => c.target === "sidebar-reorder" ? "reorder" : "ignored" },
  { id: "dom-os-paths-unavailable", when: c => c.source === "external-file" && !nativeRoute(c), outcome: () => "ignored" },
  { id: "folder-pin", when: c => folder(c) && ["bookmark", "quick-access", "sidebar-reorder"].includes(c.target), outcome: () => "pin" },
  { id: "quick-access-file", when: c => c.target === "quick-access", outcome: () => "ignored" },
  { id: "native-transfer", when: nativeRoute, outcome: c => explorer(c) || !copy(c) ? "move" : "copy" },
  { id: "pointer-plugin-surface", when: c => pointer(c) && ["plugin", "plugin-view", "textarea"].includes(c.target), outcome: () => "ignored" },
  { id: "pointer-listing-background", when: c => pointer(c) && ["listing-background", "miller-background", "covered-pane"].includes(c.target), outcome: () => "move" },
  { id: "pointer-directory", when: pointer, outcome: c => c.modifier === "option" ? "copy" : "move" }, // dev used altKey even on Windows
  { id: "dom-move-only", when: c => ["breadcrumb", "listing-background", "covered-pane"].includes(c.target), outcome: () => "move" },
  { id: "dom-directory", when: c => ["folder", "tab", "miller-background"].includes(c.target), outcome: c => copy(c) ? "copy" : "move" },
  { id: "dom-unhandled", when: () => true, outcome: () => "ignored" },
];
export function devDropPolicy(c: DropCase): Outcome {
  return devPolicyRows.find(row => row.when(c))!.outcome(c);
}

/** Every deliberate difference is named and justified, never inferred from
 * production output. All other combinations must equal the dev policy. */
export const intendedDifferences = [
  { id: "expired-gesture", reason: "An evicted source observation or retired DOM gesture must cancel instead of becoming an external file operation; bounded identity retention cannot guess old provenance.",
    when: (c: DropCase) => c.lifetime === "expired" && ((explorer(c) && c.platform === "linux" && c.transport === "native-rejected")
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
  const difference = intendedDifferences.find(row => row.when(c));
  return { outcome: difference ? difference.outcome(c) : devDropPolicy(c), difference: difference?.id ?? null };
}
export const dropCases: DropCase[] = dropPlatforms.flatMap(platform => dropSources.flatMap(source => dropTargets.flatMap(target => dropModifiers.flatMap(modifier => dropTransports.map(transport => ({ platform, source, target, modifier, transport }))))));
export const dropBoundaryCases: DropCase[] = ["folder", "breadcrumb", "tab", "bookmark", "plugin", "covered-pane"].map(target => ({
  source: "miller-file", target: target as DropCase["target"], platform: "linux", transport: "native-rejected", modifier: "none", lifetime: "expired",
}));
