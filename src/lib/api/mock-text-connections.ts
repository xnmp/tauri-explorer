/** Browser fixture follows native revisions/presence, never persists keys. */
import { validateTextConfiguration, editableConfiguration, isHttpProfile, type TextConfiguration, type TextContext } from "$lib/domain/text-connections";
import { TEXT_CONFIGURATION_CHANGED } from "./text-connections";
export function createMockTextConnections() {
  let configuration: TextConfiguration = { schemaVersion: 1, revision: 0, enabled: true, defaultProfileId: "codex", profiles: [{ id: "codex", name: "Codex", model: "fixture-model", transport: "codex-cli", executablePath: "", timeoutMs: 45000 }] };
  const savedSecrets = new Set<string>();
  const read = () => structuredClone({ ...configuration, profiles: configuration.profiles.map(profile => isHttpProfile(profile) ? { ...profile, hasCredential: profile.credential.kind === "secret" && savedSecrets.has(profile.credential.id) } : profile) });
  function revision(expected: unknown) { if (expected !== configuration.revision) throw { code: "configuration_changed", message: "Language model settings changed. Reload before saving." }; }
  function commit(next: TextConfiguration) {
    configuration = { ...editableConfiguration(next), revision: configuration.revision + 1 };
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TEXT_CONFIGURATION_CHANGED, { detail: { revision: configuration.revision } }));
    return read();
  }
  function profile(id: unknown) { const result = configuration.profiles.find(p => p.id === id); if (!result) throw { code: "invalid_configuration", message: "Profile no longer exists." }; return result; }
  const context = (id: string): TextContext => ({ profileId: id, configurationRevision: configuration.revision, fingerprint: `fixture-${id}-${configuration.revision}`, transport: profile(id).transport, requestedModel: profile(id).model });
  return {
    read,
    save: (input: unknown, expected: unknown) => { revision(expected); const next = input as TextConfiguration; const errors = validateTextConfiguration(next); if (errors.length) throw { code: "invalid_configuration", message: errors.join(" ") }; return commit(next); },
    credential: (id: unknown, key: unknown, expected: unknown) => {
      revision(expected); const target = profile(id); if (!isHttpProfile(target)) throw { code: "invalid_configuration", message: "CLI login is managed by the CLI." };
      if (key !== null && (typeof key !== "string" || !key.trim())) throw { code: "invalid_configuration", message: "Enter a replacement key." };
      const secretId = key === null ? null : crypto.randomUUID(); if (secretId) savedSecrets.add(secretId);
      return commit({ ...configuration, profiles: configuration.profiles.map(p => p.id === id ? { ...target, credential: secretId ? { kind: "secret", id: secretId } : { kind: "none" } } : p) });
    },
    check: (id: unknown) => { profile(id); return { available: true }; },
    test: (id: unknown, expected: unknown) => { revision(expected); return { text: "Connection test succeeded", context: context(profile(id).id) }; },
  };
}
