<script lang="ts">
  import { changeTransport, isHttpProfile, type TextProfile, type TextTransport, type CredentialSource } from "$lib/domain/text-connections";
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
<fieldset {disabled} class="profile-fields">
  <legend>Connection details</legend>
  <label>Name <input value={profile.name} maxlength="512" oninput={e => onchange({ ...profile, name: e.currentTarget.value })} /></label>
  <label>Protocol
    <select value={profile.transport} onchange={e => onchange(changeTransport(profile, e.currentTarget.value as TextTransport))}>
      <option value="codex-cli">Codex CLI</option><option value="claude-code-cli">Claude Code CLI</option>
      <option value="openai-chat-completions">OpenAI-compatible Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option>
    </select>
  </label>
  <label>Model ID <input value={profile.model} maxlength="512" placeholder="Enter the provider's model identifier" spellcheck="false" oninput={e => onchange({ ...profile, model: e.currentTarget.value })} /></label>
  {#if cli}
    <label>Executable path <input value={cli.executablePath} placeholder="Empty uses desktop CLI discovery" spellcheck="false" oninput={e => onchange({ ...cli, executablePath: e.currentTarget.value })} /></label>
    <p class="help">Uses the CLI's saved login. API keys are not read from this form.</p>
  {:else if http}
    <label>API root <input type="url" value={http.baseUrl} placeholder="https://example.test/v1" spellcheck="false" oninput={e => onchange({ ...http, baseUrl: e.currentTarget.value })} /></label>
    <p class="help">Include the version and any path prefix. The adapter appends {http.transport === "anthropic-messages" ? "messages" : "chat/completions"}. DeepSeek and compatible local endpoints support custom roots and model IDs.</p>
    <label class="inline"><input type="checkbox" checked={http.allowInsecureHttp} onchange={e => onchange({ ...http, allowInsecureHttp: e.currentTarget.checked })} /> Allow HTTP for this endpoint</label>
    <label>Credential source
      <select value={http.credential.kind} onchange={e => source(e.currentTarget.value)}>
        <option value="none">No credential</option><option value="environment">Environment variable</option>
        {#if http.credential.kind === "secret"}<option value="secret">Saved API key</option>{/if}
      </select>
    </label>
    {#if http.credential.kind === "environment"}
      <label>Environment variable <input value={http.credential.name} placeholder="DEEPSEEK_API_KEY" spellcheck="false" oninput={e => onchange({ ...http, credential: { kind: "environment", name: e.currentTarget.value } })} /></label>
    {/if}
  {/if}
  <label>Timeout (seconds) <input type="number" min="1" max="45" step="1" value={profile.timeoutMs / 1000} oninput={e => onchange({ ...profile, timeoutMs: e.currentTarget.valueAsNumber * 1000 })} /></label>
</fieldset>
<style>
  .profile-fields { display: grid; gap: 12px; margin: 0; padding: 12px; border: 1px solid var(--divider); border-radius: var(--radius-sm); min-width: 0; }
  legend { color: var(--text-secondary); font-size: 12px; }
  label { display: grid; gap: 4px; color: var(--text-primary); font-size: 13px; min-width: 0; }
  input, select { width: 100%; min-width: 0; box-sizing: border-box; padding: 6px 8px; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); font: inherit; }
  .inline { display: flex; align-items: center; gap: 8px; }.inline input { width: auto; }
  .help { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  input:focus-visible, select:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
</style>
