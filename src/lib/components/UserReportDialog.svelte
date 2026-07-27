<script lang="ts">
  import { submitUserReport } from "$lib/api/user-report";
  import { openExternalUrl } from "$lib/api/crash";
  import {
    userReportFallbackUrl,
    type UserReportDraft,
    type UserReportError,
    type UserReportKind,
  } from "$lib/domain/user-report";
  import { toastStore } from "$lib/state/toast.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    open: boolean;
    initialKind: UserReportKind;
    onClose: () => void;
  }

  let { open, initialKind, onClose }: Props = $props();
  let kind = $state<UserReportKind>("bug");
  let title = $state("");
  let body = $state("");
  let contact = $state("");
  let submitting = $state(false);
  const canSubmit = $derived(
    title.trim().length > 0 && body.trim().length > 0 && !submitting,
  );

  $effect(() => {
    if (!open) return;
    kind = initialKind;
    title = "";
    body = "";
    contact = "";
    submitting = false;
  });

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    submitting = true;
    const draft: UserReportDraft = { title, body, kind, contact };
    try {
      const issue = await submitUserReport(draft);
      onClose();
      toastStore.show("Report submitted", "success", {
        duration: 6000,
        link: { url: issue.url, label: `Issue #${issue.number}` },
      });
    } catch (unknownError) {
      const error = unknownError as Partial<UserReportError>;
      const dailyCap = error.kind === "daily_cap";
      toastStore.show(
        dailyCap
          ? "Reports are temporarily unavailable — opening GitHub instead"
          : "Could not submit in-app — opening GitHub instead",
        "error",
        { duration: 6000 },
      );
      try {
        await openExternalUrl(userReportFallbackUrl(draft));
        onClose();
      } catch {
        toastStore.show(
          "Could not open GitHub — your report is still here. Copy it and try again.",
          "error",
          { duration: 8000 },
        );
      }
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }
</script>

<Modal
  {open}
  {onClose}
  overlayClass="dialog-backdrop user-report-backdrop"
  label={kind === "bug" ? "Report a Bug" : "Request a Feature"}
  onkeydown={handleKeydown}
  closeOnBackdrop={!submitting}
  closeOnEscape={!submitting}
>
  <form class="modal-card user-report-dialog" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <header>
      <h2>{kind === "bug" ? "Report a Bug" : "Request a Feature"}</h2>
      <button type="button" class="close" aria-label="Close" onclick={onClose} disabled={submitting}>×</button>
    </header>

    <div class="kind-toggle" aria-label="Report type">
      <button type="button" class:active={kind === "bug"} onclick={() => (kind = "bug")}>Bug</button>
      <button type="button" class:active={kind === "feature"} onclick={() => (kind = "feature")}>Feature</button>
    </div>

    <label>
      <span>Title</span>
      <!-- svelte-ignore a11y_autofocus -- Modal traps and restores focus; the title is the deliberate first step in this short report flow. -->
      <input bind:value={title} maxlength="120" required autofocus />
    </label>
    <label>
      <span>Description</span>
      <textarea bind:value={body} maxlength="8000" rows="8" required></textarea>
    </label>
    <label>
      <span>How can we reach you? (GitHub handle, email — optional)</span>
      <input bind:value={contact} maxlength="100" />
    </label>

    <footer>
      <span class="hint">Ctrl+Enter to submit</span>
      <button type="button" onclick={onClose} disabled={submitting}>Cancel</button>
      <button type="submit" class="primary" disabled={!canSubmit}>
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </footer>
  </form>
</Modal>

<style>
  .user-report-dialog {
    width: min(560px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  header, footer, .kind-toggle {
    display: flex;
    align-items: center;
  }
  header, footer { justify-content: space-between; }
  h2 { font-size: 18px; }
  .close { border: 0; background: transparent; font-size: 22px; }
  .kind-toggle {
    align-self: flex-start;
    background: var(--surface-secondary);
    border-radius: var(--radius-md);
    padding: 2px;
  }
  .kind-toggle button {
    border: 0;
    background: transparent;
    padding: 6px 16px;
    border-radius: calc(var(--radius-md) - 2px);
  }
  .kind-toggle button.active {
    background: var(--accent);
    color: var(--text-on-accent, white);
  }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  input, textarea {
    width: 100%;
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text-primary);
    padding: 9px 10px;
    font: inherit;
  }
  textarea { resize: vertical; min-height: 130px; }
  footer { gap: 8px; }
  .hint { margin-right: auto; color: var(--text-secondary); font-size: 12px; }
  footer button { padding: 7px 16px; }
  footer .primary { background: var(--accent); color: var(--text-on-accent, white); }
</style>
