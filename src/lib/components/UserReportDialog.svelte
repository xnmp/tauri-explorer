<script lang="ts">
  import {
    readClipboardReportImage,
    submitUserReport,
  } from "$lib/api/user-report";
  import { openExternalUrl } from "$lib/api/crash";
  import { clipboardHasImage } from "$lib/api/files";
  import {
    userReportAttachmentBytes,
    userReportAttachmentFailureMessage,
    userReportFallbackUrl,
    validateUserReportAttachmentFiles,
    type UserReportAttachment,
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
  let attachments = $state<UserReportAttachment[]>([]);
  let attachmentError = $state("");
  let clipboardImageAvailable = $state(false);
  let clipboardAttachmentData = $state<string | null>(null);
  let readingClipboard = $state(false);
  let submitting = $state(false);
  const canSubmit = $derived(
    title.trim().length > 0 && body.trim().length > 0 && !submitting,
  );
  const clipboardImageAttached = $derived(
    clipboardAttachmentData !== null
      && attachments.some((attachment) => attachment.data === clipboardAttachmentData),
  );

  $effect(() => {
    if (!open) return;
    kind = initialKind;
    title = "";
    body = "";
    contact = "";
    attachments = [];
    attachmentError = "";
    clipboardImageAvailable = false;
    clipboardAttachmentData = null;
    readingClipboard = false;
    submitting = false;
    void probeClipboardImage();
  });

  function attachmentUsage() {
    return {
      count: attachments.length,
      bytes: attachments.reduce(
        (total, attachment) => total + userReportAttachmentBytes(attachment.data),
        0,
      ),
    };
  }

  async function probeClipboardImage(): Promise<void> {
    clipboardImageAvailable = await clipboardHasImage();
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    const selected = Array.from(files);
    const error = validateUserReportAttachmentFiles(selected, attachmentUsage());
    if (error) {
      attachmentError = error;
      return;
    }
    const next = await Promise.all(selected.map(async (file): Promise<UserReportAttachment> => ({
      name: file.name,
      mediaType: file.type as UserReportAttachment["mediaType"],
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    })));
    // A second picker change can complete while these reads are in flight.
    // Revalidate against the latest immutable selection before committing.
    const currentError = validateUserReportAttachmentFiles(selected, attachmentUsage());
    if (currentError) {
      attachmentError = currentError;
      return;
    }
    attachments = [...attachments, ...next];
    attachmentError = "";
  }

  async function attachClipboardImage(): Promise<void> {
    if (readingClipboard) return;
    readingClipboard = true;
    try {
      const image = await readClipboardReportImage();
      const error = validateUserReportAttachmentFiles(
        [{
          name: image.name,
          type: image.mediaType,
          size: userReportAttachmentBytes(image.data),
        }],
        attachmentUsage(),
      );
      if (error) {
        attachmentError = error;
        return;
      }
      attachments = [...attachments, image];
      clipboardAttachmentData = image.data;
      attachmentError = "";
    } catch {
      attachmentError = "Could not read the clipboard image. Try saving it and selecting the file.";
    } finally {
      readingClipboard = false;
    }
  }

  function removeAttachment(index: number): void {
    attachments = attachments.filter((_, attachmentIndex) => attachmentIndex !== index);
    attachmentError = "";
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    submitting = true;
    const draft: UserReportDraft = { title, body, kind, contact, attachments };
    try {
      const issue = await submitUserReport(draft);
      onClose();
      toastStore.show("Report submitted", "success", {
        duration: 6000,
        link: { url: issue.url, label: `Issue #${issue.number}` },
      });
    } catch (unknownError) {
      const error = unknownError as Partial<UserReportError>;
      if (attachments.length > 0) {
        attachmentError = userReportAttachmentFailureMessage(error.kind);
        toastStore.show(
          attachmentError,
          "error",
          { duration: 8000 },
        );
        return;
      }
      const dailyCap = error.kind === "daily_cap";
      toastStore.show(
        dailyCap
          ? "Reports are temporarily unavailable — opening GitHub instead"
          : "Could not submit in-app — opening GitHub instead",
        "error",
        { duration: 6000 },
      );
      const fallbackUrl = userReportFallbackUrl(draft);
      if (!fallbackUrl) {
        toastStore.show(
          "Report is too long for GitHub’s browser form — your report is still here. Copy it and try again.",
          "error",
          { duration: 8000 },
        );
        return;
      }
      try {
        await openExternalUrl(fallbackUrl);
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

    <section class="attachments" aria-label="Image attachments">
      <div class="attachment-heading">
        <span>Images (optional)</span>
        <div class="attachment-actions">
          {#if clipboardImageAvailable && !clipboardImageAttached}
            <button
              type="button"
              class="btn secondary compact"
              disabled={submitting || readingClipboard}
              onclick={() => void attachClipboardImage()}
            >
              {readingClipboard ? "Reading clipboard…" : "Attach from clipboard"}
            </button>
          {/if}
          <label class="btn secondary compact file-picker">
            Add images
            <input
              aria-label="Add images"
              type="file"
              accept="image/png,image/jpeg,image/gif"
              multiple
              disabled={submitting}
              onchange={(event) => {
                const input = event.currentTarget;
                if (input.files) void addFiles(input.files);
                input.value = "";
              }}
            />
          </label>
        </div>
      </div>
      <p class="attachment-hint">PNG, JPEG, or GIF. Up to 3 images, 2 MiB each and 3 MiB total.</p>
      {#if attachmentError}
        <p class="attachment-error" role="alert">{attachmentError}</p>
      {/if}
      {#if attachments.length > 0}
        <ul class="attachment-list">
          {#each attachments as attachment, index}
            <li>
              <img
                src={`data:${attachment.mediaType};base64,${attachment.data}`}
                alt={attachment.name}
              />
              <span title={attachment.name}>{attachment.name}</span>
              <button
                type="button"
                class="remove-attachment"
                aria-label={`Remove ${attachment.name}`}
                disabled={submitting}
                onclick={() => removeAttachment(index)}
              >×</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <footer>
      <span class="hint">Ctrl+Enter to submit</span>
      <button type="button" class="btn secondary" onclick={onClose} disabled={submitting}>Cancel</button>
      <button type="submit" class="btn primary" disabled={!canSubmit}>
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </footer>
  </form>
</Modal>

<style>
  .user-report-dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow-y: auto;
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
  .attachments {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .attachment-heading, .attachment-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .attachment-heading {
    justify-content: space-between;
    font-size: 13px;
  }
  .attachment-actions { flex-wrap: wrap; justify-content: flex-end; }
  .compact { padding: 6px 10px; font-size: 12px; }
  .file-picker { cursor: pointer; }
  .file-picker input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
  }
  .attachment-hint, .attachment-error {
    margin: 0;
    font-size: 12px;
  }
  .attachment-hint { color: var(--text-secondary); }
  .attachment-error { color: var(--danger, #d13438); }
  .attachment-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .attachment-list li {
    position: relative;
    min-width: 0;
    padding: 6px;
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-sm);
    background: var(--surface-secondary);
  }
  .attachment-list img {
    display: block;
    width: 100%;
    height: 72px;
    border-radius: calc(var(--radius-sm) - 2px);
    object-fit: cover;
  }
  .attachment-list span {
    display: block;
    margin-top: 5px;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove-attachment {
    position: absolute;
    top: 9px;
    right: 9px;
    width: 22px;
    height: 22px;
    border: 1px solid rgb(255 255 255 / 45%);
    border-radius: 50%;
    background: rgb(0 0 0 / 70%);
    color: white;
    line-height: 18px;
  }
  footer { gap: 8px; }
  .hint { margin-right: auto; color: var(--text-secondary); font-size: 12px; }
</style>
