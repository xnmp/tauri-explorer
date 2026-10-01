<script lang="ts">
  import {
    readClipboardReportImage,
    submitUserReport,
  } from "$lib/api/user-report";
  import { openExternalUrl } from "$lib/api/crash";
  import { clipboardHasImage } from "$lib/api/clipboard-image";
  import {
    MAX_USER_REPORT_CONTACT_UNITS,
    MAX_USER_REPORT_DESCRIPTION_UNITS,
    MAX_USER_REPORT_TITLE_UNITS,
    userReportAttachmentFailureMessage,
    userReportFallbackNotice,
    userReportFallbackUrl,
    type UserReportAttachment,
    type UserReportDraft,
    type UserReportError,
  } from "$lib/domain/user-report";
  import { userReportDraftStore } from "$lib/state/user-report-draft.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }


  let { open, onClose }: Props = $props();
  let attachmentError = $state("");
  let clipboardImageAvailable = $state(false);
  const textDraft = $derived(userReportDraftStore.value);
  const attachments = $derived(userReportDraftStore.attachments);
  const readingClipboard = $derived(userReportDraftStore.readingClipboard);
  const readingAttachments = $derived(userReportDraftStore.readingAttachments);
  const submitting = $derived(userReportDraftStore.submitting);
  const canSubmit = $derived(
    textDraft.title.trim().length > 0 && !submitting && !readingAttachments,
  );
  const clipboardImageAttached = $derived(
    userReportDraftStore.clipboardAttachmentData !== null
      && attachments.some((attachment) => attachment.data === userReportDraftStore.clipboardAttachmentData),
  );

  $effect(() => {
    if (!open) return;
    attachmentError = "";
    clipboardImageAvailable = false;
    void probeClipboardImage();
  });

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
    const error = await userReportDraftStore.attachFiles(
      selected,
      () => Promise.all(selected.map(async (file): Promise<UserReportAttachment> => ({
        name: file.name,
        mediaType: file.type as UserReportAttachment["mediaType"],
        data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      }))),
    );
    attachmentError = error ?? "";
  }

  async function attachClipboardImage(): Promise<void> {
    if (readingClipboard) return;
    const error = await userReportDraftStore.attachClipboard(readClipboardReportImage);
    attachmentError = error ?? "";
  }

  function removeAttachment(index: number): void {
    userReportDraftStore.removeAttachment(index);
    attachmentError = "";
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    const draft: UserReportDraft = {
      title: textDraft.title,
      body: textDraft.body,
      kind: textDraft.kind,
      contact: textDraft.contact,
      attachments: [...attachments],
    };
    const submission = userReportDraftStore.beginSubmission();
    if (!submission) return;
    onClose();
    // The dialog closes the moment Submit is pressed, so until the relay
    // answers this toast is the ONLY sign the report went anywhere (#596).
    // The "progress" type matters: `show` replaces same-type toasts, so an
    // "info" indicator would be deleted by an ordinary "Refreshed" — or by a
    // copy finishing in another window, which broadcasts one.
    const pendingToastId = toastStore.show("Submitting report…", "progress");
    // Retire it BEFORE each outcome toast, not after: the GitHub-fallback path
    // awaits a browser launch between the two, which is long enough for both
    // to be on screen at once. The `finally` is the backstop for any path that
    // returns without reaching one of these.
    const retirePendingToast = () => toastStore.dismiss(pendingToastId);
    try {
      const issue = await submitUserReport(draft);
      userReportDraftStore.finishSubmission(submission, true);
      retirePendingToast();
      toastStore.show("Report submitted", "success", {
        duration: 6000,
        link: { url: issue.url, label: `Issue #${issue.number}` },
      });
    } catch (unknownError) {
      retirePendingToast();
      const error = unknownError as Partial<UserReportError>;
      if (error.kind === "submission_uncertain") {
        toastStore.show(
          "The report may have been submitted. Check recent issues before retrying. Text is saved; images remain until this window closes.",
          "error",
          { duration: 10000 },
        );
        return;
      }
      if ((draft.attachments?.length ?? 0) > 0) {
        const fallbackUrl = userReportFallbackUrl(draft);
        toastStore.show(
          `${userReportAttachmentFailureMessage(error.kind)}${fallbackUrl ? " Opening GitHub; add the images there manually." : ""}`,
          "error",
          { duration: 8000 },
        );
        if (fallbackUrl) {
          try {
            await openExternalUrl(fallbackUrl);
          } catch {
            toastStore.show(
              "Could not open GitHub. Your draft is saved; reopen Report Issue to retry.",
              "error",
              { duration: 8000 },
            );
          }
        }
        return;
      }
      toastStore.show(
        userReportFallbackNotice(error.kind),
        "error",
        { duration: 6000 },
      );
      const fallbackUrl = userReportFallbackUrl(draft);
      if (!fallbackUrl) {
        toastStore.show(
          "Report is too long for GitHub’s browser form. Your draft is saved; reopen Report Issue to retry.",
          "error",
          { duration: 8000 },
        );
        return;
      }
      try {
        await openExternalUrl(fallbackUrl);
      } catch {
        toastStore.show(
          "Could not open GitHub. Your draft is saved; reopen Report Issue to retry.",
          "error",
          { duration: 8000 },
        );
      }
    } finally {
      retirePendingToast();
      userReportDraftStore.finishSubmission(submission);
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
  label="Report Issue"
  onkeydown={handleKeydown}
>
  <form class="modal-card user-report-dialog" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <header>
      <h2>Report Issue</h2>
      <button type="button" class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>

    <div class="kind-toggle" role="group" aria-label="Report type">
      <button
        type="button"
        class:active={textDraft.kind === "bug"}
        aria-pressed={textDraft.kind === "bug"}
        onclick={() => userReportDraftStore.update({ kind: "bug" })}
      >Bug</button>
      <button
        type="button"
        class:active={textDraft.kind === "feature"}
        aria-pressed={textDraft.kind === "feature"}
        onclick={() => userReportDraftStore.update({ kind: "feature" })}
      >Feature</button>
    </div>

    <label>
      <span>Title</span>
      <!-- svelte-ignore a11y_autofocus -- Modal traps and restores focus; the title is the deliberate first step in this short report flow. -->
      <input
        bind:value={() => textDraft.title, (title) => userReportDraftStore.update({ title })}
        maxlength={MAX_USER_REPORT_TITLE_UNITS}
        required
        autofocus
      />
    </label>
    <label>
      <span>Description (optional)</span>
      <textarea
        bind:value={() => textDraft.body, (body) => userReportDraftStore.update({ body })}
        maxlength={MAX_USER_REPORT_DESCRIPTION_UNITS}
        rows="8"
      ></textarea>
    </label>
    <label>
      <span>How can we reach you? (GitHub handle, email — optional)</span>
      <input
        bind:value={() => textDraft.contact, (contact) => userReportDraftStore.update({ contact })}
        maxlength={MAX_USER_REPORT_CONTACT_UNITS}
      />
    </label>

    <section class="attachments" aria-label="Image attachments">
      <div class="attachment-heading">
        <span>Images (optional)</span>
        <div class="attachment-actions">
          {#if !clipboardImageAttached}
            <button
              type="button"
              class="btn secondary compact"
              disabled={submitting || readingClipboard || !clipboardImageAvailable}
              title={clipboardImageAvailable ? undefined : "No image in clipboard"}
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
      <p class="attachment-hint">PNG, JPEG, or GIF. Up to 3 images, 2 MiB each and 3 MiB total. Failed images can be retried until this window closes.</p>
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

    <p class="report-disclosure">
      Submitting creates a public GitHub issue. Your description, optional contact details,
      app and OS version, and any images will be public. Images are uploaded to public hosting.
      Local logs are not attached automatically.
    </p>

    <footer>
      <span class="hint">Ctrl+Enter to submit</span>
      <button type="button" class="btn secondary" onclick={onClose}>{submitting ? "Close" : "Cancel"}</button>
      <button type="submit" class="btn primary" disabled={!canSubmit}>
        {submitting ? "Submitting…" : readingAttachments ? "Reading images…" : "Submit"}
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
  .report-disclosure {
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.45;
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
  .attachment-error { color: var(--system-critical-text, var(--system-critical)); }
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
