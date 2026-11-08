/**
 * Plugin file icons by extension (#1523). The first registration in plugin
 * order owns an extension; disposing it restores the next claimant, or the
 * built-in icon. Contributions arrive validated
 * (`register-contributions.ts`, loaded with the first registration).
 */
import type { FileEntry } from "$lib/domain/file";
import { getExtension } from "$lib/domain/file-types";
import type { ResolvedFileIcon } from "$lib/domain/plugin-file-icon";
import { createOrderedRegistry } from "$lib/state/ordered-registry";

interface RegisteredIcon { readonly extensions: readonly string[]; readonly icon: ResolvedFileIcon }

function createFileIconRegistry() {
  const registrations = createOrderedRegistry<RegisteredIcon>();
  let byExtension = $state.raw<ReadonlyMap<string, ResolvedFileIcon>>(new Map());
  const rebuild = () => {
    const next = new Map<string, ResolvedFileIcon>();
    for (const { extensions, icon } of registrations.values()) for (const ext of extensions) if (!next.has(ext)) next.set(ext, icon);
    byExtension = next;
  };
  return {
    register(id: string, value: RegisteredIcon, order?: number): () => void {
      const dispose = registrations.register(id, value, order);
      rebuild();
      return () => { if (dispose()) rebuild(); };
    },
    /** Reactive: the plugin icon for a file, never for a folder. */
    forEntry(entry: FileEntry): ResolvedFileIcon | undefined {
      return entry.kind === "file" && byExtension.size ? byExtension.get(getExtension(entry.name)) : undefined;
    },
  };
}

export const fileIconRegistry = createFileIconRegistry();
