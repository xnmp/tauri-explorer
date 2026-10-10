/** Window-local draft coordinator. Native owns durable CAS and credentials. */
import { writable, get } from "svelte/store";
import * as api from "$lib/api/text-connections";
import { extractError } from "$lib/api/common";
import { validateTextConfiguration, newTextProfile, type TextConfiguration, type TextProfile } from "$lib/domain/text-connections";
export interface TextSettingsState {
  configuration: TextConfiguration | null; draft: TextConfiguration | null;
  selectedProfileId: string | null; loading: boolean; saving: boolean; dirty: boolean;
  conflict: boolean; error: string | null; status: string | null;
  pending: "check" | "test" | null;
}
type ApiFunctions = Pick<typeof api, "readTextConnections" | "saveTextConnections" | "setTextCredential" | "clearTextCredential" | "checkTextConnection" | "testTextConnection" | "cancelTextConnectionTest" | "watchTextConnections">;
export type TextConnectionsApi = { -readonly [K in keyof ApiFunctions]: ApiFunctions[K] };
const initial = (): TextSettingsState => ({ configuration: null, draft: null, selectedProfileId: null, loading: true, saving: false, dirty: false, conflict: false, error: null, status: null, pending: null });
export function createTextSettingsController(backend: TextConnectionsApi = api) {
  const state = writable<TextSettingsState>(initial());
  let disposed = false, generation = 0, readSequence = 0, observedRevision = -1;
  let activeTest: string | null = null, unlisten: (() => void) | null = null;
  const patch = (next: Partial<TextSettingsState>) => { if (!disposed) state.update(current => ({ ...current, ...next })); };
  function adopt(configuration: TextConfiguration) {
    const current = get(state);
    patch({ configuration, draft: structuredClone(configuration), selectedProfileId: configuration.profiles.some(p => p.id === current.selectedProfileId) ? current.selectedProfileId : configuration.defaultProfileId ?? configuration.profiles[0]?.id ?? null, dirty: false, conflict: false, error: null, loading: false });
  }
  function invalidate() {
    generation++;
    const request = activeTest; activeTest = null;
    patch({ pending: null, status: null });
    const token = generation;
    if (request) void backend.cancelTextConnectionTest(request).catch(error => { if (token === generation) patch({ error: extractError(error) }); });
  }
  async function refresh(discard = false) {
    const sequence = ++readSequence;
    try {
      const configuration = await backend.readTextConnections();
      if (disposed || sequence !== readSequence) return;
      const current = get(state);
      if (!discard && current.configuration && configuration.revision <= current.configuration.revision) return;
      if (current.saving) return; // the mutation reply owns this revision
      if (current.dirty && !discard) {
        if (configuration.revision !== current.configuration?.revision) { invalidate(); patch({ conflict: true, error: "Language models changed in another window. Your edits are preserved; reload before saving." }); }
      } else { invalidate(); adopt(configuration); }
    } catch (error) { if (sequence === readSequence) patch({ error: extractError(error), loading: false }); }
  }
  async function start() {
    try {
      const stop = await backend.watchTextConnections(revision => {
        observedRevision = Math.max(observedRevision, revision);
        if (revision > (get(state).configuration?.revision ?? -1)) void refresh();
      });
      if (disposed) { stop(); return; } unlisten = stop;
      await refresh();
    } catch (error) { patch({ error: extractError(error), loading: false }); }
  }
  function edit(change: (draft: TextConfiguration) => TextConfiguration) {
    const current = get(state); if (!current.draft || current.saving) return;
    invalidate(); patch({ draft: change(current.draft), dirty: true, error: null });
  }
  function updateProfile(profile: TextProfile) { edit(draft => ({ ...draft, profiles: draft.profiles.map(item => item.id === profile.id ? profile : item) })); }
  function addProfile() {
    const profile = newTextProfile(crypto.randomUUID(), get(state).configuration?.profiles.find(p => p.transport === "codex-cli")?.model ?? "");
    edit(draft => ({ ...draft, profiles: [...draft.profiles, profile] }));
    patch({ selectedProfileId: profile.id });
  }
  function deleteProfile(profileId: string) {
    const current = get(state); if (!current.draft) return;
    if (current.draft.enabled && current.draft.defaultProfileId === profileId) { patch({ error: "Choose another default or disable language models before deleting this profile." }); return; }
    edit(draft => ({ ...draft, defaultProfileId: draft.defaultProfileId === profileId ? null : draft.defaultProfileId, profiles: draft.profiles.filter(p => p.id !== profileId) }) as TextConfiguration);
    patch({ selectedProfileId: get(state).draft?.profiles[0]?.id ?? null });
  }
  async function mutate(operation: (revision: number) => Promise<TextConfiguration>) {
    const current = get(state); if (!current.configuration || current.saving || current.conflict) return false;
    invalidate(); patch({ saving: true, error: null });
    try { const configuration = await operation(current.configuration.revision); adopt(configuration); patch({ status: "Language model settings saved." }); return true; }
    catch (error) { const message = extractError(error); patch({ saving: false, error: message }); await refresh(); if (!get(state).conflict) patch({ error: message }); return false; }
    finally {
      patch({ saving: false });
      if (!disposed && observedRevision > (get(state).configuration?.revision ?? -1)) await refresh();
    }
  }
  async function save() {
    const draft = get(state).draft; if (!draft) return;
    const errors = validateTextConfiguration(draft); if (errors.length) { patch({ error: errors.join(" ") }); return; }
    await mutate(revision => backend.saveTextConnections(draft, revision));
  }
  async function credential(profileId: string, key: string | null) {
    if (get(state).dirty) { patch({ error: "Save profile changes before replacing or clearing a key." }); return; }
    if (key !== null && !key.trim()) { patch({ error: "Enter a replacement API key." }); return; }
    return await mutate(revision => key === null ? backend.clearTextCredential(profileId, revision) : backend.setTextCredential(profileId, key, revision));
  }
  async function run(kind: "check" | "test") {
    const current = get(state); const profileId = current.selectedProfileId;
    if (!current.configuration || !profileId || current.dirty || current.conflict || current.saving || current.pending) return;
    const token = ++generation; const requestId = kind === "test" ? crypto.randomUUID() : null;
    activeTest = requestId; patch({ pending: kind, error: null, status: null });
    try {
      if (kind === "check") {
        const result = await backend.checkTextConnection(profileId);
        if (disposed || token !== generation) return;
        if (!result.available) throw new Error(result.error?.message ?? "Connection is unavailable.");
        patch({ status: "Local checks passed. Generation and remote authentication have not been tested." });
      } else {
        const result = await backend.testTextConnection(profileId, requestId!, current.configuration.revision);
        if (disposed || token !== generation) return;
        if (result.context.profileId !== profileId || result.context.configurationRevision !== current.configuration.revision) throw new Error("Settings changed during the test; run it again with the saved profile.");
        patch({ status: `Test generated: ${result.text}` });
      }
    } catch (error) { if (token === generation) patch({ error: extractError(error) }); }
    finally { if (token === generation) { activeTest = null; patch({ pending: null }); } }
  }
  return {
    subscribe: state.subscribe, start, save, edit, updateProfile, addProfile, deleteProfile, credential, run,
    selectProfile: (selectedProfileId: string) => { invalidate(); patch({ selectedProfileId, error: null }); },
    reload: () => refresh(true), cancel: invalidate,
    dispose: () => { invalidate(); disposed = true; unlisten?.(); unlisten = null; readSequence++; },
  };
}
