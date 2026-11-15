<script lang="ts">
  import { changeTransport, isHttpProfile, type TextProfile, type TextTransport, type CredentialSource } from "$lib/domain/text-connections";
  import "../settings/settings-select.css";
  import "../settings/settings-form.css";
  let { profile, disabled = false, onchange }: { profile: TextProfile; disabled?: boolean; onchange: (profile: TextProfile) => void } = $props();
  const http = $derived(isHttpProfile(profile) ? profile : null);
  const cli = $derived(!isHttpProfile(profile) ? profile : null);
  function source(kind: string) {
    if (!http) return;
    // A secret reference is allocated only by the write-only native command.
    const credential: CredentialSource = kind === "environment" ? { kind, name: "" } : { kind: "none" };
    onchange({ ...http, credential, hasCredential: false });
  }
</script>
<fieldset {disabled} class="profile-fields settings-group">
  <legend>Connection details</legend>
  <label class="settings-field">Name <input class="settings-input" value={profile.name} maxlength="512" oninput={e => onchange({ ...profile, name: e.currentTarget.value })} /></label>
  <label class="settings-field">Protocol
    <select class="settings-select" value={profile.transport} onchange={e => onchange(changeTransport(profile, e.currentTarget.value as TextTransport))}>
      <option value="codex-cli">Codex CLI</option><option value="claude-code-cli">Claude Code CLI</option>
      <option value="openai-chat-completions">OpenAI-compatible Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option>
    </select>
  </label>
  <label class="settings-field">Model ID <input class="settings-input" value={profile.model} maxlength="512" placeholder="Enter the provider's model identifier" spellcheck="false" oninput={e => onchange({ ...profile, model: e.currentTarget.value })} /></label>
  {#if cli}
    <label class="settings-field">Executable path <input class="settings-input" value={cli.executablePath} placeholder="Empty uses desktop CLI discovery" spellcheck="false" oninput={e => onchange({ ...cli, executablePath: e.currentTarget.value })} /></label>
    <p class="settings-help">Uses the CLI's saved login. API keys are not read from this form.</p>
  {:else if http}
    <label class="settings-field">API root <input class="settings-input" type="url" value={http.baseUrl} placeholder="https://example.test/v1" spellcheck="false" oninput={e => onchange({ ...http, baseUrl: e.currentTarget.value })} /></label>
    <p class="settings-help">Include the version and any path prefix. The adapter appends {http.transport === "anthropic-messages" ? "messages" : "chat/completions"}. DeepSeek and compatible local endpoints support custom roots and model IDs.</p>
    <label class="settings-switch-row"><span>Allow HTTP for this endpoint</span><input type="checkbox" class="settings-switch" checked={http.allowInsecureHttp} onchange={e => onchange({ ...http, allowInsecureHttp: e.currentTarget.checked })} /></label>
    <label class="settings-field">Credential source
      <select class="settings-select" value={http.credential.kind} onchange={e => source(e.currentTarget.value)}>
        <option value="none">No credential</option><option value="environment">Environment variable</option>
        {#if http.credential.kind === "secret"}<option value="secret">Saved API key</option>{/if}
      </select>
    </label>
    {#if http.credential.kind === "environment"}
      <label class="settings-field">Environment variable <input class="settings-input" value={http.credential.name} placeholder="DEEPSEEK_API_KEY" spellcheck="false" oninput={e => onchange({ ...http, credential: { kind: "environment", name: e.currentTarget.value } })} /></label>
    {/if}
  {/if}
  <label class="settings-field">Timeout (seconds) <input class="settings-input" type="number" min="1" max="45" step="1" value={profile.timeoutMs / 1000} oninput={e => onchange({ ...profile, timeoutMs: e.currentTarget.valueAsNumber * 1000 })} /></label>
</fieldset>
<style>
  .settings-switch-row { font-size: 13px; }
</style>
