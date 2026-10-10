<script lang="ts">
  import { onMount } from "svelte";
  import { createTextSettingsController } from "$lib/state/text-connections";
  import { isHttpProfile, type TextConfiguration } from "$lib/domain/text-connections";
  import TextProfileEditor from "./TextProfileEditor.svelte";
  const controller = createTextSettingsController();
  let replacementKey = $state("");
  const profile = $derived($controller.draft?.profiles.find(p => p.id === $controller.selectedProfileId));
  const http = $derived(profile && isHttpProfile(profile) ? profile : null);
  onMount(() => { void controller.start(); return () => controller.dispose(); });
  async function replaceKey() { const key = replacementKey; if (await controller.credential(profile!.id, key)) replacementKey = ""; }
  function selectProfile(id: string) { replacementKey = ""; controller.selectProfile(id); }
</script>
<div class="language-models" aria-busy={$controller.loading || $controller.saving}>
  <h4>Language models</h4>
  <p class="help">One global text connection for plugin language features. Image connections are configured separately.</p>
  {#if $controller.loading}<p role="status">Loading language model settings…</p>
  {:else if $controller.draft}
    <label class="inline"><input type="checkbox" checked={$controller.draft.enabled} disabled={$controller.saving} onchange={e => controller.edit(draft => ({ ...draft, enabled: e.currentTarget.checked }) as TextConfiguration)} /> Enable language models</label>
    <label>Default profile
      <select value={$controller.draft.defaultProfileId ?? ""} disabled={$controller.saving} onchange={e => controller.edit(draft => ({ ...draft, defaultProfileId: e.currentTarget.value || null }) as TextConfiguration)}>
        <option value="">Select a profile</option>{#each $controller.draft.profiles as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
      </select>
    </label>
    <div class="profile-toolbar">
      <label>Edit profile <select value={$controller.selectedProfileId ?? ""} disabled={$controller.saving} onchange={e => selectProfile(e.currentTarget.value)}>
        {#if !$controller.draft.profiles.length}<option value="">No profiles</option>{/if}
        {#each $controller.draft.profiles as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
      </select></label>
      <button disabled={$controller.saving || $controller.draft.profiles.length >= 32} onclick={() => { replacementKey = ""; controller.addProfile(); }}>Add profile</button>
      <button disabled={!profile || $controller.saving || ($controller.draft.enabled && profile.id === $controller.draft.defaultProfileId)} onclick={() => { replacementKey = ""; if (profile) controller.deleteProfile(profile.id); }}>Delete profile</button>
    </div>
    {#if profile}
      <TextProfileEditor {profile} disabled={$controller.saving} onchange={controller.updateProfile} />
      {#if http}
        <fieldset class="credential" disabled={$controller.saving || $controller.dirty || $controller.conflict}>
          <legend>API key</legend>
          <p class="help">{http.hasCredential ? "Credential present" : "No credential available"}. Saved keys are never read back. Environment values are resolved by the backend.</p>
          <label>Replacement API key <input type="password" autocomplete="new-password" bind:value={replacementKey} placeholder="Enter a new key to store securely" /></label>
          <div class="actions"><button disabled={!replacementKey.trim()} onclick={replaceKey}>Replace API key</button><button disabled={http.credential.kind === "none"} onclick={() => { replacementKey = ""; void controller.credential(http.id, null); }}>Clear credential</button></div>
        </fieldset>
      {/if}
    {:else}<p class="help">Add a profile to configure a language model.</p>{/if}
    <div class="actions">
      <button disabled={!$controller.dirty || $controller.saving || $controller.conflict} onclick={() => controller.save()}>{$controller.saving ? "Saving…" : "Save language models"}</button>
      <button disabled={$controller.saving} onclick={() => { replacementKey = ""; void controller.reload(); }}>Reload saved settings</button>
    </div>
    <p class="help">Save edits before checking or testing. Check connection performs local checks only. Test generation sends a minimal request to the saved provider and may incur a charge.</p>
    <div class="actions">
      <button disabled={!profile || $controller.dirty || $controller.saving || $controller.conflict || !!$controller.pending} onclick={() => controller.run("check")}>Check connection</button>
      <button disabled={!profile || $controller.dirty || $controller.saving || $controller.conflict || !!$controller.pending} onclick={() => controller.run("test")}>Test generation</button>
      {#if $controller.pending === "test"}<button onclick={controller.cancel}>Cancel test</button>{/if}
    </div>
    {#if $controller.pending}<p role="status">{$controller.pending === "check" ? "Checking locally…" : "Testing generation…"}</p>{/if}
  {:else}<button onclick={() => controller.reload()}>Retry loading</button>{/if}
  {#if $controller.conflict}<p role="alert">Another window changed these settings. Reload saved settings to resolve the conflict. Your current draft has been kept.</p>{/if}
  {#if $controller.error}<p role="alert" class="message">{$controller.error}</p>{/if}
  {#if $controller.status}<p role="status" class="message">{$controller.status}</p>{/if}
</div>
<style>
  .language-models { display: grid; gap: 12px; min-width: 0; }
  h4 { margin: 0; color: var(--text-primary); font-size: 14px; }
  label { display: grid; gap: 4px; color: var(--text-primary); font-size: 13px; min-width: 0; }
  .inline { display: flex; align-items: center; gap: 8px; }.inline input { width: auto; }
  input, select, button { box-sizing: border-box; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); padding: 6px 8px; min-width: 0; }
  input, select { width: 100%; }button { cursor: pointer; }button:disabled { opacity: .5; cursor: default; }
  input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .profile-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }.profile-toolbar label { flex: 1 1 180px; }
  .credential { display: grid; gap: 8px; min-width: 0; border: 1px solid var(--divider); border-radius: var(--radius-sm); padding: 12px; margin: 0; }legend { color: var(--text-secondary); font-size: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .help { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
  .message { margin: 0; color: var(--text-primary); font-size: 13px; overflow-wrap: anywhere; }
</style>
