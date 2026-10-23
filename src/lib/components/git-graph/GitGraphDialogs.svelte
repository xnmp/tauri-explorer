<!--
  GitGraphDialogs — the git graph's confirmation surfaces: branch rename and
  create-branch/tag name prompts, the post-checkout pull offer (#377), the
  reset/delete suboption modals (#406), GitHub PR action confirmation
  (#1082) and the session undo confirmation (#513). State and actions live
  in state/git-graph-actions and state/git-graph-pr-dialog.
-->
<script lang="ts">
  import { gitUndoDescription } from "$lib/domain/git-graph-undo";
  import type { GitGraphActions } from "$lib/state/git-graph-actions.svelte";
  import type { GitGraphPrDialog } from "$lib/state/git-graph-pr-dialog.svelte";
  import type { GitPrSession } from "$lib/state/git-pr-session.svelte";
  import Modal from "../Modal.svelte";

  interface Props {
    repoPath: string;
    actions: GitGraphActions;
    prDialog: GitGraphPrDialog;
    prSession: GitPrSession;
  }

  const { repoPath, actions, prDialog, prSession }: Props = $props();

  const prActionBusy = $derived(prSession.actionBusy);
  const prActionError = $derived(prSession.actionError);
  const prActionUncertain = $derived(prSession.actionUncertain);

  function prDialogTitle(action: "create" | "merge" | "approve" | undefined): string {
    return action === "create" ? "Create pull request" : action === "merge" ? "Merge pull request" : "Approve pull request";
  }
</script>

{#if actions.renamePrompt}
  <button
    class="menu-backdrop"
    aria-label="Cancel rename"
    onclick={() => (actions.renamePrompt = null)}
    oncontextmenu={(e) => { e.preventDefault(); actions.renamePrompt = null; }}
  ></button>
  <div class="name-prompt" data-testid="git-graph-rename-prompt" role="dialog" aria-label="Rename branch">
    <label class="prompt-label" for="git-graph-rename-input">Rename branch '{actions.renamePrompt.oldName}'</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="git-graph-rename-input"
      class="prompt-input"
      type="text"
      autofocus
      bind:value={actions.renamePrompt.value}
      onkeydown={(e) => { if (e.key === "Enter") actions.confirmRenameBranch(); }}
    />
    <div class="prompt-actions">
      <button class="prompt-btn" onclick={() => (actions.renamePrompt = null)}>Cancel</button>
      <button class="prompt-btn primary" onclick={actions.confirmRenameBranch}>Rename</button>
    </div>
  </div>
{/if}

{#if actions.prompt}
  <button
    class="menu-backdrop"
    aria-label="Cancel"
    onclick={() => (actions.prompt = null)}
    oncontextmenu={(e) => { e.preventDefault(); actions.prompt = null; }}
  ></button>
  <div class="name-prompt" data-testid="git-graph-prompt" role="dialog" aria-label={actions.prompt.kind === "branch" ? "Create branch" : "Create tag"}>
    <label class="prompt-label" for="git-graph-name-input">
      {actions.prompt.kind === "branch" ? "New branch name" : "New tag name"}
    </label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="git-graph-name-input"
      class="prompt-input"
      type="text"
      autofocus
      bind:value={actions.prompt.value}
      onkeydown={(e) => { if (e.key === "Enter") actions.confirmPrompt(); }}
      placeholder={actions.prompt.kind === "branch" ? "feature/my-branch" : "v1.2.3"}
    />
    <div class="prompt-actions">
      <button class="prompt-btn" onclick={() => (actions.prompt = null)}>Cancel</button>
      <button class="prompt-btn primary" onclick={actions.confirmPrompt}>
        {actions.prompt.kind === "branch" ? "Create branch" : "Create tag"}
      </button>
    </div>
  </div>
{/if}

{#if actions.pullOffer}
  <button
    class="menu-backdrop"
    aria-label="Dismiss pull offer"
    onclick={() => (actions.pullOffer = null)}
    oncontextmenu={(e) => { e.preventDefault(); actions.pullOffer = null; }}
  ></button>
  <div class="name-prompt" data-testid="git-graph-pull-offer" role="dialog" aria-label="Pull from upstream">
    <span class="prompt-label">
      The remote is ahead of '{actions.pullOffer.branch}' by {actions.pullOffer.behind}
      commit{actions.pullOffer.behind === 1 ? "" : "s"}. Pull now?
    </span>
    <div class="prompt-actions">
      <button class="prompt-btn" onclick={() => (actions.pullOffer = null)}>Not now</button>
      <button class="prompt-btn primary" onclick={actions.confirmPull}>Pull</button>
    </div>
  </div>
{/if}

{#if actions.actionModal}
  <!-- Suboption modal (#406): reset modes / delete-branch variants. -->
  <button
    class="menu-backdrop"
    aria-label="Cancel"
    onclick={() => (actions.actionModal = null)}
    oncontextmenu={(e) => { e.preventDefault(); actions.actionModal = null; }}
  ></button>
  {#if actions.actionModal.kind === "reset"}
    {@const modal = actions.actionModal}
    <div class="name-prompt action-modal" data-testid="git-graph-action-modal" role="dialog" aria-label="Reset current branch">
      <span class="prompt-label">Reset current branch to “{modal.summary}”</span>
      <div class="modal-options">
        <button class="prompt-btn modal-option" onclick={() => actions.confirmModalAction(() => void actions.reset(modal.oid, "soft"))}>
          <span class="mo-title">Soft</span><span class="mo-desc">keep changes &amp; index</span>
        </button>
        <button class="prompt-btn modal-option" onclick={() => actions.confirmModalAction(() => void actions.reset(modal.oid, "mixed"))}>
          <span class="mo-title">Mixed</span><span class="mo-desc">keep changes, reset index</span>
        </button>
        <button class="prompt-btn modal-option danger" onclick={() => actions.confirmModalAction(() => void actions.reset(modal.oid, "hard"))}>
          <span class="mo-title">Hard</span><span class="mo-desc">discard all changes</span>
        </button>
      </div>
      <div class="prompt-actions">
        <button class="prompt-btn" onclick={() => (actions.actionModal = null)}>Cancel</button>
      </div>
    </div>
  {:else if actions.actionModal.kind === "deleteBranch"}
    {@const modal = actions.actionModal}
    <div class="name-prompt action-modal" data-testid="git-graph-action-modal" role="dialog" aria-label="Delete branch">
      <span class="prompt-label">Delete branch '{modal.name}'</span>
      <div class="modal-options">
        <button class="prompt-btn modal-option" onclick={() => actions.confirmModalAction(() => actions.deleteBranch(modal.name, false, []))}>
          <span class="mo-title">Delete</span><span class="mo-desc">refuse if unmerged</span>
        </button>
        <button class="prompt-btn modal-option danger" onclick={() => actions.confirmModalAction(() => actions.deleteBranch(modal.name, true, []))}>
          <span class="mo-title">Force delete</span><span class="mo-desc">even if unmerged</span>
        </button>
        {#if modal.remotes.length > 0}
          <button class="prompt-btn modal-option danger" onclick={() => actions.confirmModalAction(() => actions.deleteBranch(modal.name, false, modal.remotes))}>
            <span class="mo-title">Delete + remote</span><span class="mo-desc">{modal.remotes.join(", ")}</span>
          </button>
        {/if}
      </div>
      <div class="prompt-actions">
        <button class="prompt-btn" onclick={() => (actions.actionModal = null)}>Cancel</button>
      </div>
    </div>
  {:else}
    {@const modal = actions.actionModal}
    <div class="name-prompt action-modal" data-testid="git-graph-action-modal" role="dialog" aria-label="Delete tag">
      <span class="prompt-label">Delete tag '{modal.name}'?</span>
      <p class="modal-warning">The tag can be restored with Ctrl+Z while this session remains open.</p>
      <div class="prompt-actions">
        <button class="prompt-btn" onclick={() => (actions.actionModal = null)}>Cancel</button>
        <button class="prompt-btn danger" onclick={() => actions.confirmModalAction(() => void actions.deleteTag(modal.name))}>Delete</button>
      </div>
    </div>
  {/if}
{/if}

<Modal open={prDialog.dialog !== null} label={prDialogTitle(prDialog.dialog?.action)} onClose={() => { if (!prActionBusy) prDialog.close(); }} canClose={() => !prActionBusy}>
  {#if prDialog.dialog}
    <form class="modal-card pr-action-card" onsubmit={(event) => { event.preventDefault(); void prDialog.submit(); }}>
      <div class="dialog-header">
        <h2>{prDialogTitle(prDialog.dialog.action)}</h2>
        <p class="dialog-subtitle">Repository: {prDialog.dialog.repoSlug}</p>
        <p class="dialog-subtitle">{prDialog.dialog.action === "create" ? `Current branch: ${prDialog.dialog.headBranch}` : `PR #${prDialog.dialog.prNumber} · ${repoPath}`}</p>
      </div>
      {#if prDialog.dialog.action === "create"}
        <div class="form-field"><label for="pr-title">Title</label><input id="pr-title" data-autofocus required bind:value={prDialog.dialog.title} disabled={prActionBusy} /></div>
        <div class="form-field"><label for="pr-base">Base branch</label><input id="pr-base" required placeholder="e.g. main" bind:value={prDialog.dialog.base} disabled={prActionBusy} /></div>
        <div class="form-field"><label for="pr-body">Description</label><textarea id="pr-body" rows="4" bind:value={prDialog.dialog.body} disabled={prActionBusy}></textarea></div>
        <p class="dialog-subtitle">Push the branch before creating a PR. This creates it on the repository's selected GitHub remote.</p>
      {:else if prDialog.dialog.action === "merge"}
        <div class="form-field"><label for="pr-method">Merge method</label><select id="pr-method" bind:value={prDialog.dialog.method} disabled={prActionBusy}><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select></div>
        <p class="dialog-subtitle">This merges the PR on GitHub. Local branches are kept. GitHub permissions and branch protection still apply.</p>
      {:else}
        <p>Submit an approving review for this PR on GitHub?</p>
      {/if}
      {#if prActionError}<p class="error-message" role="alert">{prActionError}</p>{/if}
      {#if prActionUncertain}<label><input type="checkbox" bind:checked={prDialog.retryAcknowledged} disabled={prActionBusy} /> I checked GitHub and want to retry this action</label>{/if}
      <div class="dialog-actions">
        <button type="button" class="btn secondary" disabled={prActionBusy} onclick={prDialog.close}>Cancel</button>
        <button type="submit" class="btn primary" disabled={prDialog.blocked || (prDialog.dialog.action === "create" && (!prDialog.dialog.title.trim() || !prDialog.dialog.base.trim()))}>{prActionBusy ? "Working…" : prDialog.dialog.action === "create" ? "Create PR" : prDialog.dialog.action === "merge" ? "Merge PR" : "Approve PR"}</button>
      </div>
    </form>
  {/if}
</Modal>

<Modal
  open={actions.undoConfirmation !== null}
  onClose={() => (actions.undoConfirmation = null)}
  role="alertdialog"
  label="Undo git graph operation"
  overlayClass="git-graph-undo-overlay"
>
  {#if actions.undoConfirmation}
    <div class="name-prompt action-modal undo-card" data-testid="git-graph-undo-modal">
      <span class="prompt-label">Undo {gitUndoDescription(actions.undoConfirmation)}?</span>
      <p class="modal-warning">
        The repository will be checked again before anything changes. Undo is refused if refs,
        HEAD, or the working tree no longer match the completed operation.
      </p>
      <div class="prompt-actions">
        <button class="prompt-btn" data-autofocus onclick={() => (actions.undoConfirmation = null)}>Cancel</button>
        <button class="prompt-btn primary" onclick={() => void actions.confirmUndo()}>Undo</button>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .pr-action-card .form-field { margin-top: var(--spacing-md); }
  .pr-action-card textarea, .pr-action-card select { width: 100%; box-sizing: border-box; padding: var(--spacing-sm); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; }
  .pr-action-card textarea:focus, .pr-action-card select:focus { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .pr-action-card textarea { resize: vertical; }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }

  /* Suboption modal (#406): stacked option buttons inside the name-prompt
     dialog shell. */
  .modal-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0;
  }

  .modal-option {
    display: flex;
    align-items: baseline;
    gap: 8px;
    text-align: left;
    justify-content: flex-start;
  }

  .modal-option.danger .mo-title {
    color: var(--system-critical-text, var(--system-critical));
  }

  .mo-title {
    font-weight: 600;
  }

  .mo-desc {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
  }

  /* ----- Name prompt popover (create branch / tag) ----- */

  .name-prompt {
    position: fixed;
    z-index: 42;
    left: 50%;
    top: 30%;
    transform: translateX(-50%);
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 14px 16px;
    background: linear-gradient(var(--background-card, #1e1e1e), var(--background-card, #1e1e1e)), var(--background-solid, #1e1e1e);
    border: 1px solid var(--divider);
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .prompt-label {
    font-size: var(--font-size-body);
    color: var(--text-secondary);
  }

  .modal-warning {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    line-height: 1.4;
  }

  .undo-card {
    position: static;
    transform: none;
    width: 460px;
  }

  .undo-card .prompt-label {
    color: var(--text-primary);
    font-weight: 600;
  }

  .prompt-input {
    width: 100%;
    padding: 6px 8px;
    background: var(--background-input, var(--background-card));
    border: 1px solid var(--divider);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: var(--font-size-body);
    font-family: var(--font-mono, monospace);
  }

  .prompt-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }

  .prompt-btn {
    padding: 5px 12px;
    background: var(--subtle-fill-secondary, transparent);
    border: 1px solid var(--divider);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: var(--font-size-body);
    cursor: pointer;
  }

  .prompt-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
