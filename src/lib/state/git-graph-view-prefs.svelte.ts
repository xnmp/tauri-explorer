/**
 * Persisted git-graph layout preferences: column visibility (#372, #402),
 * author avatars and Gravatar consent (#514, ADR 0026), detail metadata
 * (#402), merge muting (#458, #527) and branch tracing. These are global
 * layout choices, not per-repository curation, so every graph shares them.
 * Each toggle persists immediately.
 */
import { loadPersisted, savePersisted } from "./persisted";

export type GraphColumnId = "author" | "date" | "commit" | "parent";
export type GraphColumns = Record<GraphColumnId, boolean>;
export interface GraphAvatarPrefs { visible: boolean; gravatarEnabled: boolean }

const COLUMNS_KEY = "git-graph-columns";
const AVATAR_PREFS_KEY = "git-graph-avatar-preferences";
const DETAIL_META_KEY = "git-graph-detail-meta";
const MUTE_MERGES_KEY = "git-graph-mute-merges";
const MUTE_BASE_UPDATE_MERGES_KEY = "git-graph-mute-base-update-merges";
const BRANCH_TRACING_KEY = "git-graph-branch-tracing";

function savedObject(key: string): object {
  const saved = loadPersisted<unknown>(key, null);
  return typeof saved === "object" && saved !== null ? saved : {};
}

export function createGitGraphViewPrefs() {
  let columns = $state<GraphColumns>({
    author: true,
    date: true,
    commit: true,
    // Parent OIDs are niche — a viewable column, off by default (#402).
    parent: false,
    ...savedObject(COLUMNS_KEY),
  });
  let avatars = $state<GraphAvatarPrefs>({
    visible: true,
    gravatarEnabled: false,
    ...savedObject(AVATAR_PREFS_KEY),
  });
  // Hidden by default (#402): the graph columns already carry it.
  let showDetailMeta = $state(loadPersisted<unknown>(DETAIL_META_KEY, false) === true);
  let muteMerges = $state(loadPersisted<unknown>(MUTE_MERGES_KEY, true) !== false);
  // Separate from generic merge muting so feature merges can stay prominent
  // while periodic base syncs recede (#527).
  let muteBaseUpdateMerges = $state(loadPersisted<unknown>(MUTE_BASE_UPDATE_MERGES_KEY, true) !== false);
  // On by default; a linear history stays fully lit.
  let branchTracing = $state(loadPersisted<unknown>(BRANCH_TRACING_KEY, true) !== false);

  return {
    get columns(): GraphColumns { return columns; },
    get avatars(): GraphAvatarPrefs { return avatars; },
    get showDetailMeta() { return showDetailMeta; },
    get muteMerges() { return muteMerges; },
    get muteBaseUpdateMerges() { return muteBaseUpdateMerges; },
    get branchTracing() { return branchTracing; },
    toggleColumn(id: GraphColumnId): void {
      columns = { ...columns, [id]: !columns[id] };
      savePersisted(COLUMNS_KEY, columns);
    },
    toggleAvatars(): void {
      avatars = { ...avatars, visible: !avatars.visible };
      savePersisted(AVATAR_PREFS_KEY, avatars);
    },
    toggleGravatar(): void {
      avatars = { ...avatars, gravatarEnabled: !avatars.gravatarEnabled };
      savePersisted(AVATAR_PREFS_KEY, avatars);
    },
    toggleDetailMeta(): void {
      showDetailMeta = !showDetailMeta;
      savePersisted(DETAIL_META_KEY, showDetailMeta);
    },
    toggleMuteMerges(): void {
      muteMerges = !muteMerges;
      savePersisted(MUTE_MERGES_KEY, muteMerges);
    },
    toggleMuteBaseUpdateMerges(): void {
      muteBaseUpdateMerges = !muteBaseUpdateMerges;
      savePersisted(MUTE_BASE_UPDATE_MERGES_KEY, muteBaseUpdateMerges);
    },
    toggleBranchTracing(): void {
      branchTracing = !branchTracing;
      savePersisted(BRANCH_TRACING_KEY, branchTracing);
    },
  };
}

export type GitGraphViewPrefs = ReturnType<typeof createGitGraphViewPrefs>;
