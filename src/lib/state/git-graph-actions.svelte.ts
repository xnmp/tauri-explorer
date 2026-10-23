/**
 * Mutating git-graph actions for one repository (VSCode "Git Graph" parity):
 * checkout, cherry-pick, revert, merge, rebase, reset, branch/tag create,
 * rename and delete, remote-branch delete, tracking checkout, pull offers,
 * confirmed undo (#513) and F5 fetch (#370, #432).
 *
 * Every mutation ends in `refreshAfterGitMutation(repoPath, reload)`, the
 * shared refresh policy: invalidate, notify badges/SCM, then reload once.
 * No private refresh stack lives here (#431/#432).
 *
 * The prompt/modal state the actions drive (name prompts, suboption modals,
 * pull offer, undo confirmation) lives here too; the commit context menu's
 * anchor stays with the view because it carries DOM trigger elements.
 */
import {
  gitCheckout,
  gitCreateBranch,
  gitCreateTag,
  gitCherryPick,
  gitRevert,
  gitMerge,
  gitRebase,
  gitStashApply,
  gitStashPop,
  gitReset,
  gitFetch,
  gitPull,
  gitBranchBehindUpstream,
  gitDeleteBranch,
  gitDeleteTag,
  gitRenameBranch,
  gitDeleteRemoteBranch,
  gitUndo,
  gitCheckoutTracking,
  gitSyncLocalBranches,
  type ResetMode,
} from "$lib/api/git-log";
import type { RemoteRefChip } from "$lib/domain/git-graph";
import { gitUndoDescription, sameGitUndoAction, type GitUndoAction } from "$lib/domain/git-graph-undo";
import { refreshAfterGitMutation, runGitNetworkOperation } from "./git-graph-refresh";
import { gitUndoLedger } from "./git-graph-undo";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte";

export type NamePrompt = { kind: "branch" | "tag"; oid: string; value: string };
export type RenamePrompt = { oldName: string; value: string };
/** Suboption dialogs (#406): reset modes and delete variants open as a modal
 *  instead of a cascading submenu. */
export type ActionModal =
  | { kind: "reset"; oid: string; summary: string }
  | { kind: "deleteBranch"; name: string; remotes: string[] }
  | { kind: "deleteTag"; name: string };
export type PullOffer = { branch: string; behind: number };

export interface GitGraphActionsOptions {
  repoPath: string;
  /** The graph's shared reloader. */
  reload: () => Promise<void>;
  /** Retire an active fork-point lookup before a mutation. */
  cancelNavigation: () => void;
  /** Dismiss the view-owned commit context menu. */
  dismissMenu: () => void;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isCancellation = (message: string): boolean => /git network operation cancelled/i.test(message);

export function createGitGraphActions(options: GitGraphActionsOptions) {
  const { repoPath, reload, cancelNavigation, dismissMenu } = options;
  // Inline name prompt for Create Branch / Create Tag.
  let prompt = $state<NamePrompt | null>(null);
  let renamePrompt = $state<RenamePrompt | null>(null);
  let actionModal = $state<ActionModal | null>(null);
  let undoConfirmation = $state<GitUndoAction | null>(null);
  // Pull offer after checking out a branch whose upstream is ahead (#377).
  let pullOffer = $state<PullOffer | null>(null);
  let fetching = $state(false);

  const refresh = () => refreshAfterGitMutation(repoPath, reload);

  function closeMenu(): void {
    dismissMenu();
    prompt = null;
  }

  /** Run a mutating action, then reload the graph and refresh the SCM panel
   *  (always — a conflicting op still mutates the repo). */
  async function run(label: string, fn: () => Promise<void | GitUndoAction | null>): Promise<void> {
    cancelNavigation();
    closeMenu();
    try {
      const undoAction = await fn();
      if (undoAction) gitUndoLedger.record(repoPath, undoAction);
      toastStore.success(`${label} done`);
    } catch (err) {
      const message = errorMessage(err);
      if (isCancellation(message)) {
        toastStore.show(message, "info");
      } else {
        toastStore.error(message);
      }
    } finally {
      // Invalidate before reloading; notification after publication would
      // evict the freshly cached snapshot. The mounted graph ignores its
      // local event, so the shared reload remains the only refresh (#432).
      await refresh();
    }
  }

  /** Checkout from the context menu: a branch (attached) or the OID
   *  (detached). Only after a SUCCESSFUL branch checkout is a pull offered —
   *  a pull acts on the current branch, so offering it after a failure would
   *  pull the wrong branch. */
  function checkout(branch: string | null, oid: string): void {
    closeMenu();
    void (async () => {
      try {
        await gitCheckout(repoPath, branch ?? oid);
        toastStore.success("Checkout done");
        if (branch) {
          try {
            const behind = await gitBranchBehindUpstream(repoPath, branch);
            if (behind !== null && behind > 0) pullOffer = { branch, behind };
          } catch {
            /* no upstream info — nothing to offer */
          }
        }
      } catch (err) {
        toastStore.error(errorMessage(err));
      } finally {
        await refresh();
      }
    })();
  }

  /** Tracking checkout of a remote-only branch (#432): create/switch to a
   *  local branch tracking `<remote>/<branch>`. */
  function checkoutTracking(chip: RemoteRefChip): void {
    closeMenu();
    void (async () => {
      try {
        await gitCheckoutTracking(repoPath, chip.remote, chip.branch);
        toastStore.success(`Checked out ${chip.branch} (tracking ${chip.name})`);
      } catch (err) {
        toastStore.error(errorMessage(err));
      } finally {
        await refresh();
      }
    })();
  }

  /** Delete a local branch; optionally its counterpart on each tracking
   *  remote (#371). Safe (-d) unless `force`; git's refusals (unmerged,
   *  checked out) surface as the toast. */
  function deleteBranch(name: string, force: boolean, remotes: string[]): void {
    void run(`Delete branch '${name}'`, async () => {
      const undoAction = await gitDeleteBranch(repoPath, name, force);
      // Record the completed local mutation before touching remotes: a remote
      // push failure must not strand the already-deleted local branch.
      gitUndoLedger.record(repoPath, undoAction);
      for (const remote of remotes) {
        await runGitNetworkOperation(repoPath, `push to ${remote}`, (taskId) =>
          gitDeleteRemoteBranch(repoPath, remote, name, taskId),
        );
      }
      return null;
    });
  }

  async function confirmUndo(): Promise<void> {
    const pending = undoConfirmation;
    undoConfirmation = null;
    if (!pending) return;
    // Remove before invoking: a stale/refused action must not repeatedly offer
    // a now-impossible inverse. Cancellation never reaches this path.
    const latest = gitUndoLedger.peek(repoPath);
    if (!latest || !sameGitUndoAction(latest.action, pending)) {
      toastStore.error("Git undo history changed while confirmation was open");
      return;
    }
    const entry = gitUndoLedger.take(repoPath);
    if (!entry) return;
    const description = gitUndoDescription(entry.action);
    try {
      await gitUndo(repoPath, entry.action);
      toastStore.show(`Undo: ${description}`, "info");
    } catch (err) {
      toastStore.error(errorMessage(err));
    } finally {
      await refresh();
    }
  }

  /** F5 (#370): refresh INCLUDING a fetch from every remote, so remote-branch
   *  chips and ahead/behind state update — a plain reload only re-reads local
   *  refs. Guarded against overlap; failures (offline, auth) toast git's own
   *  message but still reload local state. `prepare` runs once the overlap
   *  guard has admitted this refresh. */
  async function refreshWithFetch(prepare: () => void): Promise<void> {
    if (fetching) return;
    cancelNavigation();
    prepare();
    fetching = true;
    // Immediate feedback (#417): the fetch can take seconds, and without an
    // opening toast F5 looks like it did nothing.
    toastStore.show("Refreshing graph…", "info");
    try {
      await runGitNetworkOperation(repoPath, "fetch", (taskId) => gitFetch(repoPath, taskId));
      // Optional local-branch sync (#432): fast-forward every local branch
      // strictly behind its upstream. Diverged branches are never touched —
      // they're surfaced in a toast so the user knows a manual merge is due.
      if (settingsStore.f5SyncsLocalBranches) {
        try {
          const sync = await gitSyncLocalBranches(repoPath);
          if (sync.diverged.length > 0) {
            toastStore.show(
              `Diverged (not synced): ${sync.diverged.join(", ")}`,
              "error",
              { duration: 6000 },
            );
          }
          if (sync.fast_forwarded.length > 0) {
            toastStore.success(
              `Fast-forwarded ${sync.fast_forwarded.length} branch${sync.fast_forwarded.length === 1 ? "" : "es"}`,
            );
          } else {
            toastStore.success("Fetched from remotes");
          }
        } catch (err) {
          toastStore.error(errorMessage(err));
        }
      } else {
        toastStore.success("Fetched from remotes");
      }
    } catch (err) {
      const message = errorMessage(err);
      if (isCancellation(message)) {
        toastStore.show("Git fetch cancelled", "info");
      } else {
        toastStore.error(message);
      }
    } finally {
      fetching = false;
      await refresh();
    }
  }

  return {
    get prompt() { return prompt; },
    set prompt(value: NamePrompt | null) { prompt = value; },
    get renamePrompt() { return renamePrompt; },
    set renamePrompt(value: RenamePrompt | null) { renamePrompt = value; },
    get actionModal() { return actionModal; },
    set actionModal(value: ActionModal | null) { actionModal = value; },
    get undoConfirmation() { return undoConfirmation; },
    set undoConfirmation(value: GitUndoAction | null) { undoConfirmation = value; },
    get pullOffer() { return pullOffer; },
    set pullOffer(value: PullOffer | null) { pullOffer = value; },
    get fetching() { return fetching; },

    closeMenu,
    run,
    checkout,
    checkoutTarget: (target: string) => run("Checkout", () => gitCheckout(repoPath, target)),
    checkoutTracking,
    cherryPick: (oid: string) => run("Cherry-pick", () => gitCherryPick(repoPath, oid)),
    revert: (oid: string) => run("Revert", () => gitRevert(repoPath, oid)),
    merge: (target: string) => run("Merge", () => gitMerge(repoPath, target)),
    rebase: (oid: string) => run("Rebase", () => gitRebase(repoPath, oid)),
    reset: (oid: string, mode: ResetMode) => run(`Reset (${mode})`, () => gitReset(repoPath, oid, mode)),
    stashApply: (stash: string) => run("Apply stash", () => gitStashApply(repoPath, stash)),
    stashPop: (stash: string) => run("Pop stash", () => gitStashPop(repoPath, stash)),
    deleteBranch,
    deleteTag: (name: string) => run(`Delete tag '${name}'`, () => gitDeleteTag(repoPath, name)),
    /** Delete a remote-only branch chip like "origin/feat/x" (#371). */
    deleteRemoteChip: (chip: RemoteRefChip) =>
      run(`Delete ${chip.name}`, () =>
        runGitNetworkOperation(repoPath, `push to ${chip.remote}`, (taskId) =>
          gitDeleteRemoteBranch(repoPath, chip.remote, chip.branch, taskId),
        ),
      ),

    confirmPull(): void {
      pullOffer = null;
      void run("Pull", () =>
        runGitNetworkOperation(repoPath, "pull", (taskId, onPhase) => gitPull(repoPath, taskId, onPhase)),
      );
    },

    /** Open a suboption modal (#406), closing the context menu behind it. */
    openActionModal(modal: ActionModal): void {
      actionModal = modal;
      dismissMenu();
    },
    /** Run the chosen modal action and dismiss the modal. The action runs
     *  FIRST: callers' closures may read the modal through a derived that
     *  recomputes to null the instant actionModal clears. */
    confirmModalAction(fn: () => void): void {
      fn();
      actionModal = null;
    },

    startPrompt(kind: "branch" | "tag", oid: string): void {
      prompt = { kind, oid, value: "" };
      dismissMenu();
    },
    confirmPrompt(): void {
      if (!prompt) return;
      const { kind, oid, value } = prompt;
      const name = value.trim();
      if (name.length === 0) {
        prompt = null;
        return;
      }
      prompt = null;
      if (kind === "branch") {
        void run("Create branch", () => gitCreateBranch(repoPath, name, oid, false));
      } else {
        void run("Create tag", () => gitCreateTag(repoPath, name, oid));
      }
    },

    startRenameBranch(name: string): void {
      renamePrompt = { oldName: name, value: name };
      dismissMenu();
    },
    confirmRenameBranch(): void {
      if (!renamePrompt) return;
      const { oldName } = renamePrompt;
      const newName = renamePrompt.value.trim();
      renamePrompt = null;
      if (!newName || newName === oldName) return;
      void run(`Rename branch '${oldName}' to '${newName}'`, () =>
        gitRenameBranch(repoPath, oldName, newName),
      );
    },

    requestUndo(): void {
      closeMenu();
      const entry = gitUndoLedger.peek(repoPath);
      if (!entry) {
        toastStore.show("Nothing to undo in this git graph", "info");
        return;
      }
      undoConfirmation = entry.action;
    },
    confirmUndo,

    async copyToClipboard(text: string, what: string): Promise<void> {
      closeMenu();
      try {
        await navigator.clipboard.writeText(text);
        toastStore.clipboard(`Copied ${what}`, false);
      } catch {
        toastStore.error(`Could not copy ${what}`);
      }
    },

    refreshWithFetch,
  };
}

export type GitGraphActions = ReturnType<typeof createGitGraphActions>;
