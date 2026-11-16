<script lang="ts">
  import { onMount } from "svelte";
  import { createTextSettingsController } from "$lib/state/text-connections";
  import { isHttpProfile, type TextConfiguration } from "$lib/domain/text-connections";
  import TextProfileEditor from "./TextProfileEditor.svelte";
  import "../settings/settings-select.css";
  import "../settings/settings-button.css";
  import "../settings/settings-form.css";
  const controller = createTextSettingsController();
  let replacementKey = $state("");
  const profile = $derived($controller.draft?.profiles.find(p => p.id === $controller.selectedProfileId));
  const http = $derived(profile && isHttpProfile(profile) ? profile : null);
  onMount(() => { void controller.start(); return () => controller.dispose(); });
  async function replaceKey() { const key = replacementKey; if (await controller.credential(profile!.id, key)) replacementKey = ""; }
  function selectProfile(id: string) { replacementKey = ""; controller.selectProfile(id); }
</script>
<div class="language-models settings-form" aria-busy={$controller.loading || $controller.saving}>
  <div class="intro">
    <h4>Language models</h4>
    <p class="settings-help">One global text connection for plugin language features. Image connections are configured separately.</p>
  </div>
  {#if $controller.loading}<p role="status" class="settings-help">Loading language model settings…</p>
  {:else if $controller.draft}
    <label class="settings-switch-row"><span>Enable language models</span><input type="checkbox" class="settings-switch" checked={$controller.draft.enabled} disabled={$controller.saving} onchange={e => controller.edit(draft => ({ ...draft, enabled: e.currentTarget.checked }) as TextConfiguration)} /></label>
    <label class="settings-field">Default profile
      <select class="settings-select" value={$controller.draft.defaultProfileId ?? ""} disabled={$controller.saving} onchange={e => controller.edit(draft => ({ ...draft, defaultProfileId: e.currentTarget.value || null }) as TextConfiguration)}>
        <option value="">Select a profile</option>{#each $controller.draft.profiles as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
      </select>
    </label>
    <div class="profile-toolbar">
      <label class="settings-field">Edit profile <select class="settings-select" value={$controller.selectedProfileId ?? ""} disabled={$controller.saving} onchange={e => selectProfile(e.currentTarget.value)}>
        {#if !$controller.draft.profiles.length}<option value="">No profiles</option>{/if}
        {#each $controller.draft.profiles as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
      </select></label>
      <button class="settings-button" disabled={$controller.saving || $controller.draft.profiles.length >= 32} onclick={() => { replacementKey = ""; controller.addProfile(); }}>Add profile</button>
      <button class="settings-button danger" disabled={!profile || $controller.saving || ($controller.draft.enabled && profile.id === $controller.draft.defaultProfileId)} onclick={() => { replacementKey = ""; if (profile) controller.deleteProfile(profile.id); }}>Delete profile</button>
    </div>
    {#if profile}
      <TextProfileEditor {profile} disabled={$controller.saving} onchange={controller.updateProfile} />
      {#if http}
        <fieldset class="settings-group" disabled={$controller.saving || $controller.dirty || $controller.conflict}>
          <legend>API key</legend>
          <p class="settings-help">{http.hasCredential ? "Credential present" : "No credential available"}. Saved keys are never read back. Environment values are resolved by the backend.</p>
          <label class="settings-field">Replacement API key <input autocorrect="off" autocapitalize="none" spellcheck="false" class="settings-input" type="password" autocomplete="new-password" bind:value={replacementKey} placeholder="Enter a new key to store securely" /></label>
          <div class="settings-actions"><button class="settings-button" disabled={!replacementKey.trim()} onclick={replaceKey}>Replace API key</button><button class="settings-button danger" disabled={http.credential.kind === "none"} onclick={() => { replacementKey = ""; void controller.credential(http.id, null); }}>Clear credential</button></div>
        </fieldset>
      {/if}
    {:else}<p class="settings-help">Add a profile to configure a language model.</p>{/if}
    <div class="settings-actions">
      <button class="settings-button primary" disabled={!$controller.dirty || $controller.saving || $controller.conflict} onclick={() => controller.save()}>{$controller.saving ? "Saving…" : "Save language models"}</button>
      <button class="settings-button" disabled={$controller.saving} onclick={() => { replacementKey = ""; void controller.reload(); }}>Reload saved settings</button>
    </div>
    <p class="settings-help">Save edits before checking or testing. Check connection performs local checks only. Test generation sends a minimal request to the saved provider and may incur a charge.</p>
    <div class="settings-actions">
      <button class="settings-button" disabled={!profile || $controller.dirty || $controller.saving || $controller.conflict || !!$controller.pending} onclick={() => controller.run("check")}>Check connection</button>
      <button class="settings-button" disabled={!profile || $controller.dirty || $controller.saving || $controller.conflict || !!$controller.pending} onclick={() => controller.run("test")}>Test generation</button>
      {#if $controller.pending === "test"}<button class="settings-button" onclick={controller.cancel}>Cancel test</button>{/if}
    </div>
    {#if $controller.pending}<p role="status" class="settings-help">{$controller.pending === "check" ? "Checking locally…" : "Testing generation…"}</p>{/if}
  {:else}<div class="settings-actions"><button class="settings-button" onclick={() => controller.reload()}>Retry loading</button></div>{/if}
  {#if $controller.conflict}<p role="alert" class="message">Another window changed these settings. Reload saved settings to resolve the conflict. Your current draft has been kept.</p>{/if}
  {#if $controller.error}<p role="alert" class="message error">{$controller.error}</p>{/if}
  {#if $controller.status}<p role="status" class="message">{$controller.status}</p>{/if}
</div>
<style>
  .intro { display: grid; gap: 4px; }
  h4 { margin: 0; color: var(--text-primary); font-size: 14px; font-weight: 600; }
  .profile-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
  .profile-toolbar .settings-field { flex: 1 1 180px; }
  .profile-toolbar .settings-button { min-height: 32px; }
  .settings-actions + .settings-help { margin-top: 2px; }
  .message { margin: 0; color: var(--text-primary); font-size: 13px; overflow-wrap: anywhere; }
  .message.error { color: var(--system-critical-text, var(--system-critical)); }
</style>
